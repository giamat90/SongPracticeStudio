import { useEffect, useState } from "react";
import { getEngine, usePlayerStore } from "../../stores/player";
import { readNoteRoll, saveNoteRoll } from "../../lib/tauri";
import { computeNoteMatrix, decodeRoll, encodeRoll, type NoteMatrix } from "../../lib/noteRoll";
import type { Song } from "../../lib/types";

/** How long to wait for the stems to be decoded before analysing the ones that are: the player loads them one by one. */
const DECODE_WAIT_MS = 120_000;
const DECODE_POLL_MS = 500;

export interface NoteRollState {
  matrices: Record<string, NoteMatrix>;
  /** Semitones the stems were shifted by when the matrices were made; the roll moves its notes by the difference to now. */
  analysedAt: number;
  /** What the analysis is doing, for the header; null when it is idle. */
  status: string | null;
  /** How far the analysis is, 0 to 1; null when it is not analysing. */
  progress: number | null;
  error: string | null;
  /** Throw the saved notes away and analyse again. */
  reanalyse: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function decoded(name: string): boolean {
  return getEngine().getStemSamples([name], 0, 0.05) !== null;
}

/**
 * The note strengths of a song's stems for the chord roll: the saved ones when the song has them, otherwise
 * analysed from the decoded stems (once the player has them) and saved, so the next visit opens ready.
 */
export function useNoteRoll(song: Song, stems: readonly string[], enabled: boolean): NoteRollState {
  const [matrices, setMatrices] = useState<Record<string, NoteMatrix>>({});
  const [analysedAt, setAnalysedAt] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState(0);

  useEffect(() => {
    setMatrices({});
    setStatus(null);
    setProgress(null);
    setError(null);
    if (!enabled || !song.hasChords || stems.length === 0) return;
    let cancelled = false;

    const analyse = async () => {
      setStatus("Waiting for the audio…");
      for (let waited = 0; waited < DECODE_WAIT_MS && !cancelled; waited += DECODE_POLL_MS) {
        if (stems.every(decoded)) break;
        await sleep(DECODE_POLL_MS);
      }
      if (cancelled) return;
      const at = usePlayerStore.getState().transpose;
      const out: Record<string, NoteMatrix> = {};
      for (let i = 0; i < stems.length && !cancelled; i++) {
        const got = getEngine().getStemSamples([stems[i]], 0, song.duration);
        if (!got) continue;
        out[stems[i]] = await computeNoteMatrix(got.samples, got.sampleRate, (done) => {
          if (cancelled) return;
          setProgress((i + done) / stems.length);
          setStatus(`Analysing notes ${Math.round(((i + done) / stems.length) * 100)}%`);
        });
        if (cancelled) return;
        setAnalysedAt(at);
        setMatrices({ ...out });
      }
      if (cancelled) return;
      setStatus(null);
      setProgress(null);
      if (Object.keys(out).length === 0) {
        setError("No audio to analyse yet.");
        return;
      }
      saveNoteRoll(song.id, encodeRoll(out, at)).catch((e: unknown) => console.error("[useNoteRoll] saving the notes failed:", e));
    };

    const start = async () => {
      try {
        if (force === 0) {
          setStatus("Loading the saved notes…");
          const text = await readNoteRoll(song.id);
          const saved = text === null ? null : decodeRoll(text);
          if (cancelled) return;
          if (saved) {
            setMatrices(saved.matrices);
            setAnalysedAt(saved.transpose);
            setStatus(null);
            return;
          }
        }
        await analyse();
      } catch (e) {
        console.error("[useNoteRoll] the analysis failed:", e);
        if (!cancelled) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void start();
    return () => { cancelled = true; };
  }, [song.id, song.hasChords, song.duration, stems, enabled, force]);

  return { matrices, analysedAt, status, progress, error, reanalyse: () => setForce((n) => n + 1) };
}
