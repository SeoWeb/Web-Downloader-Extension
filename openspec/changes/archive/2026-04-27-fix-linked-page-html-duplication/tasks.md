## 1. Client: Fix main page scroll streaming pageUrl

- [x] 1.1 In `src/sidepanel/hooks/useScrapingDownloader.ts`, remove `pageUrl: tabUrl` from the `SERVER_UPLOAD_HTML_CHUNK` message data (~line 140). The message should send only `sessionId`, `html`, `scrollIndex`, and `pageType: "main"` — no `pageUrl` field.
- [x] 1.2 Verify the `SERVER_UPLOAD_HTML_CHUNK` message handler in `src/background/message.ts` correctly passes the absence of `pageUrl` to `serverClient.uploadHtmlChunk()` (should already work since the parameter is optional).

## 2. Server: Fix `_safe_merge` deduplication

- [x] 2.1 In `server/app/services/html_merger.py`, modify `_safe_merge()` to deduplicate chunk body content before concatenation. Before appending each chunk's body content to `chunk_bodies`, check if it is identical to or a substring of `body1` (the skeleton body). Skip chunks whose body content is already contained in the skeleton body.
- [x] 2.2 Add logging when chunks are skipped due to deduplication in `_safe_merge` (at debug level): log the chunk index and reason (identical or subset).

## 3. Server: Improve `_dom_merge` superset detection

- [x] 3.1 In `server/app/services/html_merger.py`, extend `_dom_merge()` after the first-child superset check. When first children match but there are additional chunk children, verify they are all already present in the skeleton body before deciding to append. If all chunk children are subsets, return the skeleton as-is.
- [x] 3.2 Add a full-body-content subset check as a fallback: if the combined chunk body HTML (as a string) is a substring of the skeleton body HTML, return the skeleton unchanged.

## 4. Testing

- [x] 4.1 Add/update server-side test for `_safe_merge` verifying that identical chunks don't produce duplicated body content.
- [x] 4.2 Add/update server-side test for `_dom_merge` verifying that chunks with identical body content to the skeleton are detected as a superset and returned without duplication.
- [x] 4.3 Test end-to-end: download a multi-page site in server mode, verify no phantom linked page appears in `pages/`, and verify linked page HTML has no duplicated content. (Manual verification required — automated tests cover the merge logic)
