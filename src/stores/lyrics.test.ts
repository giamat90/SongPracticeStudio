import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FoundLyrics, Lyrics } from "../lib/types";

const h = vi.hoisted(() => ({
  api: {
    loadLyrics: vi.fn(),
    syncLyrics: vi.fn(),
    findLyrics: vi.fn(),
    deleteLyrics: vi.fn(),
    onLyricsProgress: vi.fn(),
  },
  progressHandler: null as null | ((p: { songId: string; progress: number; stage: string }) => void),
  unlisten: vi.fn(),
}));

vi.mock("../lib/tauri", () => h.api);

import { useLyricsStore } from "./lyrics";

const lyrics = (text = "hello world", extra: Partial<Lyrics> = {}): Lyrics => ({
  version: 1,
  source: "paste",
  text,
  aligner: "test",
  alignedAt: "2026-01-01T00:00:00Z",
  meanScore: 0.5,
  warning: null,
  lines: [{ text, start: 1, end: 3, score: 0.5, words: [] }],
  ...extra,
});

const found = (extra: Partial<FoundLyrics> = {}): FoundLyrics => ({
  text: "line a\nline b",
  synced: true,
  title: "A Song",
  artist: "A Band",
  source: "lrclib",
  ...extra,
});

const initial = useLyricsStore.getState();

beforeEach(() => {
  Object.values(h.api).forEach((fn) => fn.mockReset());
  h.unlisten.mockReset();
  h.progressHandler = null;
  h.api.onLyricsProgress.mockImplementation(async (cb) => {
    h.progressHandler = cb;
    return h.unlisten;
  });
  useLyricsStore.setState(initial, true);
});

describe("load", () => {
  it("fills lyrics and the editable draft from the saved file", async () => {
    h.api.loadLyrics.mockResolvedValue(lyrics("saved text"));
    await useLyricsStore.getState().load("s1");
    const s = useLyricsStore.getState();
    expect(s.songId).toBe("s1");
    expect(s.lyrics?.text).toBe("saved text");
    expect(s.draft).toBe("saved text");
    expect(s.status).toBe("idle");
  });

  it("a song without lyrics starts empty", async () => {
    h.api.loadLyrics.mockResolvedValue(null);
    await useLyricsStore.getState().load("s1");
    expect(useLyricsStore.getState().lyrics).toBeNull();
    expect(useLyricsStore.getState().draft).toBe("");
  });

  it("a load error is shown, not swallowed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.api.loadLyrics.mockRejectedValue("Parse lyrics: bad");
    await useLyricsStore.getState().load("s1");
    expect(useLyricsStore.getState().error).toContain("Parse lyrics");
    expect(useLyricsStore.getState().status).toBe("idle");
    expect(warn).toHaveBeenCalled();
  });

  it("switching song discards the previous song's state", async () => {
    h.api.loadLyrics.mockResolvedValueOnce(lyrics("first"));
    await useLyricsStore.getState().load("s1");
    h.api.loadLyrics.mockResolvedValueOnce(null);
    await useLyricsStore.getState().load("s2");
    expect(useLyricsStore.getState().lyrics).toBeNull();
    expect(useLyricsStore.getState().draft).toBe("");
  });

  it("a slow load for a song that is no longer open is ignored", async () => {
    let resolveFirst: (v: Lyrics | null) => void = () => {};
    h.api.loadLyrics.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    const first = useLyricsStore.getState().load("s1");
    h.api.loadLyrics.mockResolvedValueOnce(lyrics("second"));
    await useLyricsStore.getState().load("s2");
    resolveFirst(lyrics("first"));
    await first;
    expect(useLyricsStore.getState().songId).toBe("s2");
    expect(useLyricsStore.getState().lyrics?.text).toBe("second");
  });
});

