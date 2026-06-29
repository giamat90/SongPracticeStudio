import type { RefCallback } from "react";
import { usePlayerStore } from "../../stores/player";
import { exportStem } from "../../lib/tauri";
import type { Song } from "../../lib/types";

const STEM_ICONS: Record<string, string> = {
  vocals: "🎤",
  drums:  "🥁",
  bass:   "🎸",
  guitar: "🎸",
  piano:  "🎹",
  other:  "🎵",
};

interface StemTrackProps {
  name: string;
  song: Song;
  containerRef: RefCallback<HTMLDivElement>;
}

function PunchOverlay() {
  const punchIn  = usePlayerStore((s) => s.punchIn);
  const punchOut = usePlayerStore((s) => s.punchOut);
  const duration = usePlayerStore((s) => s.duration);
  if (punchIn === null || punchOut === null || duration <= 0) return null;
  return (
    <div
      className="waveform__punch-overlay"
      style={{
        left:  `${(punchIn  / duration) * 100}%`,
        width: `${((punchOut - punchIn) / duration) * 100}%`,
      }}
    />
  );
}

function StemTrack({ name, song, containerRef }: StemTrackProps) {
  const volume       = usePlayerStore((s) => s.stemVolumes[name] ?? 1.0);
  const isMuted      = usePlayerStore((s) => !!s.mutedStems[name]);
  const soloedStem   = usePlayerStore((s) => s.soloedStem);
  const isSoloed     = soloedStem === name;
  const setStemVolume = usePlayerStore((s) => s.setStemVolume);
  const toggleMute   = usePlayerStore((s) => s.toggleMute);
  const toggleSolo   = usePlayerStore((s) => s.toggleSolo);

  const stemPath = `${song.directory.replace(/\\/g, "/")}/${name}.wav`;
  const icon     = STEM_ICONS[name] ?? "🎵";
  const label    = name.charAt(0).toUpperCase() + name.slice(1);

  const handleDownload = () => {
    exportStem(stemPath, `${song.title} - ${label}.wav`).catch((e) =>
      console.error("[StemTrack] export failed:", e)
    );
  };

  return (
    <div className="stem-track">
      <div className="stem-track__header">
        <span className="stem-track__label">{icon} {label}</span>
        <div className="stem-track__controls">
          <button
            className={`stem-track__mute${isMuted ? " stem-track__mute--on" : ""}`}
            onClick={() => toggleMute(name)}
            title={isMuted ? "Unmute" : "Mute"}
          >
            M
          </button>
          <button
            className={`stem-track__solo${isSoloed ? " stem-track__solo--on" : ""}`}
            onClick={() => toggleSolo(name)}
            title={isSoloed ? "Unsolo" : "Solo"}
          >
            S
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setStemVolume(name, Number(e.target.value))}
            className="stem-track__volume"
            title={`${label} volume`}
          />
          <button
            className="stem-track__download"
            onClick={handleDownload}
            title={`Download ${label}`}
          >
            ↓
          </button>
        </div>
      </div>
      <div className="stem-track__body">
        <div className="stem-track__wave" ref={containerRef} />
        <PunchOverlay />
      </div>
    </div>
  );
}

export default StemTrack;
