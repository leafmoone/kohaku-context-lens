import re
from collections import Counter
from collections.abc import Sequence

from .anatomy import Row, argument_map, content_texts, row_value, text_value, turn_index
from .cache import event_kind
from .models import HandoffResult, Target

_COMPACT_PREFIX = "[Previous context summary (compact round "
_SUMMARY_HEADING = re.compile(r"^#{1,6}[ \t]+(.+)$", re.MULTILINE)
_MD = re.compile(r"([\\`*_{}\[\]<>|&])")
_PATH_KEYS = ("path", "file_path", "filepath", "target_path", "filename", "file")
_MUTATION_TOOLS = {"write", "multi_edit", "edit"}


def one_line(text: str, limit: int) -> str:
    value = re.sub(r"\s+", " ", text[: limit * 4]).strip()
    return _MD.sub(r"\\\1", value if len(value) <= limit else value[: limit - 1] + "…")


def text_of(value: object, limit: int) -> str:
    return one_line(" ".join(content_texts(value)), limit)


def recent_quotes(values: Sequence[str], count: int) -> list[str]:
    return list(dict.fromkeys(reversed([value for value in values if value])))[:count][
        ::-1
    ]


def compact_sections(summary: str) -> tuple[list[str], list[str], list[str]]:
    goal, progress, next_steps = [], [], []
    headings = list(_SUMMARY_HEADING.finditer(summary))
    for index, heading in enumerate(headings):
        label = heading[1].casefold()
        end = headings[index + 1].start() if index + 1 < len(headings) else len(summary)
        section = summary[heading.end() : end]
        body = one_line(section, 400)
        if not body:
            continue
        if any(
            word in label for word in ("blocker", "next step", "remaining", "pending")
        ):
            next_steps.append(body)
        elif any(word in label for word in ("goal", "objective", "task")):
            goal.append(body)
        elif "progress" in label:
            progress.append(body)
            next_steps.extend(
                one_line(line.lstrip("- "), 200)
                for line in section.splitlines()
                if "[PENDING]" in line or "[IN PROGRESS]" in line
            )
        elif any(
            word in label for word in ("decision", "completed", "work done", "outcome")
        ):
            progress.append(body)
    if summary and not headings:
        progress.append(
            one_line(
                summary.removeprefix(_COMPACT_PREFIX).partition(")]\n")[2]
                if summary.startswith(_COMPACT_PREFIX)
                else summary,
                400,
            )
        )
    return goal[:2], progress[:3], next_steps[:2]


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


def files_touched(events: Sequence[Row], messages: Sequence[Row]) -> list[str]:
    results = {
        call_id(event): event
        for event in events
        if event_kind(event) == "tool_result" and call_id(event)
    }
    counts: Counter[str] = Counter()
    identities: set[str] = set()

    def add(identity: str | None, name: object, raw_args: object) -> None:
        if name not in _MUTATION_TOOLS or (identity and identity in identities):
            return
        if identity:
            identities.add(identity)
            if identity in results and tool_failed(results[identity]):
                return
        args = argument_map(raw_args)
        for key in _PATH_KEYS:
            if path := text_value(args.get(key)):
                counts[path] += 1
                break

    for event in events:
        if event_kind(event) == "tool_call":
            add(
                call_id(event),
                event.get("name") or event.get("tool_name"),
                event.get("args"),
            )
            if identity := text_value(event.get("tool_call_id")):
                identities.add(identity)
    for message in messages:
        for raw in message.get("tool_calls") or ():
            call = row_value(raw)
            function = row_value(call.get("function"))
            add(
                text_value(call.get("id")),
                function.get("name"),
                function.get("arguments"),
            )
    return [
        f"{one_line(path, 220)} — {count} {'call' if count == 1 else 'calls'}"
        for path, count in counts.most_common(16)
    ]


def recent_blockers(events: Sequence[Row]) -> list[str]:
    last_turn = max((turn_index(row) or 0 for row in events), default=0)
    seen_calls: set[str] = set()
    blockers: list[str] = []
    for event in reversed(events):
        turn = turn_index(event)
        if turn is not None and turn < last_turn - 3:
            continue
        kind = event_kind(event)
        if kind == "tool_result":
            if identity := call_id(event):
                if identity in seen_calls:
                    continue
                seen_calls.add(identity)
            if not tool_failed(event):
                continue
            label = text_value(event.get("name")) or "Tool"
            detail = (
                event.get("error")
                or event.get("output")
                or f"exit {event.get('exit_code')}"
            )
        elif kind == "processing_error":
            label = text_value(event.get("error_type")) or "Processing error"
            detail = event.get("error") or event.get("detail")
        else:
            continue
        blockers.append(
            f"{one_line(label, 72)}: {text_of(detail, 210) or 'No detail recorded.'}"
        )
        if len(blockers) == 4:
            break
    return recent_quotes(blockers[::-1], 4)


def packet(
    target: Target,
    messages: Sequence[Row],
    events: Sequence[Row],
    channels: Sequence[tuple[str, Row]],
    llm_name: str | None,
    listen: Sequence[str],
    send: Sequence[str],
) -> HandoffResult:
    recent_users, outcomes = [], []
    summary = ""
    for message in messages:
        content = message.get("content")
        meta = row_value(message.get("metadata"))
        if isinstance(content, str) and (
            meta.get("compact_summary") or content.startswith(_COMPACT_PREFIX)
        ):
            summary = content
        elif message.get("role") == "user" and meta.get("kind") not in (
            "tool_results",
            "rules",
            "memory",
            "skills",
        ):
            recent_users.append(text_of(content, 440))
        elif message.get("role") == "assistant":
            outcomes.append(text_of(content, 260))
    for event in reversed(events):
        if event_kind(event) in ("compact_complete", "compact_replace") and (
            body := text_value(event.get("summary"))
        ):
            summary = body
            break
    recent_users.extend(
        text_of(event.get("content"), 440)
        for event in events
        if event_kind(event) in ("user_input", "user_message")
    )
    goal, progress, next_steps = compact_sections(summary)
    goal.extend(recent_quotes(recent_users, 2))
    progress.extend(recent_quotes(outcomes, 3))
    activity = [
        f"{one_line(channel, 70)} / {one_line(text_value(row.get('sender')) or 'unknown sender', 70)}: {body}"
        for channel, row in channels[-8:]
        if (body := text_of(row.get("content"), 220))
    ]
    blockers = recent_blockers(events) + next_steps
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
            files_touched(events, messages) or ["No file edits recorded."],
        ),
        ("Recent Team Channel Activity", activity or ["No channel messages recorded."]),
        ("Open Blockers & Next Steps", blockers),
    ]
    markdown = "\n\n".join(
        f"## {heading}\n\n" + "\n".join(f"- {line}" for line in lines)
        for heading, lines in sections
    )
    return {"target": target, "markdown": markdown + "\n"}
