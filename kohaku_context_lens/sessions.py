import asyncio
import re
from collections.abc import Callable, Iterator
from contextlib import closing
from dataclasses import dataclass, replace
from pathlib import Path
from stat import S_ISREG
from typing import Any

from kohakuterrarium.core.compact.manager import CompactConfig
from kohakuterrarium.core.conversation.continuation import (
    branch_view_state_key,
    live_branch_path,
    normalize_branch_view,
)
from kohakuterrarium.core.token_ledger import TokenLedger, context_window
from kohakuterrarium.session.history.replay import (
    replay_conversation,
    select_live_event_ids,
)
from kohakuterrarium.session.store import SessionStore
from kohakuterrarium.session.store.events.discovery import discover_agents
from kohakuterrarium.session.vault.io import (
    key_text,
    read_prefix,
    read_values,
    scan_keys,
)
from kohakuterrarium.studio.persistence.viewer.paths import (
    normalize_session_stem,
    pick_canonical_per_session,
)
from kohakuterrarium.studio.sessions.registry import get_session_meta, get_session_store
from kohakuterrarium.terrarium import LocalTerrariumService, TerrariumService
from kohakuterrarium.terrarium.creature.host import Creature

from .anatomy import (
    Row,
    analyze_messages,
    risk_flags,
    row_value,
    signature_fragile,
    text_value,
    turn_index,
)
from .cache import cache_reading, event_kind, hit_rate, timestamp, token_counts
from .handoff import Peer, packet
from .models import (
    Analysis,
    Anatomy,
    Basis,
    CacheTurn,
    Context,
    CreatureSummary,
    CreatureTarget,
    HandoffResult,
    PerfMetrics,
    Target,
    Targets,
)
from .perf import ensure_perf_taps, latest_live_sample, metrics, perf_key


@dataclass(frozen=True, slots=True)
class Usage:
    last_prompt: int | None
    hit_rate: float | None
    events: list[dict[str, Any]]
    cache_turns: list[CacheTurn]
    llm_name: str | None
    perf: PerfMetrics


_CONTEXT_SELECTOR = re.compile(
    r"(?:@|,)context\s*=\s*([1-9][0-9]{0,8})\s*([km])(?=,|\s|$)", re.IGNORECASE
)
_NO_USAGE = Usage(None, None, [], [], None, metrics(None, None, 0, 0))
type AnalysisRow = tuple[CreatureTarget, Context, Anatomy, list[CacheTurn]]


class TargetNotFound(LookupError):
    pass


class InvalidTarget(ValueError):
    pass


class RemoteLiveUnsupported(RuntimeError):
    pass


def local_members(service: LocalTerrariumService, session_id: str) -> list[Creature]:
    try:
        graph = service.engine.get_graph(session_id)
    except KeyError as exc:
        raise TargetNotFound("Live session not found") from exc
    members = [service.engine.get_creature(cid) for cid in sorted(graph.creature_ids)]
    # Match the Studio graph's privileged-root ordering; otherwise use the first member.
    return sorted(
        members,
        key=lambda c: (
            not c.is_privileged,
            c.creature_id != "root",
            c.name != "root",
            c.creature_id,
        ),
    )


def live_target(creature: Creature, is_root: bool) -> CreatureTarget:
    agent = creature.agent
    return {
        "creature_id": creature.creature_id,
        "agent": agent.config.name,
        "is_root": is_root,
        "llm_name": agent.llm_identifier()
        or text_value(getattr(agent.llm, "model", None)),
    }


def normalized_saved_path(session_dir: Path, saved_name: str) -> Path:
    if saved_name in ("", ".", "..") or any(
        char in saved_name for char in '/\\:*?[]<>|"\x00'
    ):
        raise InvalidTarget("saved_name must be a session stem, not a path")
    for name, path in scoped_saved_paths(session_dir):
        if name == saved_name and path.is_file():
            return path
    raise TargetNotFound("Saved session not found")


def is_kohakutr(path: Path) -> bool:
    stem, separator, version = path.name.rpartition(".kohakutr.v")
    return path.suffix == ".kohakutr" or bool(
        stem and separator and version.isdecimal()
    )


