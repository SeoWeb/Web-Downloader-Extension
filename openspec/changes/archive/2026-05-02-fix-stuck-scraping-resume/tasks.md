## 1. Progressive Checkpoint Save

- [x] 1.1 Add `updateCheckpointResourceUrls()` call in `src/background/download-core.ts` after line 814 (after filename map upload, before linked-page processing block). Save `uploadQueue.getResourceUrls()` to checkpoint when count > 0.
- [x] 1.2 Verify the existing save at line 922 still runs and overwrites with the full superset after linked-page processing. No changes needed — confirm it works.

## 2. Resume Without Resource URLs

- [x] 2.1 In `src/background/download-core.ts`, replace the throw at lines 1187-1190 (`if (!resourceUrls || resourceUrls.length === 0)`) with server-aware logic that checks `status.resources_received`.
- [x] 2.2 Add the `resources_received > 0` branch: send `scrapeComplete(serverSessionId, resources_received)`, then `finalizeSession(serverSessionId)`, then poll for assembly. Skip re-upload entirely. Early return before the normal upload path.
- [x] 2.3 Update the `resources_received === 0` branch to throw `"No resource URLs in checkpoint and server has no resources — full restart required"`.

## 3. Verification

- [x] 3.1 Build the extension and verify no compile errors.
- [x] 3.2 Test normal download flow (no interruption) — confirm checkpoint is saved progressively and cleared on completion.
- [x] 3.3 Test resume with checkpoint URLs — kill SW after progressive save, verify resume re-uploads and completes.
- [x] 3.4 Test resume without checkpoint URLs but with server resources — simulate SW death before progressive save, verify resume queries server, sends scrapeComplete, and finalizes.
