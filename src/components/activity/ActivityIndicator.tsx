import { useActivity } from "@giamat90/mps-core/hooks";
import { useActivityStore } from "../../stores/activity";

function ActivityIndicator() {
  const activity = useActivity(useActivityStore);
  if (!activity.visible) return null;

  const percent = activity.progress === null ? null : Math.round(activity.progress * 100);

  return (
    <div className="activity" role="status" aria-live="polite">
      <div className={`activity__bar${percent === null ? " activity__bar--indeterminate" : ""}`}>
        <div className="activity__bar-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      <div className="activity__pill">
        <span className="activity__spinner" aria-hidden="true" />
        <span className="activity__label">{activity.label}</span>
        {percent !== null && <span className="activity__percent">{percent}%</span>}
        {activity.others > 0 && <span className="activity__more">+{activity.others} more</span>}
      </div>
    </div>
  );
}

export default ActivityIndicator;