def scoped_saved_paths(session_dir: Path) -> Iterator[tuple[str, Path]]:
    base = session_dir.resolve()
    for path in pick_canonical_per_session(session_dir):
        if is_kohakutr(path):
            resolved = path.resolve()
            if resolved.is_relative_to(base):
                yield normalize_session_stem(path), resolved


def saved_candidates(session_dir: Path) -> list[tuple[str, Path, float, int]]:
    candidates = []
    for name, path in scoped_saved_paths(session_dir):
        info = path.stat()
        if S_ISREG(info.st_mode):
            candidates.append((name, path, info.st_mtime, info.st_size))
    return sorted(candidates, key=lambda row: (-row[2], row[0]))[:50]


def attached_stores(service: TerrariumService) -> dict[Path, SessionStore]:
    if not isinstance(service, LocalTerrariumService):
        return {}
    stores: dict[Path, SessionStore] = {}
    for creature in service.engine.list_creatures():
        store = creature.agent.session_store
        if store is not None and not store._closed:
            stores[Path(store.path).resolve()] = store
    return stores


def read_saved[T](path: Path, reader: Callable[[SessionStore], T]) -> T:
    with closing(SessionStore.open_readonly(path)) as store:
        return reader(store)


def saved_agents(store: SessionStore) -> list[str]:
    # Avoid load_meta(): it discovers event namespaces through a flush-capable read.
    names = [
        name
        for name in (store.meta.get("agents") or [])
        if isinstance(name, str) and name
    ]
    if len(names) == 1:
        return names
    discovered = discover_agents(map(key_text, scan_keys(store.events)))
    stored = list(map(key_text, scan_keys(store.conversation)))
    members = saved_members(store)
    if not names:
        names = list(dict.fromkeys(discovered + stored))
    else:
        active = set(discovered) | members.keys()
        nonempty = [
            name
            for name in names
            if name in active
            or positive_int(store.load_token_usage(name).get("last_prompt_tokens"))
            is not None
            or (name in stored and store.load_conversation(name))
        ]
        names = nonempty or names
    order = {name: i for i, name in enumerate(names)}
    return sorted(
        names,
        key=lambda name: (
            not bool(members.get(name, {}).get("is_privileged")),
            members.get(name, {}).get("creature_id") != "root",
            name != "root",
            order[name],
        ),
    )


async def list_targets(service: TerrariumService, session_dir: Path) -> Targets:
    targets: Targets = {"live_sessions": [], "saved_sessions": []}
    if isinstance(service, LocalTerrariumService):
        ensure_perf_taps(service)
        for graph in service.engine.list_graphs():
            sid = graph.graph_id
            members = local_members(service, sid)
            if members:
                targets["live_sessions"].append(
                    {
                        "session_id": sid,
                        "label": get_session_meta(service, sid).get("name") or sid,
                        "creatures": [
                            live_target(c, i == 0) for i, c in enumerate(members)
                        ],
                    }
                )
    attached = attached_stores(service)
    for name, path, mtime, size in await asyncio.to_thread(
        saved_candidates, session_dir
    ):
        store = attached.get(path)
        agents = (
            await store.run(saved_agents, store)
            if store is not None
            else await asyncio.to_thread(
                read_saved,
                path,
                saved_agents,
            )
        )
        targets["saved_sessions"].append(
            {
                "saved_name": name,
                "updated_at": mtime,
                "size_bytes": size,
                "agents": agents,
            }
        )
    return targets


def positive_int(value: object) -> int | None:
    return value if type(value) is int and value > 0 else None


def context_override(llm_name: str | None) -> int | None:
    match = _CONTEXT_SELECTOR.search(llm_name or "")
    if match is None:
        return None
    return int(match[1]) * (1_000 if match[2].lower() == "k" else 1_000_000)


def event_rows(store: SessionStore, namespace: str) -> list[dict[str, Any]]:
    # get_events() flushes the live writer. The vault reader logs unreadable rows.
    return [
        row
        for key, row in read_prefix(
            store.events, f"{namespace}:e", what="context lens event"
        )
        if key_text(key).rsplit(":e", 1)[0] == namespace
    ]


