/**
 * Shared reactive store for kohaku-context-lens.
 *
 * Coordinates event-driven fetches across DockLensOverlay, CreatureGraphBadge,
 * InspectorTab, and SettingsView with zero setInterval polling and microtask
 * request coalescing per session for graph badges.
 */

import { effectScope, reactive, watch } from "vue"

import { DEFAULT_PREFS, extractApiError, normalizePrefs } from "./utils.js"

const PREFS_STORAGE_KEY = "preferences"
const TURN_END_DEBOUNCE_MS = 250

let activeStore = null

function buildTargetKey(query) {
  if (!query || typeof query !== "object") return ""
  if (query.session_id) {
    return `live:${query.session_id}:${query.creature_id || ""}`
  }
  if (query.saved_name) {
    return `saved:${query.saved_name}:${query.agent || ""}`
  }
  return ""
}

function buildLiveQuery(sessionId, creatureId) {
  if (!sessionId) return null
  const params = { session_id: String(sessionId) }
  if (creatureId) params.creature_id = String(creatureId)
  return params
}

function buildSavedQuery(savedName, agent) {
  if (!savedName) return null
  const params = { saved_name: String(savedName) }
  if (agent) params.agent = String(agent)
  return params
}

export function createLensStore(kt) {
  const state = reactive({
    popoverOpen: false,
    inspectorActive: false,
    followActive: true,
    pinnedTarget: null,
    work: {
      sessionId: "",
      creatureId: "",
      creatureLabel: "",
      label: "",
      busy: false,
      connected: false,
    },
    targets: {
      live_sessions: [],
      saved_sessions: [],
    },
    targetsLoading: false,
    targetsError: "",
    analysis: null,
    analysisLoading: false,
    analysisError: "",
    lastUpdatedAt: 0,
    sessionCreatures: {},
    prefs: {
      warn_pct: DEFAULT_PREFS.warn_pct,
      critical_pct: DEFAULT_PREFS.critical_pct,
      fragile_patterns: DEFAULT_PREFS.fragile_patterns,
    },
    handoff: {
      loading: false,
      error: "",
      markdown: "",
      targetKey: "",
    },
  })

  let disposed = false
  let analysisGeneration = 0
  let handoffGeneration = 0
  let lastQueryKey = ""
  let handoffRequestKey = ""
  let turnEndTimer = null
  let workScope = null
  const queuedBadgeSessions = new Set()
  const inflightBadgeSessions = new Map()

  function clearHandoffIfStale(nextKey) {
    const staleStored = state.handoff.targetKey && state.handoff.targetKey !== nextKey
    const staleInflight = handoffRequestKey && handoffRequestKey !== nextKey
    if (staleStored || staleInflight) {
      handoffGeneration += 1
      handoffRequestKey = ""
      state.handoff.loading = false
      state.handoff.markdown = ""
      state.handoff.error = ""
      state.handoff.targetKey = ""
    }
  }

  function resolveActiveQuery() {
    if (state.followActive) {
      return buildLiveQuery(state.work.sessionId, state.work.creatureId)
    }
    const pinned = state.pinnedTarget
    if (!pinned) {
      return buildLiveQuery(state.work.sessionId, state.work.creatureId)
    }
    if (pinned.source === "saved") {
      return buildSavedQuery(pinned.saved_name, pinned.agent)
    }
    return buildLiveQuery(pinned.session_id, pinned.creature_id)
  }

  async function loadPreferences() {
    if (!kt || !kt.preferences || typeof kt.preferences.get !== "function") {
      return state.prefs
    }
    try {
      const raw = await kt.preferences.get(PREFS_STORAGE_KEY, DEFAULT_PREFS)
      if (disposed) return state.prefs
      const normalized = normalizePrefs(raw)
      state.prefs.warn_pct = normalized.warn_pct
      state.prefs.critical_pct = normalized.critical_pct
      state.prefs.fragile_patterns = normalized.fragile_patterns
    } catch (err) {
      console.warn("[kohaku-context-lens] failed to load preferences", err)
    }
    return state.prefs
  }

  async function savePreferences(nextRaw) {
    const normalized = normalizePrefs(nextRaw)
    state.prefs.warn_pct = normalized.warn_pct
    state.prefs.critical_pct = normalized.critical_pct
    state.prefs.fragile_patterns = normalized.fragile_patterns
    if (kt && kt.preferences && typeof kt.preferences.set === "function") {
      await kt.preferences.set(PREFS_STORAGE_KEY, normalized)
    }
    return normalized
  }

  async function resetPreferences() {
    const defaults = normalizePrefs(DEFAULT_PREFS)
    state.prefs.warn_pct = defaults.warn_pct
    state.prefs.critical_pct = defaults.critical_pct
    state.prefs.fragile_patterns = defaults.fragile_patterns
    if (kt && kt.preferences && typeof kt.preferences.remove === "function") {
      await kt.preferences.remove(PREFS_STORAGE_KEY)
    } else if (kt && kt.preferences && typeof kt.preferences.set === "function") {
      await kt.preferences.set(PREFS_STORAGE_KEY, defaults)
    }
    return defaults
  }

  async function fetchTargets() {
    if (disposed || !kt || !kt.api) return null
    state.targetsLoading = true
    state.targetsError = ""
    try {
      const resp = await kt.api.get("/targets", undefined)
      if (disposed) return null
      const data = resp && resp.data ? resp.data : {}
      state.targets.live_sessions = Array.isArray(data.live_sessions) ? data.live_sessions : []
      state.targets.saved_sessions = Array.isArray(data.saved_sessions) ? data.saved_sessions : []
      return state.targets
    } catch (err) {
      if (!disposed) {
        state.targetsError = extractApiError(err)
      }
      return null
    } finally {
      if (!disposed) state.targetsLoading = false
    }
  }

  async function fetchAnalysis(query) {
    if (disposed || !kt || !kt.api) return null
    if (!query) {
      lastQueryKey = ""
      state.analysis = null
      state.analysisError = ""
      state.analysisLoading = false
      clearHandoffIfStale("")
      return null
    }

    const mine = ++analysisGeneration
    const targetKey = buildTargetKey(query)
    if (lastQueryKey && lastQueryKey !== targetKey) {
      state.analysis = null
    }
    lastQueryKey = targetKey
    clearHandoffIfStale(targetKey)
    state.analysisLoading = true
    state.analysisError = ""

    try {
      const resp = await kt.api.get("/analysis", { params: query })
      if (disposed || mine !== analysisGeneration) return null
      const data = resp && resp.data ? resp.data : null
      state.analysis = data
      state.lastUpdatedAt = Date.now()
      if (data && data.target && data.target.source === "live" && data.target.session_id) {
        state.sessionCreatures[data.target.session_id] = Array.isArray(data.creatures)
          ? data.creatures
          : []
      }
      return data
    } catch (err) {
      if (!disposed && mine === analysisGeneration) {
        state.analysisError = extractApiError(err)
      }
      return null
    } finally {
      if (!disposed && mine === analysisGeneration) {
        state.analysisLoading = false
      }
    }
  }

  async function runSessionSummaryFetch(sessionId) {
    if (disposed || !kt || !kt.api || !sessionId) return null
    try {
      const resp = await kt.api.get("/analysis", { params: { session_id: String(sessionId) } })
      if (disposed) return null
      const data = resp && resp.data ? resp.data : null
      if (data && Array.isArray(data.creatures)) {
        state.sessionCreatures[sessionId] = data.creatures
      }
      return data
    } catch (_err) {
      return null
    } finally {
      inflightBadgeSessions.delete(sessionId)
    }
  }

  function requestSessionSummary(sessionId) {
    const sid = String(sessionId || "").trim()
    if (disposed || !sid) return Promise.resolve(null)
    if (inflightBadgeSessions.has(sid)) {
      return inflightBadgeSessions.get(sid)
    }
    if (queuedBadgeSessions.has(sid)) {
      return Promise.resolve(null)
    }
    queuedBadgeSessions.add(sid)
    return new Promise((resolve) => {
      queueMicrotask(() => {
        queuedBadgeSessions.delete(sid)
        if (disposed) {
          resolve(null)
          return
        }
        if (inflightBadgeSessions.has(sid)) {
          inflightBadgeSessions.get(sid).then(resolve)
          return
        }
        const promise = runSessionSummaryFetch(sid)
        inflightBadgeSessions.set(sid, promise)
        promise.then(resolve)
      })
    })
  }

  async function fetchHandoff(query) {
    if (disposed || !kt || !kt.api) return null
    const resolved = query || resolveActiveQuery()
    if (!resolved) {
      state.handoff.error = "No session selected for handoff extraction."
      return null
    }
    const mine = ++handoffGeneration
    const targetKey = buildTargetKey(resolved)
    handoffRequestKey = targetKey
    state.handoff.loading = true
    state.handoff.error = ""
    try {
      const resp = await kt.api.get("/handoff", { params: resolved })
      if (disposed || mine !== handoffGeneration) return null
      const data = resp && resp.data ? resp.data : {}
      state.handoff.markdown = typeof data.markdown === "string" ? data.markdown : ""
      state.handoff.targetKey = targetKey
      return state.handoff.markdown
    } catch (err) {
      if (!disposed && mine === handoffGeneration) {
        state.handoff.error = extractApiError(err)
      }
      return null
    } finally {
      if (!disposed && mine === handoffGeneration) {
        handoffRequestKey = ""
        state.handoff.loading = false
      }
    }
  }

  async function refreshActive() {
    const query = resolveActiveQuery()
    const tasks = [fetchAnalysis(query)]
    if (state.inspectorActive) {
      tasks.push(fetchTargets())
    }
    await Promise.all(tasks)
  }

  function selectLiveTarget(sessionId, creatureId, follow) {
    const sid = String(sessionId || "").trim()
    const cid = creatureId ? String(creatureId) : null
    state.followActive = Boolean(follow)
    state.pinnedTarget = sid
      ? {
          source: "live",
          session_id: sid,
          creature_id: cid,
          saved_name: null,
          agent: null,
        }
      : null
    return fetchAnalysis(buildLiveQuery(sid, cid))
  }

  function selectSavedTarget(savedName, agent) {
    const name = String(savedName || "").trim()
    const agentName = agent ? String(agent) : null
    state.followActive = false
    state.pinnedTarget = name
      ? {
          source: "saved",
          session_id: null,
          creature_id: null,
          saved_name: name,
          agent: agentName,
        }
      : null
    return fetchAnalysis(buildSavedQuery(name, agentName))
  }

  function setFollowActive(enabled) {
    state.followActive = Boolean(enabled)
    if (state.followActive) {
      state.pinnedTarget = null
      return fetchAnalysis(buildLiveQuery(state.work.sessionId, state.work.creatureId))
    }
    const current = state.analysis && state.analysis.target ? state.analysis.target : null
    if (current) {
      state.pinnedTarget = {
        source: current.source,
        session_id: current.session_id || null,
        creature_id: current.creature_id || null,
        saved_name: current.saved_name || null,
        agent: current.agent || null,
      }
    }
    return Promise.resolve(state.analysis)
  }

  function openPopover() {
    state.popoverOpen = true
    void fetchAnalysis(resolveActiveQuery())
  }

  function closePopover() {
    state.popoverOpen = false
  }

  function togglePopover() {
    if (state.popoverOpen) {
      closePopover()
    } else {
      openPopover()
    }
  }

  function openInspectorForCurrent(autoGenerateHandoff) {
    state.popoverOpen = false
    if (kt && typeof kt.openTab === "function") {
      kt.openTab("inspector")
    }
    const query = resolveActiveQuery()
    if (query) {
      void fetchAnalysis(query)
      if (autoGenerateHandoff) {
        void fetchHandoff(query)
      }
    }
  }

  function pinAndOpenInspector(sessionId, creatureId) {
    state.popoverOpen = false
    const sid = String(sessionId || "").trim()
    const cid = creatureId ? String(creatureId) : null
    if (sid) {
      const matchesActive =
        state.work.sessionId === sid && (!cid || state.work.creatureId === cid)
      state.followActive = matchesActive
      state.pinnedTarget = matchesActive
        ? null
        : {
            source: "live",
            session_id: sid,
            creature_id: cid,
            saved_name: null,
            agent: null,
          }
      void fetchAnalysis(buildLiveQuery(sid, cid))
    }
    if (kt && typeof kt.openTab === "function") {
      kt.openTab("inspector")
    }
  }

  function bindWorkContext(workRef) {
    if (workScope) {
      workScope.stop()
      workScope = null
    }
    workScope = effectScope(true)
    workScope.run(() => {
      watch(
        () => {
          const val = workRef ? workRef.value : null
          return {
            sessionId: val && val.sessionId ? String(val.sessionId) : "",
            creatureId: val && val.creatureId ? String(val.creatureId) : "",
            creatureLabel: val && val.creatureLabel ? String(val.creatureLabel) : "",
            label: val && val.label ? String(val.label) : "",
            busy: Boolean(val && val.busy),
            connected: Boolean(val && val.connected),
          }
        },
        (next, prev) => {
          if (disposed) return
          state.work.sessionId = next.sessionId
          state.work.creatureId = next.creatureId
          state.work.creatureLabel = next.creatureLabel
          state.work.label = next.label
          state.work.busy = next.busy
          state.work.connected = next.connected

          const targetChanged =
            !prev ||
            prev.sessionId !== next.sessionId ||
            prev.creatureId !== next.creatureId

          if (targetChanged && state.followActive) {
            void fetchAnalysis(buildLiveQuery(next.sessionId, next.creatureId))
          }

          if (prev && prev.busy && !next.busy && next.sessionId) {
            if (turnEndTimer !== null) {
              clearTimeout(turnEndTimer)
            }
            turnEndTimer = setTimeout(() => {
              turnEndTimer = null
              if (disposed) return
              if (state.followActive || (state.pinnedTarget && state.pinnedTarget.session_id === next.sessionId)) {
                void fetchAnalysis(resolveActiveQuery())
              } else if (state.sessionCreatures[next.sessionId]) {
                void requestSessionSummary(next.sessionId)
              }
            }, TURN_END_DEBOUNCE_MS)
          }
        },
        { immediate: true },
      )
    })
  }

  function dispose() {
    disposed = true
    if (turnEndTimer !== null) {
      clearTimeout(turnEndTimer)
      turnEndTimer = null
    }
    if (workScope) {
      workScope.stop()
      workScope = null
    }
    queuedBadgeSessions.clear()
    inflightBadgeSessions.clear()
  }

  void loadPreferences()

  return {
    kt,
    state,
    resolveActiveQuery,
    buildTargetKey,
    loadPreferences,
    savePreferences,
    resetPreferences,
    fetchTargets,
    fetchAnalysis,
    requestSessionSummary,
    fetchHandoff,
    refreshActive,
    selectLiveTarget,
    selectSavedTarget,
    setFollowActive,
    openPopover,
    closePopover,
    togglePopover,
    openInspectorForCurrent,
    pinAndOpenInspector,
    bindWorkContext,
    dispose,
  }
}

export function initLensStore(kt) {
  if (activeStore) {
    activeStore.dispose()
  }
  activeStore = createLensStore(kt)
  return activeStore
}

export function getLensStore() {
  return activeStore
}

export function disposeLensStore(kt) {
  if (!activeStore) return
  if (kt && activeStore.kt !== kt) return
  activeStore.dispose()
  activeStore = null
}
