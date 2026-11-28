# APG development guide

This guide covers the toolchain, the CLI, the bundled plugins, local debugging, and the
smallest verification commands. It describes the working tree on branch
`feat/aevia-plugin`; the source of truth is `apps/backend/cmd/apg/main.go`,
`apps/backend/internal/apg/`, `packages/plugin-sdk/index.d.ts`, and
`apps/frontend/src/service/apg*.ts`.

## Prerequisites

- Go toolchain matching `apps/backend/go.mod` (the CLI is `go run ./cmd/apg`).
- Node.js + npm for the frontend, tests and Lab.
- No additional service: the catalog is read from the local filesystem.

## Running the CLI

From the repository root:

```bash
npm run apg -- list                 # node scripts/go.mjs apg list
```

or directly, which is what the Lab fixture does:

```bash
cd apps/backend
go run ./cmd/apg list
```

`APG_DIR` defaults to `../../data/apg` when the process runs from `apps/backend`
(`apps/backend/cmd/apg/main.go:26`), so both forms target the same directory. `--dir`
must be the first argument and overrides `APG_DIR`.

### Commands

| Command | Arguments | Effect |
| --- | --- | --- |
| `pack` | `<manifest.json> <output.apg>` | Build a package; resolves `main.js` and `assets/**` relative to the manifest directory |
| `keygen` | `<private-key-file>` | Create an Ed25519 key pair; writes the base64 private key with mode `0600` (fails if the file exists) and prints the base64 public key |
| `sign` | `<input.apg> <output.apg> <key-id> <private-key-file>` | Add `signature.json`; manifestVersion 2 only |
| `validate` | `<file.apg>` | Parse and validate; prints `id version (scope) digest` |
| `verify` | `<file.apg>` | Validate and apply the configured trust policy |
| `list` | — | Print `id<TAB>version<TAB>scope<TAB>enabled\|disabled`, sorted per group |
| `install` | `<file.apg>` | Verify, archive assets, copy into `disabled/`; fails if already installed |
| `update` | `<file.apg>` | Replace an installed package in place; fails if not installed, if the version is unchanged, or if a live plugin expands capabilities |
| `rollback` | `<id>` | Restore `rollback/<id>.apg` over a **disabled** plugin |
| `enable` | `<id>` | Verify and move from `disabled/` to the catalog root; no-op if already enabled |
| `disable` | `<id>` | Move from the catalog root to `disabled/`; no-op if already disabled |
| `uninstall` | `<id>` | Delete the package file only |

Mutating commands (`list`, `install`, `update`, `rollback`, `enable`, `disable`,
`uninstall`) create `$APG_DIR/disabled` with mode `0700`, then take a directory lock at
`$APG_DIR/.apg-lock` (`os.Mkdir`). If the process crashed, the lock directory remains and
every later mutating command fails with `acquire APG lock` until an operator removes it.
There is no automatic stale-lock detection.

`enable` and `install`/`update` re-verify against the trust store. Defaults:

| Variable | Default | Used by |
| --- | --- | --- |
| `APG_DIR` | `../../data/apg` | CLI and server |
| `APG_TRUST_STORE` | `$APG_DIR/trust.json` when unset | CLI and server |
| `APG_TRUST_POLICY` | `require-signed` (`config.go:117`, `main.go:263`) | CLI and server |

### Update re-authorization

`update` refuses to replace a **live** plugin when the new package changes its authority
surface (`apg.ReauthorizationChanges`, `apps/backend/internal/apg/reauth.go:14`):

- scope change (also rejected outright unless uninstalled first);
- an added permission;
- a different signing key;
- an added or changed palette, brush, or command (including a changed command resource).

The error lists every change and ends with `disable plugin before updating;
re-authorization required: ...`. Disable, update, then enable. Version-only or program-only
changes update in place, keeping the previous package in `rollback/<id>.apg`.

## Walkthrough: declarative palette plugin

A palette plugin needs only a manifest.

