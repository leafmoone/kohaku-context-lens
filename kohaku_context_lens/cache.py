from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from .anatomy import Row, turn_index
from .models import CacheTurn, DropReason

_MARKERS: dict[str, DropReason] = {
    "compact_start": "compaction",
    "compact_complete": "compaction",
    "compact_replace": "compaction",
    "system_prompt_set": "system_change",
    "system_prompt_changed": "system_change",
    "tool_schema_changed": "tool_schema_change",
    "tool_schema_set": "tool_schema_change",
    "tool_schemas_changed": "tool_schema_change",
}


@dataclass(slots=True)
class Turn:
    rollup: Row | None = None
    total: Row | None = None
    calls: tuple[int, int, int] | None = None
    first_seen: float | None = None
    last_seen: float | None = None
    first_usage: int | None = None
    last_usage: int | None = None


@dataclass(frozen=True, slots=True)
class Marker:
    reason: DropReason
    kind: str
    event_id: int | None
    ts: float | None


def event_kind(event: Row) -> str:
    return str(event.get("type") or "").removeprefix("activity:")


def timestamp(value: object) -> float | None:
    if type(value) in (int, float):
        return float(value)
    if isinstance(value, str):
        try:
            recorded = datetime.fromisoformat(value)
        except ValueError:
            return None
        if recorded.tzinfo is None:
            recorded = recorded.replace(tzinfo=UTC)
        return recorded.timestamp()
    return None


def token_counts(row: Row) -> tuple[int, int, int]:
    prompt = row.get("prompt_tokens", row.get("tokens_in"))
    cached = row.get("cached_tokens", row.get("tokens_cached"))
    completion = row.get("completion_tokens", row.get("tokens_out"))
    return (
        prompt if type(prompt) is int and prompt > 0 else 0,
        cached if type(cached) is int and cached > 0 else 0,
        completion if type(completion) is int and completion > 0 else 0,
    )


def hit_rate(prompt: int, cached: int) -> float | None:
    return cached / prompt if prompt > 0 and 0 <= cached <= prompt else None


def turn_time(turn: Turn, key: str, fallback: float | None) -> float | None:
    recorded = timestamp(turn.rollup.get(key)) if turn.rollup is not None else None
    return recorded if recorded is not None else fallback


def cache_series(rollups: Sequence[Row], events: Sequence[Row]) -> list[CacheTurn]:
    turns: dict[int, Turn] = {}
    for row in rollups:
        if index := turn_index(row):
            turns[index] = Turn(rollup=row)
    markers: dict[int, Marker] = {}
    for position, event in enumerate(events):
        kind, ts = event_kind(event), timestamp(event.get("ts"))
        if reason := _MARKERS.get(kind):
            eid = event.get("event_id")
            markers[position] = Marker(
                reason, kind, eid if type(eid) is int else None, ts
            )
        if not (index := turn_index(event)):
            continue
        turn = turns.setdefault(index, Turn())
        if ts is not None:
            if turn.first_seen is None:
                turn.first_seen = ts
            turn.last_seen = ts
        if kind not in ("token_usage", "turn_token_usage"):
            continue
        if turn.first_usage is None:
            turn.first_usage = position
        turn.last_usage = position
        if kind == "turn_token_usage":
            turn.total = event
        else:
            left = turn.calls or (0, 0, 0)
            right = token_counts(event)
            turn.calls = (left[0] + right[0], left[1] + right[1], left[2] + right[2])

    positions = list(markers)
    by_time = sorted(
        (marker.ts, pos) for pos, marker in markers.items() if marker.ts is not None
    )
    times = [ts for ts, _ in by_time]
    series: list[CacheTurn] = []
    previous = None
    for index, turn in sorted(turns.items()):
        usage = turn.rollup if turn.rollup is not None else turn.total
        counts = token_counts(usage) if usage is not None else turn.calls
        if counts is None:
            continue
        prompt, cached, completion = counts
        rate = hit_rate(prompt, cached)
        row: CacheTurn = {
            "turn_index": index,
            "prompt_tokens": prompt,
            "cached_tokens": cached,
            "completion_tokens": completion,
            "hit_rate": rate,
            "drop": None,
        }
        if (
            previous is not None
            and rate is not None
            and (prior_rate := series[-1]["hit_rate"]) is not None
        ):
            delta = round(prior_rate - rate, 12)
            if delta >= 0.20:
                end = turn_time(previous, "ended_at", previous.last_seen)
                start = turn_time(turn, "started_at", turn.first_seen)
                if previous.last_usage is not None and turn.first_usage is not None:
                    left = bisect_right(positions, previous.last_usage)
                    right = bisect_left(positions, turn.first_usage)
                    between = [markers[pos] for pos in positions[left:right]]
                elif end is not None and start is not None:
                    left, right = bisect_left(times, end), bisect_right(times, start)
                    between = [markers[pos] for _, pos in by_time[left:right]]
                else:
                    between = []
                # Prefer a completed rewrite over a start marker in the same interval.
                compact = next(
                    (
                        m
                        for m in reversed(between)
                        if m.reason == "compaction" and m.kind != "compact_start"
                    ),
                    None,
                )
                compact = compact or next(
                    (m for m in reversed(between) if m.reason == "compaction"), None
                )
                idle = end is not None and start is not None and start - end >= 300.0
                evidence = compact or (between[-1] if between and not idle else None)
                row["drop"] = {
                    "delta": delta,
                    "reason": evidence.reason
                    if evidence
                    else "idle_gap"
                    if idle
                    else "unknown",
                    "event_id": evidence.event_id if evidence else None,
                }
        series.append(row)
        previous = turn
    return series
