import { useState } from "react";
import { playerString, stepString, type TabNoteModel } from "../../lib/tabEdit";

interface TabNoteEditorProps {
  note: TabNoteModel | null;
  canUndo: boolean;
  canRedo: boolean;
  hasOriginal: boolean;
  disabled: boolean;
  onStep: (direction: "up" | "down") => void;
  onBar: (direction: "previous" | "next") => void;
  onUndo: () => void;
  onRedo: () => void;
  onRevert: () => void;
}

/**
 * The row under the tab while editing, with TuxGuitar's keys: Shift+Up / Shift+Down move the picked note to the
 * string above / below (at the same pitch), Alt+Left / Alt+Right go to the previous / next bar, Ctrl+Z undoes.
 * Every key has a button here.
 */
export default function TabNoteEditor({
  note, canUndo, canRedo, hasOriginal, disabled, onStep, onBar, onUndo, onRedo, onRevert,
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
      <button className="tab-panel__btn" onClick={() => onBar("previous")} disabled={disabled} title="Previous bar (Alt+Left)">◀ Bar</button>
      <button className="tab-panel__btn" onClick={() => onBar("next")} disabled={disabled} title="Next bar (Alt+Right)">Bar ▶</button>
      <button
        className="tab-panel__btn"
        onClick={() => onStep("up")}
        disabled={disabled || !up}
        title="Same note on the string above, toward the thin string (Shift+Up)"
      >
        ▲ {label(up, "String above")}
      </button>
      <button
        className="tab-panel__btn"
        onClick={() => onStep("down")}
        disabled={disabled || !down}
        title="Same note on the string below, toward the thick string (Shift+Down)"
      >
        ▼ {label(down, "String below")}
      </button>
      <span className="tab-panel__fixhint">
        {note
          ? `Bar ${note.beat.voice.bar.index + 1}, string ${playerString(note, note.string)}, fret ${note.fret}`
          : "Click a note. Shift+Up / Down: string. Alt+Left / Right: bar. Ctrl+Z: undo."}
      </span>
      <span className="tab-panel__spacer" />
      <button className="tab-panel__btn" onClick={onUndo} disabled={disabled || !canUndo} title="Undo (Ctrl+Z)">Undo</button>
      <button className="tab-panel__btn" onClick={onRedo} disabled={disabled || !canRedo} title="Redo (Ctrl+Y)">Redo</button>
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