```bash
mkdir -p plugins/my/palette
# Generate a working manifest + main.js + README (default scope is user):
cd apps/backend
go run ./cmd/apg init ../../plugins/my/hello my.hello user
# Replace the generated manifest/palette example if you want a palette instead:
cat > plugins/my/palette/manifest.json <<'JSON'
{
  "manifestVersion": 2,
  "apiVersion": 1,
  "id": "my.palette",
  "name": "My Palette",
  "version": "1.0.0",
  "scope": "user",
  "contributes": {
    "palettes": [{ "id": "studio", "label": "Studio", "colors": ["#111827", "#2563EB", "#0D9488"] }]
  }
}
JSON

cd apps/backend
go run ./cmd/apg pack ../../plugins/my/palette/manifest.json ../../data/apg/packages/my-palette.apg
go run ./cmd/apg keygen ../../data/apg/release.key          # prints the public key once
# 1. write ../../data/apg/trust.json: {"version":1,"keys":{"release-2026":"<public key>"}}
# 2. then sign with the matching private key
go run ./cmd/apg sign ../../data/apg/packages/my-palette.apg \
  ../../data/apg/packages/my-palette.signed.apg release-2026 ../../data/apg/release.key
go run ./cmd/apg verify ../../data/apg/packages/my-palette.signed.apg
go run ./cmd/apg install ../../data/apg/packages/my-palette.signed.apg
go run ./cmd/apg enable my.palette
go run ./cmd/apg list
```

`apg init <dir> <plugin-id> [user|system]` scaffolds a manifest that the real validator
accepts, a `main.js` that registers one command, and a short README. It refuses to write into
a non-empty directory and rejects ids or scopes the manifest validator rejects, so the
generated starting point can be packed and validated immediately. The generated system-scope
example includes a commented `apg.mutate` call; the user-scope example only reads the scene.

The examples use bash/POSIX shell syntax. On PowerShell, set the environment first with
`$env:APG_DIR = "..."` and use backticks or one line for continuations.

If the deployment explicitly opts into `APG_TRUST_POLICY=allow-unsigned`, skip the key
and signature steps and install the unsigned package directly. Note that the built-in
default is `require-signed`, so an unsigned install fails until the policy is overridden.

After `enable`, the running server returns the plugin on the next
`GET /api/apg/catalog` (the endpoint reloads from disk on every request). An open room
picks it up on its next poll (15 s) or on the next room/page/role/reconnect reconcile.

## Walkthrough: executable plugin

Copy `plugins/template` (manifest + `main.js` + SDK reference) and change `id`, `name`
and `scope`. Executable plugins need `main: "main.js"`, `apiVersion: 1`, and any
permissions they intend to request. The six official plugins under `plugins/official/`
are the reference implementations:

| Plugin | Scope | Demonstrates |
| --- | --- | --- |
| `palette` | user | Declarative palette only |
| `brushes` | system | Declarative brush presets only |
| `scene-inspector` | user | `scene.read` + `ui.preview`, `Alt+Shift+1` |
| `shape-template` | system | `scene.write` + `ui.preview`, command `resource` holding a two-shape bundle, `Alt+Shift+2` |
| `note-template` | system | `scene.write` + `ui.preview`, `sticky.create` + `text.create` in one bundle: a native note and caption, `Alt+Shift+5` |
| `shared-counter` | system | `storage.shared` + `ui.preview`, revision CAS |
| `scene-export` | user | `scene.read` + `ui.download` + `ui.preview`: reads the bounded snapshot, hands inert text to the host and triggers a JSON download, `Alt+Shift+4` |

Guidelines that follow from the validator and broker:

- A plugin can only ask for what its scope permits (`user` cannot declare brushes,
  `scene.write` or `storage.shared`).
- One invocation may emit at most one mutation and one shared-state write.
- Scene output is 1..8 shapes per invocation; the host owns ids, clocks and one shared history group.
- Handlers are synchronous; do not return a Promise.
- Keep programs small: 128 KiB max, 150 ms execution budget, 16 MiB memory.

## Testing a plugin without a browser

`@aevia/plugin-sdk/mock` evaluates a `main.js` in Node against an in-memory host, so the
command logic can be unit-tested before packing:

