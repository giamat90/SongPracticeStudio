import { useEffect, useState } from "react";
import {
  UNITS,
  barEnd,
  barGroups,
  fillCycle,
  formatSignature,
  mergeBars,
  relabelBars,
  removeBar,
  repeatingCycle,
  rescalePulse,
  setBarStart,
  shiftBars,
  shiftDownbeat,
  splitBar,
  unitBpm,
  type BarMap,
} from "@giamat90/mps-core/meter";
import { barRange, barTitle, formatStamp, groupPresets, parseCycle, parseGroups, type ApplyScope } from "../../lib/meterView";
import { getEngine, usePlayerStore } from "../../stores/player";
import type { Song } from "../../lib/types";

interface Props {
  song: Song;
  map: BarMap | null;
  selected: number | null;
}

const NUDGES_MS = [-50, -10, 10, 50];
const SCOPES: Array<{ id: ApplyScope; label: string }> = [
  { id: "bar", label: "this bar" },
  { id: "run", label: "until the signature changes" },
  { id: "end", label: "to the end" },
];

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What can be done to the bar that is picked, and the tools that do not need one: count it differently, move it,
 * split or join it, repeat a pattern from it, tap new bars in. Every change is stored at once and can be undone.
 */
export default function MeterEditor({ song, map, selected }: Props) {
  const apply = usePlayerStore((s) => s.applyMeter);
  const seek = usePlayerStore((s) => s.seek);
  const applyLoopRegion = usePlayerStore((s) => s.applyLoopRegion);
  const tapSession = usePlayerStore((s) => s.tapSession);
  const startTapping = usePlayerStore((s) => s.startTapping);
  const tapNow = usePlayerStore((s) => s.tapNow);
  const finishTapping = usePlayerStore((s) => s.finishTapping);
  const cancelTapping = usePlayerStore((s) => s.cancelTapping);

  const bar = map && selected !== null ? map.bars[selected] : undefined;
  const [scope, setScope] = useState<ApplyScope>("bar");
  const [countText, setCountText] = useState("");
  const [groupsText, setGroupsText] = useState("");
  const [cycleText, setCycleText] = useState("");
  const [fillBpm, setFillBpm] = useState("");
  const [fillDen, setFillDen] = useState(4);
  const [fillUntil, setFillUntil] = useState<"end" | "run">("end");
  const [tapKind, setTapKind] = useState<"bars" | "beats">("bars");
  const [tapDen, setTapDen] = useState(4);
  const [tapPerBar, setTapPerBar] = useState("4");
  const [tapBpm, setTapBpm] = useState("");

  const signature = bar ? `${selected}:${bar.num}/${bar.den}:${barGroups(bar).join("+")}` : "";
  useEffect(() => {
    if (!map || !bar || selected === null) return;
    setCountText(String(bar.num));
    setGroupsText(barGroups(bar).join("+"));
    setCycleText((repeatingCycle(map) ?? [bar.num]).join("+"));
    setFillBpm(String(round1(unitBpm(map, selected))));
    setFillDen(bar.den);
    setTapDen(bar.den);
    setTapPerBar(String(bar.num));
    setTapBpm(String(round1(unitBpm(map, selected))));
    // The fields start from the bar and follow it when it is counted another way, but not when other bars change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    if (!tapSession) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
      if (e.key.toLowerCase() !== "t" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      tapNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tapSession, tapNow]);

  const [from, to] = map && bar && selected !== null ? barRange(map, selected, scope) : [0, 0];
  const now = () => getEngine().getCurrentTime();

  const relabel = (patch: Parameters<typeof relabelBars>[3]) => {
    if (!map || selected === null) return;
    void apply(relabelBars(map, from, to, patch));
  };

  const setGroups = (groups: number[]) => {
    if (!map || selected === null || !bar) return;
    let next: BarMap | null = map;
    for (let i = from; i <= to && next; i++) {
      if (map.bars[i].num === groups.reduce((a, b) => a + b, 0)) next = relabelBars(next, i, i, { groups });
    }
    void apply(next === map ? null : next);
  };

  const commitCount = () => {
    const n = Number(countText);
    if (!bar || !Number.isInteger(n)) {
      setCountText(String(bar?.num ?? ""));
      return;
    }
    if (n !== bar.num) relabel({ num: n });
  };

  const commitGroups = () => {
    if (!bar) return;
    const groups = parseGroups(groupsText, bar.num);
    if (!groups) {
      setGroupsText(barGroups(bar).join("+"));
      return;
    }
    setGroups(groups);
  };

  const fill = () => {
    if (!map || selected === null) return;
    const cycle = parseCycle(cycleText);
    const bpm = Number(fillBpm);
    if (!cycle || !(bpm > 0)) return;
    const until = fillUntil === "end" ? null : barRange(map, selected, "run")[1] + 1;
    void apply(fillCycle(map, { from: selected, until: until !== null && until >= map.bars.length ? null : until, cycle, den: fillDen, pulse: 60 / bpm }), selected);
  };

  const beginTapping = () => {
    const bpm = Number(tapBpm);
    const perBar = Math.round(Number(tapPerBar));
    if (tapKind === "bars" && !(bpm > 0)) return;
    if (tapKind === "beats" && !(perBar >= 1)) return;
    startTapping({ kind: tapKind, den: tapDen, perBar: Math.max(1, perBar || 1), pulse: bpm > 0 ? 60 / bpm : 0.5 });
  };

  return (
    <div className="meter-editor">
      {map && bar && selected !== null ? (
        <div className="meter-editor__group" role="group" aria-label={`Bar ${selected + 1}`}>
          <div className="meter-editor__head">
            <strong>Bar {selected + 1}</strong>
            <span>{barTitle(map, selected)}</span>
            <span>{formatStamp(bar.start)} to {formatStamp(barEnd(map, selected))}</span>
            <span>{round1(unitBpm(map, selected))} pulses a minute</span>
          </div>

          <div className="meter-row">
            <label className="roll-field">
              <span className="roll-field__label">Pulses</span>
              <input
                className="meter-input"
                type="number"
                min={1}
                max={32}
                value={countText}
                onChange={(e) => setCountText(e.target.value)}
                onBlur={commitCount}
                onKeyDown={(e) => e.key === "Enter" && commitCount()}
                aria-label="Pulses in the bar"
              />
            </label>
            <label className="roll-field">
              <span className="roll-field__label">of a</span>
              <select className="roll-select" value={bar.den} onChange={(e) => relabel({ den: Number(e.target.value) })} aria-label="The note that is one pulse">
                {UNITS.map((u) => <option key={u} value={u}>1/{u} note</option>)}
              </select>
            </label>
            <label className="roll-field">
              <span className="roll-field__label">Change</span>
              <select className="roll-select" value={scope} onChange={(e) => setScope(e.target.value as ApplyScope)} aria-label="How many bars a change reaches">
                {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
          </div>

          <div className="meter-row">
            <span className="roll-field__label">Accents</span>
            <div className="roll-chips" role="group" aria-label="Ways to group the pulses">
              {groupPresets(bar.num).map((g) => (
                <button
                  key={g.join("+")}
                  type="button"
                  className="roll-chip"
                  aria-pressed={g.join("+") === barGroups(bar).join("+")}
                  onClick={() => setGroups(g)}
                >
                  {g.join("+")}
                </button>
              ))}
            </div>
            <input
              className="meter-input meter-input--wide"
              value={groupsText}
              onChange={(e) => setGroupsText(e.target.value)}
              onBlur={commitGroups}
              onKeyDown={(e) => e.key === "Enter" && commitGroups()}
              aria-label="Groups, such as 3+2+2"
              title="Type your own, such as 2+2+3; it has to add up to the pulses in the bar"
            />
          </div>

          <div className="meter-row">
            <button type="button" className="meter-btn" onClick={() => seek(bar.start)}>Go to</button>
            <button type="button" className="meter-btn" onClick={() => applyLoopRegion(bar.start, barEnd(map, selected))} title="Loop this bar">Loop bar</button>
            <button type="button" className="meter-btn" onClick={() => void apply(setBarStart(map, selected, now()), selected)} title="Make the bar start where the playhead is">Start here</button>
            <button type="button" className="meter-btn" onClick={() => void apply(splitBar(map, selected, now()), selected)} title="Cut the bar in two at the playhead">Split here</button>
            <button type="button" className="meter-btn" onClick={() => void apply(mergeBars(map, selected), selected)} title="Join the next bar into this one">Join next</button>
            <button type="button" className="meter-btn" onClick={() => void apply(removeBar(map, selected), Math.max(0, Math.min(selected, map.bars.length - 2)))} title="Take this bar away; the one before runs on over it">Remove</button>
            <button type="button" className="meter-btn" onClick={() => void apply(rescalePulse(map, from, to, 2), selected)} title="Count twice as many pulses in the same time: 4/4 becomes 8/8">Count finer</button>
            <button type="button" className="meter-btn" onClick={() => void apply(rescalePulse(map, from, to, 0.5), selected)} title="Count half as many pulses in the same time: 8/8 becomes 4/4">Count coarser</button>
          </div>

          <div className="meter-row">
            <span className="roll-field__label">Repeat from here</span>
            <input className="meter-input meter-input--wide" value={cycleText} onChange={(e) => setCycleText(e.target.value)} aria-label="Pattern of pulses, such as 5+7" title="Pulses in each bar in turn, repeated: 5+7, or 9+8+7" />
            <label className="roll-field">
              <span className="roll-field__label">of a</span>
              <select className="roll-select" value={fillDen} onChange={(e) => setFillDen(Number(e.target.value))} aria-label="The note that is one pulse in the pattern">
                {UNITS.map((u) => <option key={u} value={u}>1/{u}</option>)}
              </select>
            </label>
            <label className="roll-field">
              <input className="meter-input" type="number" min={20} max={900} step={0.1} value={fillBpm} onChange={(e) => setFillBpm(e.target.value)} aria-label="Pulses a minute" />
              <span className="roll-field__label">a minute</span>
            </label>
            <select className="roll-select" value={fillUntil} onChange={(e) => setFillUntil(e.target.value as "end" | "run")} aria-label="How far the pattern reaches">
              <option value="end">to the end</option>
              <option value="run">until {formatSignature(bar)} stops</option>
            </select>
            <button type="button" className="meter-btn meter-btn--primary" onClick={fill}>Repeat</button>
          </div>
        </div>
      ) : (
        <p className="meter-editor__hint">
          {map ? "Click a bar above to count it differently, move it, split it or repeat a pattern from it." : "There are no bars yet: find them, start from the tempo, or tap them in below."}
        </p>
      )}

      {map && (
      <div className="meter-editor__group" role="group" aria-label="Whole song">
        <div className="meter-row">
          <span className="roll-field__label">First beat of every bar</span>
          <button type="button" className="meter-btn" disabled={!map} onClick={() => map && void apply(shiftDownbeat(map, -1))} title="The beat before is the first beat: every bar line moves back one pulse">&larr; a pulse earlier</button>
          <button type="button" className="meter-btn" disabled={!map} onClick={() => map && void apply(shiftDownbeat(map, 1))} title="The beat after is the first beat: every bar line moves on one pulse">a pulse later &rarr;</button>
        </div>
        <div className="meter-row">
          <span className="roll-field__label">Shift every bar</span>
          {NUDGES_MS.map((ms) => (
            <button key={ms} type="button" className="meter-btn" disabled={!map} onClick={() => map && void apply(shiftBars(map, ms / 1000))} title="Move every bar line by this much">
              {ms > 0 ? `+${ms}` : ms} ms
            </button>
          ))}
        </div>
      </div>
      )}

      <div className="meter-editor__group" role="group" aria-label="Tap the bars in">
        {tapSession ? (
          <div className="meter-row">
            <button type="button" className="meter-tap" onClick={tapNow}>Tap ({tapSession.taps.length})</button>
            <span className="meter-editor__hint">
              {tapSession.kind === "bars"
                ? "Play the song and tap T on the first beat of every bar, and once more where the last bar ends."
                : `Play the song and tap T on every beat; every ${tapSession.perBar} taps make a bar.`}
            </span>
            <button type="button" className="meter-btn meter-btn--primary" onClick={() => void finishTapping()}>Done</button>
            <button type="button" className="meter-btn" onClick={cancelTapping}>Cancel</button>
          </div>
        ) : (
          <div className="meter-row">
            <span className="roll-field__label">Tap along</span>
            <div className="roll-seg" role="group" aria-label="What each tap marks">
              <button type="button" className="roll-seg__btn" aria-pressed={tapKind === "bars"} onClick={() => setTapKind("bars")}>Each bar</button>
              <button type="button" className="roll-seg__btn" aria-pressed={tapKind === "beats"} onClick={() => setTapKind("beats")}>Each beat</button>
            </div>
            <label className="roll-field">
              <span className="roll-field__label">pulse is a</span>
              <select className="roll-select" value={tapDen} onChange={(e) => setTapDen(Number(e.target.value))} aria-label="The note that is one pulse">
                {UNITS.map((u) => <option key={u} value={u}>1/{u}</option>)}
              </select>
            </label>
            {tapKind === "bars" ? (
              <label className="roll-field">
                <input className="meter-input" type="number" min={20} max={900} step={0.1} value={tapBpm || String(round1((song.detectedBpm ?? 120) * (tapDen / 4)))} onChange={(e) => setTapBpm(e.target.value)} aria-label="Pulses a minute" />
                <span className="roll-field__label">pulses a minute</span>
              </label>
            ) : (
              <label className="roll-field">
                <input className="meter-input" type="number" min={1} max={32} value={tapPerBar} onChange={(e) => setTapPerBar(e.target.value)} aria-label="Beats in a bar" />
                <span className="roll-field__label">beats a bar</span>
              </label>
            )}
            <button type="button" className="meter-btn meter-btn--primary" onClick={beginTapping}>Start tapping</button>
          </div>
        )}
      </div>
    </div>
  );
}
