import { formatTakeDate, useTakeList } from "@giamat90/mps-core/hooks";
import { usePlayerStore, takesSilenced } from "../../stores/player";
import { exportTake } from "../../lib/tauri";
import PanelTitle from "../panels/PanelTitle";
import { usePanelCollapse } from "../../stores/collapsed";

type PlayerState = ReturnType<typeof usePlayerStore.getState>;

function TakeList() {
  const fetchTakes = usePlayerStore((s) => s.fetchTakes);
  const list = useTakeList<PlayerState>({
    useStore: usePlayerStore,
    isSilenced: takesSilenced,
    exportTake,
    onMount: fetchTakes,
  });
  const { takes, editingId, editValue, setEditValue, exportingId } = list;
  const collapse = usePanelCollapse("takes");
  const title = (
    <h3 className="take-list__title">
      <PanelTitle collapse={collapse}>Takes</PanelTitle>
    </h3>
  );

  if (takes.length === 0) {
    return (
      <div className="take-list">
        {title}
        {collapse.open && <p className="take-list__empty">No recordings yet.</p>}
      </div>
    );
  }

  return (
    <div className="take-list">
      {title}
      {collapse.open && takes.map((take, i) => {
        const isActive = list.isActive(take);
        const isShown = list.isShown(take);
        return (
        <div
          key={take.id}
          className={`take-item${isActive ? " take-item--active" : isShown ? " take-item--shown" : ""}`}
          onClick={() => list.toggle(take)}
          title={list.hintFor(take)}
          aria-pressed={isShown}
        >
          <span
            className="take-item__state"
            aria-label={list.stateOf(take)}
          >
            {list.isAudible(take) ? "\u25B6" : isShown ? "\u25B7" : "\u25CB"}
          </span>
          <div className="take-item__info">
            {editingId === take.id ? (
              <input
                className="take-item__name-input"
                value={editValue}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => list.commitEdit(take)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") list.commitEdit(take);
                  else if (e.key === "Escape") list.cancelEdit();
                }}
              />
            ) : (
              <span
                className="take-item__name"
                onDoubleClick={(e) => list.startEditing(e, take, i)}
                title="Double-click to rename"
              >
                {list.displayName(take, i)}
              </span>
            )}
            <span className="take-item__date">{formatTakeDate(take.recordedAt)}</span>
          </div>
          <div className="take-item__actions">
            <button
              className="take-item__rename"
              onClick={(e) => list.startEditing(e, take, i)}
              title="Rename take"
              aria-label="Rename take"
            >
              &#9998;
            </button>
            <button
              className="take-item__download"
              onClick={(e) => list.download(e, take, i)}
              disabled={exportingId === take.id}
              title="Download take as WAV"
              aria-label="Download take as WAV"
            >
              {exportingId === take.id ? "…" : "↓"}
            </button>
            <button
              className="take-item__delete"
              onClick={(e) => list.remove(e, take)}
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
