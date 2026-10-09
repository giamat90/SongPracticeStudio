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