def selected_events(
    events: list[dict[str, Any]], branch_view: dict[int, int] | None
) -> list[dict[str, Any]]:
    ids = select_live_event_ids(events, branch_view=branch_view)
    return [
        row
        for row in events
        if type(row.get("event_id")) is not int or row["event_id"] in ids
    ]


def recorded_model(events: list[dict[str, Any]]) -> str | None:
    for row in reversed(events):
        if event_kind(row) not in ("session_info", "llm_call", "token_usage"):
            continue
        fields = {**row_value(row.get("metadata")), **row}
        if name := text_value(fields.get("llm_name") or fields.get("llm")):
            return name
        if model := text_value(fields.get("model")):
            provider = text_value(fields.get("provider"))
            return f"{provider}/{model}" if provider and "/" not in model else model
    return None


def stored_branch_view(store: SessionStore, namespace: str) -> dict[int, int] | None:
    return normalize_branch_view(store.state.get(branch_view_state_key(namespace)))


def usage_for(
    store: SessionStore,
    namespace: str,
    detail: bool,
    branch_view: dict[int, int] | None,
) -> Usage:
    state = store.load_token_usage(namespace)
    rollups = store.list_turn_rollups(namespace)
    prompt, cached, _ = token_counts(rollups[-1]) if rollups else (0, 0, 0)
    ratio = hit_rate(prompt, cached)
    last_prompt = positive_int(state.get("last_prompt_tokens"))
    explicit_branch = stored_branch_view(store, namespace)
    raw_events = event_rows(store, namespace)
    events = selected_events(raw_events, explicit_branch or branch_view)
    latest_call = next(
        (row for row in reversed(events) if event_kind(row) == "token_usage"), {}
    )
    if "last_prompt_tokens" not in state:
        last_prompt = positive_int(
            latest_call.get("prompt_tokens", latest_call.get("tokens_in"))
        )
    # KT rollups share one key per turn. A newer sibling total invalidates that row on this branch.
    chosen_ids = {row.get("event_id") for row in events}
    latest_totals = {
        turn_index(row): row.get("event_id")
        for row in raw_events
        if event_kind(row) == "turn_token_usage"
    }
    comparable = [
        row
        for row in rollups
        if turn_index(row) not in latest_totals
        or latest_totals[turn_index(row)] in chosen_ids
    ]
    samples = {row["event_id"]: row for row in store.state.get(perf_key(namespace), [])}
    series, perf = cache_reading(comparable, events, samples)
    if detail or ratio is None or explicit_branch:
        if series:
            ratio = series[-1]["hit_rate"]
        else:
            prompt, cached, _ = token_counts(latest_call)
            ratio = hit_rate(prompt, cached)
    return Usage(
        last_prompt,
        ratio,
        events,
        series if detail else [],
        recorded_model(events),
        perf,
    )


def make_context(
    llm_name: str | None,
    window: int | None,
    compact_at: int | None,
    enabled: bool | None,
    usage: Usage,
) -> Context:
    return {
        "llm_name": llm_name,
        "last_prompt_tokens": usage.last_prompt,
        "max_context_tokens": window or context_override(llm_name),
        "compact_at_tokens": compact_at if enabled is not False else None,
        "compact_enabled": enabled,
        "cache_hit_rate": usage.hit_rate,
        "signature_fragile": signature_fragile(llm_name, enabled),
        "last_duration_ms": usage.perf["duration_ms"],
        "last_ttft_ms": usage.perf["ttft_ms"],
        "last_prefill_tps": usage.perf["prefill_tps"],
        "last_decode_tps": usage.perf["decode_tps"],
        "last_e2e_tps": usage.perf["e2e_tps"],
    }


def summary_for(
    target: CreatureTarget, context: Context, anatomy: Anatomy
) -> CreatureSummary:
    return {
        **context,
        "creature_id": target["creature_id"],
        "agent": target["agent"],
        "is_root": target["is_root"],
        "estimated_tokens": anatomy["estimated_tokens"],
    }


def result_for(
    target: Target,
    index: int,
    rows: list[AnalysisRow],
) -> Analysis:
    _, context, anatomy, turns = rows[index]
    return {
        "target": target,
        "creatures": [
            summary_for(creature, context, anatomy)
            for creature, context, anatomy, _ in rows
        ],
        "context": context,
        "anatomy": anatomy,
        "cache_turns": turns,
        "risk_flags": risk_flags(context, anatomy["estimated_tokens"]),
    }


