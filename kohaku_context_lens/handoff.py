import re
from collections import Counter
from collections.abc import Sequence
from posixpath import normpath

from .anatomy import Row, argument_map, content_texts, row_value, text_value, turn_index
from .cache import event_kind, timestamp
from .models import HandoffResult, Target

_COMPACT_PREFIX = "[Previous context summary (compact round "
_COMPACT_ROUND = re.compile(r"\[Previous context summary \(compact round (\d+)\)\]")
_COMPACT_EVENTS = {"compact_complete", "compact_replace", "compact_summary"}
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
_SUMMARY_HEADING = re.compile(r"^#{1,6}[ \t]+(.+)$")
_FENCE = re.compile(r"^[ \t]*(?:[-+*] )?(`{3,}|~{3,})(.*)$")
_LIST = re.compile(r"^[-+*] ")
_UI = re.compile(r"<ui(?:\s[^>]*)?>.*?</ui\s*>|<ui\b.*\Z", re.DOTALL | re.IGNORECASE)
_OUTSIDE_WARNING = re.compile(
    r"Warning: '([^'\r\n]+)' is outside the working directory"
)
_PATH_KEYS = ("path", "file_path", "filepath", "target_path", "filename", "file")
_MUTATION_TOOLS = {"write", "multi_edit", "edit"}
_CONTEXT_DOCS = {"agents.md", "memory.md"}


type Peer = tuple[str, Sequence[Row], Sequence[Row]]
type Success = tuple[int, float | None]


def clean_text(text: str) -> str:
    return _CONTROL.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def one_line(text: str, limit: int) -> str:
    return clip(" ".join(clean_text(text).split()), limit)


def text_of(value: object, limit: int) -> str:
    return one_line(" ".join(content_texts(value)), limit)


def recent_quotes(values: Sequence[str], count: int) -> list[str]:
    return list(dict.fromkeys(reversed([value for value in values if value])))[:count][
        ::-1
    ]


def fence_delimiter(line: str, opened: str) -> str:
    if match := _FENCE.match(line):
        if not opened:
            return match[1]
        if match[1].startswith(opened) and not match[2].strip():
            return ""
    return opened


def summary_part(label: str) -> str | None:
    label = label.casefold()
    if any(word in label for word in ("blocker", "next step", "remaining", "pending")):
        return "next"
    if any(word in label for word in ("goal", "objective", "task")):
        return "goal"
    if any(
        word in label
        for word in ("progress", "decision", "completed", "work done", "outcome")
    ):
        return "progress"
    return None


def summary_body(summary: str) -> str:
    text = clean_text(summary).strip()
    return text.partition("\n")[2].strip() if text.startswith(_COMPACT_PREFIX) else text


def compact_sections(summary: str) -> tuple[list[str], list[str], list[str]]:
    summary = summary_body(summary)
    sections: dict[str, list[str]] = {"goal": [], "progress": [], "next": []}
    part, body, fence, heading = "progress", [], "", ""
    for line in summary.splitlines():
        match = _SUMMARY_HEADING.match(line) if not fence else None
        if match and (destination := summary_part(match[1])):
            if block := "\n".join(body).strip():
                sections[part].append(clip(block, 3200))
            part, body, heading = destination, [], match[1].casefold()
        else:
            body.append(line.rstrip())
            if (
                "progress" in heading
                and not fence
                and ("[PENDING]" in line or "[IN PROGRESS]" in line)
            ):
                sections["next"].append(one_line(line.lstrip("- "), 200))
            fence = fence_delimiter(line, fence)
    if block := "\n".join(body).strip():
        sections[part].append(clip(block, 3200))
    return sections["goal"][:2], sections["progress"][:3], sections["next"][:2]


