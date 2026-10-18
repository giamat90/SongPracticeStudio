import { usePlayerStore } from "../../stores/player";
import { useLibraryStore } from "../../stores/library";
import { cancelLyricsSync } from "../../lib/tauri";
import type { Song } from "../../lib/types";
import { useLyricsPanel, type LyricsPlayer } from "@giamat90/mps-core/hooks";

interface LyricsPanelProps {
  songId: string;
  /** False when the song was imported without the vocals stem */
  hasVocals: boolean;
}

const player: LyricsPlayer<Song> = {
  use: usePlayerStore,
  applySong: (saved) => usePlayerStore.setState((s) => (s.song?.id === saved.id ? { song: saved } : {})),
  seek: (seconds) => usePlayerStore.getState().seek(seconds),
};

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function LyricsPanel({ songId, hasVocals }: LyricsPanelProps) {
  const saveIdentity = useLibraryStore((s) => s.setSongIdentity);
  const p = useLyricsPanel({
    songId,
    player,
    saveIdentity,
    cancelSync: cancelLyricsSync,
    hasVocals,
    artistFallback: false,
  });
  const { lyrics, status, draft, candidates, chosen, busy, activeLine, activeWord } = p;

  return (
    <div className="lyrics-panel">
      <div className="lyrics-panel__bar">
        <button
          className={`analysis-tab ${p.open ? "analysis-tab--active" : ""}`}
          onClick={p.toggleOpen}
          aria-expanded={p.open}
        >
          Lyrics {p.showAddHint ? "(add)" : ""}
        </button>
      </div>

      {p.open && !hasVocals && (
        <div className="lyrics-panel__body">
          <p className="lyrics-panel__hint">
            Lyrics are synced to the vocals stem, and this song was imported without it. Import it again with Vocals
            selected to use synced lyrics.
          </p>
        </div>
      )}

      {p.open && hasVocals && (
        <div className="lyrics-panel__body">
          {status === "syncing" && (
            <div className="lyrics-panel__progress" role="status">
              <div
                className="lyrics-panel__progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(p.progress * 100)}
              >
                <div className="lyrics-panel__progress-bar" style={{ width: `${Math.round(p.progress * 100)}%` }} />
              </div>
              <span className="lyrics-panel__progress-label">{p.stage}</span>
              <button
                type="button"
                className="lyrics-panel__cancel"
                onClick={p.cancelSync}
                title="Stop the sync. Nothing is changed."
              >
                Cancel
              </button>
            </div>
          )}

          {p.error && (
            <p className="lyrics-panel__error" role="alert">
              {p.error}
            </p>
          )}
          {p.notice && <p className="lyrics-panel__notice">{p.notice}</p>}

          {p.showEditor && status !== "syncing" && (
            <div className="lyrics-panel__editor">
              <textarea
                className="lyrics-panel__text"
                value={draft}
                onChange={(e) => p.setDraft(e.target.value)}
                placeholder={
                  "Paste the lyrics here, one line per sung line.\nWrite repeated choruses out in full so every line can be placed."
                }
                rows={8}
                spellCheck={false}
                aria-label="Lyrics text"
                disabled={busy}
              />
              <div className="lyrics-panel__lookup">
                {p.identityOpen ? (
                  <form
                    className="lyrics-panel__identity"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void p.saveIdentity();
                    }}
                  >
                    <input
                      className="lyrics-panel__input"
                      value={p.artistDraft}
                      onChange={(e) => p.setArtistDraft(e.target.value)}
                      placeholder="Artist"
                      aria-label="Official artist"
                    />
                    <input
                      className="lyrics-panel__input"
                      value={p.titleDraft}
                      onChange={(e) => p.setTitleDraft(e.target.value)}
                      placeholder="Title"
                      aria-label="Official title"
                    />
                    <button type="submit" className="lyrics-panel__btn lyrics-panel__btn--primary">
                      Save
                    </button>
                    <button type="button" className="lyrics-panel__btn" onClick={p.closeIdentity}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p className="lyrics-panel__hint">
                    Searches as:{" "}
                    <strong>{p.lookupArtist ? `${p.lookupArtist} – ${p.lookupTitle}` : p.lookupTitle}</strong>{" "}
                    <button
                      type="button"
                      className="lyrics-panel__link"
                      onClick={p.openIdentity}
                      disabled={busy || !p.song}
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
                  onClick={p.findOnline}
                  disabled={busy}
                  title="Searches lrclib.net with this song's official title and artist"
                >
                  {status === "finding" ? "Searching..." : "Find online"}
                </button>
                <button
                  className="lyrics-panel__btn lyrics-panel__btn--primary"
                  onClick={p.syncLyrics}
                  disabled={busy || !draft.trim()}
                >
                  {lyrics ? "Re-sync" : "Sync lyrics"}
                </button>
                {lyrics && (
                  <button className="lyrics-panel__btn" onClick={p.stopEditing} disabled={busy}>
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
                        onClick={() => p.chooseCandidate(i)}
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

          {lyrics && !p.editing && status !== "syncing" && (
            <>
              {lyrics.warning && <p className="lyrics-panel__warning">{lyrics.warning}</p>}
              <div className="lyrics-panel__actions">
                <button className="lyrics-panel__btn" onClick={p.startEditing} disabled={busy}>
                  Edit and re-sync
                </button>
                <button className="lyrics-panel__btn" onClick={p.removeLyrics} disabled={busy}>
                  Remove
                </button>
              </div>
              <div className="lyrics-view" ref={p.listRef}>
                {lyrics.lines.map((line, i) => {
                  const isActive = i === activeLine;
                  return (
                    <button
                      key={i}
                      ref={p.setLineRef(i)}
                      className={`lyrics-line${isActive ? " lyrics-line--active" : ""}`}
                      onClick={() => p.seekToLine(i)}
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
