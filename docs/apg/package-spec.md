# APG package specification

This document specifies the `.apg` container, manifest contract, size limits, digest and
signature format as implemented in `apps/backend/internal/apg/catalog.go`,
`apps/backend/internal/apg/package.go`, `apps/backend/internal/apg/archive.go`, and
mirrored for the browser in `apps/frontend/src/service/apgCatalog.ts`.

A package is produced by `apg pack`, optionally signed by `apg sign`, trusted by
`apg verify`/`apg install`, and served to browsers only after it exists in `APG_DIR`.

## Container layout

An `.apg` file is a ZIP archive. Only regular file entries are allowed; directories are
implicit and not required. Entry names are restricted by `safeEntryName`
(`package.go:211`): no backslash, no absolute path, `path.Clean(name) == name`, not `.`,
not starting with `../`. Duplicate names are rejected.

| Entry | manifestVersion 1 | manifestVersion 2 |
| --- | --- | --- |
| `manifest.json` | required, only entry | required |
| `main.js` | forbidden | optional; required iff `main` is set |
| `signature.json` | forbidden | optional |
| `assets/**` | forbidden | allowed, `system` scope only |

`manifestVersion 1` packages are the original declarative format and must contain exactly
one entry, `manifest.json`, at no more than 256 KiB. They can be installed unsigned, but
they **cannot be signed**: `SignPackage` rejects anything other than
manifestVersion 2 (`only manifestVersion 2 packages can be signed`,
`package.go:315`). `manifestVersion 2` adds permissions, executable `main.js`, command
resources, and signatures.

## Manifest, field by field

Root object; unknown fields are rejected (`DisallowUnknownFields`), duplicate keys are
rejected case-insensitively, and trailing data after the JSON value is rejected.

| Field | Type | V1 | V2 | Rules |
| --- | --- | --- | --- | --- |
| `manifestVersion` | integer | required | required | `1` or `2` |
| `apiVersion` | integer | must be absent | **required** | must equal `1` |
| `id` | string | required | required | `^[a-z0-9]+(?:[.-][a-z0-9]+)*$`, at most 128 chars |
| `name` | string | required | required | non-blank, at most 256 chars |
| `version` | string | required | required | `^[0-9]+\.[0-9]+\.[0-9]+$` |
| `scope` | string | required | required | `system` or `user` |
| `permissions` | string array | must be absent | optional | subset of `scene.read`, `scene.write`, `ui.preview`, `ui.download`, `storage.shared`; no duplicates |
| `stateSchemaVersion` | integer | must be absent | optional, `0`-`1000` | versions the shared-state value; non-zero requires `storage.shared`; a package cannot overwrite state stored under a higher schema (409 `APG state schema conflict`) |
| `main` | string | must be absent | optional | only `"main.js"`; required for commands; requires the `main.js` entry |
| `contributes` | object | required | required | shape below |
| `contributes.palettes` | array | optional | optional | at most 64; each `{id, label, colors}` |
| `contributes.brushes` | array | optional | optional | at most 64; `system` scope only; each `{id, label, base, color?, size?, opacity?}` |
| `contributes.commands` | array | must be absent | optional | at most 64; requires `main`; each `{id, label, shortcut?, resource?}` |

`contributes` itself must be present as a JSON object in both versions. All contribution
ids share the same id grammar as the plugin id and must be unique within their array.
Labels are bounded by the same 1..256 text rule as `name`.

### Palettes

| Field | Rules |
| --- | --- |
| `id` | id grammar, unique per plugin |
| `label` | non-blank, at most 256 chars |
| `colors` | 1..64 strings, each `^#[0-9a-fA-F]{6}$` |

Palettes are display-only. A `user`-scope palette can be toggled per browser.

### Brushes

