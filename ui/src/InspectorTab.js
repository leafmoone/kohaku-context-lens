/**
 * Full-page Context Lens analytical tab.
 *
 * Displays live/saved session selection, watermark KPI cards, 6-dimension
 * context breakdown, turn-by-turn KV cache telemetry & drop forensics,
 * Top 10 bloated tool outputs, compaction risk advisory, and 1-click
 * lossless Markdown handoff extraction.
 */

import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { notify, useLocale, useWorkContext } from "@kohakuterrarium/ui-sdk"

import { translateLensText } from "./i18n.js"
import { getLensStore } from "./store.js"
import {
  buildBucketEntries,
  evaluateWatermarkStatus,
  formatPct,
  formatTokens,
} from "./utils.js"

const CHART_W = 760
const CHART_H = 220
const CHART_PAD = { left: 54, right: 48, top: 16, bottom: 30 }

function sanitizeFilenameSegment(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return cleaned || "session"
}

async function copyTextToClipboard(text) {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_err) {
      // Fall through to legacy selection copy in restricted desktop WebViews.
    }
  }
  if (typeof document === "undefined" || !document.body) return false
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "readonly")
  area.style.position = "fixed"
  area.style.left = "-9999px"
  area.style.top = "-9999px"
  document.body.appendChild(area)
  area.select()
  let copied = false
  try {
    copied = Boolean(document.execCommand && document.execCommand("copy"))
  } catch (_err) {
    copied = false
  } finally {
    document.body.removeChild(area)
  }
  return copied
}

function triggerMarkdownDownload(filename, markdown) {
  if (typeof document === "undefined" || typeof URL === "undefined") return false
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}

function buildLinePaths(points) {
  const paths = []
  let current = []
  for (const pt of points) {
    if (pt === null) {
      if (current.length > 1) paths.push(current.join(" "))
      current = []
    } else {
      current.push(`${current.length === 0 ? "M" : "L"}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`)
    }
  }
  if (current.length > 1) paths.push(current.join(" "))
  return paths
}

