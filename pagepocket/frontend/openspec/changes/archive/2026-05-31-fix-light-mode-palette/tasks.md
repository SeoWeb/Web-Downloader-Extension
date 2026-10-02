## 1. Fix CSS Variables

- [x] 1.1 Replace light mode `:root` tokens in `globals.css` with brand-tinted palette (background, card, sidebar, primary, border, input, ring, accent, muted, charts)
- [x] 1.2 Remove the `@media (prefers-color-scheme: dark) { :root { ... } }` block (lines 51-75)
- [x] 1.3 Normalize `--destructive-foreground` from hex to oklch format

## 2. Component Fixes

- [x] 2.1 Change sidebar `bg-card` to `bg-sidebar` in `src/components/app/sidebar.tsx`
- [x] 2.2 Add `bg-input/20` to input component for light mode visibility (matching dark mode's `dark:bg-input/30` pattern)

## 3. Marketing Theme Toggle

- [x] 3.1 Add `ThemeToggle` to marketing layout header in `src/app/(marketing)/layout.tsx`

## 4. Verification

- [x] 4.1 Verify light mode renders correctly: tinted background, white cards, visible borders, blue-indigo primary buttons
- [x] 4.2 Verify dark mode still works correctly after removing media query block
- [x] 4.3 Verify theme toggle works on marketing pages
- [x] 4.4 Run `npm run build` to check for errors
