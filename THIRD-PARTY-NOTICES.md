# Third-Party Notices

This application bundles the following third-party software.

## ffmpeg

Song Practice Studio bundles a static `ffmpeg` executable, invoked as a
separate subprocess by the Python sidecar (it is not statically or
dynamically linked into any compiled binary in this application).

- Project: https://ffmpeg.org
- License: GNU Lesser General Public License v2.1 or later (LGPL). See
  `ffmpeg-LICENSE.txt` alongside this file, or
  https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- Windows build source: https://github.com/BtbN/FFmpeg-Builds
- macOS build source: https://github.com/eugeneware/ffmpeg-static (release b6.1.1, FFmpeg 6.1.1 static build, arm64)

## alphaTab and the Bravura music font

The Tab panel reads and draws Guitar Pro files with alphaTab, bundled into the
application's JavaScript, together with the Bravura music font it loads.

- alphaTab: https://github.com/CoderLine/alphaTab, Mozilla Public License 2.0,
  Copyright Daniel Kuschny and contributors. Unmodified; its source is at the
  address above.
- Bravura: https://github.com/steinbergmedia/bravura, SIL Open Font License 1.1,
  Copyright Steinberg Media Technologies GmbH.

## Deno and yt-dlp-ejs

The sidecar bundles the `deno` executable, run as a separate subprocess by
yt-dlp to solve YouTube's signature challenges, together with the
`yt-dlp-ejs` solver scripts.

- Deno: https://deno.com, MIT License, Copyright the Deno authors
- yt-dlp-ejs: https://github.com/yt-dlp/ejs, Unlicense (public domain)

## Demucs pretrained model weights

Song Practice Studio bundles pretrained weights for the `htdemucs` and
`htdemucs_6s` models from the Demucs project (Meta Platforms, Inc.).

- Project: https://github.com/facebookresearch/demucs
- License: MIT (code); weights distributed under the same repository terms
- Source: https://dl.fbaipublicfiles.com/demucs/
