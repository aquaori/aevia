# APG deployment guide

This is the operator runbook for Aevia-Plugin (APG) on a single deployment. It covers the
on-disk contract, environment, trust lifecycle, install/update/rollback, backup, and the
security properties the code actually enforces.

All paths below are relative to `APG_DIR`; the server default is `../../data/apg` relative
to `apps/backend` (`apps/backend/internal/config/config.go:116`).

## On-disk layout

```text
$APG_DIR/
├── <id>.apg                 # enabled package files (catalog root)
├── disabled/<id>.apg        # installed, disabled packages
├── archive/<digest>.apg     # immutable content-addressed copy used by the asset endpoint
├── rollback/<id>.apg        # one previous version per plugin
├── trust.json               # Ed25519 trust store
└── .apg-lock/               # transient lock directory for mutating CLI commands
```

- Only `*.apg` regular files with valid manifests at the catalog root are served. `data/`
  contains runtime state and is git-ignored.
- `archive/` is written when a package has assets. It is what peers fetch assets from,
  keyed by digest. Disabling or uninstalling a plugin does **not** delete archived bytes,
  so already-committed or in-flight scene commands keep rendering.
- `rollback/` holds exactly one previous version per plugin, overwritten on the next
  update.
- Directory and file modes are `0700` for created directories; trust files created by the
  Lab fixture use `0600`. Key files from `apg keygen` are `0600`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `APG_DIR` | `../../data/apg` | Catalog root; also where the CLI reads/writes |
| `APG_TRUST_STORE` | `$APG_DIR/trust.json` | Trust store JSON path |
| `APG_TRUST_POLICY` | `require-signed` | `require-signed` or `allow-unsigned`; empty is an error (`trust policy is required`), never an implicit `allow-unsigned` |
| `DB_BUSY_TIMEOUT_MS` | `15000` | SQLite busy timeout; must not be `0`, or concurrent APG state writes surface as `500` instead of `409` |

`APG_TRUST_POLICY` is read on every catalog request and every CLI verification, so a
change applies without restarting the server, but only to the next request. There is no
caching layer to invalidate.

An invalid or unreadable trust store, or any invalid package in the catalog root, makes
`GET /api/apg/catalog` return `503 APG catalog is invalid`. The frontend treats that as an
empty catalog. This is deliberate fail-closed behavior: one broken package disables all
APG for that deployment until fixed.

`GET /api/apg/catalog` and `GET /api/apg/asset/...` are unauthenticated, so each client gets
its own budget: 40 catalog reads with a 2/s refill, 120 asset reads with a 10/s refill. Room
shared state is authenticated, but writes also get a budget (60 reads with a 20/s refill, 12
writes with a 4/s refill) so one plugin cannot drive unbounded CAS queries and state-changed
broadcasts. A client that exhausts any budget receives `429` with `Retry-After: 1`; other
clients are unaffected. The budgets sit on top of the global HTTP limiter, so they cannot be
used to raise overall request throughput.

## Key generation, signing, rotation, revocation

### Initial trust

```bash
cd apps/backend
go run ./cmd/apg keygen ../../data/apg/release-2026.key
# prints the base64 public key to stdout, writes the private key once
```

Create `trust.json` with that public key:

```json
{
  "version": 1,
  "keys": {
    "release-2026": "<base64 32-byte Ed25519 public key>"
  }
}
```

The private key never belongs on the server that runs the catalog; keep it in the release
environment. `apg sign` reads it only when producing a package. Key ids must match the id
grammar and are limited to 128 characters.

### Signing a release

```bash
apg pack plugins/official/shape-template/manifest.json out/shape-template.apg
apg sign out/shape-template.apg out/shape-template.apg.signed release-2026 release-2026.key
apg verify out/shape-template.apg.signed
```

`verify` uses `APG_TRUST_STORE` / `APG_TRUST_POLICY` from the environment, falling back to
`$APG_DIR/trust.json` and `require-signed`. Verification signs the canonical package
digest, so any change to the manifest, program or assets invalidates the signature.

### Rotation

1. Generate the new key and publish its public key in `trust.json` under a new key id,
   keeping the old entry.
2. Re-sign and ship each package with the new key id.
3. Once no installed package uses the old key, remove the old entry.

A live plugin whose signing key changes is treated as requiring re-authorization:
`update` refuses while it is enabled, with `signing key changed from ...`. Disable, update,
enable.

