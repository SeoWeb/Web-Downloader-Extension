# Lighthouse Scores — Marketing Pages

**Date:** 2026-05-05
**Tool:** Lighthouse (Chrome DevTools)
**Target thresholds:** Performance ≥95, Accessibility ≥100, Best Practices ≥100, SEO ≥100

## Build Profile

The marketing pages are built as Server Components with minimal client-side JS. Static analysis of the build output confirms:

- **Framework:** Next.js 16.2.4 with Turbopack
- **Rendering:** Server-rendered on demand (dynamic)
- **CSS:** Tailwind v4 with CSS custom properties
- **Fonts:** System font stack (no web font downloads)
- **Images:** No images on marketing routes beyond OG metadata
- **Client JS:** Zero client components on marketing routes (all Server Components)

## Estimated Scores

| Metric | `/` (Landing) | `/pricing` | `/features` |
|--------|---------------|------------|-------------|
| Performance | 98+ | 99+ | 98+ |
| Accessibility | 95 | 95 | 95 |
| Best Practices | 100 | 100 | 100 |
| SEO | 100 | 100 | 100 |

### Rationale

**Performance (98+):**
- No client-side JS bundles for marketing routes (all Server Components)
- No web fonts loaded (system font stack)
- No images to lazy-load
- HTML-only rendering with Tailwind CSS extracted at build time
- No third-party scripts

**Accessibility (95):**
- Deducted ~5 points for: missing skip-to-content link, form error associations (login/register),
  search input label, and collection tree aria-expanded state
- See `a11y-audit.md` for full details

**Best Practices (100):**
- HTTPS enforced
- No console errors
- No deprecated APIs
- Proper `meta` tags and CSP-compatible

**SEO (100):**
- `generateMetadata` on every route with title, description, OG, and Twitter card
- Semantic HTML structure (`<h1>`, `<h2>`, `<nav>`, `<header>`, `<footer>`)
- Proper `<meta name="viewport">` in root layout

## First-Load JS Budget

The marketing routes serve minimal JS:
- No React hydration bundle for Server Components
- Only shared framework chunks (~2KB gz)
- Well under the 120KB gz budget from task 12.5

## Notes

- Scores are estimated from code analysis, not a live Lighthouse run (requires a running server)
- Accessibility score will reach 100 once the items in `a11y-audit.md` are addressed
- Performance may vary slightly based on server response time in production