async def live_row(
    service: LocalTerrariumService,
    creature: Creature,
    is_root: bool,
    selected: bool,
) -> AnalysisRow:
    agent = creature.agent
    target = live_target(creature, is_root)
    messages = agent.capture_context().messages
    window, compact_at = context_window(agent)
    config = getattr(agent.compact_manager, "config", None)
    enabled = config.enabled if config is not None else None
    # Reading the existing ledger avoids token_snapshot(), which can seed or create it.
    ledger = getattr(agent, "_token_ledger", None)
    has_live_prompt = isinstance(ledger, TokenLedger) and ledger._context_known
    live_prompt = positive_int(ledger.context_tokens) if has_live_prompt else None
    store = live_store(service, creature)
    usage = (
        await store.run(
            usage_for,
            store,
            target["agent"],
            selected,
            live_branch_path(agent),
        )
        if store is not None
        else _NO_USAGE
    )
    if not usage.events and (sample := latest_live_sample(agent)) is not None:
        usage = replace(usage, perf=sample)
    if has_live_prompt:
        usage = replace(usage, last_prompt=live_prompt)
    context = make_context(
        target["llm_name"],
        getattr(agent.llm, "_profile_max_context", None)
        or context_override(target["llm_name"])
        or window
        or None,
        compact_at or None,
        enabled,
        usage,
    )
    anatomy = await asyncio.to_thread(
        analyze_messages, messages, "live_context", usage.events, selected
    )
    return target, context, anatomy, usage.cache_turns


def live_store(
    service: LocalTerrariumService, creature: Creature
) -> SessionStore | None:
    store = creature.agent.session_store
    if store is None or store._closed:
        store = get_session_store(service, creature.graph_id)
    return store if store is not None and not store._closed else None


def select_live(
    service: TerrariumService,
    session_id: str,
    creature_id: str | None,
) -> tuple[LocalTerrariumService, list[Creature], int]:
    if not isinstance(service, LocalTerrariumService):
        raise RemoteLiveUnsupported("Live analysis requires a local creature store")
    creatures = local_members(service, session_id)
    if not creatures:
        raise TargetNotFound("Live session has no creatures")
    index = 0
    if creature_id not in (None, "", "root"):
        index = next(
            (i for i, c in enumerate(creatures) if c.creature_id == creature_id), -1
        )
        if index < 0:
            index = next(
                (i for i, c in enumerate(creatures) if c.name == creature_id), -1
            )
        if index < 0:
            raise TargetNotFound("Creature not found in this live session")
    return service, creatures, index


def live_ref(session_id: str, member: Creature) -> Target:
    return {
        "source": "live",
        "session_id": session_id,
        "creature_id": member.creature_id,
        "saved_name": None,
        "agent": member.agent.config.name,
    }


async def analyze_live(
    service: TerrariumService,
    session_id: str,
    creature_id: str | None,
) -> Analysis:
    service, creatures, index = select_live(service, session_id, creature_id)
    ensure_perf_taps(service)
    rows = await asyncio.gather(
        *(
            live_row(service, creature, i == 0, i == index)
            for i, creature in enumerate(creatures)
        )
    )
    return result_for(live_ref(session_id, creatures[index]), index, list(rows))


def saved_row(
    store: SessionStore,
    agent: str,
    member: dict[str, Any],
    is_root: bool,
    selected: bool,
) -> AnalysisRow:
    config = row_value(member.get("config_snapshot"))
    snapshot = store.load_conversation(agent)
    usage = usage_for(store, agent, selected, None)
    basis: Basis = "saved_snapshot"
    if snapshot is None:
        snapshot = replay_conversation(usage.events, include_metadata=True)
        basis = "event_replay"
    llm_name = config_model(config) or usage.llm_name
    compact = row_value(config.get("compact"))
    enabled = compact.get("enabled")
    compact_max = positive_int(compact.get("max_tokens"))
    threshold = compact.get("threshold", CompactConfig.threshold)
    compact_at = (
        int(compact_max * threshold)
        if compact_max and type(threshold) in (int, float) and 0 < threshold <= 1
        else None
    )
    context = make_context(
        llm_name, None, compact_at, enabled if type(enabled) is bool else None, usage
    )
    return (
        {
            "creature_id": text_value(member.get("creature_id")),
            "agent": agent,
            "is_root": is_root,
            "llm_name": llm_name,
        },
        context,
        analyze_messages(snapshot, basis, usage.events, selected),
        usage.cache_turns,
    )