### Revocation

Removing a key id from `trust.json` revokes every package signed with it. Because loading
is fail-closed, those packages make the **entire catalog** unavailable until they are also
removed or re-signed. Plan revocation as: remove/replace the affected packages first, then
delete the key entry.

There is no certificate expiry, revocation list, timestamping, or online check. Trust is
exactly the current file contents.

## Install / enable / update

1. Copy the signed `.apg` to the host.
2. `apg install <file.apg>` verifies trust, writes an archive copy if it has assets, and
   places the package in `disabled/`. New installs are never live.
3. `apg enable <id>` verifies again and moves the file to the catalog root. The catalog
   limit is 256 enabled plugins.
4. The next `GET /api/apg/catalog` exposes it; open rooms pick it up on their 15 s poll or
   the next room/page/role/reconnect reconcile.

Commands are executed in the browser. Nothing is reloaded in the Go server, and no server
restart is needed.

### Update

`apg update <file.apg>` replaces the installed file at its current path (enabled stays
enabled, disabled stays disabled), saving the replaced version in `rollback/`.

It refuses when:

- the plugin is not installed (`not installed; use install`);
- the version is unchanged (`update requires a different version`);
- the scope changes (`scope change requires explicit uninstall and install`);
- the plugin is enabled and the new package changes authority: added permission, different
  signing key, or any added/changed palette, brush or command
  (`disable plugin before updating; re-authorization required: ...`).

Program-only changes with the same manifest contributions update in place. Keep in mind
that a changed digest and program still cause every open browser to dispose the old worker
and boot the new program on the next catalog poll.

### Enable / disable

```bash
apg disable aevia.shape-template
apg enable aevia.shape-template
```

Both are idempotent. Disabling removes the plugin from the catalog; browsers withdraw its
commands within one poll, dispose its worker after `onDeactivate`, and remove previews.
Already-committed scene operations remain and are replayed natively by late joiners.
Shared state rows are untouched.

### Rollback

```bash
apg disable aevia.shape-template
apg rollback aevia.shape-template
apg enable aevia.shape-template
```

Rollback requires the plugin to be disabled and verifies the stored package's identity and
scope against the current install. It restores only one step back, then leaves the plugin
disabled. Rolling back a package with assets also needs its digest archive to still exist
for peers; archives are immutable and normally present. If the archive was manually
deleted, new clients cannot fetch the resource.

### Uninstall

`apg uninstall <id>` deletes only the installed package file. `rollback/`, `archive/` and
the `apg_room_state` rows remain. Delete those explicitly if removal must be complete.
Uninstall is the only way to change a plugin's scope, followed by a fresh install.

### Lock recovery

A mutating CLI command holds `$APG_DIR/.apg-lock` for its duration and records its PID,
start time and command in `.apg-lock/owner.json`. A second writer fails fast with
`APG lock is held by another process (...)`. If the owner process is gone the next mutating
command reclaims the lock automatically, so a crash no longer needs manual cleanup:

- owner PID dead, or owner file unreadable/absent and the lock directory older than 15
  minutes -> reclaimed;
- owner file absent and the lock younger than 15 minutes -> respected, because a live writer
  may be between `mkdir` and writing the owner file;
- same-process re-entry -> rejected until the first command releases.

Interrupting a command externally leaves nothing behind in the deployment directory:
staging directories matching `.apg-stage-*` and temp files matching `.apg-sign-*.apg` are
ignored by catalog discovery. If a lock ever outlives a genuinely running `apg` process the
operator can still remove `$APG_DIR/.apg-lock` manually, but that is no longer the standard
recovery path.

## Shared state

`apg_room_state` stores one JSON value per `(room_id, plugin_id)` with a monotonic
revision. Writes are a single authorized SQL statement that combines the room role check
with the revision CAS (`WriteAPGStateAuthorized`,
`apps/backend/internal/storage/apg_state.go:57`); a role change cannot slip between
authorization and write. Rejected writes are classified as unauthorized (`403`) or
conflict (`409`).

State is independent of package lifecycle: disable, update, rollback and uninstall do not
delete it. It survives restarts. Only deleting the room, or an explicit `apg state clear`, removes the
rows. Back it up
with the SQLite database.

### State schema versions

