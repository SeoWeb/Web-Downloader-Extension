## Context

The frontend uses shadcn/ui with Tailwind v4 and CSS custom properties for theming. Light mode tokens in `globals.css` are all achromatic (`oklch(x 0 0)`) — pure grays with zero chroma. This was likely generated from shadcn's "neutral" base color, which produces a minimal but lifeless light palette. Dark mode works better because the dark surfaces provide natural contrast, but light mode suffers from:

- White-on-white layering (background = card = popover = white)
- Near-invisible borders and input edges
- No brand color — primary is just near-black
- A conflicting `@media (prefers-color-scheme: dark)` block that overrides `:root` and fights with `next-themes`

The project uses `next-themes` with `attribute="class"` and `enableSystem`, toggling the `.dark` class on `<html>`. The `@media` dark block is redundant and harmful.

## Goals / Non-Goals

**Goals:**
- Give light mode a cohesive color identity with a blue-indigo brand accent
- Create visible surface layering (background → card → sidebar)
- Fix input/form control visibility in light mode
- Remove the conflicting `@media (prefers-color-scheme: dark)` block
- Use sidebar-specific tokens in the sidebar component
- Add theme toggle to marketing pages

**Non-Goals:**
- Redesigning dark mode (it works fine)
- Changing component structure or layout
- Adding new UI components
- Changing fonts or typography

## Decisions

### 1. Brand color: Blue-indigo (`oklch(0.55 0.2 265)`)

A saturated blue-indigo for `--primary` in light mode. This provides strong contrast on white backgrounds (WCAG AA) and feels professional for a bookmarking/archiving tool.

**Alternatives considered:**
- Teal/cyan: Works but feels more "developer tool" than consumer product
- Pure blue (`240` hue): Too generic, reminds of browser defaults
- Warm amber: Too playful for a productivity tool

### 2. Surface layering strategy

| Token | Current | New | Purpose |
|---|---|---|---|
| `--background` | `oklch(1 0 0)` | `oklch(0.99 0.003 265)` | Very subtle blue-white tint |
| `--card` | `oklch(1 0 0)` | `oklch(1 0 0)` | Pure white (cards pop against tinted bg) |
| `--sidebar` | `oklch(0.985 0 0)` | `oklch(0.975 0.008 265)` | Noticeable blue-gray tint |

This creates a subtle depth hierarchy without adding heavy colors.

### 3. Border contrast bump

`--border` and `--input` move from `oklch(0.922 0 0)` to `oklch(0.90 0.005 265)` — slightly darker with a hint of brand color. This makes form controls and card edges visible on white.

### 4. Remove `@media (prefers-color-scheme: dark)` block

The `.dark` class block (line 132) is the correct mechanism. The `@media` block (lines 51-75) overrides `:root` when OS is dark, fighting with `next-themes` user toggle. Remove it entirely.

### 5. Sidebar uses `bg-sidebar`

Change `sidebar.tsx` from `bg-card` to `bg-sidebar` so the dedicated sidebar tokens are actually used.

## Risks / Trade-offs

- **[Subtle brand tint may feel too subtle]** → The tints are intentionally minimal (0.003-0.008 chroma). If users want more, chroma values can be increased.
- **[Breaking existing screenshots/docs]** → Visual change to all light-mode pages. No API or behavioral changes.
- **[Chart colors still achromatic in light mode]** → Charts use grayscale in light but colored in dark. This is inconsistent but out of scope for this change.
