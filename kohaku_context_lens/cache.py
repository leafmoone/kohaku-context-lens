from bisect import bisect_left, bisect_right
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .anatomy import Row, turn_index
from .models import CacheTurn, DropReason, PerfMetrics
from .perf import metrics, rate

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
    timing: list[tuple[PerfMetrics, int]] = field(default_factory=list)


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


def elapsed_ms(start: float | None, end: float | None) -> float | None:
    return (
        (end - start) * 1000.0
        if start is not None and end is not None and end > start
        else None
    )


def turn_metrics(turn: Turn, completion: int) -> PerfMetrics:
    timed = [
        (m, n, m["duration_ms"]) for m, n in turn.timing if m["duration_ms"] is not None
    ]
    if not timed:
        duration = elapsed_ms(
            turn_time(turn, "started_at", None), turn_time(turn, "ended_at", None)
        )
        return metrics(duration, None, 0, completion)
    duration = sum(d for _, _, d in timed if d is not None)
    decode = [
        (n, d - t)
        for m, n, d in timed
        if d is not None and (t := m["ttft_ms"]) is not None and d - t >= 5.0
    ]
    first = turn.timing[0][0]
    return {
        "duration_ms": duration,
        "ttft_ms": first["ttft_ms"],
        "prefill_tps": first["prefill_tps"],
        "decode_tps": rate(sum(n for n, _ in decode), sum(d for _, d in decode)),
        "e2e_tps": rate(sum(n for _, n, _ in timed), duration),
    }


def cache_series(rollups: Sequence[Row], events: Sequence[Row]) -> list[CacheTurn]:
    return cache_reading(rollups, events, {})[0]


def cache_reading(
    rollups: Sequence[Row], events: Sequence[Row], samples: dict[int, Row]
) -> tuple[list[CacheTurn], PerfMetrics]:
    turns: dict[int, Turn] = {}
    for row in rollups:
        if index := turn_index(row):
            turns[index] = Turn(rollup=row)
    trigger_turns = not turns and not any(turn_index(event) for event in events)
    trigger_index = 1
    markers: dict[int, Marker] = {}
    round_start: tuple[int | None, object, float | None] | None = None
    latest_call: tuple[int, PerfMetrics] | None = None
    for position, event in enumerate(events):
        kind, ts = event_kind(event), timestamp(event.get("ts"))
        if reason := _MARKERS.get(kind):
            eid = event.get("event_id")
            markers[position] = Marker(
                reason, kind, eid if type(eid) is int else None, ts
            )
        index = turn_index(event)
        branch = event.get("branch_id")
        if kind == "assistant_round_start":
            round_start = (index, branch, ts)
        elif kind in (
            "processing_start",
            "processing_end",
            "processing_error",
            "interrupt",
            "turn_token_usage",
        ):
            round_start = None
        if trigger_turns and kind in ("token_usage", "turn_token_usage"):
            index = trigger_index
            if kind == "turn_token_usage":
                trigger_index += 1
        if not index:
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
            start = (
                round_start[2]
                if round_start is not None
                and round_start[:2] == (turn_index(event), branch)
                else None
            )
            round_start = None
            sample = samples.get(event.get("event_id"), {})
            duration = timestamp(sample.get("duration_ms")) or elapsed_ms(start, ts)
            ttft = timestamp(sample.get("ttft_ms"))
            perf = metrics(duration, ttft, right[0], right[2])
            turn.timing.append((perf, right[2]))
            latest_call = (index, perf)

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
            **turn_metrics(turn, completion),
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
    if latest_call is not None and (
        not series or latest_call[0] >= series[-1]["turn_index"]
    ):
        index, latest = latest_call
        if latest["duration_ms"] is None and len(turns[index].timing) == 1:
            latest = turn_metrics(turns[index], turns[index].timing[0][1])
    else:
        latest = (
            turn_metrics(
                turns[series[-1]["turn_index"]], series[-1]["completion_tokens"]
            )
            if series
            else metrics(None, None, 0, 0)
        )
    return series, latest
