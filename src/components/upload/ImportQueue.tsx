import { useLibraryStore } from "../../stores/library";

function ImportQueue() {
  const processing = useLibraryStore((s) => s.processing);
  const label = useLibraryStore((s) => s.processingLabel);
  const queue = useLibraryStore((s) => s.queue);
  const removeFromQueue = useLibraryStore((s) => s.removeFromQueue);

  if (!processing && queue.length === 0) return null;
  const indeterminate = (processing?.progress ?? 0) < 0;
  const percent = Math.round((processing?.progress ?? 0) * 100);

  return (
    <div className="import-queue" aria-live="polite">
      {processing && (
        <div className="import-queue__running">
          <div className="import-queue__row">
            <span className="import-queue__label" title={label ?? undefined}>{label}</span>
            {!indeterminate && <span className="import-queue__percent">{percent}%</span>}
          </div>
          <div className="import-queue__stage">{processing.stage}</div>
          <div className={indeterminate ? "progress-bar progress-bar--indeterminate" : "progress-bar"}>
            <div className="progress-bar__fill" style={indeterminate ? undefined : { width: `${percent}%` }} />
          </div>
        </div>
      )}
      {queue.length > 0 && (
        <ul className="import-queue__waiting" aria-label="Waiting to be analyzed">
          {queue.map((item, index) => (
            <li className="import-queue__item" key={item.id}>
              <span className="import-queue__position">{index + 1}</span>
              <span className="import-queue__label" title={item.label}>{item.label}</span>
              <button
                className="import-queue__remove"
                type="button"
                onClick={() => removeFromQueue(item.id)}
                aria-label={`Remove ${item.label} from the queue`}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default ImportQueue;
