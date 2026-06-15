# ADR-0031 — `wardenx-piv` drops the interactive approve node (review moves to the PR)

- **Status:** Accepted — applied 2026-06-15 (`wardenx-piv` **v0.3.0**, commit `d9bc969`).
- **Date:** 2026-06-15
- **Phase:** build-harness governance (affects every wave run through `wardenx-piv`).
- **Resolves:** the recurring **approve-node hang** that stalled both completed builds after all work
  was done — the M1+M2 slice (PR #3) and Wave A / M3+M4 (PR #4) — each forcing a manual recover; plus a
  latent bug where the workflow **never committed** the work it built.
- **Relates to:** the Archon nested-Claude class issue
  [coleam00/Archon#1067](https://github.com/coleam00/Archon/issues/1067); the v0.4.1 installer warns:
  *"Detected CLAUDECODE=1 … if workflows hang silently, this is a known class of issue."*

## Context

`wardenx-piv` (≤ v0.2.0) ended each run with two nodes:

```
… → fix → approve (interactive: true) → pr (bash: git push + gh pr create)
```

`approve` paused for a human to review the diff and "proceed"; `pr` then pushed and opened the PR.

Two independent defects made this never complete on its own:

1. **The interactive node hangs.** Archon's `interactive: true` node blocks waiting for terminal input.
   Under a Claude Code session (`CLAUDECODE=1`) it hangs silently (#1067) instead of prompting. This bit
   **twice**: the slice run (2026-06-14) and the Wave A run (2026-06-15) each built their entire backend,
   reached `approve`, and then churned indefinitely with **0 commits / no PR** until killed. Both were
   recovered by hand (verify gate → `git add -A && commit` → push → `gh pr create`).
   - **Root cause is not fully pinned.** The slice's launch terminal was a Claude-spawned shell
     (`CLAUDECODE=1` inherited) — clean #1067. Wave A was launched from an apparently-normal shell yet
     hung the same way, leaving two possibilities we could not disambiguate after the fact: (a) that
     terminal *also* carried `CLAUDECODE=1`, or (b) the interactive node is simply unreliable in this
     Archon build regardless of nesting. Either way the node is the failure point.
   - Note: the **non-interactive** prompt nodes (`confirm-plan`, the `implement` loop) worked fine even
     while nested — they built the whole backend. Only the `interactive` node fails.

2. **Nothing committed the work.** The `implement` loop and `validate`/`fix` gates never commit; the old
   `pr` node only ran `git push -u origin HEAD`. So even absent the hang, `HEAD == base` and the push
   would have carried an empty branch. The work survived only because it sat uncommitted in the worktree.

## Decision

**Remove the interactive `approve` node. The run finalizes and opens its PR autonomously; review happens
on the GitHub PR.** New tail:

```
… → fix → finalize (prompt, non-interactive) → pr (bash)
```

- **`finalize`** (non-interactive prompt) writes two gitignored files: `.archon/commit-msg.txt` (a
  conventional-commit message for the wave) and `.archon/pr-body.md` (the PR description — per-module
  summary, gate results, **an explicit "Reviewer items" section listing every fitness-gate / build-config
  edit for ratification**, and any deferred / deny-stub / forward-seam work). It runs no git/gh itself.
- **`pr`** (bash) does the deterministic part: `git add -A` → `git commit -F .archon/commit-msg.txt` →
  `git push` → `gh pr create --body-file .archon/pr-body.md` (fallback `--fill`).

Retained unchanged: the per-task `setup`/`confirm-plan`/`implement`/`validate`/`fix` structure — including
the `confirm-plan` "STOP if ambiguous" discipline and the green-gate requirement before `finalize`.

## Consequences

- **Runs complete without a human in the loop at the harness level.** Wave B onward should run
  start-to-finish and open their own PR — no build-everything-then-die-at-approve recovery.
- **Review is not lost — it moves to where it belongs.** The GitHub PR carries the `finalize`-composed
  body; the "Reviewer items" call-out is what surfaced, e.g., the Wave A `check-table-ownership.ts`
  helper-path exemption for ratification. Merge discipline (CI green + human review/merge) is unchanged;
  `main` is still guarded by CI + the pre-push gate (no branch protection on the free private repo).
- **The "nothing commits" bug is fixed** as a side effect (the `pr` node now commits).
- **Operational guidance (still true):** launch `archon workflow run` from a genuinely independent
  terminal, not a Claude-/editor-spawned one; verify with `echo "$CLAUDECODE"` (must be blank). This
  reduces the odds of *other* nested-execution issues even though the approve hang itself is now moot.
- **Supersedes** the "human-approve a PR" step described in earlier `wardenx-piv` versions and in
  `docs/ARCHON_SETUP.md` / `docs/plans/ARCHON_RUN_TRACKER.md` (those describe a pause that no longer
  exists; the run auto-opens the PR).

## References

- Workflow: `.archon/workflows/wardenx-piv.yaml` (v0.3.0)
- History: PR #3 (slice, recovered 2026-06-14), PR #4 (Wave A, recovered 2026-06-15)
- Related plan-input fix (same evolution): `{{ inputs.plan }}` → `setup` resolves `.archon/run-plan.txt`
  (v0.2.0), since v0.4.x exposes per-run data only via the message (`$ARGUMENTS`).
