import { MASTER_STEP } from "@giamat90/mps-core/master";
import { useMasterVolume } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";

function MasterVolume() {
  const master = useMasterVolume(usePlayerStore);

  return (
    <div className="master-volume">
      <button
        className="master-volume__btn"
        onClick={master.toggleMute}
        title={master.title}
        aria-label={master.muted ? "Unmute master volume" : "Mute master volume"}
        aria-pressed={master.muted}
      >
        {master.muted ? "🔇" : master.value < 0.5 ? "🔉" : "🔊"}
      </button>
      <input
        type="range"
        className="master-volume__slider"
        min={0}
        max={1}
        step={MASTER_STEP}
        value={master.value}
        onChange={(e) => master.onChange(e.target.value)}
        title={`Master volume ${master.percentText}`}
        aria-label="Master volume"
        aria-valuetext={master.percentText}
      />
      <span className="master-volume__value" aria-hidden="true">{master.percentText}</span>
    </div>
  );
}

export default MasterVolume;
