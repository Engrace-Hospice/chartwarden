# ADR-0042 — `wardenx-piv` output is local-only: commit on a branch, no push, no PR

- **Status:** **Accepted** — ratifies the as-built workflow (2026-08-14; the harness has run
  local-only since v0.5.0).
- **Date:** 2026-08-14
- **Supersedes (clause):** ADR-0031's "the `pr` node pushes and `gh pr create`s; review happens on
  the GitHub PR" — the *no-interactive-approve* decision itself stands unchanged.
- **Related:** [ADR-0031](ADR-0031-wardenx-piv-no-interactive-approve.md).

## Context

ADR-0031 removed the interactive approve node and had the run open a GitHub PR autonomously. The
workflow has since moved to **v0.5.0 local-only**: the tail is `fix → finalize → commit` on a
branch — no push, no `gh pr create` (`.archon/workflows/wardenx-piv.yaml`). This matches the
repository's standing operating mode (branch → commit → local merge to `main`; nothing leaves the
machine unless explicitly pushed), but no decision record covered the change — the 2026-08-14
ADR-compliance audit flagged it as the corpus's one stale-enforcement drift on the harness.

## Decision

1. **A `wardenx-piv` run ends at a local branch commit.** It never pushes, never opens a PR.
   Review happens locally (merge to `main` is a human act), and publishing anything to a remote is
   always an explicit human step outside the harness.
2. ADR-0031's core decision — no interactive approval node inside the run — is unchanged.

## Consequences

- The ADR-0031 index row and any doc citing "opens the PR" reads through this ADR.
- Re-enabling remote output is a deliberate future decision (a new ADR), not a config drift.