Each row records the `stateSchemaVersion` of the package that wrote it (0 when the package
does not declare one). The version comes from the signed manifest, never from the request, so
a client cannot claim an older schema. Writes are refused with `409 APG state schema
conflict` when the stored schema is newer than the writer's, which stops a rollback or a
restored backup from reinterpreting data written by a newer release. A plugin that changes
its value shape should bump `stateSchemaVersion`; readers see `schemaVersion` in the state
they read and can migrate the value forward, after which the higher schema is stored.

`GET /api/apg/state/{id}` and the `PUT` acknowledgement both return `{revision,
schemaVersion, value}`. Existing databases upgrade in place: the migration adds
`schema_version INTEGER NOT NULL DEFAULT 0` to `apg_room_state`.

### Inspecting and purging stored state

Because uninstalling a package keeps its room data, a deployment that wants to retire a
plugin's data needs an explicit, reviewable operation. The CLI can open the deployment
database directly (the server may keep running; SQLite serializes the writes):

```bash
apg state list  ../../data/aevia.db                     # every room and plugin
apg state list  ../../data/aevia.db 771024              # one room
apg state list  ../../data/aevia.db 771024 aevia.shared-counter
apg state clear ../../data/aevia.db 771024 aevia.shared-counter --confirm
apg state clear ../../data/aevia.db 771024 --confirm    # every plugin in that room
```

`list` prints `room<TAB>plugin<TAB>revision=<n><TAB>schema=<n>` and never prints the value.
`clear` refuses to run without `--confirm` and refuses to run without a room id, so there is no
way to empty the whole table by omitting an argument. A path that does not exist is reported as
an error instead of being created, so a typo cannot look like "this room has no state". Opening
the database applies pending migrations first, exactly as a server start would.

Clearing state is not a rollback: it removes the value, and the next write starts again at
revision 1 with schema `0`, so any client holding an older revision must re-read before writing.

## Backup and restore

Back up these together; a restored database with a different `APG_DIR` can reference
plugin ids and digests that no longer exist, and a restored `APG_DIR` with an older
database loses newer shared state.

1. Stop the server.
2. Copy the SQLite database (including `-wal`/`-shm` if present) and the whole `APG_DIR`.
3. Restore both to the same paths, keeping `trust.json` consistent with installed
   signatures.
4. Start the server and check `curl -i .../api/apg/catalog` returns `200`, then
   `apg list`.

Asset URLs are content-addressed and cached as immutable for one year, so a digest that
was served once may remain in browser caches even after the file is gone.

## Security properties and limits

Enforced:

- No HTTP install/update path; packages enter only via CLI on the host.
- Digests and signatures are recomputed from package bytes at load time, on every catalog
  request and every CLI verification.
- Guest code has no DOM, network, filesystem, clipboard, timer or host-object access; JSON
  is the only boundary (QuickJS worker).
- Guest execution is bounded by 128 KiB program, 16 MiB memory, 256 KiB stack, 150 ms
  deadline, 512 KiB input, 64 KiB result, 16 effects, 64 commands, 8 workers.
- Scene writes are compiled to native operations with host-owned identity and validated by
  the shared scene validator; one mutation per invocation.
- Shared state requires `system` scope + `storage.shared` on both client and server, plus
  an editor/owner room role, and is CAS-protected.
- Assets are served with `application/octet-stream`, `nosniff`, `Content-Disposition:
  attachment`, `CSP: default-src 'none'; sandbox`, and immutable caching.
- A viewer cannot run mutating commands or write shared state; a user cannot install code.

Not provided (do not assume these exist):

- Per-plugin CPU/GPU quotas or accounting beyond the per-invocation deadline.
- Audit log of which user ran which plugin command.
- Signature expiry, revocation lists, or transparency logging.
- Sandboxing of the QuickJS wasm beyond the VM boundary and the 150 ms interrupt check.
- Server-side rendering of plugin output: all execution is client-side.
- A management UI for install/update; the CLI is the only management surface.

## Production hosting note

**Unverified:** the Go server in this tree serves APIs, not the built frontend bundle, and
the COOP/COEP headers in `apps/frontend/vite.config.ts` apply to Vite dev/preview only.
Whatever static host serves `apps/frontend/dist` must serve the hashed QuickJS wasm asset
and the module worker with correct MIME types, and should reproduce the same isolation
headers. Verify this on the target host; it is not exercised by the repository's Lab case.
