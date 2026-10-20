import { useState } from "react";
import { CLICK_DENSITIES, barIndexAt, repeatingCycle, unitBpm, type ClickDensity } from "@giamat90/mps-core/meter";
import MeterEditor from "./MeterEditor";
import MeterLane from "./MeterLane";
import MeterOverview from "./MeterOverview";
import { useHitEnvelope } from "./useHitEnvelope";
import { barTitle, meterShares } from "../../lib/meterView";
import { usePlayerStore } from "../../stores/player";
import type { Song } from "../../lib/types";

const PREFS_KEY = "sps_meter_view";
const WINDOWS = [6, 12, 24] as const;
const DENSITY_LABEL: Record<ClickDensity, string> = { pulses: "Every pulse", groups: "Groups", bars: "Bars" };
const DENSITY_HINT: Record<ClickDensity, string> = {
  pulses: "The metronome clicks every pulse, the first of each group louder",
  groups: "The metronome clicks only the start of each group: 7/8 as 3+2+2 gives three clicks",
  bars: "The metronome clicks only the start of each bar",
};

interface Prefs {
  window: (typeof WINDOWS)[number];
  envelope: boolean;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return { window: WINDOWS.find((w) => w === raw?.window) ?? 12, envelope: raw?.envelope !== false };
  } catch (e) {
    console.warn("[MeterPanel] could not read the saved settings:", e);
    return { window: 12, envelope: true };
  }
}

/** Where the playhead is in the bars, kept apart so only this line redraws as the song plays. */
function Readout() {
  const map = usePlayerStore((s) => s.meterMap);
  const index = usePlayerStore((s) => (s.meterMap ? barIndexAt(s.meterMap, s.currentTime) : -1));
  if (!map) return null;
  if (index < 0) return <span className="meter-panel__readout">Outside the bars</span>;
  return (
    <span className="meter-panel__readout" aria-live="off">
      Bar {index + 1} of {map.bars.length} · {barTitle(map, index)} · {Math.round(unitBpm(map, index) * 10) / 10} pulses a minute
    </span>
  );
}

function sourceLabel(source: string, edited: boolean, confidence: number | undefined): string {
  if (edited) return "Your bars";
  if (source === "detected") return confidence === undefined ? "Detected" : `Detected · ${Math.round(confidence * 100)}% sure`;
  if (source === "grid") return "From the tempo, not checked";
  return source === "tapped" ? "Tapped in" : "Your bars";
}

export default function MeterPanel({ song }: { song: Song }) {
  const map = usePlayerStore((s) => s.meterMap);
  const edited = usePlayerStore((s) => s.meterEdited);
  const busy = usePlayerStore((s) => s.meterBusy);
  const error = usePlayerStore((s) => s.meterError);
  const history = usePlayerStore((s) => s.meterHistory.length);
  const selected = usePlayerStore((s) => s.meterSelected);
  const density = usePlayerStore((s) => s.clickDensity);
  const tapping = usePlayerStore((s) => s.tapSession !== null);
  const select = usePlayerStore((s) => s.selectBar);
  const apply = usePlayerStore((s) => s.applyMeter);
  const detect = usePlayerStore((s) => s.detectMeter);
  const fromTempo = usePlayerStore((s) => s.startMeterFromGrid);
  const undo = usePlayerStore((s) => s.undoMeter);
  const reset = usePlayerStore((s) => s.resetMeter);
  const setDensity = usePlayerStore((s) => s.setClickDensity);
  const dismiss = usePlayerStore((s) => s.clearMeterError);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const envelope = useHitEnvelope(song, prefs.envelope && map !== null);

  const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn("[MeterPanel] could not save the settings:", e);
    }
  };

  const shares = map ? meterShares(map) : [];
  const cycle = map ? repeatingCycle(map) : null;
  const pattern = cycle && cycle.length > 1 ? cycle.join("+") : null;
  const hasDrums = song.stems.includes("drums");

  return (
    <section className="meter-panel">
      <header className="meter-panel__head">
        <div className="meter-panel__headline">
          <h2 className="meter-panel__title">Meter</h2>
          <span className="meter-panel__source">{map ? sourceLabel(map.source, edited, map.confidence) : "No bars yet"}</span>
          <Readout />
        </div>
        <div className="meter-panel__actions">
          <button type="button" className="meter-btn" onClick={() => void detect()} disabled={busy || tapping} title="Listen to the song's beat and work out where the bars fall and how long they are">
            {busy ? "Finding bars…" : map ? "Find bars again" : "Find bars"}
          </button>
          <button type="button" className="meter-btn" onClick={() => void fromTempo()} disabled={busy || tapping} title="Start from the song's tempo with four beats to a bar, then correct it">
            {map ? "Start over from the tempo" : "Start from the tempo"}
          </button>
          <button type="button" className="meter-btn" onClick={() => void undo()} disabled={history === 0 || busy} title="Undo the last change to the bars">Undo</button>
          {edited && (
            <button type="button" className="meter-btn" onClick={() => void reset()} disabled={busy} title="Throw away your changes and show what was detected">
              Discard my changes
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="meter-panel__error" role="alert">
          {error} <button type="button" className="meter-link" onClick={dismiss}>Dismiss</button>
        </p>
      )}

      {map && (
        <>
          <div className="meter-panel__summary">
            {shares.slice(0, 5).map((s) => (
              <span key={s.label} className="meter-pill" title={`${s.bars} bars`}>
                {s.label} <small>{Math.round(s.share * 100)}%</small>
              </span>
            ))}
            {shares.length > 5 && <span className="meter-pill meter-pill--more">+{shares.length - 5} more</span>}
            {pattern && <span className="meter-pill meter-pill--pattern" title="A pattern of bar lengths that repeats">Repeats {pattern}</span>}
          </div>

          <MeterOverview map={map} duration={song.duration} />

          <div className="meter-panel__options">
            <div className="roll-seg" role="group" aria-label="What the metronome clicks">
              {CLICK_DENSITIES.map((d) => (
                <button key={d} type="button" className="roll-seg__btn" aria-pressed={density === d} onClick={() => setDensity(d)} title={DENSITY_HINT[d]}>
                  {DENSITY_LABEL[d]}
                </button>
              ))}
            </div>
            <label className="roll-field">
              <span className="roll-field__label">Window</span>
              <select className="roll-select" value={prefs.window} onChange={(e) => setPref("window", Number(e.target.value) as Prefs["window"])} aria-label="Seconds shown">
                {WINDOWS.map((w) => <option key={w} value={w}>{w} s</option>)}
              </select>
            </label>
            {hasDrums && (
              <button type="button" className="roll-chip" aria-pressed={prefs.envelope} onClick={() => setPref("envelope", !prefs.envelope)} title="Draw where the drums hit under the bars, to see whether a bar line lands on one">
                Show the drums
              </button>
            )}
          </div>

          <MeterLane
            map={map}
            duration={song.duration}
            windowSeconds={prefs.window}
            envelope={prefs.envelope ? envelope : null}
            selected={selected}
            onSelect={select}
            onMoveBar={(next) => void apply(next, selected)}
          />
          <p className="meter-panel__hint">
            Click to go there · drag to scrub · click a bar to edit it · drag the amber handle at its left to move where it starts · the metronome in the tempo box follows these bars
          </p>
        </>
      )}

      <MeterEditor song={song} map={map} selected={map && selected !== null && selected < map.bars.length ? selected : null} />
    </section>
  );
}
