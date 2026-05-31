## ADDED Requirements

### Requirement: Light mode uses brand-tinted color tokens
All light mode semantic color tokens SHALL use the blue-indigo brand hue (oklch hue ~265) where appropriate, rather than pure achromatic grays.

#### Scenario: Background has subtle brand tint
- **WHEN** the user views the app in light mode
- **THEN** the page background SHALL be `oklch(0.99 0.003 265)` — a very slight blue-white

#### Scenario: Cards are pure white against tinted background
- **WHEN** the user views cards in light mode
- **THEN** card backgrounds SHALL be `oklch(1 0 0)` (pure white), creating visible contrast against the tinted page background

#### Scenario: Sidebar has distinct surface color
- **WHEN** the user views the sidebar in light mode
- **THEN** the sidebar background SHALL use `bg-sidebar` which maps to `oklch(0.975 0.008 265)`, visually distinct from both the page background and cards

### Requirement: Primary color is a visible brand accent
The `--primary` token in light mode SHALL be a saturated blue-indigo, not near-black.

#### Scenario: Primary buttons show brand color
- **WHEN** the user views a primary button in light mode
- **THEN** the button background SHALL be `oklch(0.55 0.2 265)` — a visible blue-indigo

#### Scenario: Primary text links show brand color
- **WHEN** the user sees text styled with `text-primary` in light mode
- **THEN** the text SHALL be blue-indigo, not black

### Requirement: Form controls are visible in light mode
Input borders, select borders, and other form control edges SHALL have sufficient contrast against white backgrounds.

#### Scenario: Input borders are visible
- **WHEN** the user views a text input in light mode
- **THEN** the input border SHALL be `oklch(0.90 0.005 265)` — visibly distinct from the white background

#### Scenario: Focused inputs show brand-colored ring
- **WHEN** the user focuses an input in light mode
- **THEN** the focus ring SHALL use the brand-tinted `--ring` color

### Requirement: No conflicting media query dark mode
The `@media (prefers-color-scheme: dark)` block SHALL NOT override `:root` CSS variables. System dark mode preference SHALL be handled exclusively by `next-themes` toggling the `.dark` class.

#### Scenario: User toggles to light mode on dark OS
- **WHEN** the user's OS is in dark mode but they toggle to light mode via the theme switcher
- **THEN** the app SHALL display in light mode with light tokens, not be overridden by the media query

### Requirement: Marketing pages have theme toggle
The marketing layout SHALL include a theme toggle button so users can switch between light and dark mode.

#### Scenario: Theme toggle visible on landing page
- **WHEN** the user visits the marketing/landing pages
- **THEN** a theme toggle button SHALL be visible in the header navigation
