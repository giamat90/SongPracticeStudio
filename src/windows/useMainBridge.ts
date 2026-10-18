import { emit, listen } from "@tauri-apps/api/event";
import { useMainBridgeHost } from "@giamat90/mps-core/hooks";
import { closeDetachedPanel, closeDetachedWindows } from "../lib/tauri";
import { useDetachedStore } from "../stores/detached";
import { useAnalyzerPanels } from "../stores/panels";
import { takesSilenced, usePlayerStore } from "../stores/player";
import { startMainBridge } from "./mainBridge";
import { DETACHABLE_PANELS, EVT_DOCKED } from "./protocol";

/**
 * Lets the analyzer page feed panels that were dragged out into their own
 * windows. Costs nothing until one is opened; leaving the page closes them,
 * since they would otherwise keep showing a song that is no longer loaded.
 */
export function useMainBridge(): void {
  useMainBridgeHost(() => ({
    startBridge: () =>
      startMainBridge({
        player: usePlayerStore,
        emit: (event, payload) => emit(event, payload),
        listen: (event, cb) => listen(event, (e) => cb(e.payload)),
        now: () => Date.now(),
        takesSilenced: () => takesSilenced(usePlayerStore.getState()),
      }),
    ids: DETACHABLE_PANELS,
    panels: useAnalyzerPanels,
    detached: useDetachedStore,
    listenDocked: (cb) => listen<string>(EVT_DOCKED, (e) => cb(e.payload)),
    closePanel: closeDetachedPanel,
    closeAll: closeDetachedWindows,
  }));
}
