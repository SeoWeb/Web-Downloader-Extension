## 1. Proto contract

- [x] 1.1 Add streaming `ExportPage(ListPagesRequest-style: page_id, user_id) → stream (bytes chunks)` RPC to the archive proto (additive only); regenerate stubs per `Generated Stub Freshness`; note the 512 KB chunk contract in a proto comment

## 2. Archive service

- [x] 2.1 Implement `ExportPage` in `archive-service/servicer.py`: R2 `ListObjectsV2` under `{user_id}/{page_id}/` → zip64 ZIP in `SpooledTemporaryFile` (≈64 MB spill) → stream 512 KB chunks; entry order `index.html`, `meta.json`, assets sorted; reuse path-hardening normalization for reads
- [x] 2.2 Ownership + error semantics: unknown/foreign page → NOT_FOUND (identical behavior, no existence leak); R2 failures → existing error classification
- [x] 2.3 Service tests: zip contents mirror prefix (incl. `meta.json`, excl. thumbnail), offline-renderability of entry paths (relative), manifest-less page exports fine, chunk-size bound, determinism, ownership NOT_FOUND, empty/missing page

## 3. API gateway

- [x] 3.1 New route `GET /api/v1/archive/pages/{page_id}/zip` in `routers/archive.py`: `GetPage` (ownership + title) → `ExportPage` stream → `StreamingResponse` (`application/zip`, chunked, no full buffering)
- [x] 3.2 `Content-Disposition: attachment; filename="<sanitized title>.zip"` with ASCII fallback `page-{page_id}.zip`; sanitization unit tests (unicode, control chars, empty)
- [x] 3.3 Gateway tests: 404 unknown/foreign page (no existence leak), auth required, headers present, streamed body assembled == service bytes, 5xx mapping on service/R2 failure

## 4. Frontend

- [x] 4.1 Viewer: Download button in `page-viewer-shell.tsx` toolbar (lucide `Download`, beside Share) navigating to `/api/pp/archive/pages/{pageId}/zip`; hotkey `d`; tooltip "Download as ZIP — static snapshot, scripts not included"
- [x] 4.2 Dashboard: "Download" entry in `page-card.tsx` dropdown (above Share), wired in `dashboard.tsx` like existing handlers, closes menu on trigger
- [x] 4.3 Component tests following existing patterns (button presence, navigation target, hotkey, menu wiring)

## 5. QA & ship

- [x] 5.1 Full gate: gateway + archive-service + frontend test suites, lint, typecheck green; manual smoke via docker compose: download a real page, unzip, open `index.html` offline (assets resolve, no scripts), confirm `Content-Disposition` filename
- [x] 5.2 Docs: getting-started download section (honest static-snapshot wording); changelog entry; verify features-page ZIP-export claim now holds end-to-end
- [ ] 5.3 `openspec validate add-page-export-zip` clean; commit; deploy (monolith rebuild per runbook §3 + `deploy-frontend`) only on explicit user order; post-deploy verification
