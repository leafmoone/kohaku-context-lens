import json
import re
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from heapq import nlargest
from typing import Any, cast

from .models import Anatomy, Basis, Bucket, Buckets, Context, RiskFlag, ToolOutput

Row = Mapping[str, Any]

BUCKETS = (
    "system_prompt",
    "rules_memory",
    "skills_tools",
    "tool_outputs",
    "chat_channels",
    "reasoning_compaction",
)
_CONTEXT_FILES = re.compile(
    r"<!-- kt-context-files -->.*?(?:<!-- /?kt-context-files -->|\Z)", re.DOTALL
)
_HEADING = re.compile(r"^(#{1,6})[ \t]+([^\n]+)", re.MULTILINE)
_TOOL_BOUNDARY = re.compile(
    r"^\[Tool ([^\s\]]+) (?:completed|cancelled|failed(?:, exit [^\]]+)?)\]",
    re.MULTILINE,
)
_RULES_HEADINGS = {
    "working memory",
    "memory",
    "rules",
    "琥珀生态瓶通用项目工作约定",
    "kt 全局项目约束",
    "仓库内容边界",
}
_SKILLS_HEADINGS = {
    "skills",
    "tools",
    "available tools",
    "available mcp tools",
    "available functions",
    "function documentation",
    "tool guidance",
}
_PATH_KEYS = ("path", "file_path", "filepath", "target_path", "filename", "file")


@dataclass(frozen=True, slots=True)
class ToolCall:
    name: str | None
    arguments: object
    turn_index: int | None


def estimate_tokens(text: str) -> int:
    return (len(text.encode("utf-8", errors="replace")) + 3) // 4


def text_value(value: object) -> str | None:
    return value if isinstance(value, str) and value else None


def row_value(value: object) -> Row:
    return value if isinstance(value, Mapping) else {}


def turn_index(record: Row) -> int | None:
    turn = record.get("turn_index")
    return turn if type(turn) is int and turn > 0 else None


def content_texts(content: object) -> Iterator[str]:
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for item in content:
            part = row_value(item)
            if part.get("type") in ("text", "input_text", "output_text") and (
                text := text_value(part.get("text"))
            ):
                yield text


def reasoning_texts(message: Row) -> Iterator[str]:
    # Providers may mirror reasoning in multiple fields. Use one representation.
    for field in ("reasoning_content", "reasoning", "reasoning_summary"):
        if text := text_value(message.get(field)):
            yield text
            return
    details = message.get("reasoning_details")
    if isinstance(details, list):
        texts = [
            text
            for item in details
            if (detail := row_value(item))
            and (text := text_value(detail.get("text") or detail.get("summary")))
        ]
        if texts:
            yield from texts
            return
    for item in row_value(message.get("_kt_antigravity_content")).get("parts", ()):
        part = row_value(item)
        if part.get("thought") is True and (text := text_value(part.get("text"))):
            yield text


def prompt_sections(text: str, base: Bucket) -> Iterator[tuple[Bucket, str]]:
    if base != "system_prompt":
        yield base, text
        return
    cursor = 0
    current: Bucket = base
    scopes: list[tuple[int, Bucket]] = [(0, base)]
    for marker in _HEADING.finditer(text):
        heading = marker[2].strip().lower().rstrip(":")
        level = len(marker[1])
        while scopes[-1][0] >= level:
            scopes.pop()
        bucket = scopes[-1][1]
        if heading in _RULES_HEADINGS or heading.endswith(
            (" guidelines", "agents.md", "memory.md")
        ):
            bucket = "rules_memory"
        elif heading in _SKILLS_HEADINGS:
            bucket = "skills_tools"
        scopes.append((level, bucket))
        if bucket != current:
            yield current, text[cursor : marker.start()]
            cursor, current = marker.start(), bucket
    yield current, text[cursor:]


def context_sections(text: str, base: Bucket) -> Iterator[tuple[Bucket, str]]:
    cursor = 0
    for block in _CONTEXT_FILES.finditer(text):
        yield from prompt_sections(text[cursor : block.start()], base)
        yield "rules_memory", block[0]
        cursor = block.end()
    yield from prompt_sections(text[cursor:], base)


def message_bucket(message: Row, meta: Row) -> Bucket:
    role = message.get("role")
    kind = meta.get("kind")
    if role == "tool" or kind == "tool_results":
        return "tool_outputs"
    content = message.get("content")
    if meta.get("compact_summary") or (
        role == "assistant"
        and isinstance(content, str)
        and content.startswith("[Previous context summary (compact round ")
    ):
        return "reasoning_compaction"
    if kind in ("rules", "memory", "rules_memory", "context_files"):
        return "rules_memory"
    if kind in ("skills", "tools", "skills_tools", "tool_schema"):
        return "skills_tools"
    return "system_prompt" if role in ("system", "developer") else "chat_channels"


def feedback_segments(
    text: str, job_ids: list[str]
) -> Iterator[tuple[str | None, str]]:
    headers = [
        header for header in _TOOL_BOUNDARY.finditer(text) if header[1] in job_ids
    ]
    if not headers or headers[0].start() != 0:
        yield (job_ids[0] if len(job_ids) == 1 else None), text
        return
    for index, header in enumerate(headers):
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        yield header[1], text[header.start() : end]


