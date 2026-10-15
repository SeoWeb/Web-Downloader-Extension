# Key Rotation & History Purge Runbook

> Status: **forward-fix done, history purge pending** (operational task — must be
> coordinated, see below). Do not treat the leak as closed until the
> "Verification" checklist at the bottom passes.

## 1. What happened and why the key must be considered compromised

- `dist.pem` — the real RSA-2048 private key used to sign the Chrome extension
  package — was committed to this repository in `4a7ddcc` (*"version: 1.0"*,
  April 2024), together with the signed artifact `dist.crx`.
- Both files have been in git history ever since: **~200 commits** (207 commits
  total on `main` at the time of writing). The pre-existing `.gitignore` rule
  `dist.*` could not help because the files predate it and git keeps tracking
  already-committed files.
- Anyone with read access to the repository (or any clone, mirror, or backup
  made from it) can retrieve the private key from history with:
  `git show 4a7ddcc:dist.pem`.
- Consequence: the key must be treated as **public**. It cannot be "unleaked";
  it can only be replaced and, optionally, scrubbed from history.

## 2. Forward-fix (already executed)

1. `git rm dist.pem dist.crx` — removed both files from the index **and** from
   the working tree, so they cannot ship with the extension again.
2. Appended to `.gitignore`: `*.pem`, `*.crx`, `dist.pem`, `dist.crx` — so the
   files cannot be re-added accidentally.
3. This runbook.

**Important:** the forward-fix removes the files from *new* commits only. The
key remains retrievable from every commit between `4a7ddcc` and the removal
commit via `git log --all -- dist.pem`. Only the history purge (§4) removes
that, and rotation (§3) is what actually restores security.

## 3. Chrome Web Store key rotation — understand the two keys first

There are **two different keys** involved, and they are not interchangeable:

| Key | Where it lives | What it controls |
|---|---|---|---|
| **Upload / signing key** (`dist.pem`) | Your local build, used to pack the `.crx`/zip; CWS re-encrypts with its own key on publish | Proves you may push a new package. Was leaked. |
| **Manifest key** (`"key"` field in `public/manifest.json`) | Public key embedded in the manifest | Pins the **extension ID**. It is public by design and was *not* leaked. |

Key facts:

- The extension ID is derived from the **manifest key**. Because the manifest
  key is unchanged, rotating the *upload* key does **not** change the extension
  ID, and existing users keep receiving updates normally.
- **Do not** rotate/regenerate the manifest key unless you accept a new
  extension ID (new listing, all users lost, `host_permissions` and OAuth
  client redirects re-pinned). There is no security need: the manifest key is
  a public key.
- CWS upload-key note: when uploading a package, the Chrome Web Store accepts
  a zip (signed internally) or a signed `.crx`. After rotation, pack with the
  **new** `dist.pem`:

  ```bash
  # Generate a fresh upload key (keep it OUT of the repo — .gitignore now blocks *.pem)
  openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -outform PEM -out ~/.keys/dist.pem
  # Pack (this only produces a local .crx; a plain zip upload is equally fine)
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --pack-extension=./dist --pack-extension-key=~/.keys/dist.pem
  ```

- Store the new key outside the repository (password manager / secrets vault)
  and share it with whoever needs to sign builds via a secrets channel.

### Rotation steps

1. Generate a fresh RSA-2048 upload key (command above). Keep it off-repo.
2. Build `dist/` (`npm run build`).
3. Pack with the new key or upload the plain zip.
4. Upload to the Chrome Web Store as a **new version** of the existing listing
   (same manifest key → same extension ID).
5. Verify the item updates for an existing install (extension ID unchanged).

## 4. History purge with `git filter-repo` (operational task — NOT yet executed)

> This rewrites **every commit SHA** after (and including) `4a7ddcc`. It must
> be coordinated with all clones, open PRs, and CI before running. That is why
> it is a separate ops task from the code change, not something done silently
> in a feature branch.

### Preconditions

- [ ] Schedule maintenance: force-push rights confirmed, branch protection on
      `main` temporarily lifted or bypass approved.
- [ ] All developers/agents have pushed or are willing to rebase; no critical
      open PRs (they will need a force rebase).
- [ ] CI secrets that reference commit SHAs or are scoped to old branches are
      identified; deploy pipelines paused.
- [ ] Fresh backup: `git clone --mirror <url> extension-backup-$(date +%F).git`.

### Steps

```bash
# 1. Fresh clone (filter-repo insists on a fresh clone)
git clone --no-local <repo-url> purge-work && cd purge-work

# 2. Purge the key material from all history
pipx install git-filter-repo
git filter-repo \
  --invert-paths \
  --path dist.pem \
  --path dist.crx

# filter-repo strips remotes on purpose. Re-add and force-push everything:
git remote add origin <repo-url>
git push origin --force --all
git push origin --force --tags
```

3. **Coordinate the rewrite with every clone:**

   ```bash
   # Each collaborator (no local work to keep):
   git fetch origin && git reset --hard origin/main

   # Each collaborator (local branches to keep):
   git rebase --onto origin/main <old-sha> <my-branch>
   # or: git pull --rebase  (may require --rebase-merges for merges)
   ```

4. CI: re-trigger pipelines; anything pinned to old SHAs/tags must be updated.
   Cached CI checkouts keyed by SHA will cold-build once.
5. Delete and re-protect stale refs that may still hold the old objects until
   the host's garbage collection runs (GitHub: support ticket / repo rebuild
   via mirror-push if you must guarantee removal from cached views;
   unreachable objects can persist on the server until GC).

### Verification

- [ ] `git log --all --full-history -- dist.pem dist.crx` → empty on the host.
- [ ] `git rev-list --all --objects | grep -E 'dist\.(pem|crx)$'` → empty.
- [ ] Fresh clone of `main` contains no `*.pem`/`*.crx`.
- [ ] New upload key stored off-repo; CWS listing updated and serving the new
      version; extension ID unchanged (manifest `key` untouched).
- [ ] `.gitignore` still contains the `*.pem`/`*.crx`/`dist.pem`/`dist.crx`
      rules.

## 5. References

- Chrome Web Store: "Using a private key to sign extensions" — developer.chrome.com
- `git filter-repo` manual: https://htmlpreview.github.io/?https://github.com/newren/git-filter-repo/blob/master/Documentation/git-filter-repo.txt
- OpenSpec change: `openspec/changes/stabilize-extension-downloads-and-ux/`
  (decision D11, task 7.1)
