## Context

Verified inventory (2026-10-20): the PagePocket side (api-gateway + gRPC services + web frontend) has **no ZIP/export/download capability**. The only ZIP machinery lives in the extension's monolith (`server/app/services/zip_assembler.py`), which writes to local disk at save-time and is irrelevant to the cloud path (cloud sessions get `zip_path = None`; its `GET /api/v1/sessions/{id}/download` 500s with `file_missing` for them).

What the cloud side has:

- **R2 layout** (single bucket, `shared/r2_utils.py`): `{user_id}/{page_id}/index.html` + `assets/{filename}` (linked pages under `assets/pages/*.html`) + `meta.json` (title/url/archived_at/size_bytes — **no asset manifest**); thumbnail at `{user_id}/{page_id}.webp` sits **outside** the page prefix. Stored HTML references assets relatively (`archive-service/page_processor.py`), so a prefix ZIP renders offline unmodified.
- **Archive service**: `GetArchiveFile` RPC reads one object fully into RAM (`servicer.py:559–616`); prefix-delete (`:651`) already defines prefix semantics; `ListPageAssets`-style listing does **not** exist. `R2 Error Classification` and `Archive file path hardening` requirements are in force.
- **Gateway**: `routers/archive.py` serves files at `GET /pages/{page_id}/f/{path}` (:272) with ownership enforced; `GetPage` metadata (:122) exists for titles; `AuthMiddleware` (JWT Bearer) and the 600/min/user rate bucket apply automatically; `gRPC transport discipline` and `Bounded request buffering` requirements are in force.
- **BFF proxy** (`api/pp/[...path]/route.ts`): forwards any method to `/api/v1/(archive|library|search|share|auth)(/|$)`, streams responses through, only buffers `text/html` for token injection — an `application/zip` body streams untouched. **No proxy change needed.**
- **Frontend**: viewer actions in `page-viewer-shell.tsx` (:112–156, hotkeys Escape/s/Delete at :85–101); card dropdown in `page-card.tsx` (:76–106) wired in `dashboard.tsx` (:267–271).

## Goals / Non-Goals

- **Goals**: authenticated dashboard users can download any of their saved pages as one offline-renderable ZIP; works for every existing page without data migration; streaming end-to-end (no whole-ZIP buffering in gateway or browser); honest UX copy.
- **Non-Goals**: share-page visitor downloads; single-file HTML export; batch/collection export; extension cloud-download; presigned URLs (platform decision D4 — delivery stays inside the gateway); read-side quota changes (ingest-time caps already bound page size at ~256 MB).

## Decisions

### D1 · Service-side streaming export (alternatives rejected: gateway-side assembly, client-side ZIP)

The archive service gets a **streaming `ExportPage` RPC**: it lists the page's objects, builds the ZIP locally, and yields bounded chunks to the gateway, which pipes them into a `StreamingResponse`. Gateway-side assembly would need a new list-RPC anyway and double-buffer every byte; client-side ZIP (fflate) would mean N+1 authenticated fetches + HTML parsing fragility + browser memory spikes, and wouldn't be reusable by the extension later. Service-side keeps R2 access, listing, and assembly in one trust domain.

### D2 · Enumeration via R2 prefix listing (manifest optimization deferred)

`ListObjectsV2` under `{user_id}/{page_id}/` is the source of truth — works for **all existing pages** with zero backfill, and stays correct even if a manifest would drift. Include `index.html`, `assets/**`, and `meta.json`; the thumbnail is excluded naturally (outside the prefix). A written-at-ingest asset manifest is a possible future speedup, not a dependency.

### D3 · ZIP construction: spooled zip64, bounded chunks

Python `zipfile` writing into a `SpooledTemporaryFile` (`max_size` ≈ 64 MB → spills to service-pod disk), ZIP64 enabled, DEFLATE level 6 (matches monolith `zip_assembler`). The RPC then streams the spool back in **512 KB chunks** (well under gRPC's 4 MB default message cap; aligns with `gRPC transport discipline`). Preserve relative paths exactly (`index.html`, `assets/…`) — no rewriting; `GetArchiveFile`'s path-hardening normalization is reused for each object read. Deterministic order: `index.html` first, then `meta.json`, then assets sorted by key (stable archives, test-friendliness).

### D4 · Gateway route: `GET /api/v1/archive/pages/{page_id}/zip`

Lives next to the file route in `routers/archive.py`. Flow: `GetPage` (ownership + title) → `ExportPage` stream → `StreamingResponse` with `Content-Type: application/zip` and `Content-Disposition: attachment; filename="<sanitized-title>.zip"` (sanitize to ASCII filename-safe, collapse whitespace, strip control chars, ASCII-fallback `page-<page_id>.zip`; per-page uniqueness beats fancy unicode). Errors map to existing semantics: unknown/foreign page → 404, R2 outage → the classified 5xx per `R2 Error Classification`, gRPC unavailable → 503 per service-boundary conventions. No `Content-Length` (compressed size unknown upfront; chunked transfer is fine for browser downloads). Auth and rate limiting are inherited — nothing new to configure.

### D5 · Frontend: plain links, no new client state

Viewer toolbar gains a Download button (lucide `Download` icon, beside Share) triggering a plain navigation to `/api/pp/archive/pages/{pageId}/zip` — the browser owns progress UX for downloads; no fetch/progress state, no client JS additions worth speaking of. Hotkey `d` joins the existing shortcut set. Tooltip: "Download as ZIP — static snapshot, scripts not included." Dashboard card dropdown gains "Download" (first item, above Share) with the same navigation; wiring mirrors the existing Share/Delete handler pattern.

### D6 · Honesty surface

The scripts-stripped nature of archives is a feature (what you see is what was saved) and is stated in the tooltip and the getting-started doc; the changelog entry says "static snapshot" explicitly. No "opens exactly like the live site" claims.

## Risks / Trade-offs

- **[Large pages → long-held streams]** → per-page ingest cap (~256 MB) bounds worst case; spool spills to disk so service RAM stays flat; 600/min/user bucket is per-request so downloads can't be amortized-attacked cheaply. No read-side quota in v1 — revisit if abuse appears.
- **[gRPC message-size mistakes]** → 512 KB chunks with a shared chunk-size constant + a test asserting max chunk size.
- **[Filename weirdness]** → sanitization unit tests (unicode titles, control chars, empty title → fallback).
- **[Browser handling of streamed ZIP]** → `Content-Disposition: attachment` + `application/zip` is the most standard download path that exists; verified in QA against real Chromium.
- **[Proto churn]** → additive RPC only; existing contracts untouched (proto-contracts `Contract Stability` respected; stubs regenerated per `Generated Stub Freshness`).

## Migration Plan

Purely additive: new RPC, new route, new buttons. No data changes, no behavior changes to existing endpoints. Ships backend-first (monolith rebuild), frontend can ship in the same or later push (buttons on an un-deployed backend would 404 — so ship frontend only after/with backend).

## Open Questions

- None blocking. (Changelog wording and docs placement confirmed during implementation; ZIP-includes-`meta.json` is reversible if undesired.)
