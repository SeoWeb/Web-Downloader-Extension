# Accessibility Audit Report

**Date:** 2026-05-05
**Scope:** All major routes and components
**Standard:** WCAG 2.1 AA

## Routes Audited

| Route | Component Path | Status |
|-------|---------------|--------|
| `/` (landing) | `app/(marketing)/page.tsx` | Reviewed |
| `/pricing` | `app/(marketing)/pricing/page.tsx` | Reviewed |
| `/features` | `app/(marketing)/features/page.tsx` | Reviewed |
| `/login` | `app/(marketing)/login/page.tsx` | Reviewed |
| `/register` | `app/(marketing)/register/page.tsx` | Reviewed |
| `/app` | `app/(app)/app/page.tsx` | Reviewed |
| `/app/pages/[id]` | `app/(app)/pages/[pageId]/page.tsx` | Reviewed |
| `/app/search` | `app/(app)/search/page.tsx` | Reviewed |
| `/app/collections/[id]` | `app/(app)/collections/[id]/page.tsx` | Reviewed |
| `/s/[token]` | `app/(share)/s/[token]/page.tsx` | Reviewed |

## Critical Issues

### C1. Form error messages not associated with inputs
- **Routes:** `/login`, `/register`
- **Issue:** Error messages rendered near form fields are not linked via `aria-describedby`. Screen readers won't announce which field has the error.
- **Fix:** Add `aria-describedby` on each input pointing to its error message element with `role="alert"`.

### C2. Collection tree nodes lack expanded/collapsed state
- **Component:** `collection-tree.tsx`
- **Issue:** Tree `<button>` elements don't expose `aria-expanded` to screen readers.
- **Fix:** Add `aria-expanded={isExpanded}` to each tree node button.

### C3. Search input lacks visible label
- **Component:** topbar search
- **Issue:** Search input uses only `placeholder` as label. Screen readers may not convey purpose.
- **Fix:** Add a visually hidden `<label>` or `aria-label="Search pages"`.

### C4. Missing skip-to-content link
- **Routes:** All app routes
- **Issue:** No skip link for keyboard users to bypass sidebar navigation.
- **Fix:** Add a visually hidden skip link at the top of the app layout that targets `<main>`.

## Warnings

### W1. Disabled buttons don't explain why
- **Routes:** `/pricing`
- **Issue:** "Coming soon" buttons are disabled with no explanation for screen reader users.
- **Fix:** Add `aria-disabled="true"` with `aria-label="Coming soon"` or use `title` attribute.

### W2. Loading spinner not announced
- **Component:** `dashboard.tsx`
- **Issue:** Infinite-scroll loading spinner has no `aria-live` region.
- **Fix:** Wrap spinner in a `<div role="status" aria-live="polite">` with visually hidden text "Loading...".

### W3. Copy-to-clipboard result not announced
- **Component:** `share-dialog.tsx`
- **Issue:** Success/failure of copy action not announced to screen readers.
- **Fix:** Use `toast` (already present via sonner) which renders in an aria-live region. Verify sonner's `role="status"` output.

### W4. iframe missing title
- **Routes:** page viewer, share viewer
- **Issue:** The content iframe lacks a `title` attribute describing the embedded content.
- **Fix:** Add `title="Saved page preview"` or dynamically set to the page title.

### W5. Password strength indicator not announced
- **Route:** `/register`
- **Issue:** Visual-only strength indicator. No aria-live announcement of strength changes.
- **Fix:** Add `aria-live="polite"` with visually hidden text describing current strength level.

### W6. Dialog color picker lacks label
- **Component:** `sidebar.tsx`, `collection-tree.tsx`
- **Issue:** `<input type="color">` in new-collection dialog has no programmatic label.
- **Fix:** The existing `<label>` element needs `htmlFor` matching the input `id`.

## Suggestions

### S1. Use semantic landmarks
- App layout should use explicit `<nav aria-label="Collections">` for the sidebar.
- Consider `<article>` for page cards in the dashboard grid.

### S2. Keyboard shortcut discoverability
- `Shift+M` for move and `Esc/S/Del` in viewer have no discoverable UI.
- Consider a keyboard shortcut help dialog triggered by `?`.

### S3. Heading hierarchy
- Some pages start at `<h1>` then jump to `<h3>`. Ensure no levels are skipped.

## Follow-up Actions

- [ ] C1: Add `aria-describedby` to form inputs in login and register pages
- [ ] C2: Add `aria-expanded` to collection tree node buttons
- [ ] C3: Add `aria-label` to search input
- [ ] C4: Add skip-to-content link in app layout
- [ ] W1: Add aria context to disabled pricing buttons
- [ ] W2: Add `role="status"` to loading spinner
- [ ] W3: Verify sonner toast announcements
- [ ] W4: Add `title` to viewer iframes
- [ ] W5: Add aria-live to password strength indicator
- [ ] W6: Associate color picker label with input