export const InspectorTab = defineComponent({
  name: "KclInspectorTab",
  setup() {
    const store = getLensStore()
    const locale = useLocale()
    const localWork = useWorkContext({ retainLast: true })

    const tr = (key, params) => translateLensText(locale.value, key, params)

    const browseSource = ref("live")
    const hoveredTurnIndex = ref(null)
    const sessionSelectEl = ref(null)
    const creatureSelectEl = ref(null)

    watch(
      () => {
        const analysisSource =
          store && store.state.analysis && store.state.analysis.target
            ? store.state.analysis.target.source
            : null
        const pinnedSource =
          store && store.state.pinnedTarget ? store.state.pinnedTarget.source : null
        return analysisSource || pinnedSource || "live"
      },
      (source) => {
        if (source === "live" || source === "saved") {
          browseSource.value = source
        }
      },
      { immediate: true },
    )

    watch(
      localWork,
      (val) => {
        if (!store || !val || !val.sessionId) return
        if (!store.state.work.sessionId && store.state.followActive && !store.state.analysis) {
          const query = { session_id: String(val.sessionId) }
          if (val.creatureId) query.creature_id = String(val.creatureId)
          void store.fetchAnalysis(query)
        }
      },
      { immediate: true },
    )

    onMounted(() => {
      if (!store) return
      store.state.inspectorActive = true
      void store.fetchTargets()
      const query = store.resolveActiveQuery()
      if (query && !store.state.analysis) {
        void store.fetchAnalysis(query)
      }
    })

    onBeforeUnmount(() => {
      if (store) {
        store.state.inspectorActive = false
      }
    })

    const analysis = computed(() => (store ? store.state.analysis : null))

    const watermark = computed(() => {
      if (!store || !analysis.value) {
        return evaluateWatermarkStatus(null, null, [], store ? store.state.prefs : null)
      }
      return evaluateWatermarkStatus(
        analysis.value.context,
        analysis.value.anatomy,
        analysis.value.risk_flags,
        store.state.prefs,
      )
    })

    const bucketEntries = computed(() => {
      const anatomy = analysis.value ? analysis.value.anatomy : null
      if (!anatomy) return []
      return buildBucketEntries(anatomy.buckets, anatomy.estimated_tokens)
    })

    const liveSessions = computed(() =>
      store && Array.isArray(store.state.targets.live_sessions)
        ? store.state.targets.live_sessions
        : [],
    )

    const savedSessions = computed(() =>
      store && Array.isArray(store.state.targets.saved_sessions)
        ? store.state.targets.saved_sessions
        : [],
    )

    const selectedLiveSessionId = computed(() => {
      const pinned = store && !store.state.followActive ? store.state.pinnedTarget : null
      if (pinned) {
        return pinned.source === "live" ? pinned.session_id || "" : ""
      }
      const target = analysis.value ? analysis.value.target : null
      if (target && target.source === "live" && target.session_id) {
        return target.session_id
      }
      return ""
    })

    const selectedSavedName = computed(() => {
      const pinned = store && !store.state.followActive ? store.state.pinnedTarget : null
      if (pinned) {
        return pinned.source === "saved" ? pinned.saved_name || "" : ""
      }
      const target = analysis.value ? analysis.value.target : null
      if (target && target.source === "saved" && target.saved_name) {
        return target.saved_name
      }
      return ""
    })

    const creatureOptions = computed(() => {
      if (browseSource.value === "live") {
        const sid = selectedLiveSessionId.value
        if (!sid) return []
        const target = analysis.value ? analysis.value.target : null
        if (
          target &&
          target.source === "live" &&
          target.session_id === sid &&
          Array.isArray(analysis.value.creatures) &&
          analysis.value.creatures.length > 0
        ) {
          return analysis.value.creatures.map((c) => ({
            value: c.creature_id || c.agent,
            label: c.is_root ? `${c.agent} (root)` : c.agent,
          }))
        }
        const liveMatch = liveSessions.value.find((s) => s.session_id === sid)
        if (liveMatch && Array.isArray(liveMatch.creatures)) {
          return liveMatch.creatures.map((c) => ({
            value: c.creature_id || c.agent,
            label: c.is_root ? `${c.agent} (root)` : c.agent,
          }))
        }
        return []
      }

      const savedName = selectedSavedName.value
      if (!savedName) return []
      const savedMatch = savedSessions.value.find((s) => s.saved_name === savedName)
      if (savedMatch && Array.isArray(savedMatch.agents) && savedMatch.agents.length > 0) {
        return savedMatch.agents.map((name) => ({ value: name, label: name }))
      }
      const target = analysis.value ? analysis.value.target : null
      if (
        target &&
        target.source === "saved" &&
        target.saved_name === savedName &&
        Array.isArray(analysis.value.creatures)
      ) {
        return analysis.value.creatures.map((c) => ({ value: c.agent, label: c.agent }))
      }
      return []
    })

    const selectedCreatureValue = computed(() => {
      const pinned = store && !store.state.followActive ? store.state.pinnedTarget : null
      if (pinned) {
        if (pinned.source !== browseSource.value) return ""
        if (pinned.source === "live" && pinned.creature_id) return pinned.creature_id
        if (pinned.source === "saved" && pinned.agent) return pinned.agent
      }
      const target = analysis.value ? analysis.value.target : null
      if (!target || target.source !== browseSource.value) return ""
      if (browseSource.value === "live") {
        return target.creature_id || target.agent || ""
      }
      return target.agent || ""
    })

    watch(
      () => [
        browseSource.value,
        selectedLiveSessionId.value,
        selectedSavedName.value,
        liveSessions.value.length,
        savedSessions.value.length,
        selectedCreatureValue.value,
        creatureOptions.value.length,
      ],
      () => {
        const expectedSession =
          browseSource.value === "live" ? selectedLiveSessionId.value : selectedSavedName.value
        if (sessionSelectEl.value && sessionSelectEl.value.value !== expectedSession) {
          sessionSelectEl.value.value = expectedSession
        }
        if (creatureSelectEl.value && creatureSelectEl.value.value !== selectedCreatureValue.value) {
          creatureSelectEl.value.value = selectedCreatureValue.value
        }
      },
      { flush: "post" },
    )

    const cacheTurns = computed(() =>
      analysis.value && Array.isArray(analysis.value.cache_turns)
        ? analysis.value.cache_turns
        : [],
    )

    const dropTurns = computed(() => cacheTurns.value.filter((turn) => Boolean(turn.drop)))

    const activeTurnDetail = computed(() => {
      if (!cacheTurns.value.length) return null
      if (hoveredTurnIndex.value !== null) {
        const matched = cacheTurns.value.find(
          (turn) => turn.turn_index === hoveredTurnIndex.value,
        )
        if (matched) return matched
      }
      return cacheTurns.value[cacheTurns.value.length - 1]
    })

    const topToolOutputs = computed(() => {
      const anatomy = analysis.value ? analysis.value.anatomy : null
      return anatomy && Array.isArray(anatomy.top_tool_outputs) ? anatomy.top_tool_outputs : []
    })

    function onSessionSelectChange(event) {
      if (!store || !event || !event.target) return
      const val = String(event.target.value || "").trim()
      if (!val) return
      if (browseSource.value === "live") {
        const matchesWork = store.state.work.sessionId === val
        void store.selectLiveTarget(val, null, matchesWork)
      } else {
        void store.selectSavedTarget(val, null)
      }
    }

    function onCreatureSelectChange(event) {
      if (!store || !event || !event.target) return
      const val = String(event.target.value || "").trim()
      if (!val) return
      if (browseSource.value === "live") {
        const sid = selectedLiveSessionId.value
        if (!sid) return
        const matchesWork = Boolean(
          store.state.work.sessionId === sid &&
            store.state.work.creatureId &&
            store.state.work.creatureId === val,
        )
        void store.selectLiveTarget(sid, val, matchesWork)
      } else {
        const savedName = selectedSavedName.value
        if (!savedName) return
        void store.selectSavedTarget(savedName, val)
      }
    }

    async function handleCopyHandoff() {
      if (!store || !store.state.handoff.markdown) return
      const ok = await copyTextToClipboard(store.state.handoff.markdown)
      notify(
        tr(ok ? "inspector.handoff.copied" : "inspector.handoff.copyFailed", null),
        ok ? "success" : "error",
      )
    }

    function handleDownloadHandoff() {
      if (!store || !store.state.handoff.markdown) return
      const target = analysis.value ? analysis.value.target : null
      const slug = sanitizeFilenameSegment(
        (target && (target.saved_name || target.agent || target.session_id)) || "session",
      )
      const ok = triggerMarkdownDownload(
        `context-handoff-${slug}.md`,
        store.state.handoff.markdown,
      )
      if (ok) {
        notify(tr("inspector.handoff.downloaded", null), "success")
      }
    }

    function renderRiskBanner() {
      const wm = watermark.value
      if (!wm.flags.length) return null
      return h(
        "div",
        {
          class: [
            "kcl-risk-banner",
            wm.tone === "critical" ? "kcl-tone-critical" : "kcl-tone-warn",
          ],
          role: "status",
          "data-test": "kcl-inspector-risk",
        },
        [
          h("div", { class: "kcl-risk-banner__head" }, [
            h("span", null, tr("risk.title", null)),
            ...wm.flags.map((flag) =>
              h("span", { class: "kcl-risk-pill" }, tr(`risk.badge.${flag}`, null)),
            ),
          ]),
          h(
            "ul",
            { class: "kcl-risk-list" },
            wm.flags.map((flag) =>
              h("li", null, tr(`risk.${flag}`, { pct: formatPct(wm.usageRatio) })),
            ),
          ),
        ],
      )
    }

    function renderKpiCards() {
      const data = analysis.value
      const wm = watermark.value
      const context = data ? data.context : null
      const anatomy = data ? data.anatomy : null
      const basisKey = anatomy && anatomy.basis ? anatomy.basis : "unknown"
      const basisLabel = tr(`inspector.basis.${basisKey}`, null)

      const limitCaption =
        wm.limitKind === "compact" && wm.limit !== null
          ? tr("popover.limitCompact", { limit: formatTokens(wm.limit) })
          : wm.limitKind === "window" && wm.limit !== null
            ? tr("popover.limitWindow", { limit: formatTokens(wm.limit) })
            : tr("popover.limitNone", null)

      const meterPct =
        wm.usageRatio !== null
          ? `${Math.min(100, Math.max(0, wm.usageRatio * 100)).toFixed(1)}%`
          : "0%"

      const exactCount =
        typeof wm.effectiveTokens === "number" && Number.isFinite(wm.effectiveTokens)
          ? `${Math.round(wm.effectiveTokens).toLocaleString()} tok`
          : ""

      return h("div", { class: "kcl-kpi-grid" }, [
        h("div", { class: "kcl-kpi-card" }, [
          h("div", { class: "kcl-kpi-card__label" }, tr("inspector.kpi.tokens", null)),
          h("div", { class: "kcl-kpi-card__value kcl-mono" }, formatTokens(wm.effectiveTokens)),
          h(
            "div",
            { class: "kcl-kpi-card__sub" },
            exactCount ? `${basisLabel} · ${exactCount}` : basisLabel,
          ),
        ]),
        h("div", { class: "kcl-kpi-card" }, [
          h("div", { class: "kcl-kpi-card__label" }, tr("inspector.kpi.budget", null)),
          h(
            "div",
            { class: "kcl-kpi-card__value kcl-mono" },
            wm.limit !== null
              ? `${formatPct(wm.usageRatio)} / ${formatTokens(wm.limit)}`
              : tr("popover.limitNone", null),
          ),
          h("div", { class: "kcl-kpi-card__sub" }, limitCaption),
          h("div", { class: "kcl-meter" }, [
            h("div", {
              class: ["kcl-meter__fill", `kcl-tone-${wm.tone}`],
              style: { width: meterPct },
            }),
          ]),
        ]),
        h("div", { class: "kcl-kpi-card" }, [
          h("div", { class: "kcl-kpi-card__label" }, tr("inspector.kpi.cache", null)),
          h(
            "div",
            { class: "kcl-kpi-card__value kcl-mono" },
            formatPct(context ? context.cache_hit_rate : null),
          ),
          h(
            "div",
            { class: "kcl-kpi-card__sub" },
            dropTurns.value.length > 0
              ? `${dropTurns.value.length} ${tr("inspector.chart.dropLegend", null)}`
              : tr("inspector.drop.none", null),
          ),
        ]),
        h("div", { class: "kcl-kpi-card" }, [
          h("div", { class: "kcl-kpi-card__label" }, tr("inspector.kpi.model", null)),
          h(
            "div",
            {
              class: "kcl-kpi-card__value kcl-mono",
              title: (context && context.llm_name) || "",
            },
            (context && context.llm_name) || "--",
          ),
          h(
            "div",
            { class: "kcl-kpi-card__sub" },
            tr("inspector.kpi.messages", { count: anatomy ? anatomy.message_count : 0 }),
          ),
        ]),
      ])
    }

    function renderAnatomySection() {
      return h("section", { class: "kcl-card", "data-test": "kcl-section-anatomy" }, [
        h("div", { class: "kcl-card__head" }, [
          h("div", null, [
            h("h3", { class: "kcl-card__title" }, tr("inspector.section.anatomy", null)),
            h("p", { class: "kcl-card__hint" }, tr("inspector.section.anatomyHint", null)),
          ]),
        ]),
        h(
          "div",
          { class: "kcl-stacked-bar" },
          bucketEntries.value.map((entry, idx) =>
            entry.tokens > 0
              ? h("div", {
                  key: entry.key,
                  class: ["kcl-stacked-seg", `kcl-bucket-color-${idx}`],
                  style: { width: `${(entry.share * 100).toFixed(2)}%` },
                  title: `${tr(`bucket.${entry.key}`, null)}: ${formatTokens(entry.tokens)} (${entry.pctText})`,
                })
              : null,
          ),
        ),
        h("div", { class: "kcl-table-wrap" }, [
          h("table", { class: "kcl-table" }, [
            h("thead", null, [
              h("tr", null, [
                h("th", null, tr("inspector.table.bucket", null)),
                h("th", { class: "is-num" }, tr("inspector.table.tokens", null)),
                h("th", { class: "is-num" }, tr("inspector.table.share", null)),
              ]),
            ]),
            h(
              "tbody",
              null,
              bucketEntries.value.map((entry, idx) =>
                h("tr", { key: entry.key }, [
                  h("td", null, [
                    h("span", { class: "kcl-bucket-item__name" }, [
                      h("span", { class: ["kcl-swatch", `kcl-bucket-color-${idx}`] }),
                      h("span", null, tr(`bucket.${entry.key}`, null)),
                    ]),
                  ]),
                  h(
                    "td",
                    { class: "is-num kcl-mono" },
                    `${entry.tokens.toLocaleString()} (${formatTokens(entry.tokens)})`,
                  ),
                  h("td", { class: "is-num kcl-mono" }, entry.pctText),
                ]),
              ),
            ),
          ]),
        ]),
      ])
    }

    function renderCacheChart() {
      const turns = cacheTurns.value
      const plotW = CHART_W - CHART_PAD.left - CHART_PAD.right
      const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom
      const maxPrompt = Math.max(
        1,
        ...turns.map((turn) => (typeof turn.prompt_tokens === "number" ? turn.prompt_tokens : 0)),
      )
      const step = plotW / turns.length
      const barW = Math.min(28, Math.max(4, step * 0.56))
      const labelStride = Math.max(1, Math.ceil(turns.length / 12))
      const ticks = [0, 0.25, 0.5, 0.75, 1]

      const gridNodes = ticks.flatMap((tick) => {
        const y = CHART_PAD.top + plotH - tick * plotH
        return [
          h("line", {
            x1: String(CHART_PAD.left),
            y1: y.toFixed(1),
            x2: String(CHART_W - CHART_PAD.right),
            y2: y.toFixed(1),
            stroke: "var(--kcl-border)",
            "stroke-dasharray": tick === 0 ? undefined : "3 3",
            "stroke-width": "1",
          }),
          h(
            "text",
            {
              x: String(CHART_PAD.left - 6),
              y: (y + 3).toFixed(1),
              "text-anchor": "end",
              fill: "var(--kcl-text-muted)",
              "font-size": "10",
              "font-family": "var(--font-mono, monospace)",
            },
            formatTokens(Math.round(maxPrompt * tick)),
          ),
          h(
            "text",
            {
              x: String(CHART_W - CHART_PAD.right + 6),
              y: (y + 3).toFixed(1),
              "text-anchor": "start",
              fill: "var(--kcl-text-muted)",
              "font-size": "10",
              "font-family": "var(--font-mono, monospace)",
            },
            `${Math.round(tick * 100)}%`,
          ),
        ]
      })

      const hitPoints = []
      const barNodes = []
      const dotNodes = []
      const hitBandNodes = []
      const xLabels = []

      turns.forEach((turn, idx) => {
        const cx = CHART_PAD.left + step * (idx + 0.5)
        const promptVal = typeof turn.prompt_tokens === "number" ? turn.prompt_tokens : 0
        const cachedVal = typeof turn.cached_tokens === "number" ? turn.cached_tokens : 0
        const barH = Math.max(0, (promptVal / maxPrompt) * plotH)
        const cachedRatio = promptVal > 0 ? Math.min(1, Math.max(0, cachedVal / promptVal)) : 0
        const cachedH = barH * cachedRatio
        const x = cx - barW / 2
        const yPrompt = CHART_PAD.top + plotH - barH
        const yCached = CHART_PAD.top + plotH - cachedH
        const isHovered =
          activeTurnDetail.value && activeTurnDetail.value.turn_index === turn.turn_index

        barNodes.push(
          h("rect", {
            x: x.toFixed(1),
            y: yPrompt.toFixed(1),
            width: barW.toFixed(1),
            height: barH.toFixed(1),
            rx: "2",
            fill: "var(--kcl-accent)",
            "fill-opacity": isHovered ? "0.42" : "0.24",
          }),
        )

        if (cachedH > 0) {
          barNodes.push(
            h("rect", {
              x: x.toFixed(1),
              y: yCached.toFixed(1),
              width: barW.toFixed(1),
              height: cachedH.toFixed(1),
              rx: "2",
              fill: "var(--kcl-b4)",
              "fill-opacity": isHovered ? "0.65" : "0.45",
            }),
          )
        }

        if (typeof turn.hit_rate === "number" && Number.isFinite(turn.hit_rate)) {
          const clampedRate = Math.min(1, Math.max(0, turn.hit_rate))
          const py = CHART_PAD.top + plotH - clampedRate * plotH
          hitPoints.push({ x: cx, y: py })

          if (turn.drop) {
            dotNodes.push(
              h("circle", {
                cx: cx.toFixed(1),
                cy: py.toFixed(1),
                r: "6",
                fill: "var(--kcl-surface)",
                stroke: "var(--kcl-critical-accent)",
                "stroke-width": "2",
              }),
              h("circle", {
                cx: cx.toFixed(1),
                cy: py.toFixed(1),
                r: "2.6",
                fill: "var(--kcl-critical-accent)",
              }),
            )
          } else {
            dotNodes.push(
              h("circle", {
                cx: cx.toFixed(1),
                cy: py.toFixed(1),
                r: isHovered ? "4.2" : "3",
                fill: "var(--kcl-ok-accent)",
              }),
            )
          }
        } else {
          hitPoints.push(null)
        }

        if (idx % labelStride === 0 || idx === turns.length - 1) {
          xLabels.push(
            h(
              "text",
              {
                x: cx.toFixed(1),
                y: String(CHART_H - 8),
                "text-anchor": "middle",
                fill: "var(--kcl-text-muted)",
                "font-size": "10",
                "font-family": "var(--font-mono, monospace)",
              },
              `#${turn.turn_index}`,
            ),
          )
        }

        hitBandNodes.push(
          h("rect", {
            x: (CHART_PAD.left + step * idx).toFixed(1),
            y: String(CHART_PAD.top),
            width: step.toFixed(1),
            height: String(plotH),
            fill: "transparent",
            tabindex: "0",
            "aria-label": `#${turn.turn_index}`,
            onMouseenter: () => {
              hoveredTurnIndex.value = turn.turn_index
            },
            onFocus: () => {
              hoveredTurnIndex.value = turn.turn_index
            },
          }),
        )
      })

      const linePaths = buildLinePaths(hitPoints)
      const pathNodes = linePaths.map((d) =>
        h("path", {
          d,
          fill: "none",
          stroke: "var(--kcl-ok-accent)",
          "stroke-width": "2.2",
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      )

      const detail = activeTurnDetail.value

      return h("div", null, [
        h("div", { class: "kcl-chart-legend" }, [
          h("span", { class: "kcl-chart-legend__item" }, [
            h("span", {
              class: "kcl-swatch",
              style: { background: "var(--kcl-accent)", opacity: "0.45" },
            }),
            h("span", null, tr("inspector.chart.promptLegend", null)),
          ]),
          h("span", { class: "kcl-chart-legend__item" }, [
            h("span", { class: "kcl-swatch", style: { background: "var(--kcl-ok-accent)" } }),
            h("span", null, tr("inspector.chart.hitRateLegend", null)),
          ]),
          h("span", { class: "kcl-chart-legend__item" }, [
            h("span", {
              class: "kcl-swatch",
              style: {
                background: "var(--kcl-critical-accent)",
                borderRadius: "9999px",
              },
            }),
            h("span", null, tr("inspector.chart.dropLegend", null)),
          ]),
        ]),
        h("div", { class: "kcl-chart-wrap" }, [
          h(
            "svg",
            {
              class: "kcl-chart-svg",
              viewBox: `0 0 ${CHART_W} ${CHART_H}`,
              role: "img",
              "aria-label": tr("inspector.section.cacheTurns", null),
            },
            [...gridNodes, ...barNodes, ...pathNodes, ...dotNodes, ...xLabels, ...hitBandNodes],
          ),
        ]),
        detail
          ? h("div", { class: "kcl-chart-tooltip kcl-mono" }, [
              h("span", null, `${tr("inspector.table.turn", null)} #${detail.turn_index}`),
              h(
                "span",
                null,
                `${tr("inspector.table.promptTokens", null)}: ${formatTokens(detail.prompt_tokens)}`,
              ),
              h(
                "span",
                null,
                `${tr("inspector.table.cachedTokens", null)}: ${formatTokens(detail.cached_tokens)}`,
              ),
              h(
                "span",
                null,
                `${tr("inspector.table.completionTokens", null)}: ${formatTokens(detail.completion_tokens)}`,
              ),
              h(
                "span",
                null,
                `${tr("inspector.table.hitRate", null)}: ${formatPct(detail.hit_rate)}`,
              ),
              detail.drop
                ? h(
                    "span",
                    null,
                    `${tr("inspector.table.dropReason", null)}: ${tr(`drop.reason.${detail.drop.reason}`, null)} (${tr("inspector.drop.delta", { delta: formatPct(detail.drop.delta) })})`,
                  )
                : null,
            ])
          : null,
      ])
    }

    function renderCacheSection() {
      const turns = cacheTurns.value
      return h("section", { class: "kcl-card", "data-test": "kcl-section-cache" }, [
        h("div", { class: "kcl-card__head" }, [
          h("div", null, [
            h("h3", { class: "kcl-card__title" }, tr("inspector.section.cacheTurns", null)),
            h("p", { class: "kcl-card__hint" }, tr("inspector.section.cacheTurnsHint", null)),
          ]),
        ]),
        turns.length === 0
          ? h("div", { class: "kcl-popover__empty" }, tr("inspector.cacheTurns.empty", null))
          : h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } }, [
              renderCacheChart(),
              h("div", null, [
                h("div", { class: "kcl-section-label" }, tr("inspector.drop.title", null)),
                dropTurns.value.length === 0
                  ? h("div", { class: "kcl-card__hint" }, tr("inspector.drop.none", null))
                  : h(
                      "div",
                      { class: "kcl-drops-grid" },
                      dropTurns.value.map((turn) =>
                        h("div", { key: `drop-${turn.turn_index}`, class: "kcl-drop-card" }, [
                          h("div", { class: "kcl-drop-card__top" }, [
                            h("span", { class: "kcl-mono" }, `#${turn.turn_index}`),
                            h("span", null, tr(`drop.reason.${turn.drop.reason}`, null)),
                          ]),
                          h(
                            "div",
                            { class: "kcl-mono" },
                            tr("inspector.drop.delta", { delta: formatPct(turn.drop.delta) }),
                          ),
                          turn.drop.event_id !== null && turn.drop.event_id !== undefined
                            ? h(
                                "div",
                                { class: "kcl-mono" },
                                tr("inspector.drop.event", { id: turn.drop.event_id }),
                              )
                            : null,
                        ]),
                      ),
                    ),
              ]),
              h("div", { class: "kcl-table-wrap" }, [
                h("table", { class: "kcl-table" }, [
                  h("thead", null, [
                    h("tr", null, [
                      h("th", null, tr("inspector.table.turn", null)),
                      h("th", { class: "is-num" }, tr("inspector.table.promptTokens", null)),
                      h("th", { class: "is-num" }, tr("inspector.table.cachedTokens", null)),
                      h("th", { class: "is-num" }, tr("inspector.table.completionTokens", null)),
                      h("th", { class: "is-num" }, tr("inspector.table.hitRate", null)),
                      h("th", null, tr("inspector.table.dropReason", null)),
                    ]),
                  ]),
                  h(
                    "tbody",
                    null,
                    turns.map((turn) =>
                      h("tr", { key: `turn-${turn.turn_index}` }, [
                        h("td", { class: "kcl-mono" }, `#${turn.turn_index}`),
                        h("td", { class: "is-num kcl-mono" }, formatTokens(turn.prompt_tokens)),
                        h("td", { class: "is-num kcl-mono" }, formatTokens(turn.cached_tokens)),
                        h(
                          "td",
                          { class: "is-num kcl-mono" },
                          formatTokens(turn.completion_tokens),
                        ),
                        h("td", { class: "is-num kcl-mono" }, formatPct(turn.hit_rate)),
                        h(
                          "td",
                          null,
                          turn.drop
                            ? `${tr(`drop.reason.${turn.drop.reason}`, null)} (${tr("inspector.drop.delta", { delta: formatPct(turn.drop.delta) })})`
                            : "--",
                        ),
                      ]),
                    ),
                  ),
                ]),
              ]),
            ]),
      ])
    }

    function renderTopToolsSection() {
      const items = topToolOutputs.value
      return h("section", { class: "kcl-card", "data-test": "kcl-section-tools" }, [
        h("div", { class: "kcl-card__head" }, [
          h("div", null, [
            h("h3", { class: "kcl-card__title" }, tr("inspector.section.topTools", null)),
            h("p", { class: "kcl-card__hint" }, tr("inspector.section.topToolsHint", null)),
          ]),
        ]),
        items.length === 0
          ? h("div", { class: "kcl-popover__empty" }, tr("popover.noToolOutputs", null))
          : h("div", { class: "kcl-table-wrap" }, [
              h("table", { class: "kcl-table" }, [
                h("thead", null, [
                  h("tr", null, [
                    h("th", null, tr("inspector.table.rank", null)),
                    h("th", null, tr("inspector.table.tool", null)),
                    h("th", { class: "is-num" }, tr("inspector.table.turn", null)),
                    h("th", null, tr("inspector.table.target", null)),
                    h("th", { class: "is-num" }, tr("inspector.table.tokens", null)),
                    h("th", { class: "is-num" }, tr("inspector.table.share", null)),
                    h("th", null, tr("inspector.table.preview", null)),
                  ]),
                ]),
                h(
                  "tbody",
                  null,
                  items.map((item, idx) =>
                    h("tr", { key: `${item.call_id || idx}` }, [
                      h("td", { class: "kcl-mono" }, String(idx + 1)),
                      h("td", { class: "kcl-mono" }, item.tool_name || "--"),
                      h(
                        "td",
                        { class: "is-num kcl-mono" },
                        item.turn_index !== null && item.turn_index !== undefined
                          ? `#${item.turn_index}`
                          : "--",
                      ),
                      h(
                        "td",
                        { class: "kcl-cell-path kcl-mono", title: item.target_path || "" },
                        item.target_path || "--",
                      ),
                      h("td", { class: "is-num kcl-mono" }, formatTokens(item.estimated_tokens)),
                      h("td", { class: "is-num kcl-mono" }, formatPct(item.share)),
                      h("td", { class: "kcl-cell-preview kcl-mono" }, item.preview || "--"),
                    ]),
                  ),
                ),
              ]),
            ]),
      ])
    }

    function renderHandoffSection() {
      const handoff = store ? store.state.handoff : { loading: false, error: "", markdown: "" }
      const hasMarkdown = Boolean(handoff.markdown)
      return h("section", { class: "kcl-card", "data-test": "kcl-section-handoff" }, [
        h("div", { class: "kcl-card__head" }, [
          h("div", null, [
            h("h3", { class: "kcl-card__title" }, tr("inspector.section.handoff", null)),
            h("p", { class: "kcl-card__hint" }, tr("inspector.section.handoffHint", null)),
          ]),
        ]),
        h("div", { class: "kcl-handoff-actions" }, [
          h(
            "button",
            {
              type: "button",
              class: "kcl-btn kcl-btn--primary",
              disabled: !store || handoff.loading || (!analysis.value && !store.resolveActiveQuery()),
              "data-test": "kcl-handoff-generate",
              onClick: () => store && void store.fetchHandoff(null),
            },
            tr(
              handoff.loading ? "inspector.handoff.generating" : "inspector.handoff.generate",
              null,
            ),
          ),
          h(
            "button",
            {
              type: "button",
              class: "kcl-btn",
              disabled: !hasMarkdown,
              "data-test": "kcl-handoff-copy",
              onClick: () => void handleCopyHandoff(),
            },
            tr("inspector.handoff.copy", null),
          ),
          h(
            "button",
            {
              type: "button",
              class: "kcl-btn",
              disabled: !hasMarkdown,
              "data-test": "kcl-handoff-download",
              onClick: handleDownloadHandoff,
            },
            tr("inspector.handoff.download", null),
          ),
          hasMarkdown
            ? h(
                "span",
                { class: "kcl-handoff-chars kcl-mono" },
                tr("inspector.handoff.chars", { count: handoff.markdown.length }),
              )
            : null,
        ]),
        handoff.error ? h("div", { class: "kcl-error-box", role: "alert" }, handoff.error) : null,
        hasMarkdown
          ? h(
              "pre",
              { class: "kcl-handoff-pre", "data-test": "kcl-handoff-preview" },
              handoff.markdown,
            )
          : h("div", { class: "kcl-popover__empty" }, tr("inspector.handoff.empty", null)),
      ])
    }

    return () => {
      if (!store) {
        return h("div", { class: "kcl-inspector" }, [
          h("div", { class: "kcl-inspector__inner" }, [
            h("div", { class: "kcl-empty-state" }, tr("inspector.noSelection", null)),
          ]),
        ])
      }

      const sessions = browseSource.value === "live" ? liveSessions.value : savedSessions.value
      const sessionSelectVal =
        browseSource.value === "live" ? selectedLiveSessionId.value : selectedSavedName.value

      return h("div", { class: "kcl-inspector", "data-test": "kcl-inspector" }, [
        h("div", { class: "kcl-inspector__inner" }, [
          h("header", { class: "kcl-inspector__header" }, [
            h("div", null, [
              h("h2", { class: "kcl-inspector__title" }, tr("inspector.title", null)),
              h("p", { class: "kcl-inspector__subtitle" }, tr("inspector.subtitle", null)),
            ]),
            h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } }, [
              h(
                "button",
                {
                  type: "button",
                  class: ["kcl-btn", store.state.followActive ? "kcl-btn--active" : ""],
                  "data-test": "kcl-follow-active",
                  onClick: () => void store.setFollowActive(!store.state.followActive),
                },
                tr(
                  store.state.followActive ? "inspector.following" : "inspector.followActive",
                  null,
                ),
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "kcl-btn",
                  disabled: store.state.analysisLoading || store.state.targetsLoading,
                  "data-test": "kcl-inspector-refresh",
                  onClick: () => void store.refreshActive(),
                },
                tr("inspector.refresh", null),
              ),
            ]),
          ]),

          h("div", { class: "kcl-toolbar" }, [
            h("div", { class: "kcl-segmented", role: "group" }, [
              h(
                "button",
                {
                  type: "button",
                  class: ["kcl-segmented__btn", browseSource.value === "live" ? "is-active" : ""],
                  "data-test": "kcl-source-live",
                  onClick: () => {
                    browseSource.value = "live"
                  },
                },
                `${tr("inspector.sourceLive", null)} (${liveSessions.value.length})`,
              ),
              h(
                "button",
                {
                  type: "button",
                  class: ["kcl-segmented__btn", browseSource.value === "saved" ? "is-active" : ""],
                  "data-test": "kcl-source-saved",
                  onClick: () => {
                    browseSource.value = "saved"
                  },
                },
                `${tr("inspector.sourceSaved", null)} (${savedSessions.value.length})`,
              ),
            ]),
            h("label", { class: "kcl-field" }, [
              h("span", { class: "kcl-field__label" }, tr("inspector.sessionLabel", null)),
              h(
                "select",
                {
                  ref: sessionSelectEl,
                  class: "kcl-select",
                  value: sessionSelectVal,
                  disabled: sessions.length === 0,
                  "data-test": "kcl-session-select",
                  onChange: onSessionSelectChange,
                },
                [
                  h(
                    "option",
                    { value: "", selected: sessionSelectVal === "" },
                    sessions.length === 0
                      ? tr("inspector.noSessions", null)
                      : tr("inspector.noSelection", null),
                  ),
                  ...sessions.map((item) => {
                    if (browseSource.value === "live") {
                      return h(
                        "option",
                        {
                          key: item.session_id,
                          value: item.session_id,
                          selected: sessionSelectVal === item.session_id,
                        },
                        item.label || item.session_id,
                      )
                    }
                    return h(
                      "option",
                      {
                        key: item.saved_name,
                        value: item.saved_name,
                        selected: sessionSelectVal === item.saved_name,
                      },
                      item.saved_name,
                    )
                  }),
                ],
              ),
            ]),
            h("label", { class: "kcl-field" }, [
              h("span", { class: "kcl-field__label" }, tr("inspector.creatureLabel", null)),
              h(
                "select",
                {
                  ref: creatureSelectEl,
                  class: "kcl-select",
                  value: selectedCreatureValue.value,
                  disabled: creatureOptions.value.length === 0,
                  "data-test": "kcl-creature-select",
                  onChange: onCreatureSelectChange,
                },
                [
                  creatureOptions.value.length === 0 || selectedCreatureValue.value === ""
                    ? h(
                        "option",
                        { value: "", selected: selectedCreatureValue.value === "" },
                        "--",
                      )
                    : null,
                  ...creatureOptions.value.map((opt) =>
                    h(
                      "option",
                      {
                        key: opt.value,
                        value: opt.value,
                        selected: selectedCreatureValue.value === opt.value,
                      },
                      opt.label,
                    ),
                  ),
                ],
              ),
            ]),
          ]),

          store.state.targetsError
            ? h("div", { class: "kcl-error-box", role: "alert" }, store.state.targetsError)
            : null,
          store.state.analysisError
            ? h("div", { class: "kcl-error-box", role: "alert" }, store.state.analysisError)
            : null,

          !analysis.value && store.state.analysisLoading
            ? h("div", { class: "kcl-empty-state" }, tr("inspector.loading", null))
            : !analysis.value
              ? h("div", { class: "kcl-empty-state" }, tr("inspector.noSelection", null))
              : h("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } }, [
                  renderRiskBanner(),
                  renderKpiCards(),
                  renderAnatomySection(),
                  renderCacheSection(),
                  renderTopToolsSection(),
                  renderHandoffSection(),
                ]),
        ]),
      ])
    }
  },
})
