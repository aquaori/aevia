# CI by Git event

- Development branch push runs `quick.yml` for commit, changed-file, and change-obligation checks (`scripts/lab-inventory.mjs --check`, `scripts/ci-check-obligations.mjs`) and `ci.yml` for the managed core test suite (`test:ci`).
- Quick checks run actionlint on changed GitHub Actions workflow files; other pushes do not need to install or run it.
- Both `ci.yml` (push range `CI_BASE..HEAD`) and `pr.yml` (full PR range `base.sha..HEAD`) enforce `module-obligations.json` (schema v2) so newly added or modified managed source files (`apps/frontend/src`, `apps/backend`, `packages/shared/src`) cannot remain `uncovered` and must bind valid executable `evidence` (or `excluded` with `reason` and `alternativeEvidence`).
- `ci.yml` reuses Vitest, Browser, Go, and core E2E results from the same `test:ci` run to verify selected targets fail-closed, appends any extra non-default E2E cases triggered by changes or conservative fallbacks, and reports the result in job `Aevia change tests / <passed>/<total>|<sources>|<newUncovered>|<debt>`.
- A PR to `main` runs `pr.yml` against GitHub's merge commit. It requires successful push runs of both push workflows for the exact same-repository PR head, validates the title, enforces full-PR change obligations, and runs the build plus selected PR unit/browser/Go targets deduplicated alongside the fixed smoke, convergence, late-join and recovery cases (and `Aevia change tests / ...`). Its managed report is uploaded as `aevia-pr-evidence`.
- A push to `main` runs `main.yml`, verifies association with a merged PR, builds the resulting tree and runs the public WebSocket-to-canvas health case. A failure is post-merge evidence and must block any future deployment.
- `nightly.yml` and the scheduled/manual compatibility matrix in `ci.yml` remain separate.
- Local `.husky/pre-commit` (`scripts/commit-gate.mjs`) runs `scripts/ci-check-obligations.mjs --staged` after `lint-staged` to block unmapped staged source changes before push.

Branch protection requires `PR merge checks` with the PR branch up to date with `main`. The PR verifier waits up to 15 minutes for push runs and fails when the head has no successful push evidence. Same-repository branches are supported; fork PRs require a separate trust and evidence policy.