def bullets(entries: Sequence[str]) -> str:
    output = []
    for entry in entries:
        fence = padding = closing_indent = ""
        for index, line in enumerate(clean_text(entry).splitlines()):
            if not fence and line.startswith("## "):
                line = "#" + line
            next_fence = fence_delimiter(line, fence)
            if fence:
                output.append(padding + line if line else "")
            elif _LIST.match(line):
                output.append("- " + line[2:])
                padding = closing_indent = "  "
            elif not index and not next_fence:
                output.append("- " + line)
            else:
                if not index:
                    output.append("-")
                padding = "" if line.startswith("  ") else "  "
                output.append(padding + line if line else "")
                closing_indent = padding + line[: len(line) - len(line.lstrip())]
            fence = next_fence
        if fence:
            output.append(closing_indent + fence)
    return "\n".join(output)


def tool_failed(event: Row) -> bool:
    return bool(
        event.get("error")
        or event.get("exit_code") not in (None, 0)
        or event.get("success") is False
        or event.get("interrupted")
        or event.get("cancelled")
        or event.get("final_state") in ("error", "failed", "interrupted", "cancelled")
    )


def call_id(event: Row) -> str | None:
    return text_value(
        event.get("call_id") or event.get("job_id") or event.get("tool_call_id")
    )


def path_key(path: str) -> str:
    normalized = normpath(path.replace("\\", "/"))
    return (
        normalized.casefold()
        if ":" in normalized[:2] or normalized.startswith("//")
        else normalized
    )


def row_time(row: Row) -> float | None:
    return timestamp(row.get("ts", row.get("timestamp")))


def file_activity(
    events: Sequence[Row], messages: Sequence[Row]
) -> tuple[Counter[str], set[str], dict[str, Success]]:
    results = {
        identity: (index, event)
        for index, event in enumerate(events)
        if event_kind(event) == "tool_result" and (identity := call_id(event))
    }
    counts: Counter[str] = Counter()
    docs: set[str] = set()
    successes: dict[str, Success] = {}
    seen: set[str] = set()

    def add(identity: str | None, name: object, raw_args: object) -> None:
        args = argument_map(raw_args)
        path = next(
            (path for key in _PATH_KEYS if (path := text_value(args.get(key)))), None
        )
        if not path or identity in seen:
            return
        if identity:
            seen.add(identity)
        if identity in results:
            index, result = results[identity]
            if tool_failed(result):
                return
            key = path_key(path)
            if key not in successes or index > successes[key][0]:
                successes[key] = index, row_time(result)
        if name in _MUTATION_TOOLS:
            counts[path] += 1
        if (
            name in _MUTATION_TOOLS | {"read"}
            and path_key(path).rsplit("/", 1)[-1].casefold() in _CONTEXT_DOCS
        ):
            docs.add(path)

    for event in events:
        if event_kind(event) == "tool_call":
            add(
                call_id(event),
                event.get("name") or event.get("tool_name"),
                event.get("args"),
            )
            if identity := text_value(event.get("tool_call_id")):
                seen.add(identity)
    for message in messages:
        for raw in message.get("tool_calls") or ():
            call = row_value(raw)
            function = row_value(call.get("function"))
            add(
                text_value(call.get("id")),
                function.get("name"),
                function.get("arguments"),
            )
    return counts, docs, successes


def file_lines(
    own: Counter[str], peers: Sequence[tuple[str, Counter[str]]], docs: set[str]
) -> list[str]:
    paths: dict[tuple[str, str], tuple[str, int, list[str]]] = {}
    for name, counts in peers:
        for path, count in counts.items():
            normalized = path_key(path)
            # A relative path can refer to different worktrees on different creatures.
            scope = "" if normalized.startswith("/") or ":" in normalized[:2] else name
            key = (scope, normalized)
            display, total, names = paths.get(key, (path, 0, []))
            paths[key] = (
                display,
                total + count,
                names if name in names else names + [name],
            )
    lines = [
        f"{one_line(path, 220)} — {count} {'call' if count == 1 else 'calls'}"
        for path, count in own.most_common(16)
    ]
    lines.extend(
        f"{one_line(path, 220)} — {count} {'call' if count == 1 else 'calls'} ({one_line(', '.join(names), 180)})"
        for path, count, names in sorted(paths.values(), key=lambda item: -item[1])
    )
    context_docs = {path_key(path): path for path in sorted(docs, reverse=True)}
    return lines + [
        f"Context doc: {one_line(path, 220)}" for path in context_docs.values()
    ]


