/**
 * Stage overlay controller that mounts a compact watermark button into the
 * host session's v2-dock pill bar and renders the Context Lens popover drawer.
 *
 * Uses useWorkContext({ retainLast: true }) so the active session remains
 * observed across view switches without polling.
 */

import {
  Teleport,
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue"
import { useLocale, useWorkContext } from "@kohakuterrarium/ui-sdk"

import { syncSettingsHostLabels, translateLensText } from "./i18n.js"
import { getLensStore } from "./store.js"
import {
  buildBucketEntries,
  evaluateWatermarkStatus,
  formatPct,
  formatTokens,
  formatWholePct,
} from "./utils.js"

const RING_RADIUS = 7
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
const OWNS_INPUT_SELECTOR =
  "input, textarea, select, [contenteditable='true'], .el-overlay, .el-popper"

function isElementExplicitlyHidden(el) {
  if (!el || typeof el.closest !== "function") return true
  if (el.closest("[hidden], [aria-hidden='true']")) return true
  let cursor = el
  while (cursor && cursor.nodeType === 1) {
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(cursor)
      if (style.display === "none" || style.visibility === "hidden") return true
    } else if (cursor.style && cursor.style.display === "none") {
      return true
    }
    cursor = cursor.parentElement
  }
  return false
}