describe("sync", () => {
  it("sends the draft, shows progress while it runs and stores the result", async () => {
    useLyricsStore.setState({ songId: "s1", draft: "la la la" });
    h.api.syncLyrics.mockImplementation(async () => {
      expect(useLyricsStore.getState().status).toBe("syncing");
      h.progressHandler?.({ songId: "s1", progress: 0.4, stage: "Listening to the vocals" });
      expect(useLyricsStore.getState().progress).toBe(0.4);
      expect(useLyricsStore.getState().stage).toBe("Listening to the vocals");
      return lyrics("la la la");
    });

    await useLyricsStore.getState().sync("s1");

    expect(h.api.syncLyrics).toHaveBeenCalledWith("s1", "la la la", "paste");
    const s = useLyricsStore.getState();
    expect(s.lyrics?.text).toBe("la la la");
    expect(s.status).toBe("idle");
    expect(s.error).toBeNull();
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("ignores progress that belongs to another song", async () => {
    useLyricsStore.setState({ songId: "s1", draft: "la" });
    let seen = -1;
    h.api.syncLyrics.mockImplementation(async () => {
      h.progressHandler?.({ songId: "other", progress: 0.9, stage: "x" });
      seen = useLyricsStore.getState().progress;
      return lyrics("la");
    });
    await useLyricsStore.getState().sync("s1");
    expect(seen).toBe(0);
  });

  it("keeps the previous lyrics and reports the error when syncing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLyricsStore.setState({ songId: "s1", draft: "new text", lyrics: lyrics("old") });
    h.api.syncLyrics.mockRejectedValue("The vocals track is silent");
    await useLyricsStore.getState().sync("s1");
    const s = useLyricsStore.getState();
    expect(s.error).toBe("The vocals track is silent");
    expect(s.lyrics?.text).toBe("old");
    expect(s.status).toBe("idle");
    expect(h.unlisten).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty draft", async () => {
    useLyricsStore.setState({ songId: "s1", draft: "   " });
    await useLyricsStore.getState().sync("s1");
    expect(h.api.syncLyrics).not.toHaveBeenCalled();
    expect(useLyricsStore.getState().error).toMatch(/paste/i);
  });

  it("refuses to start a second sync while one is running", async () => {
    useLyricsStore.setState({ songId: "s1", draft: "la", status: "syncing" });
    await useLyricsStore.getState().sync("s1");
    expect(h.api.syncLyrics).not.toHaveBeenCalled();
  });

  it("a result that arrives after the user opened another song is dropped", async () => {
    useLyricsStore.setState({ songId: "s1", draft: "la" });
    let finish: (l: Lyrics) => void = () => {};
    h.api.syncLyrics.mockImplementation(() => new Promise((r) => { finish = r; }));
    const running = useLyricsStore.getState().sync("s1");
    await vi.waitFor(() => expect(h.api.syncLyrics).toHaveBeenCalled());
    useLyricsStore.setState({ songId: "s2", lyrics: null, draft: "", status: "idle" });
    finish(lyrics("la"));
    await running;
    expect(useLyricsStore.getState().songId).toBe("s2");
    expect(useLyricsStore.getState().lyrics).toBeNull();
  });

  it("still syncs when the progress listener cannot be attached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.api.onLyricsProgress.mockRejectedValue(new Error("no events"));
    useLyricsStore.setState({ songId: "s1", draft: "la" });
    h.api.syncLyrics.mockResolvedValue(lyrics("la"));
    await useLyricsStore.getState().sync("s1");
    expect(useLyricsStore.getState().lyrics?.text).toBe("la");
    expect(warn).toHaveBeenCalled();
  });

  it("passes along that the draft came from an online lookup", async () => {
    useLyricsStore.setState({ songId: "s1" });
    h.api.findLyrics.mockResolvedValue(found());
    await useLyricsStore.getState().findOnline("s1");
    h.api.syncLyrics.mockResolvedValue(lyrics("line a\nline b", { source: "lrclib" }));
    await useLyricsStore.getState().sync("s1");
    expect(h.api.syncLyrics).toHaveBeenCalledWith("s1", "line a\nline b", "lrclib");
  });
});

describe("findOnline", () => {
  it("puts the found text in the draft for review and says what was found", async () => {
    useLyricsStore.setState({ songId: "s1" });
    h.api.findLyrics.mockResolvedValue(found());
    await useLyricsStore.getState().findOnline("s1");
    const s = useLyricsStore.getState();
    expect(s.draft).toBe("line a\nline b");
    expect(s.notice).toContain("A Song");
    expect(s.notice).toContain("A Band");
    expect(s.status).toBe("idle");
  });

  it("warns that plain-text lyrics may leave out repeated choruses", async () => {
    useLyricsStore.setState({ songId: "s1" });
    h.api.findLyrics.mockResolvedValue(found({ synced: false }));
    await useLyricsStore.getState().findOnline("s1");
    expect(useLyricsStore.getState().notice).toMatch(/chorus/i);
  });

  it("reports a failed lookup without touching the draft", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLyricsStore.setState({ songId: "s1", draft: "mine" });
    h.api.findLyrics.mockRejectedValue('No lyrics found for "X".');
    await useLyricsStore.getState().findOnline("s1");
    const s = useLyricsStore.getState();
    expect(s.error).toContain("No lyrics found");
    expect(s.draft).toBe("mine");
    expect(s.status).toBe("idle");
  });
});

describe("remove and clear", () => {
  it("deleting lyrics clears them and keeps the text for another go", async () => {
    useLyricsStore.setState({ songId: "s1", lyrics: lyrics("keep me"), draft: "keep me" });
    h.api.deleteLyrics.mockResolvedValue(undefined);
    await useLyricsStore.getState().remove("s1");
    expect(h.api.deleteLyrics).toHaveBeenCalledWith("s1");
    expect(useLyricsStore.getState().lyrics).toBeNull();
    expect(useLyricsStore.getState().draft).toBe("keep me");
  });

  it("a failed delete keeps the lyrics and says why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useLyricsStore.setState({ songId: "s1", lyrics: lyrics("x") });
    h.api.deleteLyrics.mockRejectedValue("Delete lyrics: denied");
    await useLyricsStore.getState().remove("s1");
    expect(useLyricsStore.getState().lyrics).not.toBeNull();
    expect(useLyricsStore.getState().error).toContain("denied");
  });

  it("clear returns to the empty state", () => {
    useLyricsStore.setState({ songId: "s1", lyrics: lyrics(), draft: "x", error: "e", notice: "n", progress: 0.5 });
    useLyricsStore.getState().clear();
    const s = useLyricsStore.getState();
    expect([s.songId, s.lyrics, s.draft, s.error, s.notice, s.progress]).toEqual([null, null, "", null, null, 0]);
  });

  it("editing the draft clears a stale error and notice", () => {
    useLyricsStore.setState({ error: "e", notice: "n" });
    useLyricsStore.getState().setDraft("typing");
    expect(useLyricsStore.getState().draft).toBe("typing");
    expect(useLyricsStore.getState().error).toBeNull();
    expect(useLyricsStore.getState().notice).toBeNull();
  });
});