def retry_succeeded(
    path: str,
    index: int,
    when: float | None,
    own: dict[str, Success],
    peers: Sequence[dict[str, Success]],
) -> bool:
    key = path_key(path)
    if (success := own.get(key)) and success[0] > index:
        return True
    # Relative paths do not identify the same worktree across creatures.
    return (
        when is not None
        and (key.startswith("/") or ":" in key[:2])
        and any(
            (success := group.get(key)) and success[1] is not None and success[1] > when
            for group in peers
        )
    )


def recent_blockers(
    events: Sequence[Row], own: dict[str, Success], peers: Sequence[dict[str, Success]]
) -> list[str]:
    last_turn = max((turn_index(row) or 0 for row in events), default=0)
    seen_calls: set[str] = set()
    errors, tool_failures = [], []
    for index in range(len(events) - 1, -1, -1):
        event = events[index]
        turn = turn_index(event)
        if turn is not None and turn < last_turn - 3:
            continue
        kind = event_kind(event)
        if kind == "processing_error":
            label = text_value(event.get("error_type")) or "Processing error"
            detail = event.get("error") or event.get("detail")
            destination = errors
        elif kind == "tool_result":
            if identity := call_id(event):
                if identity in seen_calls:
                    continue
                seen_calls.add(identity)
            if not tool_failed(event):
                continue
            detail = (
                event.get("error")
                or event.get("output")
                or f"exit {event.get('exit_code')}"
            )
            warning = _OUTSIDE_WARNING.search(" ".join(content_texts(detail)))
            if warning and retry_succeeded(
                warning[1], index, row_time(event), own, peers
            ):
                continue
            label = text_value(event.get("name")) or "Tool"
            destination = tool_failures
        else:
            continue
        destination.append(
            f"{one_line(label, 72)}: {text_of(detail, 210) or 'No detail recorded.'}"
        )
    errors = recent_quotes(errors[::-1], 4)
    return errors + recent_quotes(tool_failures[::-1], 4 - len(errors))


def compact_message(message: Row) -> bool:
    content = text_value(message.get("content")) or ""
    meta = row_value(message.get("metadata"))
    return bool(
        meta.get("compact_summary")
        or event_kind(message) == "compact_summary"
        or message.get("role") == "compact_summary"
        or content.startswith(_COMPACT_PREFIX)
    )


def message_order(row: Row) -> tuple[int | None, float | None]:
    meta = row_value(row.get("metadata"))
    turn = turn_index(row)
    return turn if turn is not None else turn_index(meta), row_time(row) or row_time(
        meta
    )


def is_after(row: Row, marker: Row) -> bool | None:
    turn, when = message_order(row)
    cutoff, then = message_order(marker)
    if when is not None and then is not None:
        return when > then
    if turn is not None and cutoff is not None and turn != cutoff:
        return turn > cutoff
    return None


def compact_round(row: Row) -> int | None:
    if type(row.get("round")) is int:
        return row["round"]
    match = _COMPACT_ROUND.match(text_value(row.get("content")) or "")
    return int(match[1]) if match else None


def after_compaction(
    messages: Sequence[Row], events: Sequence[Row]
) -> tuple[str, list[Row], list[Row]]:
    message_index = next(
        (i for i in range(len(messages) - 1, -1, -1) if compact_message(messages[i])),
        -1,
    )
    event_index = next(
        (
            i
            for i in range(len(events) - 1, -1, -1)
            if event_kind(events[i]) in _COMPACT_EVENTS
        ),
        -1,
    )
    marker = messages[message_index] if message_index >= 0 else {}
    compact = events[event_index] if event_index >= 0 else {}
    marker_round, event_round = compact_round(marker), compact_round(compact)
    covered = row_value(marker.get("metadata")).get("compact_result_event_ids")
    relative = is_after(marker, compact)
    if marker_round is not None and event_round is not None:
        relative = None if marker_round == event_round else marker_round > event_round
    elif covered and covered == compact.get("compact_result_event_ids"):
        relative = None
    marker_is_newer = relative is True
    event_summary = text_value(compact.get("summary") or compact.get("content")) or ""
    message_summary = text_value(marker.get("content") or marker.get("summary")) or ""
    summary = message_summary if marker_is_newer or not event_summary else event_summary
    cutoff = marker if marker_is_newer else compact or marker
    post_events = [
        row
        for row in events[event_index + 1 :]
        if not marker_is_newer or is_after(row, marker)
    ]
    # Undated legacy snapshots can fall back to the last marker's position.
    use_position = (event_index < 0 or message_index >= 0) and relative is not False
    post_messages = [
        row
        for row in messages[message_index + 1 :]
        if (after := is_after(row, cutoff)) is True or (after is None and use_position)
    ]
    return summary, post_messages, post_events