function findVisibleDockElement() {
  if (typeof document === "undefined") return null
  const candidates = Array.from(document.querySelectorAll('[data-test="v2-dock"]'))
  if (!candidates.length) return null
  const nonHidden = candidates.filter((el) => !isElementExplicitlyHidden(el))
  if (!nonHidden.length) return null
  const withRect = nonHidden.find((el) => {
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  return withRect || nonHidden[0]
}

function findDockCapsule(dockEl) {
  if (!dockEl || !dockEl.children) return null
  for (const child of Array.from(dockEl.children)) {
    const hasFloat =
      child.classList && typeof child.classList.contains === "function"
        ? child.classList.contains("kt-v2-float")
        : typeof child.className === "string" &&
          child.className.split(/\s+/).includes("kt-v2-float")
    const testAttr =
      typeof child.getAttribute === "function" ? child.getAttribute("data-test") : null
    if (hasFloat && testAttr !== "v2-dock-more-menu") {
      return child
    }
  }
  return null
}

function findDockInsertionPoint() {
  const dockEl = findVisibleDockElement()
  if (!dockEl) return null
  const capsuleEl = findDockCapsule(dockEl)
  const collapsed = Boolean(
    capsuleEl &&
      typeof capsuleEl.querySelector === "function" &&
      capsuleEl.querySelector('[data-test="v2-dock-pill"]'),
  )
  return { dockEl, capsuleEl, collapsed }
}

function buildWatermarkSvg(ratio, tone, hasRisk) {
  const hasRatio = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0
  const clamped = hasRatio ? Math.min(1, Math.max(0.04, ratio)) : 0
  const dashOffset = hasRatio ? RING_CIRCUMFERENCE * (1 - clamped) : RING_CIRCUMFERENCE

  const children = [
    h("circle", {
      cx: "10",
      cy: "10",
      r: String(RING_RADIUS),
      fill: "none",
      stroke: "currentColor",
      "stroke-opacity": "0.24",
      "stroke-width": "2.2",
    }),
  ]

  if (hasRatio) {
    children.push(
      h("circle", {
        cx: "10",
        cy: "10",
        r: String(RING_RADIUS),
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2.2",
        "stroke-linecap": "round",
        "stroke-dasharray": RING_CIRCUMFERENCE.toFixed(2),
        "stroke-dashoffset": dashOffset.toFixed(2),
        transform: "rotate(-90 10 10)",
      }),
    )
  }

  children.push(
    h("circle", {
      cx: "10",
      cy: "10",
      r: "2.3",
      fill: "currentColor",
      "fill-opacity": tone === "neutral" && !hasRatio ? "0.55" : "0.95",
    }),
  )

  if (hasRisk) {
    children.push(
      h("circle", {
        cx: "16.2",
        cy: "3.8",
        r: "2.1",
        fill: "currentColor",
      }),
    )
  }

  return h(
    "svg",
    {
      class: "kcl-dock-svg",
      viewBox: "0 0 20 20",
      width: "16",
      height: "16",
      "aria-hidden": "true",
    },
    children,
  )
}

function formatRiskLine(flag, usageRatio, tr) {
  const pct = formatPct(usageRatio)
  return tr(`risk.${flag}`, { pct })
}

export const DockLensOverlay = defineComponent({
  name: "KclDockLensOverlay",
  setup() {
    const work = useWorkContext({ retainLast: true })
    const locale = useLocale()
    const store = getLensStore()

    if (store) {
      store.bindWorkContext(work)
    }

    const tr = (key, params) => translateLensText(locale.value, key, params)

    const dockSlotTarget = ref(null)
    const triggerBtnEl = ref(null)
    const popoverEl = ref(null)
    const popoverStyle = ref({
      right: "16px",
      bottom: "16px",
      maxHeight: "min(620px, calc(100vh - 32px))",
    })

    let slotHost = null
    let anchorDockEl = null
    let wasDockCollapsed = false
    let domObserver = null
    let syncFrameId = null

    function clearSyncSchedule() {
      if (syncFrameId === null) return
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(syncFrameId)
      } else {
        clearTimeout(syncFrameId)
      }
      syncFrameId = null
    }

    function detachSlotHost() {
      if (slotHost && slotHost.parentElement) {
        slotHost.parentElement.removeChild(slotHost)
      }
      dockSlotTarget.value = null
    }

    function syncDockSlot() {
      syncSettingsHostLabels(locale.value, null)
      const found = findDockInsertionPoint()
      anchorDockEl = found ? found.dockEl : null
      if (!found || !found.capsuleEl) {
        wasDockCollapsed = false
        detachSlotHost()
        return
      }
      if (!wasDockCollapsed && found.collapsed && store && store.state.popoverOpen) {
        store.closePopover()
      }
      wasDockCollapsed = found.collapsed
      if (!slotHost && typeof document !== "undefined") {
        slotHost = document.createElement("span")
        slotHost.className = "kcl-dock-slot"
        slotHost.setAttribute("data-test", "kcl-dock-slot")
        slotHost.setAttribute("data-kcl-dock-slot", "true")
      }
      if (!slotHost) return
      if (slotHost.parentElement !== found.capsuleEl) {
        found.capsuleEl.insertBefore(slotHost, found.capsuleEl.firstChild || null)
      }
      if (dockSlotTarget.value !== slotHost) {
        dockSlotTarget.value = slotHost
      }
    }

    function scheduleDockSync() {
      if (syncFrameId !== null) return
      if (typeof requestAnimationFrame === "function") {
        syncFrameId = requestAnimationFrame(() => {
          syncFrameId = null
          syncDockSlot()
          if (store && store.state.popoverOpen) {
            updatePopoverPosition()
          }
        })
      } else {
        syncFrameId = setTimeout(() => {
          syncFrameId = null
          syncDockSlot()
          if (store && store.state.popoverOpen) {
            updatePopoverPosition()
          }
        }, 0)
      }
    }

    function updatePopoverPosition() {
      if (typeof window === "undefined") return
      const minPad = window.innerWidth <= 767 ? 8 : 12
      const fallbackRight = window.innerWidth <= 767 ? 8 : 16
      const btnRect =
        triggerBtnEl.value && typeof triggerBtnEl.value.getBoundingClientRect === "function"
          ? triggerBtnEl.value.getBoundingClientRect()
          : null
      const btnVisible = Boolean(btnRect && (btnRect.width > 0 || btnRect.height > 0))
      const anchorEl = btnVisible ? triggerBtnEl.value : anchorDockEl || findVisibleDockElement()
      if (!anchorEl || typeof anchorEl.getBoundingClientRect !== "function") {
        popoverStyle.value = {
          right: `${fallbackRight}px`,
          bottom: `${fallbackRight}px`,
          maxHeight: `min(620px, calc(100vh - ${fallbackRight * 2}px))`,
        }
        return
      }
      const rect = anchorEl.getBoundingClientRect()
      if (!rect || (rect.width <= 0 && rect.height <= 0)) {
        popoverStyle.value = {
          right: `${fallbackRight}px`,
          bottom: `${fallbackRight}px`,
          maxHeight: `min(620px, calc(100vh - ${fallbackRight * 2}px))`,
        }
        return
      }
      const dockBox = anchorDockEl ? anchorDockEl.getBoundingClientRect() : rect
      const alignRightEdge = dockBox && dockBox.width > 0 ? dockBox.right : rect.right
      const popoverWidth = Math.min(410, Math.max(200, window.innerWidth - minPad * 2))
      const maxRight = Math.max(minPad, window.innerWidth - popoverWidth - minPad)
      const right = Math.max(
        minPad,
        Math.min(maxRight, Math.round(window.innerWidth - alignRightEdge)),
      )
      const bottom = Math.max(minPad, Math.round(window.innerHeight - rect.top + 10))
      const availableAbove = Math.max(220, Math.min(620, window.innerHeight - bottom - minPad))
      popoverStyle.value = {
        right: `${right}px`,
        bottom: `${bottom}px`,
        maxHeight: `${availableAbove}px`,
      }
    }

    function onDocumentPointerDown(event) {
      if (!store || !store.state.popoverOpen) return
      const target = event ? event.target : null
      if (popoverEl.value && popoverEl.value.contains(target)) return
      if (triggerBtnEl.value && triggerBtnEl.value.contains(target)) return
      store.closePopover()
    }

    function onWindowKeydown(event) {
      if (!store || !store.state.popoverOpen || !event) return
      if (event.key !== "Escape") return
      const target = event.target
      if (target && typeof target.closest === "function") {
        if (target.closest(OWNS_INPUT_SELECTOR)) return
        const insidePopover = Boolean(popoverEl.value && popoverEl.value.contains(target))
        if (!insidePopover && target.closest("[role='dialog']")) return
      }
      event.preventDefault()
      store.closePopover()
    }

    function onWindowResize() {
      if (store && store.state.popoverOpen) {
        updatePopoverPosition()
      }
    }

    function shouldIgnoreMutation(records) {
      if (!records || !records.length) return false
      return records.every((record) => {
        const target = record.target
        if (slotHost && slotHost.contains(target)) return true
        if (popoverEl.value && popoverEl.value.contains(target)) return true
        return false
      })
    }

    onMounted(() => {
      syncDockSlot()
      if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body) {
        domObserver = new MutationObserver((records) => {
          if (!shouldIgnoreMutation(records)) {
            scheduleDockSync()
          }
        })
        domObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["style", "class", "hidden", "aria-hidden"],
        })
      }
      if (typeof document !== "undefined") {
        document.addEventListener("pointerdown", onDocumentPointerDown, true)
      }
      if (typeof window !== "undefined") {
        window.addEventListener("keydown", onWindowKeydown, true)
        window.addEventListener("resize", onWindowResize)
      }
    })

    onBeforeUnmount(() => {
      clearSyncSchedule()
      if (domObserver) {
        domObserver.disconnect()
        domObserver = null
      }
      detachSlotHost()
      if (typeof document !== "undefined") {
        document.removeEventListener("pointerdown", onDocumentPointerDown, true)
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("keydown", onWindowKeydown, true)
        window.removeEventListener("resize", onWindowResize)
      }
    })

    const activeAnalysis = computed(() => {
      if (!store || !store.state.analysis) return null
      return store.state.analysis
    })

    const activeWatermark = computed(() => {
      if (!store) {
        return evaluateWatermarkStatus(null, null, [], null)
      }
      const analysis = activeAnalysis.value
      const workSid = store.state.work.sessionId
      const targetSid = analysis && analysis.target ? analysis.target.session_id : null
      if (analysis && (!workSid || targetSid === workSid)) {
        return evaluateWatermarkStatus(
          analysis.context,
          analysis.anatomy,
          analysis.risk_flags,
          store.state.prefs,
        )
      }
      const cached = workSid ? store.state.sessionCreatures[workSid] : null
      if (Array.isArray(cached) && cached.length) {
        const cid = store.state.work.creatureId
        const match =
          cached.find((item) => item && cid && (item.creature_id === cid || item.agent === cid)) ||
          cached[0]
        if (match) {
          return evaluateWatermarkStatus(match, null, [], store.state.prefs)
        }
      }
      return evaluateWatermarkStatus(null, null, [], store.state.prefs)
    })

    const popoverWatermark = computed(() => {
      if (!store || !activeAnalysis.value) {
        return evaluateWatermarkStatus(null, null, [], store ? store.state.prefs : null)
      }
      return evaluateWatermarkStatus(
        activeAnalysis.value.context,
        activeAnalysis.value.anatomy,
        activeAnalysis.value.risk_flags,
        store.state.prefs,
      )
    })

    const bucketEntries = computed(() => {
      const anatomy = activeAnalysis.value ? activeAnalysis.value.anatomy : null
      if (!anatomy) return []
      return buildBucketEntries(anatomy.buckets, anatomy.estimated_tokens)
    })

    const topTools = computed(() => {
      const anatomy = activeAnalysis.value ? activeAnalysis.value.anatomy : null
      if (!anatomy || !Array.isArray(anatomy.top_tool_outputs)) return []
      return anatomy.top_tool_outputs.slice(0, 3)
    })

    watch(
      locale,
      (loc) => {
        syncSettingsHostLabels(loc, null)
      },
      { immediate: true },
    )

    watch(
      () => (store ? store.state.popoverOpen : false),
      async (open) => {
        if (open) {
          await nextTick()
          syncDockSlot()
          updatePopoverPosition()
        }
      },
    )

    watch(
      () => [store ? store.state.work.sessionId : "", store ? store.state.work.creatureId : ""],
      async () => {
        await nextTick()
        syncDockSlot()
      },
    )

    function onTriggerClick(event) {
      if (event && typeof event.stopPropagation === "function") {
        event.stopPropagation()
      }
      if (!store) return
      if (store.state.popoverOpen) {
        store.closePopover()
        return
      }
      const workSid = store.state.work.sessionId
      const pinned = store.state.pinnedTarget
      if (
        workSid &&
        !store.state.followActive &&
        (!pinned || pinned.source === "saved" || pinned.session_id !== workSid)
      ) {
        store.state.followActive = true
        store.state.pinnedTarget = null
      }
      store.openPopover()
    }

    function renderDockButton() {
      if (!dockSlotTarget.value || !store) return null
      const wm = activeWatermark.value
      const usageSummary =
        wm.usageRatio !== null
          ? formatWholePct(wm.usageRatio)
          : wm.effectiveTokens !== null
            ? formatTokens(wm.effectiveTokens)
            : ""
      const titleText = usageSummary
        ? tr("dock.button.status", { usage: usageSummary })
        : tr("dock.button.title")
      return h(
        Teleport,
        { to: dockSlotTarget.value },
        [
          h(
            "button",
            {
              ref: triggerBtnEl,
              type: "button",
              class: [
                "kcl-dock-btn",
                `kcl-tone-${wm.tone}`,
                store.state.popoverOpen ? "is-open" : "",
              ],
              title: titleText,
              "aria-label": tr("dock.button.aria"),
              "aria-expanded": String(Boolean(store.state.popoverOpen)),
              "data-test": "kcl-dock-trigger",
              "data-tone": wm.tone,
              onClick: onTriggerClick,
            },
            [buildWatermarkSvg(wm.usageRatio, wm.tone, wm.flags.length > 0)],
          ),
        ],
      )
    }

    function renderPopover() {
      if (!store || !store.state.popoverOpen) return null
      const analysis = activeAnalysis.value
      const wm = popoverWatermark.value
      const context = analysis ? analysis.context : null
      const target = analysis ? analysis.target : null
      const activeAgent =
        (target && target.agent) ||
        store.state.work.creatureLabel ||
        store.state.work.creatureId ||
        ""

      const limitCaption =
        wm.limitKind === "compact" && wm.limit !== null
          ? tr("popover.limitCompact", { limit: formatTokens(wm.limit) })
          : wm.limitKind === "window" && wm.limit !== null
            ? tr("popover.limitWindow", { limit: formatTokens(wm.limit) })
            : tr("popover.limitNone", null)

      const meterPct =
        wm.usageRatio !== null ? `${Math.min(100, Math.max(0, wm.usageRatio * 100)).toFixed(1)}%` : "0%"

      const bodyChildren = []

      if (store.state.analysisError) {
        bodyChildren.push(
          h("div", { class: "kcl-error-box", role: "alert" }, store.state.analysisError),
        )
      }

      if (!analysis && store.state.analysisLoading) {
        bodyChildren.push(h("div", { class: "kcl-popover__empty" }, tr("popover.loading", null)))
      } else if (!analysis) {
        bodyChildren.push(h("div", { class: "kcl-popover__empty" }, tr("popover.empty", null)))
      } else {
        if (wm.flags.length > 0) {
          bodyChildren.push(
            h(
              "div",
              {
                class: [
                  "kcl-risk-banner",
                  wm.tone === "critical" ? "kcl-tone-critical" : "kcl-tone-warn",
                ],
                role: "status",
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
                    h("li", null, formatRiskLine(flag, wm.usageRatio, tr)),
                  ),
                ),
              ],
            ),
          )
        }

        bodyChildren.push(
          h("div", { class: "kcl-popover__metrics" }, [
            h("div", { class: "kcl-metric-box" }, [
              h("div", { class: "kcl-metric-box__label" }, tr("popover.usage", null)),
              h("div", { class: "kcl-metric-box__value kcl-mono" }, [
                h("span", null, formatTokens(wm.effectiveTokens)),
                wm.usageRatio !== null
                  ? h("span", { class: "kcl-metric-box__sub" }, formatPct(wm.usageRatio))
                  : null,
              ]),
              h("div", { class: "kcl-metric-box__sub" }, limitCaption),
              h("div", { class: "kcl-meter" }, [
                h("div", {
                  class: ["kcl-meter__fill", `kcl-tone-${wm.tone}`],
                  style: { width: meterPct },
                }),
              ]),
            ]),
            h("div", { class: "kcl-metric-box" }, [
              h("div", { class: "kcl-metric-box__label" }, tr("popover.cacheHit", null)),
              h(
                "div",
                { class: "kcl-metric-box__value kcl-mono" },
                formatPct(context ? context.cache_hit_rate : null),
              ),
              h(
                "div",
                { class: "kcl-metric-box__sub", title: (context && context.llm_name) || "" },
                (context && context.llm_name) || "--",
              ),
            ]),
          ]),
        )

        if (Array.isArray(analysis.creatures) && analysis.creatures.length > 1) {
          bodyChildren.push(
            h("div", null, [
              h("div", { class: "kcl-section-label" }, tr("popover.creatures", null)),
              h(
                "div",
                { class: "kcl-creatures" },
                analysis.creatures.map((creature) => {
                  const itemWm = evaluateWatermarkStatus(creature, null, [], store.state.prefs)
                  const hasIds = Boolean(target && target.creature_id && creature.creature_id)
                  const isSelected = Boolean(
                    target &&
                      (hasIds
                        ? target.creature_id === creature.creature_id
                        : creature.agent === target.agent),
                  )
                  return h(
                    "button",
                    {
                      type: "button",
                      class: ["kcl-creature-pill", isSelected ? "is-active" : ""],
                      onClick: () => {
                        if (target && target.source === "live" && target.session_id) {
                          const matchesWork = Boolean(
                            store.state.work.sessionId === target.session_id &&
                              store.state.work.creatureId &&
                              store.state.work.creatureId === creature.creature_id,
                          )
                          void store.selectLiveTarget(
                            target.session_id,
                            creature.creature_id,
                            matchesWork,
                          )
                        } else if (target && target.source === "saved" && target.saved_name) {
                          void store.selectSavedTarget(target.saved_name, creature.agent)
                        }
                      },
                    },
                    [
                      h("span", { class: ["kcl-dot", `kcl-tone-${itemWm.tone}`] }),
                      h("span", null, creature.agent),
                      h(
                        "span",
                        { class: "kcl-mono" },
                        itemWm.usageRatio !== null
                          ? formatWholePct(itemWm.usageRatio)
                          : formatTokens(itemWm.effectiveTokens),
                      ),
                    ],
                  )
                }),
              ),
            ]),
          )
        }

        bodyChildren.push(
          h("div", null, [
            h("div", { class: "kcl-section-label" }, tr("popover.buckets", null)),
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
            h(
              "div",
              { class: "kcl-bucket-list" },
              bucketEntries.value.map((entry, idx) =>
                h("div", { key: entry.key, class: "kcl-bucket-item" }, [
                  h("span", { class: "kcl-bucket-item__name" }, [
                    h("span", { class: ["kcl-swatch", `kcl-bucket-color-${idx}`] }),
                    h("span", null, tr(`bucket.${entry.key}`, null)),
                  ]),
                  h(
                    "span",
                    { class: "kcl-bucket-item__val kcl-mono" },
                    `${formatTokens(entry.tokens)} (${entry.pctText})`,
                  ),
                ]),
              ),
            ),
          ]),
        )

        bodyChildren.push(
          h("div", null, [
            h("div", { class: "kcl-section-label" }, tr("popover.topTools", null)),
            topTools.value.length === 0
              ? h("div", { class: "kcl-popover__empty" }, tr("popover.noToolOutputs", null))
              : h(
                  "div",
                  { class: "kcl-popover-tools" },
                  topTools.value.map((item, idx) =>
                    h("div", { key: `${item.call_id || idx}`, class: "kcl-popover-tool" }, [
                      h("div", { class: "kcl-popover-tool__top" }, [
                        h(
                          "span",
                          { class: "kcl-popover-tool__name" },
                          item.tool_name || "--",
                        ),
                        h(
                          "span",
                          { class: "kcl-mono" },
                          `${formatTokens(item.estimated_tokens)} (${formatPct(item.share)})`,
                        ),
                      ]),
                      h(
                        "div",
                        {
                          class: "kcl-popover-tool__preview kcl-mono",
                          title: item.target_path || item.preview || "",
                        },
                        item.target_path || item.preview || "--",
                      ),
                    ]),
                  ),
                ),
          ]),
        )
      }

      return h(
        Teleport,
        { to: "body" },
        [
          h(
            "section",
            {
              ref: popoverEl,
              class: "kcl-popover",
              style: popoverStyle.value,
              role: "dialog",
              "aria-label": tr("popover.title", null),
              "data-test": "kcl-dock-popover",
            },
            [
              h("header", { class: "kcl-popover__head" }, [
                h("div", { class: "kcl-popover__titleWrap" }, [
                  h("span", { class: "kcl-popover__title" }, tr("popover.title", null)),
                  activeAgent
                    ? h("span", { class: "kcl-popover__agent", title: activeAgent }, activeAgent)
                    : null,
                ]),
                h("div", { class: "kcl-popover__headActions" }, [
                  h(
                    "button",
                    {
                      type: "button",
                      class: "kcl-btn kcl-btn--ghost",
                      disabled: store.state.analysisLoading,
                      "data-test": "kcl-popover-refresh",
                      onClick: () => void store.refreshActive(),
                    },
                    tr("popover.refresh", null),
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "kcl-btn kcl-btn--ghost",
                      "data-test": "kcl-popover-close",
                      onClick: () => store.closePopover(),
                    },
                    tr("popover.close", null),
                  ),
                ]),
              ]),
              h("div", { class: "kcl-popover__body" }, bodyChildren),
              h("footer", { class: "kcl-popover__foot" }, [
                h(
                  "button",
                  {
                    type: "button",
                    class: "kcl-btn",
                    disabled: !analysis && !store.resolveActiveQuery(),
                    "data-test": "kcl-popover-handoff",
                    onClick: () => store.openInspectorForCurrent(true),
                  },
                  tr("popover.handoff", null),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "kcl-btn kcl-btn--primary",
                    "data-test": "kcl-popover-inspector",
                    onClick: () => store.openInspectorForCurrent(false),
                  },
                  tr("popover.openInspector", null),
                ),
              ]),
            ],
          ),
        ],
      )
    }

    return () => h("div", { class: "kcl-stage-anchor", "data-test": "kcl-stage" }, [
      renderDockButton(),
      renderPopover(),
    ])
  },
})
