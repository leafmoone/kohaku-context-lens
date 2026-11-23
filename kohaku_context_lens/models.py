from typing import Literal, TypedDict


class CreatureTarget(TypedDict):
    creature_id: str | None
    agent: str
    is_root: bool
    llm_name: str | None


class LiveSession(TypedDict):
    session_id: str
    label: str
    creatures: list[CreatureTarget]


class SavedSession(TypedDict):
    saved_name: str
    updated_at: float
    size_bytes: int
    agents: list[str]


class Targets(TypedDict):
    live_sessions: list[LiveSession]
    saved_sessions: list[SavedSession]


class Target(TypedDict):
    source: Literal["live", "saved"]
    session_id: str | None
    creature_id: str | None
    saved_name: str | None
    agent: str


class Context(TypedDict):
    llm_name: str | None
    last_prompt_tokens: int | None
    max_context_tokens: int | None
    compact_at_tokens: int | None
    compact_enabled: bool | None
    cache_hit_rate: float | None
    signature_fragile: bool


class CreatureSummary(Context):
    creature_id: str | None
    agent: str
    is_root: bool
    estimated_tokens: int


Bucket = Literal[
    "system_prompt",
    "rules_memory",
    "skills_tools",
    "tool_outputs",
    "chat_channels",
    "reasoning_compaction",
]


class Buckets(TypedDict):
    system_prompt: int
    rules_memory: int
    skills_tools: int
    tool_outputs: int
    chat_channels: int
    reasoning_compaction: int


class ToolOutput(TypedDict):
    tool_name: str | None
    turn_index: int | None
    call_id: str | None
    target_path: str | None
    preview: str
    estimated_tokens: int
    share: float


Basis = Literal["live_context", "saved_snapshot", "event_replay"]


class Anatomy(TypedDict):
    basis: Basis
    message_count: int
    estimated_tokens: int
    buckets: Buckets
    top_tool_outputs: list[ToolOutput]


DropReason = Literal[
    "compaction", "system_change", "tool_schema_change", "idle_gap", "unknown"
]


class CacheDrop(TypedDict):
    delta: float
    reason: DropReason
    event_id: int | None


class CacheTurn(TypedDict):
    turn_index: int
    prompt_tokens: int
    cached_tokens: int
    completion_tokens: int
    hit_rate: float | None
    drop: CacheDrop | None


RiskFlag = Literal["near_compaction", "near_context_window", "signature_chain"]


class Analysis(TypedDict):
    target: Target
    creatures: list[CreatureSummary]
    context: Context
    anatomy: Anatomy
    cache_turns: list[CacheTurn]
    risk_flags: list[RiskFlag]


class HandoffResult(TypedDict):
    target: Target
    markdown: str
