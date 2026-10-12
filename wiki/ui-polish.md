# UI Polish Layer

Ported from VPS (`ui/polish`). Visual/UX refinement without layout changes.

## Structure

- `src/styles/global.css` — layout and component styles. `:root` now also carries design tokens: `--border`, `--border-strong`, `--bg-raised`, `--accent-soft`, `--accent-ring`, `--info`, `--radius-*`, `--shadow-*`, `--ease`, `--dur*`. (`--border` was previously referenced by `.count-in-btn` but never defined.)
- `src/styles/polish.css` — loaded after `global.css` from `main.tsx`. Pure refinement: focus rings, press feedback, scrollbars, slider styling, card elevation, hover-reveal of rename/delete actions, empty states, entrance animations, `prefers-reduced-motion`. Deleting the file reverts to the previous look.
- All new dimensions are relative units. The 22 remaining layout `px` values in `global.css` were converted to `rem`.

## Accessibility

- Global `:focus-visible` ring (mouse clicks stay clean).
- Icon-only buttons have `aria-label`s; toggles use `aria-pressed` / `aria-expanded`; error/status text uses `role="alert"` / `role="status"`.
- Song cards are keyboard-operable (Enter / Space opens, only when the card itself is focused).
- Rename/delete controls on song cards and takes are revealed on hover **and** `:focus-within`, never hidden from keyboard users.

## SPS-specific

`polish.css` also covers `stem-track`, `stem-picker__chip`, `update-dialog__*`, `analyzer-page__*` and the chord chips. `.stem-track` itself gets no box-shadow because its waveform children would paint over an inset shadow.

## Colour palette (accent diverges from VPS on purpose, 2026-10-12)

VPS and SPS were forks with the same navy + coral-red palette, which made the two windows indistinguishable side by side. SPS keeps the VPS base (`--bg-*`, `--text-*` unchanged) and swaps only the accent family to amber. Several other bases (teal, graphite, espresso, plum, ink, slate) and accents (indigo, magenta, sky blue) were tried live; navy + amber was the choice, with the user's explicit wish that the apps differ **only by accent**.

| Token | VPS | SPS |
|---|---|---|
| `--accent` | `#e94560` | `#d97706` (solid fills carrying white text) |
| `--accent-hover` | `#ff6b81` | `#f59e0b` (also accent text/borders: `.loop-btn--active`, `.legend-dot--take`) |
| `--accent-ring` | `rgba(255,107,129,.75)` | `rgba(252,211,77,.75)` |

Translucent accent overlays (soft backgrounds, glows, the punch region in `TimeRuler.tsx`) are `rgba(245, 158, 11, a)`; the WaveSurfer playhead (`engine.ts` `cursorColor`) is `#fbbf24`. `--warning` stays `#fbbf24` and `STEM_COLORS` is unchanged. Amber sits near the guitar/piano stems, so check playhead and punch-region visibility there when touching it. Do not copy VPS accent values back in when porting CSS.

## App icon

Each app has its own icon, in the same family: dark navy rounded square with a soft glow in the accent colour. SPS: four stacked horizontal stem bars, one in amber. VPS: a five-bar waveform, centre bar in coral. Both were designed in Claude Design, exported at 1024 px and expanded with `npx tauri icon <png> -o src-tauri/icons`; the generated `android/`, `ios/` and `64x64.png` are deleted since the bundle config lists only `32x32`, `128x128`, `128x128@2x`, `icon.icns`, `icon.ico`. Before this both apps shipped the identical default Tauri logo.
