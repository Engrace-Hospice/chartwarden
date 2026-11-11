---
name: compliance-pr
description: Pre-PR compliance pass for ChartWarden — runs the gate stack in the cheap-to-expensive order, the ECC reviews, then the compliance-reviewer agent, and writes the PR body's Compliance impact section. Use before opening a PR or asking to push/merge to main.
---
# Compliance PR pass

Run these in order and stop at the first red step. Each step is cheaper than the one after it.

1. `bun run harness:phi-scan --staged` (or pass the changed files). Clean means no PHI-shaped
   identifiers or credentials.
2. `bun run typecheck && bun run arch:fitness && bun run test`. This is the repo's real gate.
   `/ecc:quality-gate` doesn't know `arch:fitness`.
3. `/ecc:code-review` on `git diff main...HEAD` in a fresh agent (mandatory per CLAUDE.md). Add
   `/ecc:react-review` for `apps/web`/`apps/admin`, and `/ecc:security-scan` for auth, PHI or RLS code.
4. Delegate to the **compliance-reviewer** agent with the branch name. Fix every CRITICAL/HIGH.
5. If a control changed, update its row in `compliance/controls.yaml` (human approval prompt), then
   run `bun run arch:compliance`.
6. Write the PR body with these sections:
   - **What changed**
   - **Gates run**: the exact commands and their results
   - **Review findings**: what ECC and compliance-reviewer found, and what was fixed
   - **Compliance impact**: the control ids touched, PHI paths affected (or "none"), and any vendor change
7. Don't push or merge. Ask the human; pushes to main are batched (CLAUDE.md #257).
