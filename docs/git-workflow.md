# 分支模型与合并规范

本文件是仓库里 Git 分支持久约定的唯一来源。`AGENTS.md` 只保留一句指引，
`.codex/AGENTS.md` 与 `.agents/rules/agents.md` 不再重复维护分支规则。

## 1. 分支只按「需求」划分

一条分支对应一个**需求**，而不是一个周期、一个阶段或一个 PR。

- 需求是线性的（先做完第 1 周期才能做第 2 周期）→ **只开一条分支**，周期与阶段用提交表达。
- 需求之间相互独立 → **各开一条分支**，这样才能并行推进（例如同时进行的
  `feat/redesign-entry-views`、`feat/aevia-plugin`、`bugfix/nightly-boundary-isolation`）。

禁止为了「一个阶段一个分支」把线性需求切碎：那只会让分支数量膨胀，而且阶段之间无法续接。

命名前缀沿用现有约定：`feat/`、`bugfix/`、`perf/`、`chore/`、`docs/`。
`bugfix/` 分支的提交 type 用 `fix`。

## 2. 合并方法按分支类型选

| 分支类型 | 合并方法 | 理由 |
| --- | --- | --- |
| `perf/*` | **Rebase and merge** | 性能结论要能 bisect 到具体某次改动 |
| `feat/*`（跨多个周期） | **Rebase and merge** | 保留每个提交，周期边界清晰 |
| `bugfix/*`、小 `fix` | Squash | 单个逻辑修复，压成一条更干净 |
| `docs/*`、`chore/*` | Squash | 无考古价值 |
| 任意类型 | ~~Create a merge commit~~ | 已禁用：它只产生菱形气泡 |

Rebase 与 squash 都不会在 `main` 上留下合并节点，主干始终是一条直线。

## 3. 多周期需求：合并后「重置分支」继续

Rebase / squash 都会在 `main` 上生成**新的提交 SHA**，而原分支仍持有旧 SHA。
如果把同一条分支直接拿去开下一个 PR，GitHub 会把已经合并过的内容再算一次。
所以每轮合并后按下面做一次：

```powershell
git fetch origin
git switch feat/<需求>
git reset --hard origin/main     # 整条分支已合并时；提交仍在 main 上，不丢历史
```

然后在这个基础上继续写下一周期。

如果只想合并**一部分**（后续周期还是半成品），不要整体合并，而是从需求分支切一条短分支：

```powershell
git switch -c feat/<需求>-cycle1 feat/<需求>
# 只保留已完成的提交：git reset --hard <最后一个已完成提交>
```

合完这条短分支后删掉它，需求分支保持不动。

## 4. 用标签钉住周期边界

分支会被删除，标签不会。每轮合并后在 `main` 上打一个标签：

```powershell
git tag -a req/<需求>/c1 -m "cycle 1: <一句话说明>"
git push origin req/<需求>/c1
```

第二轮出问题时，`git diff req/<需求>/c1..origin/main` 就能定位到这一轮的全部改动，
`git bisect` 也仍然有效——这是「合并后不立刻删分支」之外更可靠的保险。

## 5. 分支寿命：分级，不强制短命

| 状态 | 判定 | 处理 |
| --- | --- | --- |
| 活跃 | 最近 30 天内有提交 | 正常使用，可跨多个 PR |
| 沉寂 | ≥30 天无提交且未合并 | **不自动删除**，但必须分诊：继续 / 打标签归档后删 / 明确保留 |
| 已合并 | 已进入 `main`（含 squash 合并） | 打标签后删除 |
| 与 main 同步 | 已无独有提交 | 直接删除 |

**不要开启 GitHub 的 “Automatically delete head branches”**：它会在 PR 合并后立刻删除
源分支，正好和多周期需求分支冲突。删除动作始终由人执行，且先打标签。

## 6. 查看分支状态

```powershell
npm run branch:status            # 全部分支
npm run branch:status -- --merged   # 已合并（含 squash 合并）
npm run branch:status -- --stale    # 沉寂 30 天以上
npm run branch:status -- --json     # 机器可读
```

输出包含：最后提交时间、相对 `origin/main` 的领先/落后、本地与远端是否一致、
是否已合并（祖先关系或 patch-id，squash 也能认出来）、被哪个 worktree 占用、状态。

脚本只读，不会改动任何 ref。CI 每周一跑一次同样的报告（`.github/workflows/branch-hygiene.yml`），
输出写在 job summary 里。

## 7. GitHub 仓库设置

Ruleset（`Main Protect`）建议：

- **Allowed merge methods**：只留 `Squash` 与 `Rebase`，关闭 `Merge`；
- `Require linear history`：可开启，强制主干无合并提交；
- `Require branches to be up to date before merging`：保持**关闭**（GitHub 会用合并结果跑 CI，
  不必让每条分支都追平）；
- `Block force pushes`：保持开启；
- 仓库 General → Pull Requests：**不要**勾选 “Automatically delete head branches”。

## 8. 尚未自动化

- 周期标签目前手工打。自动化需要 PR 合并事件里能安全推导标签名，且要防重名，
  暂不放进 CI；
- 分支清理只出报告，不自动删除（避免误删仍在用的多周期分支）。
