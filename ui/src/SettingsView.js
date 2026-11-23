/**
 * Extension Settings section for watermark thresholds and fragile-model rules.
 *
 * Uses native @kohakuterrarium/ui-sdk SettingsGroup, SettingsRow, and
 * ActionButton controls, and synchronizes host Settings labels on locale switch.
 */

import { defineComponent, h, onMounted, ref, watch } from "vue"
import {
  ActionButton,
  SettingsGroup,
  SettingsRow,
  notify,
  useLocale,
} from "@kohakuterrarium/ui-sdk"

import { syncSettingsHostLabels, translateLensText } from "./i18n.js"
import { getLensStore } from "./store.js"
import { DEFAULT_PREFS, validatePrefsInput } from "./utils.js"

export const SettingsView = defineComponent({
  name: "KclSettingsView",
  setup() {
    const store = getLensStore()
    const locale = useLocale()
    const tr = (key, params) => translateLensText(locale.value, key, params)

    const rootEl = ref(null)
    const dirty = ref(false)
    const saving = ref(false)
    const errorText = ref("")

    const initial = store ? store.state.prefs : DEFAULT_PREFS
    const warnInput = ref(String(initial.warn_pct))
    const criticalInput = ref(String(initial.critical_pct))
    const fragileInput = ref(String(initial.fragile_patterns))

    function syncFormFromPrefs(prefs) {
      const source = prefs || DEFAULT_PREFS
      warnInput.value = String(source.warn_pct)
      criticalInput.value = String(source.critical_pct)
      fragileInput.value = String(source.fragile_patterns)
    }

    watch(
      () =>
        store
          ? [
              store.state.prefs.warn_pct,
              store.state.prefs.critical_pct,
              store.state.prefs.fragile_patterns,
            ]
          : null,
      () => {
        if (!dirty.value && store) {
          syncFormFromPrefs(store.state.prefs)
        }
      },
    )

    watch(
      locale,
      (nextLocale) => {
        syncSettingsHostLabels(nextLocale, rootEl.value)
      },
      { flush: "post" },
    )

    onMounted(async () => {
      syncSettingsHostLabels(locale.value, rootEl.value)
      if (store) {
        await store.loadPreferences()
        if (!dirty.value) {
          syncFormFromPrefs(store.state.prefs)
        }
      }
    })

    async function handleSave() {
      const warnNum = Number(warnInput.value)
      const critNum = Number(criticalInput.value)
      if (!validatePrefsInput(warnNum, critNum)) {
        errorText.value = tr("settings.invalidRange", null)
        return
      }
      errorText.value = ""
      if (!store) return
      saving.value = true
      try {
        const saved = await store.savePreferences({
          warn_pct: warnNum,
          critical_pct: critNum,
          fragile_patterns: fragileInput.value,
        })
        dirty.value = false
        syncFormFromPrefs(saved)
        notify(tr("settings.saved", null), "success")
      } catch (err) {
        errorText.value = err && err.message ? err.message : String(err)
      } finally {
        saving.value = false
      }
    }

    async function handleReset() {
      errorText.value = ""
      if (!store) {
        dirty.value = false
        syncFormFromPrefs(DEFAULT_PREFS)
        return
      }
      saving.value = true
      try {
        const defaults = await store.resetPreferences()
        dirty.value = false
        syncFormFromPrefs(defaults)
        notify(tr("settings.resetDone", null), "info")
      } catch (err) {
        errorText.value = err && err.message ? err.message : String(err)
      } finally {
        saving.value = false
      }
    }

    return () =>
      h("div", { ref: rootEl, class: "kcl-settings", "data-test": "kcl-settings" }, [
        errorText.value
          ? h("div", { class: "kcl-error-box", role: "alert" }, errorText.value)
          : null,

        h(
          SettingsGroup,
          {
            title: tr("settings.group.thresholds", null),
            description: tr("settings.group.thresholdsDesc", null),
          },
          {
            default: () => [
              h(
                SettingsRow,
                {
                  title: tr("settings.warnPct.title", null),
                  hint: tr("settings.warnPct.hint", null),
                  inline: true,
                },
                {
                  default: () =>
                    h("input", {
                      type: "number",
                      min: "10",
                      max: "95",
                      step: "1",
                      class: "kcl-input kcl-mono kcl-settings__input-num",
                      value: warnInput.value,
                      "aria-label": tr("settings.warnPct.title", null),
                      "data-test": "kcl-pref-warn",
                      onInput: (event) => {
                        dirty.value = true
                        errorText.value = ""
                        warnInput.value = event.target.value
                      },
                    }),
                },
              ),
              h(
                SettingsRow,
                {
                  title: tr("settings.criticalPct.title", null),
                  hint: tr("settings.criticalPct.hint", null),
                  inline: true,
                },
                {
                  default: () =>
                    h("input", {
                      type: "number",
                      min: "15",
                      max: "100",
                      step: "1",
                      class: "kcl-input kcl-mono kcl-settings__input-num",
                      value: criticalInput.value,
                      "aria-label": tr("settings.criticalPct.title", null),
                      "data-test": "kcl-pref-critical",
                      onInput: (event) => {
                        dirty.value = true
                        errorText.value = ""
                        criticalInput.value = event.target.value
                      },
                    }),
                },
              ),
            ],
          },
        ),

        h(
          SettingsGroup,
          {
            title: tr("settings.group.risk", null),
            description: tr("settings.group.riskDesc", null),
          },
          {
            default: () => [
              h(
                SettingsRow,
                {
                  title: tr("settings.fragile.title", null),
                  hint: tr("settings.fragile.hint", null),
                },
                {
                  default: () =>
                    h("input", {
                      type: "text",
                      class: "kcl-input kcl-mono kcl-settings__input-text",
                      value: fragileInput.value,
                      placeholder: tr("settings.fragile.placeholder", null),
                      "aria-label": tr("settings.fragile.title", null),
                      "data-test": "kcl-pref-fragile",
                      onInput: (event) => {
                        dirty.value = true
                        fragileInput.value = event.target.value
                      },
                    }),
                },
              ),
            ],
          },
        ),

        h("div", { class: "kcl-settings__actions" }, [
          h(
            ActionButton,
            {
              variant: "primary",
              disabled: saving.value,
              "data-test": "kcl-pref-save",
              onClick: () => void handleSave(),
            },
            { default: () => tr("settings.save", null) },
          ),
          h(
            ActionButton,
            {
              variant: "secondary",
              disabled: saving.value,
              "data-test": "kcl-pref-reset",
              onClick: () => void handleReset(),
            },
            { default: () => tr("settings.reset", null) },
          ),
        ]),
      ])
  },
})