| Field | Rules |
| --- | --- |
| `id` | id grammar, unique per plugin |
| `label` | non-blank, at most 256 chars |
| `base` | `pen`, `pencil` or `highlighter` |
| `color` | optional `#RRGGBB`; cannot be JSON `null` |
| `size` | optional number 0.1..30; cannot be `null` |
| `opacity` | optional number 0..1; cannot be `null` |

Brushes are `system` scope only because they change what every participant draws with.
The browser exposes only `system` brush presets (`buildApgBrushViews`).

### Commands

| Field | Rules |
| --- | --- |
| `id` | id grammar, unique per plugin |
| `label` | non-blank, at most 256 chars |
| `shortcut` | optional, exactly `Alt+Shift+<0-9>` |
| `resource` | optional; `system` scope only; `^assets/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.json$`; the entry must exist; at most 16384 bytes; valid JSON |

A declared `resource` is loaded before the command runs and is available as
`apg.readResource()`. Two plugins may declare the same shortcut; the browser then refuses
to run either until the conflict is resolved by disabling one.

## Size and count limits

Constants are defined in `apps/backend/internal/apg/catalog.go:18` (`Max*`) and applied in
`package.go` / `catalog.go`. The browser client mirrors the structural limits in
`apps/frontend/src/service/apgCatalog.ts`; the server remains authoritative.

| Limit | Value | Enforced in |
| --- | --- | --- |
| Package file size (v1) | 256 KiB | `ReadPackageBundle` |
| Package file size (v2) | 1 MiB | `ReadPackageBundle` |
| `manifest.json` | 64 KiB | `ReadPackageBundle` |
| `signature.json` | 64 KiB | `ReadPackageBundle` |
| `main.js` | 128 KiB | `ReadPackageBundle` |
| Each `assets/**` entry | 256 KiB | `ReadPackageBundle` |
| Total expanded bytes | 1 MiB | `ReadPackageBundle` |
| ZIP entries | 1..67 | `ReadPackageBundle` |
| Asset entries | at most 64 | `validateV2Entries` |
| Plugins in one catalog | 256 | `LoadCatalogWithTrust`, `enable` |
| Palettes per plugin | 64 | manifest validation |
| Brushes per plugin | 64 | manifest validation |
| Colors per palette | 64 | manifest validation |
| Command resource | 16384 bytes | `validateV2Entries` |
| Plugin/contribution id | 128 chars | `validateID` |
| Text field (`name`, labels) | 256 chars | `validateText` |
| Brush size | 0.1..30 | manifest validation |

`MaxPackageEntries = 67` is exactly `manifest.json + main.js + signature.json + 64 assets`;
`MaxExpandedBytes = 1 MiB` matches `MaxPackageBytes`, so compression cannot expand beyond
the archive cap.

## Canonical digest

The package digest is computed over every entry except `signature.json`
(`digestEntries`, `package.go:219`):

```text
names = sorted(entry names except "signature.json")
digest = SHA-256( for each name:
             uint64_be(len(name)) || name ||
             uint64_be(len(data)) || data )
```

The digest is lowercase hex (64 characters). Consequences:

- The manifest is covered, so scope, permissions and contributions cannot change without
  changing the digest.
- Entry order in the ZIP does not matter; the writer sorts names, but readers accept any
  order.
- Adding, removing or editing `signature.json` does not change the digest, which is why a
  signature can be added to an already-packed package.
- The digest is the identity used by the asset endpoint and by shared-state requests:
  `GET /api/apg/asset/{digest}/{name}` and `?digest=` on `/api/apg/state/{id}`.

## signature.json

`apg sign` writes one extra entry. It is parsed strictly (`DisallowUnknownFields`).

```json
{
  "algorithm": "ed25519",
  "keyId": "release-2026",
  "digest": "<64 lowercase hex chars>",
  "signature": "<base64 Ed25519 signature>"
}
```

| Field | Rules |
| --- | --- |
| `algorithm` | exactly `ed25519` |
| `keyId` | id grammar; must exist in the trust store |
| `digest` | case-insensitive match with the recomputed package digest |
| `signature` | base64 of a 64-byte Ed25519 signature over the 32-byte digest |

