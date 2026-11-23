/**
 * Kohaku Context Lens UI extension entry module.
 *
 * Registers the shared reactive store, v2-dock stage overlay, Graph creature
 * watermark badge, full-page Context Lens inspector tab, preferences view,
 * and Ctrl+Alt+C toggle command with clean disposal on unload/host switch.
 */

import { defineExtension } from "@kohakuterrarium/ui-sdk"

import { CreatureGraphBadge } from "./src/CreatureGraphBadge.js"
import { DockLensOverlay } from "./src/DockLensOverlay.js"
import { InspectorTab } from "./src/InspectorTab.js"
import { SettingsView } from "./src/SettingsView.js"
import { disposeLensStore, initLensStore } from "./src/store.js"

export default defineExtension((kt) => {
  const store = initLensStore(kt)

  kt.registerOverlay("stage", DockLensOverlay)
  kt.registerTab("inspector", InspectorTab)
  kt.registerGraphBadge("watermark", CreatureGraphBadge)
  kt.registerSettingsSection("preferences", SettingsView)

  kt.registerCommand("toggle-lens", () => {
    if (!kt.isOverlayVisible("stage")) {
      kt.showOverlay("stage")
    }
    store.togglePopover()
  })

  kt.onDispose(() => {
    disposeLensStore(kt)
  })
})
