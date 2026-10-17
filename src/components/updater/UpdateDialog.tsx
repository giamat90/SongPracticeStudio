import { useUpdateDialog } from "@giamat90/mps-core/hooks";

function UpdateDialog() {
  const { visible, status, update, percent, install, dismiss } = useUpdateDialog();

  if (!visible) {
    return null;
  }

  return (
    <div className="update-dialog__overlay">
      <div className="update-dialog__panel">
        {status === "available" && update && (
          <>
            <h2 className="update-dialog__title">Update available</h2>
            <p className="update-dialog__version">
              Version {update.version} is ready to install.
            </p>
            {update.body && <p className="update-dialog__notes">{update.body}</p>}
            <div className="update-dialog__actions">
              <button className="update-dialog__btn-secondary" type="button" onClick={dismiss}>
                Later
              </button>
              <button className="update-dialog__btn-primary" type="button" onClick={install}>
                Install &amp; Restart
              </button>
            </div>
          </>
        )}

        {status === "downloading" && (
          <>
            <h2 className="update-dialog__title">Downloading update…</h2>
            <div className="update-dialog__progress-track">
              <div
                className="update-dialog__progress-fill"
                style={{ width: `${percent}%` }}
              />
            </div>
          </>
        )}

        {status === "ready" && (
          <h2 className="update-dialog__title">Restarting…</h2>
        )}

        {status === "error" && (
          <>
            <h2 className="update-dialog__title">Update failed</h2>
            <p className="update-dialog__notes">
              Something went wrong while installing the update.
            </p>
            <div className="update-dialog__actions">
              <button className="update-dialog__btn-secondary" type="button" onClick={dismiss}>
                Later
              </button>
              <button className="update-dialog__btn-primary" type="button" onClick={install}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default UpdateDialog;