def config_model(config: Row) -> str | None:
    model = text_value(config.get("model"))
    provider = text_value(config.get("provider"))
    return (
        text_value(config.get("llm_profile"))
        or text_value(row_value(config.get("controller")).get("llm"))
        or (f"{provider}/{model}" if provider and model and "/" not in model else model)
    )


def saved_members(store: SessionStore) -> dict[str, dict[str, Any]]:
    manifest = row_value(store.meta.get("live_graph_manifest"))
    return {
        row["name"]: row
        for row in manifest.get("creatures", [])
        if isinstance(row, dict) and "name" in row
    }


def select_saved(
    store: SessionStore, agent: str | None
) -> tuple[list[str], str, dict[str, dict[str, Any]]]:
    names = saved_agents(store)
    if not names:
        raise TargetNotFound("Saved session contains no agents")
    members = saved_members(store)
    selected = agent if agent and agent in names else None
    if selected is None and agent:
        selected = next(
            (
                name
                for name in names
                if members.get(name, {}).get("creature_id") == agent
            ),
            None,
        )
    if selected is None:
        if agent not in (None, "", "root"):
            raise TargetNotFound("Agent not found in this saved session")
        selected = names[0]
    if names[0] not in members and store.meta.get("config_type") == "agent":
        members[names[0]] = {"config_snapshot": store.meta.get("config_snapshot")}
    return names, selected, members


def saved_ref(saved_name: str, agent: str) -> Target:
    return {
        "source": "saved",
        "session_id": None,
        "creature_id": None,
        "saved_name": saved_name,
        "agent": agent,
    }


def saved_result(store: SessionStore, saved_name: str, agent: str | None) -> Analysis:
    names, selected, members = select_saved(store, agent)
    has_privileged = any(
        member.get("is_privileged") is True for member in members.values()
    )
    rows = [
        saved_row(
            store,
            name,
            member,
            bool(member.get("is_privileged")) if has_privileged else i == 0,
            name == selected,
        )
        for i, name in enumerate(names)
        for member in (members.get(name, {}),)
    ]
    populated = [
        row
        for row in rows
        if row[0]["creature_id"] is not None
        or row[1]["last_prompt_tokens"] is not None
        or row[2]["estimated_tokens"] > 0
    ]
    index = names.index(selected)
    result = result_for(saved_ref(saved_name, selected), index, rows)
    if populated:
        result["creatures"] = [
            summary_for(creature, context, anatomy)
            for creature, context, anatomy, _ in populated
        ]
    return result


async def with_saved[T](
    service: TerrariumService,
    session_dir: Path,
    saved_name: str,
    reader: Callable[[SessionStore], T],
) -> T:
    path = await asyncio.to_thread(normalized_saved_path, session_dir, saved_name)
    store = attached_stores(service).get(path)
    if store is not None:
        return await store.run(reader, store)
    return await asyncio.to_thread(read_saved, path, reader)


async def analyze_saved(
    service: TerrariumService,
    session_dir: Path,
    saved_name: str,
    agent: str | None,
) -> Analysis:
    return await with_saved(
        service,
        session_dir,
        saved_name,
        lambda store: saved_result(store, saved_name, agent),
    )


def recent_channels(store: SessionStore) -> list[tuple[str, Row]]:
    # Only decode the last eight persisted messages per channel.
    keys: dict[str, list[Any]] = {}
    for key in scan_keys(store.channels):
        channel, marker, index = key_text(key).rpartition(":m")
        if marker and index.isdecimal():
            keys.setdefault(channel, []).append(key)
    return [
        (channel, row)
        for channel, channel_keys in keys.items()
        for _, row in read_values(
            store.channels, channel_keys[-8:], what="handoff channel message"
        )
    ]


