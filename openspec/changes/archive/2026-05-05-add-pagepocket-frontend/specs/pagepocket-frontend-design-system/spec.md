## ADDED Requirements

### Requirement: Tailwind + Design Tokens
The frontend SHALL use Tailwind CSS v4 with a dedicated design-token layer defined in CSS custom properties and exposed to Tailwind.

#### Scenario: Token categories
- **WHEN** the design system is configured
- **THEN** tokens MUST be defined for: colour (background, foreground, muted, primary, accent, destructive, border, ring, card, popover — each with a light and dark variant), radius (sm/md/lg), spacing scale (Tailwind default), and font family (`--font-sans`, `--font-mono`)
- **AND** every token MUST be reachable as a Tailwind utility (e.g. `bg-background`, `text-foreground`)

### Requirement: Component Library
The frontend SHALL include a curated component library based on shadcn/ui (Radix primitives + Tailwind) covering at minimum: Button, Input, Label, Textarea, Select, Combobox, Dialog, DropdownMenu, Tooltip, Tabs, Toggle, Switch, Checkbox, RadioGroup, Avatar, Badge, Card, Skeleton, Table, Toast (sonner), ContextMenu, Command (⌘K palette), Popover.

#### Scenario: Component source
- **WHEN** a component is added
- **THEN** it MUST live under `components/ui/<name>.tsx` with a single default export, Tailwind-based styling using design tokens, and TypeScript prop types derived from the underlying Radix primitive where applicable

#### Scenario: No inline styles
- **WHEN** any component is authored
- **THEN** styling MUST use Tailwind utilities or `data-*`-gated variants only; inline `style={{...}}` MUST NOT be used except for dynamic positioning (portals, virtualisation, drag offsets)

### Requirement: Accessibility Baseline
Every interactive component SHALL meet WCAG 2.1 AA.

#### Scenario: Focus ring
- **WHEN** any interactive element receives keyboard focus
- **THEN** a visible focus ring (2-px, `ring-ring` token, offset 2 px from the element) MUST render

#### Scenario: Color contrast
- **WHEN** the design tokens are audited against WCAG AA
- **THEN** `foreground` on `background`, `primary-foreground` on `primary`, and `destructive-foreground` on `destructive` MUST meet ≥ 4.5:1 contrast in both light and dark modes

#### Scenario: Dialog & menu trap
- **WHEN** a Dialog or DropdownMenu opens
- **THEN** focus MUST move into the popover; Tab and Shift+Tab MUST cycle focus within it; Escape MUST close it and return focus to the trigger

### Requirement: Toast System
The frontend SHALL use `sonner` for toast notifications with consistent variants.

#### Scenario: Variants
- **WHEN** a toast is emitted
- **THEN** one of these variants MUST be used: `success` (auto-dismiss 3 s), `error` (auto-dismiss 6 s, with action button when applicable), `info` (auto-dismiss 4 s), `warning` (auto-dismiss 5 s)
- **AND** the top-right position MUST be used on desktop, bottom-center on viewports < 640 px

### Requirement: Form Primitives
Forms SHALL be built with `react-hook-form` + `zod` with a shared `<Form>` wrapper and per-field error rendering.

#### Scenario: Validation
- **WHEN** a form submits
- **THEN** client-side Zod validation MUST run first; only on validation success MUST the submit fire
- **AND** server-side validation errors (400 with field issues) MUST be surfaced by calling `setError(field, { type: "server", message })` on the matching field

### Requirement: Theme Persistence
The theme toggle SHALL persist the user's preference via `localStorage` (through `next-themes`) and honour `prefers-color-scheme` as the default.

#### Scenario: Persisted preference
- **WHEN** the user selects a theme via `<ThemeToggle />`
- **THEN** the choice MUST be stored in `localStorage` under the key `theme`
- **AND** on subsequent visits the stored theme MUST be applied immediately (no flash)

#### Scenario: System default
- **WHEN** no stored preference exists
- **THEN** the theme MUST follow the user's `prefers-color-scheme` media query

### Requirement: Icon Set
The frontend SHALL use `lucide-react` as the sole icon library.

#### Scenario: Icon usage
- **WHEN** an icon is used
- **THEN** it MUST be imported from `lucide-react` and sized via Tailwind (`size-4`, `size-5`) with no hard-coded pixel sizes on the SVG
