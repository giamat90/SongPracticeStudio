"""
Make a data set from a list of songs and their reference charts.

    python chord_lab\\import_set.py path\\to\\manifest.json isophonics --copy-audio --align \\
        --description "12 Beatles and Queen songs vs the Isophonics charts"
    python chord_lab\\import_set.py path\\to\\manifest.json tabs \\
        --description "11 songs vs charts read from the user's Guitar Pro tabs"

The input is the JSON list chord_eval.py reads: {"name", "song_dir", "ref"} per
song, paths relative to that file. The charts are copied into
datasets/<name>/. With --copy-audio each song folder's .wav files (the source
and its stems) are copied too, so the set no longer depends on where it came
from; without it the manifest points at the original folders (a path under your
home is stored as ~/..., so it still resolves on the same account).
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab


def portable(path: Path) -> str:
    try:
        return "~/" + path.resolve().relative_to(Path.home()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("manifest")
    ap.add_argument("name", help="name of the new data set")
    ap.add_argument("--description", default="")
    ap.add_argument("--align", action="store_true", help="the charts need a constant offset found before scoring")
    ap.add_argument("--copy-audio", action="store_true")
    args = ap.parse_args(argv)

    source = Path(args.manifest)
    target = lab.DATASETS / args.name
    if (target / "manifest.json").exists():
        raise SystemExit(f"{target} already has a manifest; remove the folder to rebuild it")
    target.mkdir(parents=True, exist_ok=True)

    songs = []
    for entry in json.loads(source.read_text(encoding="utf-8")):
        song_dir = (source.parent / entry["song_dir"]).resolve()
        ref = (source.parent / entry["ref"]).resolve()
        name = entry.get("name") or song_dir.name
        shutil.copy2(ref, target / ref.name)
        if args.copy_audio:
            slug = song_dir.name
            (target / slug).mkdir(exist_ok=True)
            for wav in song_dir.glob("*.wav"):
                print(f"  {slug}/{wav.name}", file=sys.stderr)
                shutil.copy2(wav, target / slug / wav.name)
            location = slug
        else:
            location = portable(song_dir)
        songs.append({"name": name, "song_dir": location, "ref": ref.name})

    (target / "manifest.json").write_text(json.dumps(
        {"description": args.description, "align": args.align, "songs": songs}, indent=2), encoding="utf-8")
    print(f"wrote {target / 'manifest.json'} ({len(songs)} songs)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
