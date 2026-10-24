"""
Reference bar maps for the meter lab: where every bar of a song starts on its recording, and its
time signature, read from the user's Guitar Pro tab and placed with `tab_sync`.

    python -m meter_lab.reference            # builds datasets/reference/<slug>.json for every song below

A `.mid` export goes through `tab_chords.read_midi`; a `.gp` file through `gp2score.mts` (alphaTab in
Node, the same score the Tab panel builds). Run from `sidecar/` with SPS_NODE_MODULES set for `.gp`.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SIDECAR = HERE.parent
sys.path.insert(0, str(SIDECAR))

import tab_chords  # noqa: E402
import tab_sync  # noqa: E402

LIBRARY = Path.home() / ".songpracticestudio" / "library"
TABS = Path(os.environ.get("MPS_TABS", HERE.parents[2] / "GP-and-MIDI-files"))
OUT = HERE / "datasets" / "reference"

# slug, set, library id prefix, tab file (relative to TABS)
SONGS = [
    ("mercy", "constant", "fc44013f", "Muse-Mercy-10-02-2026.mid"),
    ("beat-it", "constant", "d4ca1b84", "Michael Jackson-Beat It-09-26-2026.mid"),
    ("chop-suey", "constant", "52aee3b7", "System of a Down-Chop Suey!-09-12-2026.mid"),
    ("like-a-stone", "constant", "d18d0ee7", "Audioslave-Like A Stone - Audioslave-11-15-2025.mid"),
    ("war-pigs", "constant", "83661b0d", "Black Sabbath-War Pigs-10-07-2026.mid"),
    ("immigrant-song", "constant", "b9891296", "Led Zeppelin-immigrant song Eb-11-02-2021.mid"),
    ("what-ive-done", "constant", "10b6baba", "Linkin Park-What I've Done-09-29-2026.mid"),
    ("party-in-the-usa", "constant", "e97ed14a", "Miley Cyrus-Party in the U.S.A.-09-24-2026.mid"),
    ("the-kill", "constant", "c65b351d", "Misc Covers-The Kill (Bury Me) by 30 Seconds to Mars-07-19-2025.mid"),
    ("starlight", "constant", "6cfb28cf", "Muse-Starlight-09-22-2026.mid"),
    ("you-oughta-know", "constant", "2333360b", "Alanis Morissette-You Oughta Know-09-27-2026.mid"),
    ("money", "constant", "d7068805", "Pink Floyd-Money-09-30-2026.gp"),
    ("solsbury-hill", "constant", "a2ceb8e7", "Peter Gabriel-Solsbury Hill-09-24-2026.gp"),
    ("schism", "odd", "5951db32", "Tool-Schism-09-23-2026.gp"),
    ("lateralus", "odd", "e3304638", "Tool-Lateralus-10-05-2026.gp"),
    ("pneuma", "odd", "b5a8b095", "Tool-Pneuma-09-18-2026.gp"),
    ("7empest", "odd", "8e646009", "Tool-7empest-09-19-2026.gp"),
]


def song_dir(prefix: str) -> Path:
    return next(p for p in LIBRARY.iterdir() if p.name.startswith(prefix))


def score_and_signatures(tab: Path) -> tuple:
    if tab.suffix == ".mid":
        midi = tab_chords.read_midi(tab)
        score = tab_chords.score_from_midi(midi)
        sigs = [[b["num"], b["den"]] for b in _signature_bars(midi)]
        return score, sigs
    tmp = OUT / (tab.stem + ".score.json")
    root = SIDECAR.parent
    subprocess.run(["node", "--experimental-strip-types", str(HERE / "gp2score.mts"), str(tab), str(tmp)],
                   cwd=root, check=True)
    data = json.loads(tmp.read_text(encoding="utf-8"))
    tmp.unlink()
    return data, data.pop("signatures")


def _signature_bars(midi: dict) -> list:
    sigs = midi["time_signatures"] or [[0, 4, 4]]
    if sigs[0][0] > 0:
        sigs = [[0, sigs[0][1], sigs[0][2]]] + sigs
    out, bars, k = [], tab_chords.bars_from_signatures(midi), 0
    for b in bars:
        while k + 1 < len(sigs) and sigs[k + 1][0] <= b["tick"]:
            k += 1
        out.append({"num": sigs[k][1], "den": sigs[k][2]})
    return out


def build(slug: str, group: str, prefix: str, tab_name: str) -> dict:
    directory = song_dir(prefix)
    stems = {n: str(directory / f"{n}.wav") for n in ("drums", "bass", "guitar", "piano", "other", "vocals")
             if (directory / f"{n}.wav").exists()}
    score, signatures = score_and_signatures(TABS / tab_name)
    aligned = tab_sync.align_tab_to_stems(score, stems)
    bars = []
    for placed in aligned["bars"]:
        num, den = signatures[placed["index"]]
        bars.append({"index": placed["index"], "time": placed["time"], "num": num, "den": den})
    return {"name": slug, "set": group, "song_dir": str(directory), "tab": tab_name, "quality": aligned["quality"],
            "steadiness": aligned["steadiness"], "ear_checked": None, "bars": bars}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for slug, group, prefix, tab_name in SONGS:
        ref = build(slug, group, prefix, tab_name)
        (OUT / f"{slug}.json").write_text(json.dumps(ref), encoding="utf-8")
        kinds = sorted({(b["num"], b["den"]) for b in ref["bars"]})
        print(f"{slug:18} {group:8} {len(ref['bars']):4d} bars  {ref['quality']:6} meters {kinds[:6]}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
