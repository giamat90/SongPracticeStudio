import { createDetachedStore } from "@giamat90/mps-core/windows";
import { isDetachablePanel, type DetachablePanel } from "../windows/protocol";

/** Panels currently shown in a window of their own. Never persisted: every session starts docked. */
export const useDetachedStore = createDetachedStore<DetachablePanel>(isDetachablePanel);
