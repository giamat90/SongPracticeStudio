import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { activeLineIndex, activeWordIndex, lineSeekTime, useLyricsStore } from "@giamat90/mps-core/lyrics";

interface LyricsPanelProps {
  songId: string;
  /** False when the song was imported without the vocals stem */
  hasVocals: boolean;
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
  const findOnline = useLyricsStore((s) => s.findOnline);
  const sync = useLyricsStore((s) => s.sync);
  const remove = useLyricsStore((s) => s.remove);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setOpen(false);
    setEditing(false);
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
              <div className="lyrics-panel__actions">
                <button
                  className="lyrics-panel__btn"
                  onClick={() => findOnline(songId)}
                  disabled={busy}
                  title="Searches lrclib.net with this song's title"
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
