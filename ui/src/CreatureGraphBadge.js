/**
 * Compact context watermark badge mounted on Graph canvas creature nodes.
 *
 * Uses useGraphNode() to resolve { kind, id, name, sessionId }, coalesces
 * per-session summary requests through the shared store, and opens the
 * Inspector tab pinned to the clicked creature.
 */

import { computed, defineComponent, h, watch } from "vue"
import { useGraphNode, useLocale } from "@kohakuterrarium/ui-sdk"

import { translateLensText } from "./i18n.js"
import { getLensStore } from "./store.js"
import { evaluateWatermarkStatus, formatPct, formatTokens, formatWholePct } from "./utils.js"

function findCreatureSummary(list, node) {
  if (!Array.isArray(list) || !node) return null
  return (
    list.find((item) => item && node.id && item.creature_id === node.id) ||
    list.find((item) => item && node.name && item.agent === node.name) ||
    list.find((item) => item && node.id && item.agent === node.id) ||
    null
  )
}

export const CreatureGraphBadge = defineComponent({
  name: "KclCreatureGraphBadge",
  setup() {
    const node = useGraphNode()
    const locale = useLocale()
    const store = getLensStore()

    const tr = (key, params) => translateLensText(locale.value, key, params)

    watch(
      () => (node.value && node.value.sessionId ? String(node.value.sessionId) : ""),
      (sessionId) => {
        if (sessionId && store) {
          void store.requestSessionSummary(sessionId)
        }
      },
      { immediate: true },
    )

    const summary = computed(() => {
      if (!store || !node.value || !node.value.sessionId) return null
      const list = store.state.sessionCreatures[node.value.sessionId]
      return findCreatureSummary(list, node.value)
    })

    const watermark = computed(() => {
      if (!summary.value || !store) return null
      return evaluateWatermarkStatus(summary.value, null, [], store.state.prefs)
    })

    const labelText = computed(() => {
      if (!watermark.value || watermark.value.effectiveTokens === null) {
        return tr("badge.noData", null)
      }
      const tokensText = formatTokens(watermark.value.effectiveTokens)
      if (watermark.value.usageRatio !== null) {
        return `${tokensText} ${formatWholePct(watermark.value.usageRatio)}`
      }
      return tokensText
    })

    const tooltipText = computed(() => {
      if (!summary.value || !watermark.value) return tr("extension.name", null)
      const agent = summary.value.agent || (node.value ? node.value.name : "") || ""
      const tokens = formatTokens(watermark.value.effectiveTokens)
      const cache = formatPct(summary.value.cache_hit_rate)
      if (watermark.value.usageRatio !== null) {
        return tr("badge.tooltip", {
          agent,
          tokens,
          pct: formatPct(watermark.value.usageRatio),
          cache,
        })
      }
      return tr("badge.tooltipNoLimit", { agent, tokens, cache })
    })

    function onClick(event) {
      if (event && typeof event.stopPropagation === "function") {
        event.stopPropagation()
      }
      if (!store || !node.value || !node.value.sessionId) return
      const targetCreatureId =
        (summary.value && summary.value.creature_id) ||
        (node.value.id ? String(node.value.id) : null)
      store.pinAndOpenInspector(node.value.sessionId, targetCreatureId)
    }

    return () => {
      const tone = watermark.value ? watermark.value.tone : "neutral"
      return h(
        "button",
        {
          type: "button",
          class: ["kcl-graph-badge", `kcl-tone-${tone}`],
          title: tooltipText.value,
          "data-test": "kcl-graph-badge",
          "data-tone": tone,
          onClick,
        },
        labelText.value,
      )
    }
  },
})