The signed message is the **digest**, not the ZIP bytes. Verification therefore succeeds
only if the manifest and every covered entry are byte-identical to what was signed; the
ZIP writer's temp-file and rename behavior means the archive is never modified in place.

## Trust store

JSON file, default `$APG_DIR/trust.json` (override with `APG_TRUST_STORE`). Missing file is
treated as an empty store. Unknown fields are rejected.

```json
{
  "version": 1,
  "keys": {
    "release-2026": "<base64 32-byte Ed25519 public key>"
  }
}
```

Key ids follow the plugin id grammar. Values must decode to exactly 32 bytes.

## Trust policies

`APG_TRUST_POLICY` selects behavior when packages are loaded (`VerifyTrust`,
`package.go:242`). Only two values are accepted; an empty value is an error
(`trust policy is required`) rather than an implicit `allow-unsigned`.

| Policy | Unsigned package | Signed package with unknown key / bad signature |
| --- | --- | --- |
| `allow-unsigned` | accepted | rejected |
| `require-signed` (server default, `config.go:117`) | rejected (`package signature is required`) | rejected (`signing key %q is not trusted`) |

The policy is read by the server when it builds the catalog and again by the CLI on every
install/update/enable. A policy is not stored in the package, so rotating it applies to
the next catalog load (per request) and the next mutating CLI command.

## Rejection cases

Errors are returned by the CLI as `apg: <message>` with exit code 1, and by the server as
`503 APG catalog is invalid` / `503 APG trust store is invalid`. A single invalid package
therefore makes the whole catalog unavailable rather than silently dropping it
(`LoadCatalogWithTrust` fails closed).

| Case | Result |
| --- | --- |
| File extension is not `.apg` | rejected |
| Path is not a regular file (symlink, directory, device) | rejected |
| Archive larger than the package cap | rejected |
| Fewer than 1 or more than 67 entries | rejected |
| Entry with `../`, absolute path, backslash, or normalized collision | rejected (`unsafe entry`) |
| Duplicate ZIP entry name | rejected |
| V1 package with any entry besides `manifest.json` | rejected |
| V1 package larger than 256 KiB | rejected |
| Unknown JSON field in manifest/signature/trust store | rejected |
| Duplicate JSON key differing only in case | rejected (`duplicate JSON key at ...`) |
| Trailing bytes after the JSON document | rejected |
| Missing `manifestVersion`, `id`, `name`, `version`, `scope`, or `contributes` | rejected |
| Contribution array missing a required field | rejected |
| Contribution field explicitly `null` where optional | rejected |
| Invalid id/version/scope/color/shortcut/base | rejected |
| Brush size outside 0.1..30, opacity outside 0..1 | rejected |
| `user` scope with brushes, `scene.write`, `storage.shared`, or a command resource | rejected |
| V2 manifest without `apiVersion: 1` | rejected |
| V2 commands without `main: "main.js"` | rejected |
| `main: "main.js"` without the entry, or the entry without `main` | rejected |
| `signature.json` before digest exists, non-ed25519 algorithm, malformed base64 | rejected |
| Digest mismatch between signature and computed digest | rejected |
| Signature invalid or key untrusted under `require-signed` | rejected |
| V2 asset whose path is not `assets/**` | rejected (unknown entry) |
| V2 asset not referenced by any command | accepted, but unreachable: the browser fetches only declared command resources; it still counts toward the 64-asset and 1 MiB budgets |

## Packing rules

`apg pack <manifest.json> <output.apg>` (`PackPackage`, `package.go:352`) resolves
`main.js` and `assets/**` relative to the **manifest's directory**. It refuses symlinks and
non-regular files, enforces per-entry and count caps, and writes entries in sorted order
through a `.apg-sign-*.apg` temp file. The output path must end in `.apg` and must not
already exist.
