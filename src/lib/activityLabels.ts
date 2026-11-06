// Command name -> the sentence shown while it runs. A command left out is fast or
// reports its own progress (process_song, import_youtube, import_song_tab, align_song_tab,
// lyrics sync, updates).
export const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  pitch_shift_song: "Transposing…",
  save_take: "Analyzing take…",
  export_stem: "Exporting audio…",
  export_take: "Exporting take…",
  export_mix: "Exporting mix…",
  export_all: "Zipping tracks…",
  export_file: "Exporting file…",
  read_song_chords: "Loading chords…",
  redetect_song_chords: "Detecting chords…",
  read_note_roll: "Loading note roll…",
  read_song_meter: "Loading meter…",
  redetect_song_meter: "Detecting meter…",
  read_song_tab: "Loading tab…",
  save_edited_tab: "Saving tab…",
  read_tab_transposed: "Transposing tab…",
  save_tab_transposed: "Transposing tab…",
};
