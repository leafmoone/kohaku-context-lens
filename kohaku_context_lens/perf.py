"""Observe streamed model calls without modifying the host's output."""

import time
from collections import deque
from collections.abc import Callable
from typing import TYPE_CHECKING

from kohakuterrarium.llm.codex.provider import CodexOAuthProvider
from kohakuterrarium.modules.output.base import BaseOutputModule
from kohakuterrarium.modules.output.event import OutputEvent
from kohakuterrarium.session.output.output import SessionOutput
from kohakuterrarium.session.store import SessionStore
from kohakuterrarium.terrarium import LocalTerrariumService

from .anatomy import Row
from .models import PerfMetrics

if TYPE_CHECKING:
    from kohakuterrarium.core.agent import Agent


class PerfSample(PerfMetrics):
    call_seq: int
    turn_index: int
    ts: float
    prompt_tokens: int
    completion_tokens: int


def rate(tokens: int, ms: float | None) -> float | None:
    return tokens * 1000.0 / ms if tokens > 0 and ms is not None and ms >= 5.0 else None


def metrics(
    duration: float | None, ttft: float | None, prompt: int, completion: int
) -> PerfMetrics:
    decode = duration - ttft if duration is not None and ttft is not None else None
    return {
        "duration_ms": duration,
        "ttft_ms": ttft,
        "prefill_tps": rate(prompt, ttft),
        "decode_tps": rate(completion, decode),
        "e2e_tps": rate(completion, duration),
    }


def perf_key(namespace: str) -> str:
    return f"context_lens:{namespace}"


def _save_sample(store: SessionStore, namespace: str, sample: PerfSample) -> None:
    # The session sink queues the raw usage event before the tap sees the activity.
    index = store._event_seq.get(namespace, 0) - 1
    event = store.events.get(f"{namespace}:e{index:06d}")
    if not event or (
        event.get("type"),
        event.get("turn_index", 0),
        event.get("prompt_tokens"),
        event.get("completion_tokens"),
    ) != (
        "token_usage",
        sample["turn_index"],
        sample["prompt_tokens"],
        sample["completion_tokens"],
    ):
        return
    key = perf_key(namespace)
    previous = store.state.get(key) or []
    store.state[key] = [
        *previous[-255:],
        {
            **sample,
            "event_id": event["event_id"],
            "call_seq": previous[-1]["call_seq"] + 1 if previous else 1,
        },
    ]


class _PerfTap(BaseOutputModule):
    def __init__(self, agent: "Agent") -> None:
        super().__init__()
        self.agent = agent
        self.t_start: float | None = None
        self.t_first: float | None = None
        self.samples: deque[PerfSample] = deque(maxlen=256)
        self._sink: SessionOutput | None = None
        self._restore_codex: Callable[[], None] | None = None

    def _session_output(self) -> SessionOutput | None:
        output = self.agent.output_router.default_output
        if not isinstance(output, SessionOutput):
            output = getattr(self.agent, "_session_output", None)
        return output if isinstance(output, SessionOutput) else None

    def _stop_codex(self) -> None:
        if self._restore_codex is not None:
            self._restore_codex()
            self._restore_codex = None

    def _observe_codex(self) -> None:
        self._stop_codex()
        llm = getattr(getattr(self.agent, "controller", None), "llm", None)
        if not isinstance(llm, CodexOAuthProvider):
            return
        consume = llm._process_stream_event
        instance_handler = vars(llm).get("_process_stream_event")

        def observe(event, *args):
            if getattr(event, "type", "") in (
                "response.output_text.delta",
                "response.function_call_arguments.delta",
                "response.reasoning_summary_text.delta",
                "response.reasoning_text.delta",
            ) and getattr(event, "delta", None):
                self._first()
            return consume(event, *args)

        def restore() -> None:
            if llm._process_stream_event is not observe:
                return
            if instance_handler is None:
                del llm._process_stream_event
            else:
                llm._process_stream_event = instance_handler

        # Native Codex tool-only calls do not route their deltas through OutputRouter.
        llm._process_stream_event = observe
        self._restore_codex = restore

    async def emit(self, event: OutputEvent) -> None:
        if event.type == "assistant_round_start":
            self.t_start, self.t_first = time.monotonic(), None
            self._sink = self._session_output()
            router = self.agent.output_router
            secondary = router._secondary_outputs
            if self._sink in secondary and secondary.index(
                self._sink
            ) > secondary.index(self):
                # A reattached session sink must enqueue its raw usage before this tap.
                router.remove_secondary(self)
                router.add_secondary(self)
            self._observe_codex()
        elif event.type == "tool_args_progress":
            self._first()
        else:
            await super().emit(event)

    def _first(self) -> None:
        if self.t_start is not None and self.t_first is None:
            self.t_first = time.monotonic()

    async def write(self, content: str) -> None:
        if content:
            self._first()

    async def on_processing_end(self) -> None:
        self.t_start = None
        self._stop_codex()

    def on_activity(self, activity_type: str, detail: str) -> None:
        self.on_activity_with_metadata(activity_type, detail, {})

    def on_activity_with_metadata(
        self, activity_type: str, detail: str, metadata: Row
    ) -> None:
        if activity_type in ("reasoning", "thinking"):
            self._first()
        if activity_type != "token_usage" or self.t_start is None:
            return
        end = time.monotonic()
        start, self.t_start = self.t_start, None
        self._stop_codex()
        duration = (end - start) * 1000.0
        if duration <= 0:
            return
        ttft = (self.t_first - start) * 1000.0 if self.t_first is not None else None
        prompt = metadata.get("prompt_tokens", 0)
        completion = metadata.get("completion_tokens", 0)
        sample: PerfSample = {
            "call_seq": self.samples[-1]["call_seq"] + 1 if self.samples else 1,
            "turn_index": self.agent._turn_index,
            "ts": time.time(),
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            **metrics(
                duration, ttft if ttft and ttft > 0 else None, prompt, completion
            ),
        }
        self.samples.append(sample)
        output = self._sink
        if (
            output is not None
            and output is self._session_output()
            and output._capture_activity
            and output._store is not None
            and output._store._flush is not None
        ):
            output._submit_store_write(
                _save_sample, output._store, output._event_key_prefix, sample
            )


def ensure_perf_taps(service: LocalTerrariumService) -> None:
    for creature in service.engine.list_creatures():
        agent = creature.agent
        router = getattr(agent, "output_router", None)
        if router is not None and not hasattr(router, "_context_lens_perf"):
            tap = _PerfTap(agent)
            router.add_secondary(tap)
            router._context_lens_perf = tap


def latest_live_sample(agent: "Agent") -> PerfSample | None:
    tap = getattr(getattr(agent, "output_router", None), "_context_lens_perf", None)
    return tap.samples[-1] if isinstance(tap, _PerfTap) and tap.samples else None