def outcome(value: object) -> str:
    return one_line(_UI.sub(" ", "\n".join(content_texts(value))), 600)


def incremental_quotes(
    events: Sequence[str], snapshot: Sequence[str], limit: int
) -> list[str]:
    # Keep snapshot-only replies newer than the last persisted overlap.
    recorded = set(events) - {""}
    overlap = next(
        (i for i in range(len(snapshot) - 1, -1, -1) if snapshot[i] in recorded), -1
    )
    return recent_quotes([*events, *snapshot[overlap + 1 :]], limit)


def packet(
    target: Target,
    messages: Sequence[Row],
    events: Sequence[Row],
    channels: Sequence[tuple[str, Row]],
    llm_name: str | None,
    listen: Sequence[str],
    send: Sequence[str],
    peers: Sequence[Peer],
) -> HandoffResult:
    summary, post_messages, post_events = after_compaction(messages, events)
    recent_users = [
        text_of(row.get("content"), 440)
        for row in post_messages
        if row.get("role") == "user"
        and row_value(row.get("metadata")).get("kind")
        not in ("tool_results", "rules", "memory", "skills")
    ]
    event_users = [
        text_of(row.get("content"), 440)
        for row in post_events
        if event_kind(row) in ("user_input", "user_message")
    ]
    outcomes = [
        outcome(row.get("content"))
        for row in post_messages
        if row.get("role") == "assistant"
    ]
    event_outcomes = [
        outcome(row_value(row.get("message")).get("content", row.get("content")))
        for row in post_events
        if event_kind(row) == "assistant_message"
    ]
    goal, progress, next_steps = compact_sections(summary)
    goal.extend(incremental_quotes(event_users, recent_users, 2))
    progress.extend(incremental_quotes(event_outcomes, outcomes, 3))
    own, docs, successful_paths = file_activity(events, messages)
    peer_counts, peer_successes = [], []
    for name, peer_events, peer_messages in peers:
        counts, context_docs, successes = file_activity(peer_events, peer_messages)
        docs.update(context_docs)
        peer_counts.append((name, counts))
        peer_successes.append(successes)
    activity = [
        f"{one_line(channel, 70)} / {one_line(text_value(row.get('sender')) or 'unknown sender', 70)}: {body}"
        for channel, row in channels[-8:]
        if (body := text_of(row.get("content"), 1000))
    ]
    blockers = recent_blockers(events, successful_paths, peer_successes) + next_steps
    if not blockers:
        blockers.append("No recent failures or explicit next steps recorded.")
    blockers.extend(
        [
            f"Target model: {one_line(llm_name or 'not recorded', 140)}",
            "Listens: "
            + (one_line(", ".join(sorted(set(listen))), 220) or "none recorded"),
            "Sends: "
            + (one_line(", ".join(sorted(set(send))), 220) or "none recorded"),
        ]
    )
    sections = [
        ("Current Goal", goal or ["No goal recorded."]),
        (
            "Key Decisions & Completed Work",
            progress or ["No decisions or completed work recorded."],
        ),
        (
            "Files Touched",
            file_lines(own, peer_counts, docs) or ["No file edits recorded."],
        ),
        ("Recent Team Channel Activity", activity or ["No channel messages recorded."]),
        ("Open Blockers & Next Steps", blockers),
    ]
    markdown = "\n\n".join(
        f"## {heading}\n\n{bullets(lines)}" for heading, lines in sections
    )
    return {"target": target, "markdown": markdown + "\n"}
