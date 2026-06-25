import { useAnalysisStore } from "../../stores/analysis";
import { avgCentsDeviation } from "../../audio/analysisUtils";
import type { CoachingTip } from "../../lib/types";

function generateTips(
  takePitch: ReturnType<typeof useAnalysisStore.getState>["takePitch"],
  songPitch: ReturnType<typeof useAnalysisStore.getState>["songPitch"],
  timingDeviations: ReturnType<typeof useAnalysisStore.getState>["timingDeviations"],
  takeVibrato: ReturnType<typeof useAnalysisStore.getState>["takeVibrato"],
  takeDynamics: ReturnType<typeof useAnalysisStore.getState>["takeDynamics"],
  songDynamics: ReturnType<typeof useAnalysisStore.getState>["songDynamics"],
): CoachingTip[] {
  const tips: CoachingTip[] = [];

  // Pitch
  if (takePitch.length > 0 && songPitch.length > 0) {
    const avg = avgCentsDeviation(takePitch, songPitch);
    const absAvg = Math.abs(avg);
    if (absAvg > 20) {
      tips.push({
        category: "pitch",
        title: avg > 0 ? "Tendency to Sing Sharp" : "Tendency to Sing Flat",
        detail: `Your pitch averaged ${Math.round(absAvg)} cents ${avg > 0 ? "sharp (high)" : "flat (low)"}. ${
          avg > 0
            ? "Try relaxing your throat and letting the note settle lower."
            : "Support from the diaphragm can help you reach and sustain pitch."
        }`,
      });
    } else if (absAvg > 8) {
      tips.push({
        category: "pitch",
        title: "Slight Pitch Drift",
        detail: `Average deviation is ${Math.round(absAvg)} cents — nearly there! Focus on long vowels where pitch tends to drift.`,
      });
    } else {
      tips.push({
        category: "pitch",
        title: "Solid Pitch Accuracy",
        detail: "Your pitch tracking is within 8 cents on average — excellent intonation.",
      });
    }
  }

  // Timing
  if (timingDeviations.length > 0) {
    const avgMs =
      timingDeviations.reduce((s, d) => s + d.deltaMs, 0) / timingDeviations.length;
    const late = timingDeviations.filter((d) => d.deltaMs > 80).length;
    const early = timingDeviations.filter((d) => d.deltaMs < -80).length;

    if (avgMs > 60) {
      tips.push({
        category: "timing",
        title: "Running Behind the Beat",
        detail: `Notes arrive ~${Math.round(avgMs)}ms late on average. Try anticipating entries by thinking ahead to the next phrase.`,
      });
    } else if (avgMs < -60) {
      tips.push({
        category: "timing",
        title: "Rushing the Beat",
        detail: `Notes arrive ~${Math.round(-avgMs)}ms early. Take a breath before phrases to set the pace.`,
      });
    } else if (late > timingDeviations.length / 3) {
      tips.push({
        category: "timing",
        title: "Some Late Entries",
        detail: `${late} of ${timingDeviations.length} notes arrived late. Check transitions at phrase boundaries.`,
      });
    } else if (early > timingDeviations.length / 3) {
      tips.push({
        category: "timing",
        title: "Some Early Entries",
        detail: `${early} of ${timingDeviations.length} notes were early. Slow down slightly before entering.`,
      });
    } else {
      tips.push({
        category: "timing",
        title: "Good Rhythmic Placement",
        detail: "Your entries are well-timed relative to the reference.",
      });
    }
  }

  // Vibrato
  if (takeVibrato) {
    const { rate, depth, regularity } = takeVibrato;
    if (rate < 3.5 || rate > 7.5) {
      tips.push({
        category: "vibrato",
        title: rate < 3.5 ? "Slow Vibrato" : "Fast Vibrato",
        detail: `Vibrato rate is ${rate.toFixed(1)} Hz. Classical singing typically targets 4–7 Hz. ${
          rate < 3.5 ? "Speed it up slightly for more life." : "Relax the oscillation a little."
        }`,
      });
    }
    if (depth < 15) {
      tips.push({
        category: "vibrato",
        title: "Narrow Vibrato",
        detail: `Vibrato depth is only ${Math.round(depth)} cents. Aim for 30–80 cents for expressiveness.`,
      });
    } else if (depth > 120) {
      tips.push({
        category: "vibrato",
        title: "Wide Vibrato",
        detail: `Vibrato depth of ${Math.round(depth)} cents is quite wide. Aim for 30–80 cents.`,
      });
    }
    if (regularity < 0.5) {
      tips.push({
        category: "vibrato",
        title: "Uneven Vibrato",
        detail: `Regularity is ${Math.round(regularity * 100)}%. Practice slow sustained notes to build a more even oscillation.`,
      });
    }
    if (rate >= 3.5 && rate <= 7.5 && depth >= 15 && depth <= 120 && regularity >= 0.5) {
      tips.push({
        category: "vibrato",
        title: "Natural Vibrato",
        detail: `Rate ${rate.toFixed(1)} Hz, depth ${Math.round(depth)} ct — your vibrato is well-balanced.`,
      });
    }
  }

  // Dynamics
  if (takeDynamics.length > 0 && songDynamics.length > 0) {
    const avgTake = takeDynamics.reduce((s, d) => s + d.rms, 0) / takeDynamics.length;
    const avgSong = songDynamics.reduce((s, d) => s + d.rms, 0) / songDynamics.length;
    const ratio = avgTake / (avgSong + 1e-9);
    if (ratio < 0.5) {
      tips.push({
        category: "dynamics",
        title: "Singing Too Quietly",
        detail: "Your volume is significantly lower than the reference. Project more and use diaphragmatic support.",
      });
    } else if (ratio > 2.0) {
      tips.push({
        category: "dynamics",
        title: "Singing Too Loudly",
        detail: "Your volume is much higher than the reference. Dial back intensity, especially on high notes.",
      });
    }
  }

  return tips;
}

const CATEGORY_ICONS: Record<CoachingTip["category"], string> = {
  pitch: "♩",
  timing: "♪",
  vibrato: "~",
  dynamics: "◈",
  general: "✦",
};

export default function CoachPanel() {
  const takePitch = useAnalysisStore((s) => s.takePitch);
  const songPitch = useAnalysisStore((s) => s.songPitch);
  const timingDeviations = useAnalysisStore((s) => s.timingDeviations);
  const takeVibrato = useAnalysisStore((s) => s.takeVibrato);
  const takeDynamics = useAnalysisStore((s) => s.takeDynamics);
  const songDynamics = useAnalysisStore((s) => s.songDynamics);
  const isLoaded = useAnalysisStore((s) => s.isLoaded);

  if (!isLoaded || takePitch.length === 0) {
    return (
      <div className="coach-panel coach-panel--empty">
        <p>Select a take to see coaching tips.</p>
      </div>
    );
  }

  const tips = generateTips(takePitch, songPitch, timingDeviations, takeVibrato, takeDynamics, songDynamics);

  return (
    <div className="coach-panel">
      <h3 className="coach-panel__title">Coaching</h3>
      <div className="coach-panel__tips">
        {tips.map((tip, i) => (
          <div key={i} className={`coach-tip coach-tip--${tip.category}`}>
            <div className="coach-tip__header">
              <span className="coach-tip__icon">{CATEGORY_ICONS[tip.category]}</span>
              <span className="coach-tip__title">{tip.title}</span>
            </div>
            <p className="coach-tip__detail">{tip.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
