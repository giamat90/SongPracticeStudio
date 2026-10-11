import { installShortcuts, type KeyEventTarget, type ShortcutBinding } from "@giamat90/mps-core/shortcuts";

export const SEEK_STEP_S = 5;
export const SEEK_FINE_STEP_S = 1;

/** What the shortcuts read from the player store and the actions they call. */
export interface ShortcutPlayer {
  isRecording: boolean;
  isCountingIn: boolean;
  currentTime: number;
  duration: number;
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
  togglePlay(): void;
  skipToStart(): void;
  skipToEnd(): void;
  seek(time: number): void;
  setPunchIn(time: number): void;
  setPunchOut(time: number): void;
  setPunchLoop(on: boolean): void;
}

/** Space, arrows, Home / End, L, [ and ]. Nothing runs while recording or counting in. */
export function buildShortcuts(player: () => ShortcutPlayer): ShortcutBinding[] {
  const guarded = (run: (p: ShortcutPlayer) => void) => () => {
    const p = player();
    if (p.isRecording || p.isCountingIn) return;
    run(p);
  };
  const seekBy = (delta: number) =>
    guarded((p) => p.seek(Math.max(0, Math.min(p.duration, p.currentTime + delta))));

  return [
    { key: "space", run: guarded((p) => p.togglePlay()) },
    { key: "Home", run: guarded((p) => p.skipToStart()) },
    { key: "End", run: guarded((p) => p.skipToEnd()) },
    { key: "ArrowLeft", run: seekBy(-SEEK_STEP_S) },
    { key: "ArrowRight", run: seekBy(SEEK_STEP_S) },
    { key: "ArrowLeft", shift: true, run: seekBy(-SEEK_FINE_STEP_S) },
    { key: "ArrowRight", shift: true, run: seekBy(SEEK_FINE_STEP_S) },
    {
      key: "l",
      run: guarded((p) => {
        if (p.punchIn !== null && p.punchOut !== null) p.setPunchLoop(!p.punchLoop);
      }),
    },
    {
      key: "[",
      run: guarded((p) => {
        p.setPunchIn(p.currentTime);
        if (p.punchOut !== null && p.punchOut <= p.currentTime) p.setPunchOut(Math.min(p.duration, p.currentTime + SEEK_STEP_S));
      }),
    },
    {
      key: "]",
      run: guarded((p) => {
        if (p.punchIn !== null && p.punchIn >= p.currentTime) p.setPunchIn(Math.max(0, p.currentTime - SEEK_STEP_S));
        p.setPunchOut(p.currentTime);
      }),
    },
  ];
}

/** Starts the shortcuts on the window; returns the function that stops them. */
export function installPlayerShortcuts(player: () => ShortcutPlayer): () => void {
  return installShortcuts(window as unknown as KeyEventTarget, buildShortcuts(player));
}
