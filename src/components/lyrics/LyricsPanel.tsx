import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { useLibraryStore } from "../../stores/library";
import { cancelLyricsSync } from "../../lib/tauri";
import { activeLineIndex, activeWordIndex, lineSeekTime, useLyricsStore } from "@giamat90/mps-core/lyrics";

interface LyricsPanelProps {
  songId: string;
  /** False when the song was imported without the vocals stem */
  hasVocals: boolean;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function LyricsPanel({ songId, hasVocals }: LyricsPanelProps) {
  const lyrics = useLyricsStore((s) => s.lyrics);
  const draft = useLyricsStore((s) => s.draft);
  const status = useLyricsStore((s) => s.status);
  const progress = useLyricsStore((s) => s.progress);
  const stage = useLyricsStore((s) => s.stage);
  const error = useLyricsStore((s) => s.error);
  const notice = useLyricsStore((s) => s.notice);
  const load = useLyricsStore((s) => s.load);
  const clear = useLyricsStore((s) => s.clear);
  const setDraft = useLyricsStore((s) => s.setDraft);
  const candidates = useLyricsStore((s) => s.candidates);
  const chosen = useLyricsStore((s) => s.chosen);
  const searchOnline = useLyricsStore((s) => s.searchOnline);
  const chooseCandidate = useLyricsStore((s) => s.chooseCandidate);
  const sync = useLyricsStore((s) => s.sync);
  const remove = useLyricsStore((s) => s.remove);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const song = usePlayerStore((s) => (s.song?.id === songId ? s.song : null));
  const setSongIdentity = useLibraryStore((s) => s.setSongIdentity);
  const lookupTitle = song?.officialTitle?.trim() || song?.title || "";
  const lookupArtist = song?.officialArtist?.trim() || "";
  const [identityOpen, setIdentityOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [artistDraft, setArtistDraft] = useState("");

  const openIdentity = () => {
    setTitleDraft(lookupTitle);
    setArtistDraft(lookupArtist);
    setIdentityOpen(true);
  };

  const saveIdentity = async () => {
    const saved = await setSongIdentity(songId, titleDraft, artistDraft);
    if (!saved) return;
    usePlayerStore.setState((s) => (s.song?.id === songId ? { song: saved } : {}));
    setIdentityOpen(false);
  };

  useEffect(() => {
    setOpen(false);
    setEditing(false);
    setIdentityOpen(false);
    if (hasVocals) load(songId);
    return () => clear();
  }, [songId, hasVocals]);

  useEffect(() => {
    if (lyrics) {
      setOpen(true);
      setEditing(false);
    }
  }, [lyrics]);

  // Selectors return the index, not the time, so the list re-renders only when
  // the line or word actually changes rather than 30 times a second.
  const activeLine = usePlayerStore((s) => (lyrics ? activeLineIndex(lyrics.lines, s.currentTime) : -1));
  const activeWord = usePlayerStore((s) =>
    lyrics && activeLine >= 0 ? activeWordIndex(lyrics.lines[activeLine], s.currentTime) : -1,
  );

  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const list = listRef.current;
    const el = activeLine >= 0 ? lineRefs.current[activeLine] : null;
    if (!list || !el) return;
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [activeLine]);

  const busy = status !== "idle";
  const showEditor = !lyrics || editing;

  const seekToLine = (index: number) => {
    if (!lyrics) return;
    usePlayerStore.getState().seek(lineSeekTime(lyrics.lines[index]));
  };

  return (
    <div className="lyrics-panel">
      <div className="lyrics-panel__bar">
        <button
          className={`analysis-tab ${open ? "analysis-tab--active" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          Lyrics {lyrics || status === "loading" || !hasVocals ? "" : "(add)"}
        </button>
      </div>

      {open && !hasVocals && (
        <div className="lyrics-panel__body">
          <p className="lyrics-panel__hint">
            Lyrics are synced to the vocals stem, and this song was imported without it. Import it again with Vocals
            selected to use synced lyrics.
          </p>
        </div>
      )}

      {open && hasVocals && (
        <div className="lyrics-panel__body">
          {status === "syncing" && (
            <div className="lyrics-panel__progress" role="status">
              <div
                className="lyrics-panel__progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
              >
                <div className="lyrics-panel__progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="lyrics-panel__progress-label">{stage}</span>
              <button
                type="button"
                className="lyrics-panel__cancel"
                onClick={() =>
                  cancelLyricsSync().catch((e: unknown) => console.error("[LyricsPanel] cancel failed:", e))
                }
                title="Stop the sync. Nothing is changed."
              >
                Cancel
              </button>
            </div>
          )}

          {error && (
            <p className="lyrics-panel__error" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="lyrics-panel__notice">{notice}</p>}

          {showEditor && status !== "syncing" && (
            <div className="lyrics-panel__editor">
              <textarea
                className="lyrics-panel__text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  "Paste the lyrics here, one line per sung line.\nWrite repeated choruses out in full so every line can be placed."
                }
                rows={8}
                spellCheck={false}
                aria-label="Lyrics text"
                disabled={busy}
              />
              <div className="lyrics-panel__lookup">
                {identityOpen ? (
                  <form
                    className="lyrics-panel__identity"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveIdentity();
                    }}
                  >
                    <input
                      className="lyrics-panel__input"
                      value={artistDraft}
                      onChange={(e) => setArtistDraft(e.target.value)}
                      placeholder="Artist"
                      aria-label="Official artist"
                    />
                    <input
                      className="lyrics-panel__input"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      placeholder="Title"
                      aria-label="Official title"
                    />
                    <button type="submit" className="lyrics-panel__btn lyrics-panel__btn--primary">
                      Save
                    </button>
                    <button type="button" className="lyrics-panel__btn" onClick={() => setIdentityOpen(false)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p className="lyrics-panel__hint">
                    Searches as: <strong>{lookupArtist ? `${lookupArtist} – ${lookupTitle}` : lookupTitle}</strong>{" "}
                    <button
                      type="button"
                      className="lyrics-panel__link"
                      onClick={openIdentity}
                      disabled={busy || !song}
                      title="The title and artist the online search uses. Renaming the song in the library does not change them."
                    >
                      Change
                    </button>
                  </p>
                )}
              </div>
              <div className="lyrics-panel__actions">
                <button
                  className="lyrics-panel__btn"
                  onClick={() => searchOnline(songId)}
                  disabled={busy}
                  title="Searches lrclib.net with this song's official title and artist"
                >
                  {status === "finding" ? "Searching..." : "Find online"}
                </button>
                <button
                  className="lyrics-panel__btn lyrics-panel__btn--primary"
                  onClick={() => sync(songId)}
                  disabled={busy || !draft.trim()}
                >
                  {lyrics ? "Re-sync" : "Sync lyrics"}
                </button>
                {lyrics && (
                  <button className="lyrics-panel__btn" onClick={() => setEditing(false)} disabled={busy}>
                    Cancel
                  </button>
                )}
              </div>
              {candidates.length > 1 && (
                <ul className="lyrics-panel__results" aria-label="Other results">
                  {candidates.map((c, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className={`lyrics-panel__result${i === chosen ? " lyrics-panel__result--chosen" : ""}`}
                        onClick={() => chooseCandidate(i)}
                        disabled={busy}
                        aria-pressed={i === chosen}
                      >
                        <span className="lyrics-panel__result-name">
                          {c.title || "Untitled"}
                          {c.artist ? ` – ${c.artist}` : ""}
                        </span>
                        <span className="lyrics-panel__result-meta">
                          {c.duration != null ? formatDuration(c.duration) : "length unknown"}
                          {c.lengthMismatch ? " · different length" : ""}
                          {c.synced ? " · timed" : " · plain"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="lyrics-panel__hint">
                Syncing places each line on the separated vocals. The first run downloads a one-time speech model.
              </p>
            </div>
          )}

          {lyrics && !editing && status !== "syncing" && (
            <>
              {lyrics.warning && <p className="lyrics-panel__warning">{lyrics.warning}</p>}
              <div className="lyrics-panel__actions">
                <button className="lyrics-panel__btn" onClick={() => setEditing(true)} disabled={busy}>
                  Edit and re-sync
                </button>
                <button className="lyrics-panel__btn" onClick={() => remove(songId)} disabled={busy}>
                  Remove
                </button>
              </div>
              <div className="lyrics-view" ref={listRef}>
                {lyrics.lines.map((line, i) => {
                  const isActive = i === activeLine;
                  return (
                    <button
                      key={i}
                      ref={(el) => {
                        lineRefs.current[i] = el;
                      }}
                      className={`lyrics-line${isActive ? " lyrics-line--active" : ""}`}
                      onClick={() => seekToLine(i)}
                      aria-current={isActive ? "true" : undefined}
                      title="Jump to this line"
                    >
                      {isActive && line.words.length > 0
                        ? line.words.map((w, wi) => (
                            <span key={wi} className={wi <= activeWord ? "lyrics-word lyrics-word--sung" : "lyrics-word"}>
                              {w.text}{" "}
                            </span>
                          ))
                        : line.text}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default LyricsPanel;
