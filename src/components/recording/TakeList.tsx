import { useEffect, useState } from "react";
import { audibleTakes } from "@giamat90/mps-core/takes";
import { usePlayerStore } from "../../stores/player";
import { exportTake } from "../../lib/tauri";
import type { Take } from "../../lib/types";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TakeList() {
  const song = usePlayerStore((s) => s.song);
  const takes = usePlayerStore((s) => s.takes);
  const activeTakeId = usePlayerStore((s) => s.activeTakeId);
  const fetchTakes = usePlayerStore((s) => s.fetchTakes);
  const shownTakeIds = usePlayerStore((s) => s.shownTakeIds);
  const toggleTake = usePlayerStore((s) => s.toggleTake);
  const takePlayback = usePlayerStore((s) => s.takePlayback);
  const mutedTakeIds = usePlayerStore((s) => s.mutedTakeIds);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const muteTakesWhileRecording = usePlayerStore((s) => s.muteTakesWhileRecording);
  const soloedTakeId = usePlayerStore((s) => s.soloedTakeId);
  const deleteTake = usePlayerStore((s) => s.deleteTake);
  const renameTake = usePlayerStore((s) => s.renameTake);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [exportingId, setExportingId] = useState<string | null>(null);

  const audibleIds = audibleTakes({
    shown: shownTakeIds,
    active: activeTakeId,
    playback: takePlayback,
    muted: mutedTakeIds,
    recording: isRecording,
    muteWhileRecording: muteTakesWhileRecording,
    soloed: soloedTakeId,
  });

  const displayName = (take: Take, i: number) => take.name || `Take ${i + 1}`;

  const handleDownload = async (e: React.MouseEvent, take: Take, i: number) => {
    e.stopPropagation();
    setExportingId(take.id);
    const baseName = song ? `${song.title} - ${displayName(take, i)}` : displayName(take, i);
    try {
      await exportTake(take.filepath, `${baseName}.wav`);
    } catch (e) {
      console.error("[TakeList] export failed:", e);
    } finally {
      setExportingId(null);
    }
  };

  const startEditing = (e: React.MouseEvent, take: Take, i: number) => {
    e.stopPropagation();
    setEditingId(take.id);
    setEditValue(take.name || `Take ${i + 1}`);
  };

  const commitEdit = (takeId: string) => {
    setEditingId(null);
    renameTake(takeId, editValue);
  };

  useEffect(() => {
    fetchTakes();
  }, []);

  if (takes.length === 0) {
    return (
      <div className="take-list">
        <h3 className="take-list__title">Takes</h3>
        <p className="take-list__empty">No recordings yet.</p>
      </div>
    );
  }

  return (
    <div className="take-list">
      <h3 className="take-list__title">Takes</h3>
      {takes.map((take, i) => {
        const isActive = activeTakeId === take.id;
        const isShown = shownTakeIds.includes(take.id);
        const isAudible = audibleIds.includes(take.id);
        const hint = !isShown
          ? "Click to show this take"
          : isActive
            ? "Selected. Click to hide this take"
            : takePlayback === "selected"
              ? "Shown. Click to play this one"
              : "Shown. Click to select it";
        return (
        <div
          key={take.id}
          className={`take-item${isActive ? " take-item--active" : isShown ? " take-item--shown" : ""}`}
          onClick={() => toggleTake(take.id)}
          title={hint}
          aria-pressed={isShown}
        >
          <span
            className="take-item__state"
            aria-label={isAudible ? "playing" : isShown ? "silent" : "hidden"}
          >
            {isAudible ? "\u25B6" : isShown ? "\u25B7" : "\u25CB"}
          </span>
          <div className="take-item__info">
            {editingId === take.id ? (
              <input
                className="take-item__name-input"
                value={editValue}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => commitEdit(take.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit(take.id);
                  else if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span
                className="take-item__name"
                onDoubleClick={(e) => startEditing(e, take, i)}
                title="Double-click to rename"
              >
                {displayName(take, i)}
              </span>
            )}
            <span className="take-item__date">{formatDate(take.recordedAt)}</span>
          </div>
          <div className="take-item__actions">
            <button
              className="take-item__rename"
              onClick={(e) => startEditing(e, take, i)}
              title="Rename take"
              aria-label="Rename take"
            >
              &#9998;
            </button>
            <button
              className="take-item__download"
              onClick={(e) => handleDownload(e, take, i)}
              disabled={exportingId === take.id}
              title="Download take as WAV"
              aria-label="Download take as WAV"
            >
              {exportingId === take.id ? "…" : "↓"}
            </button>
            <button
              className="take-item__delete"
              onClick={(e) => {
                e.stopPropagation();
                deleteTake(take.id);
              }}
              title="Delete take"
              aria-label="Delete take"
            >
              &times;
            </button>
          </div>
        </div>
        );
      })}
    </div>
  );
}

export default TakeList;
