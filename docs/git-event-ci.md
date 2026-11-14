# CI by Git event

- Development branch push runs `quick.yml` for commit and changed-file checks and `ci.yml` for the managed core test suite.
- Quick checks run actionlint on changed GitHub Actions workflow files; other pushes do not need to install or run it.
- A PR to `main` runs `pr.yml` against GitHub's merge commit. It requires successful push runs of both workflows for the exact same-repository PR head, validates the title, and runs a build plus selected smoke, convergence, late-join and recovery cases. Its managed report is uploaded as `aevia-pr-evidence`.
- A push to `main` runs `main.yml`, verifies association with a merged PR, builds the resulting tree and runs the public WebSocket-to-canvas health case. A failure is post-merge evidence and must block any future deployment.
- `nightly.yml` and the scheduled/manual compatibility matrix in `ci.yml` remain separate.

Branch protection requires `PR merge checks` with the PR branch up to date with `main`. The PR verifier waits up to 15 minutes for push runs and fails when the head has no successful push evidence. Same-repository branches are supported; fork PRs require a separate trust and evidence policy.
