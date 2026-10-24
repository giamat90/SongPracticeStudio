import { hiddenTrackTags } from "@giamat90/mps-core/hooks";
import { createPanelStore } from "@giamat90/mps-core/panels";
import type { StemName } from "../lib/types";

// What the user wants to see of the area under the topbar. Not part of panels.ts:
// those panels are unmounted when hidden and can be moved or detached, whereas
// the stems own what the audio engine draws into, so hiding them only collapses
// them and the audio is never affected. `waveforms` is the whole stem area and
// the stem ids are its tracks, where "not visible" means shrunk to the strip
// with the name, M, S and volume (the arrow on the strip, or the Panels menu);
// recorded takes have their own show/hide in the take list. The bass tab and the imported Guitar Pro tab
// sit under the stems and are plain show/hide.
export const WAVEFORM_PANELS = [
  { id: "waveforms", label: "Waveforms", defaultVisible: true },
  { id: "bassTab", label: "Bass tab", defaultVisible: true },
  { id: "songTab", label: "Tab", defaultVisible: true },
  { id: "vocals", label: "Vocals", defaultVisible: true },
  { id: "drums", label: "Drums", defaultVisible: true },
  { id: "bass", label: "Bass", defaultVisible: true },
  { id: "guitar", label: "Guitar", defaultVisible: true },
  { id: "piano", label: "Piano", defaultVisible: true },
  { id: "other", label: "Other", defaultVisible: true },
] as const;

export type WaveformPanelId = (typeof WAVEFORM_PANELS)[number]["id"];

export const useWaveformPanels = createPanelStore({ storageKey: "sps_waveforms", panels: WAVEFORM_PANELS });

type Visible = Readonly<Record<WaveformPanelId, boolean>>;

export interface WaveformMenuItem {
  id: WaveformPanelId;
  label: string;
  parts?: readonly { id: WaveformPanelId; label: string }[];
}

const LABELS = Object.fromEntries(WAVEFORM_PANELS.map((p) => [p.id, p.label])) as Record<WaveformPanelId, string>;

/** What the Panels menu offers for a song: its own stems under the waveforms, the bass tab if there is a bass, and the imported tab. */
export function waveformMenuItems(stems: readonly StemName[]): WaveformMenuItem[] {
  const items: WaveformMenuItem[] = [
    { id: "waveforms", label: LABELS.waveforms, parts: stems.map((id) => ({ id, label: LABELS[id] })) },
  ];
  if (stems.includes("bass")) items.push({ id: "bassTab", label: LABELS.bassTab });
  items.push({ id: "songTab", label: LABELS.songTab });
  return items;
}

/** Why a minimized stem may be silent or alone: its waveform is shrunk to a strip but its mute and solo still apply. */
export function hiddenStemTags(
  visible: Visible,
  {
    stems,
    muted,
    soloed,
  }: { stems: readonly StemName[]; muted: Readonly<Partial<Record<string, boolean>>>; soloed: string | null },
): Partial<Record<WaveformPanelId, string>> {
  return hiddenTrackTags(visible, stems, { muted, soloed });
}