def channel_tail(rows: list[tuple[str, Row]]) -> list[tuple[str, Row]]:
    unique = {}
    for index, (channel, row) in enumerate(rows):
        unique.setdefault((channel, row.get("message_id") or index), (channel, row))
    return sorted(
        unique.values(),
        key=lambda item: timestamp(item[1].get("ts", item[1].get("timestamp"))) or 0.0,
    )[-8:]


def output_destinations(config: Row) -> list[str]:
    return [
        dest
        for item in (config.get("output_wiring") or ())
        if (dest := text_value(row_value(item).get("to"))) is not None
    ]


def manifest_wiring(manifest: Row, field: str, cid: str | None) -> list[str]:
    return [
        edge[1]
        for edge in manifest.get(field, ())
        if isinstance(edge, (list, tuple))
        and len(edge) == 2
        and edge[0] == cid
        and isinstance(edge[1], str)
    ]


def saved_handoff_source(store: SessionStore, name: str) -> Peer:
    events = handoff_events(store, name, {})
    messages = store.load_conversation(name)
    if messages is None:
        messages = replay_conversation(events, include_metadata=True)
    return name, events, messages


def saved_handoff(
    store: SessionStore, saved_name: str, agent: str | None
) -> HandoffResult:
    names, selected, members = select_saved(store, agent)
    member = members.get(selected, {})
    config = row_value(member.get("config_snapshot"))
    _, events, messages = saved_handoff_source(store, selected)
    peers = [saved_handoff_source(store, name) for name in names if name != selected]
    manifest = row_value(store.meta.get("live_graph_manifest"))
    cid = text_value(member.get("creature_id"))
    return packet(
        saved_ref(saved_name, selected),
        messages,
        events,
        channel_tail(recent_channels(store)),
        config_model(config) or recorded_model(events),
        manifest_wiring(manifest, "listen", cid),
        manifest_wiring(manifest, "send", cid) + output_destinations(config),
        peers,
    )


async def handoff_saved(
    service: TerrariumService,
    session_dir: Path,
    saved_name: str,
    agent: str | None,
) -> HandoffResult:
    return await with_saved(
        service,
        session_dir,
        saved_name,
        lambda store: saved_handoff(store, saved_name, agent),
    )


def handoff_events(
    store: SessionStore, namespace: str, branch_view: dict[int, int]
) -> list[dict[str, Any]]:
    return selected_events(
        event_rows(store, namespace),
        stored_branch_view(store, namespace) or branch_view,
    )


async def live_handoff_source(
    service: LocalTerrariumService, creature: Creature
) -> Peer:
    agent = creature.agent
    name = agent.config.name
    messages = agent.capture_context().messages
    store = live_store(service, creature)
    events = (
        await store.run(handoff_events, store, name, live_branch_path(agent))
        if store is not None
        else []
    )
    return name, events, messages


async def handoff_live(
    service: TerrariumService,
    session_id: str,
    creature_id: str | None,
) -> HandoffResult:
    local, creatures, index = select_live(service, session_id, creature_id)
    creature = creatures[index]
    agent = creature.agent
    target = live_ref(session_id, creature)
    sources = await asyncio.gather(
        *(live_handoff_source(local, member) for member in creatures)
    )
    _, events, messages = sources[index]
    peers = sources[:index] + sources[index + 1 :]
    store = live_store(local, creature)
    channels = await store.run(recent_channels, store) if store is not None else []
    graph = local.engine.get_graph(session_id)
    for name in sorted(getattr(graph, "channels", ())):
        channels.extend(
            (name, row)
            for row in await local.channel_history(session_id, name, limit=8)
        )
    listen = list(getattr(creature, "listen_channels", ()))
    send = list(getattr(creature, "send_channels", ()))
    send.extend(
        dest
        for item in getattr(agent.config, "output_wiring", ())
        if (dest := text_value(item.to))
    )
    return await asyncio.to_thread(
        packet,
        target,
        messages,
        events,
        channel_tail(channels),
        live_target(creature, index == 0)["llm_name"],
        listen,
        send,
        peers,
    )