def tool_event_calls(events: Sequence[Row]) -> dict[str, ToolCall]:
    calls: dict[str, ToolCall] = {}
    for event in events:
        if event.get("type") != "tool_call":
            continue
        call = ToolCall(
            text_value(event.get("name")), event.get("args"), turn_index(event)
        )
        for key in ("call_id", "job_id", "tool_call_id"):
            if identity := text_value(event.get(key)):
                calls[identity] = call
    return calls


def argument_map(arguments: object) -> Row:
    if isinstance(arguments, str):
        try:
            return row_value(json.loads(arguments))
        except json.JSONDecodeError:
            return {}
    return row_value(arguments)


def preview_line(text: str) -> str:
    # Stop after 180 visible characters without copying the whole tool output.
    words: list[str] = []
    length = 0
    for match in re.finditer(r"\S+", text):
        room = 180 - length - bool(words)
        if match.end() - match.start() > room:
            if room > 0:
                words.append(text[match.start() : match.start() + room])
            return " ".join(words)[:179].rstrip() + "…"
        words.append(match[0])
        length += len(match[0]) + (len(words) > 1)
    return " ".join(words)


def output_row(
    message: Row,
    identity: str | None,
    text: str,
    count: int,
    calls: Mapping[str, ToolCall],
    active_turn: int | None,
) -> ToolOutput:
    call = calls.get(identity) if identity is not None else None
    args = argument_map(call.arguments) if call is not None else {}
    path = next(
        (value for key in _PATH_KEYS if (value := text_value(args.get(key)))), None
    )
    command = text_value(args.get("command") or args.get("cmd"))
    preview = preview_line(text)
    if command is not None and path is None:
        preview = preview_line(f"{preview_line(command)} — {preview}")
    return {
        "tool_name": (call.name if call is not None else None)
        or text_value(message.get("name")),
        "turn_index": (call.turn_index if call is not None else None) or active_turn,
        "call_id": identity,
        "target_path": path,
        "preview": preview,
        "estimated_tokens": count,
        "share": 0.0,
    }


def analyze_messages(
    messages: Sequence[Row],
    basis: Basis,
    events: Sequence[Row],
    include_outputs: bool,
) -> Anatomy:
    buckets = dict.fromkeys(BUCKETS, 0)
    calls = tool_event_calls(events) if include_outputs else {}
    outputs: list[ToolOutput] = []
    active_turn = None
    for message in messages:
        meta = row_value(message.get("metadata"))
        active_turn = turn_index(meta) or active_turn
        bucket = message_bucket(message, meta)
        texts = content_texts(message.get("content"))

        for item in message.get("tool_calls") or ():
            item = row_value(item)
            function = row_value(item.get("function"))
            name = text_value(function.get("name"))
            arguments = function.get("arguments")
            arg_text = (
                arguments
                if isinstance(arguments, str)
                else (
                    json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
                    if arguments is not None
                    else ""
                )
            )
            buckets["skills_tools"] += estimate_tokens(name or "") + estimate_tokens(
                arg_text
            )
            if include_outputs and (identity := text_value(item.get("id"))):
                event = calls.get(identity)
                calls[identity] = ToolCall(
                    name or (event.name if event else None),
                    arguments
                    if arguments is not None
                    else (event.arguments if event else None),
                    (event.turn_index if event else None) or active_turn,
                )

        if bucket == "tool_outputs":
            identity = text_value(message.get("tool_call_id") or meta.get("job_id"))
            job_ids = [
                job for job in (meta.get("job_ids") or ()) if isinstance(job, str)
            ]
            if message.get("role") != "tool" and job_ids:
                segments = feedback_segments("\n\n".join(texts), job_ids)
            else:
                segments = ((identity, "\n".join(texts)),)
            for result_id, text in segments:
                count = estimate_tokens(text)
                buckets[bucket] += count
                if include_outputs and count:
                    outputs.append(
                        output_row(message, result_id, text, count, calls, active_turn)
                    )
        else:
            for text in texts:
                if bucket in ("chat_channels", "system_prompt"):
                    for section, body in context_sections(text, bucket):
                        buckets[section] += estimate_tokens(body)
                else:
                    buckets[bucket] += estimate_tokens(text)
        if message.get("role") == "assistant":
            buckets["reasoning_compaction"] += sum(
                map(estimate_tokens, reasoning_texts(message))
            )

    total = sum(buckets.values())
    top = nlargest(10, outputs, key=lambda item: item["estimated_tokens"])
    for item in top:
        item["share"] = item["estimated_tokens"] / total
    return {
        "basis": basis,
        "message_count": len(messages),
        "estimated_tokens": total,
        "buckets": cast(Buckets, buckets),
        "top_tool_outputs": top,
    }


def signature_fragile(llm_name: str | None, enabled: bool | None) -> bool:
    name = (llm_name or "").lower()
    return enabled is not False and "antigravity" in name and "gemini" in name


def risk_flags(context: Context, estimated_tokens: int) -> list[RiskFlag]:
    used = context["last_prompt_tokens"] or estimated_tokens
    compact_at = context["compact_at_tokens"]
    window = context["max_context_tokens"]
    flags: list[RiskFlag] = []
    if (
        context["compact_enabled"] is not False
        and compact_at
        and used * 5 >= compact_at * 4
    ):
        flags.append("near_compaction")
    if window and used * 5 >= window * 4:
        flags.append("near_context_window")
    if context["signature_fragile"]:
        flags.append("signature_chain")
    return flags
