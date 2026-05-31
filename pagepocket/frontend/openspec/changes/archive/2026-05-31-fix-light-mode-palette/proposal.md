## Why

The light mode palette is entirely achromatic — every semantic color token uses `oklch(x 0 0)` (zero chroma). This makes the UI look like an unstyled wireframe: white backgrounds, white cards, near-white borders, and near-black text with no brand identity. Cards blend into the page background, inputs are nearly invisible, and there's no visual hierarchy beyond font weight. Dark mode works better because the darker surfaces create natural contrast, but light mode needs a proper color system.

## What Changes

- Introduce a brand color (blue-indigo family) into `--primary`, `--accent`, `--ring`, and chart tokens for light mode
- Add subtle surface tinting to differentiate layers: `--background` stays white, `--card` gets a very slight warm/cool tint, `--sidebar` gets a slightly more noticeable tint
- Increase `--border` and `--input` contrast so form controls and card edges are visible
- Fix the conflicting `@media (prefers-color-scheme: dark)` block that overrides `:root` variables and fights with `next-themes`
- Make sidebar component use `bg-sidebar` instead of `bg-card`
- Add theme toggle to marketing layout
- Normalize `--destructive-foreground` to oklch format

## Capabilities

### New Capabilities
- `light-mode-palette`: Defines the light mode color tokens, surface layering, and brand color integration

### Modified Capabilities

## Impact

- `src/app/globals.css` — primary file being modified (CSS variables)
- `src/components/ui/card.tsx` — may adjust ring opacity
- `src/components/ui/input.tsx` — light mode background treatment
- `src/components/app/sidebar.tsx` — switch from `bg-card` to `bg-sidebar`
- `src/app/(marketing)/layout.tsx` — add theme toggle
- All components using `bg-card`, `border-border`, `ring-foreground/10` will visually change
