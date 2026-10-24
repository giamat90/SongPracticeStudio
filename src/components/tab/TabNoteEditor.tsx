import { useState } from "react";
import { playerString, stepString, type TabNoteModel } from "../../lib/tabEdit";

interface TabNoteEditorProps {
  note: TabNoteModel | null;
  canUndo: boolean;
  canRedo: boolean;
  hasOriginal: boolean;
  disabled: boolean;
  onStep: (direction: "up" | "down") => void;
  onNeighbour: (direction: "previous" | "next") => void;
  onUndo: () => void;
  onRedo: () => void;
  onRevert: () => void;
}

/**
 * The row under the tab. Like Guitar Pro: pick a note, then move it to the string above or below with the buttons
 * or Alt+Up / Alt+Down, and step to the previous or next note with Alt+Left / Alt+Right. No mode to switch on.
 */
export default function TabNoteEditor({
  note, canUndo, canRedo, hasOriginal, disabled, onStep, onNeighbour, onUndo, onRedo, onRevert,
}: TabNoteEditorProps) {
  const [confirming, setConfirming] = useState(false);
  const up = note ? stepString(note, "up") : null;
  const down = note ? stepString(note, "down") : null;
  const label = (to: { string: number; fret: number } | null, word: string) => {
    if (!note) return word;
    return to ? `${word}: string ${playerString(note, to.string)}, fret ${to.fret}` : `${word}: not possible`;
  };

  return (
    <div className="tab-panel__fix tab-panel__edit">
      <button className="tab-panel__btn" onClick={() => onNeighbour("previous")} disabled={disabled || !note} title="Previous note (Alt+Left)">◀</button>
      <button className="tab-panel__btn" onClick={() => onNeighbour("next")} disabled={disabled || !note} title="Next note (Alt+Right)">▶</button>
      <button
        className="tab-panel__btn"
        onClick={() => onStep("up")}
        disabled={disabled || !up}
        title="Same note on the string above, toward the thin string (Alt+Up)"
      >
        ▲ {label(up, "String above")}
      </button>
      <button
        className="tab-panel__btn"
        onClick={() => onStep("down")}
        disabled={disabled || !down}
        title="Same note on the string below, toward the thick string (Alt+Down)"
      >
        ▼ {label(down, "String below")}
      </button>
      <span className="tab-panel__fixhint">
        {note
          ? `Bar ${note.beat.voice.bar.index + 1}, string ${playerString(note, note.string)}, fret ${note.fret}`
          : "Click a note to move it to another string (Alt+Up / Alt+Down)."}
      </span>
      <span className="tab-panel__spacer" />
      <button className="tab-panel__btn" onClick={onUndo} disabled={disabled || !canUndo}>Undo</button>
      <button className="tab-panel__btn" onClick={onRedo} disabled={disabled || !canRedo}>Redo</button>
      {hasOriginal && !confirming && (
        <button
          className="tab-panel__btn"
          onClick={() => setConfirming(true)}
          disabled={disabled}
          title="Go back to the file as it was imported"
        >
          Revert to imported
        </button>
      )}
      {hasOriginal && confirming && (
        <>
          <span className="tab-panel__fixhint">Drop every edit?</span>
          <button className="tab-panel__btn" onClick={() => { setConfirming(false); onRevert(); }}>Revert</button>
          <button className="tab-panel__btn" onClick={() => setConfirming(false)}>Keep edits</button>
        </>
      )}
    </div>
  );
}
