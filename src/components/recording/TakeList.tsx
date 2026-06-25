import { useEffect } from "react";
import { usePlayerStore } from "../../stores/player";

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
  const takes = usePlayerStore((s) => s.takes);
  const activeTakeId = usePlayerStore((s) => s.activeTakeId);
  const fetchTakes = usePlayerStore((s) => s.fetchTakes);
  const setActiveTake = usePlayerStore((s) => s.setActiveTake);
  const deleteTake = usePlayerStore((s) => s.deleteTake);

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
      {takes.map((take, i) => (
        <div
          key={take.id}
          className={`take-item ${activeTakeId === take.id ? "take-item--active" : ""}`}
          onClick={() => setActiveTake(take.id)}
        >
          <div className="take-item__info">
            <span className="take-item__name">Take {i + 1}</span>
            <span className="take-item__date">{formatDate(take.recordedAt)}</span>
          </div>
          <button
            className="take-item__delete"
            onClick={(e) => {
              e.stopPropagation();
              deleteTake(take.id);
            }}
            title="Delete take"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

export default TakeList;
