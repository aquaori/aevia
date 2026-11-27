# Updating This Skill

Use this when project structure, scripts, protocols, benchmarks, or durable implementation knowledge changes.

## Update Workflow

1. Identify the durable knowledge produced by the code change.
2. Update the smallest matching reference file.
3. If no reference fits, add one new `references/*.md` file.
4. Update `references/index.md` when adding, renaming, or deleting references.
5. Update `../SKILL.md` topic map only when the new topic should be discoverable from the skill entry.
6. Update `scripts/context.ps1` when a topic's file list, search commands, or verification commands changed.
7. Run skill validation:

```powershell
python C:\Users\ASUS\.codex\skills\.system\skill-creator\scripts\quick_validate.py .codex\skills\aevia-project-guide
```

## What Belongs Here

Put stable project knowledge here:

- source ownership maps
- cross-file coupling rules
- protocol format notes
- benchmark harness workflows
- dangerous command side effects
- verification commands that future Codex sessions should know

Do not put one-off task notes, temporary debugging observations, generated reports, or large pasted code blocks into the skill.

## Keep AGENTS.md Small

`.codex/AGENTS.md` should tell Codex to use this skill for implementation details. It should not grow into a project manual.

## Reference Style

- Prefer short sections and file lists.
- Name concrete source files before explaining behavior.
- Include the smallest useful verification command.
- When a reference exceeds roughly 150 lines, split it by topic and update the index.