```ts
const host = createApgMockHost({ scene, resource });
host.load(readFileSync("plugins/official/shape-template/main.js", "utf8"));
expect(host.runCommand("insert").preview).toBe("Card inserted");
```

It records previews, shared-state writes and `mutate` requests and rejects unknown command
ids, but it is not a sandbox — see `sdk.md#mock-host-development-only`.

## Local debugging

### Frontend

```bash
npm run dev        # backend + Vite from scripts/dev.mjs
```

Vite is configured for this feature set (`apps/frontend/vite.config.ts`):

- `worker: { format: "es" }` so `apgSandbox.worker.ts` loads as a module worker.
- `optimizeDeps.include: ["quickjs-emscripten"]`, because a worker-only import is not
  seen by the initial dependency scan and otherwise triggers a mid-command reload.
- COOP/COEP headers on dev and preview servers. The guest itself does not need
  `SharedArrayBuffer`, but the headers are part of the existing isolation setup.
- The QuickJS wasm URL is imported as `@jitl/quickjs-wasmfile-release-sync/wasm?url`
  instead of the package default, which would resolve into the prebundle directory and be
  served as `index.html` (`expected magic word ... found <!do`).

Useful browser handles:

| Handle | Meaning |
| --- | --- |
| `[data-testid="apg-panel"]` | APG `<details>` panel, rendered only when a program-bearing plugin is in the catalog |
| `[data-apg-command="pluginId:commandId"]` | Command button; present only while the plugin is enabled |
| `role="status"` inside the panel | Latest preview text |
| `[APG] Command failed` | Console warning from `runApgCommand` |

Because the catalog is fail-closed, an empty panel almost always means the server
returned `503` or an empty catalog. Check the endpoint directly:

```bash
curl -i http://127.0.0.1:4646/api/apg/catalog
```

and the CLI view of the same directory:

```bash
cd apps/backend && go run ./cmd/apg list
```

### Sandbox debugging

The worker swallows guest internals deliberately. To debug, temporarily log inside
`main.js` — `print` is not available, so use a thrown error or return values through
`apg.preview`. Network/DOM APIs are absent by design, not by configuration.

## Verification commands

Smallest loop while developing APG:

```bash
cd apps/backend
go test ./internal/apg ./internal/gateway ./internal/storage ./cmd/apg
```

Frontend unit tests (the APG specs are `*.unit.spec.ts` picked up by the `frontend-unit`
project):

```bash
npx vitest run --project frontend-unit \
  apps/frontend/src/service/apgSandbox.unit.spec.ts \
  apps/frontend/src/service/apgCatalog.unit.spec.ts
```

Real multi-client case (two browsers, signed fixture, CAS, disable, late joiner). It is
memory-hungry; run it alone, not alongside other builds:

```bash
npx tsx tests/run-system.ts --profile=single --only=case:apg-official-business --yes
```

`--profile=single` requires `--only` or `--since` and never records baselines or history
(`tests/run-system.ts:1639`). The case is registered as optional in
`apps/frontend/tests/e2e/external/suites.ts`; the Lab fixture in `tests/lab/apg-fixture.ts`
builds the CLI, generates a throwaway key, writes `trust.json`, and installs/enables the
six official plugins with `APG_TRUST_POLICY=require-signed`. Set `AEVIA_TEST_APG=off`
only to skip fixture provisioning for unrelated cases.

This case passed on 2026-11-28 in Lab run
`105b8c14-3e5a-40c9-8421-e188cbfb6051`; see `docs/apg/acceptance.md` for what it covers
and what it does not.

## Adding a new official plugin

1. Create `plugins/official/<name>/manifest.json` (and `main.js`, `assets/` if needed).
2. If it is executable, add the directory name to `OFFICIAL_APG_IDS` in
   `tests/lab/apg-fixture.ts` so the Lab fixture packs, signs, installs and enables it.
3. If it needs a new E2E assertion, extend
   `apps/frontend/tests/e2e/external/apg-business.ts` or the case definition in
   `tests/catalog/external-cases.ts`; do not weaken existing thresholds.
4. Run the Go APG tests and the single Lab case.
5. Update `docs/apg/acceptance.md` only with evidence you actually observed.
