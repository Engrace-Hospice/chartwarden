<!-- Audit PRs: see docs/reviews/PROMPT_5_WARDENX_PRODUCTION_READINESS_AUDIT.md §8b.
     Open as a DRAFT while you work. Mark ready-for-review when it is complete. -->

Closes #

## What changed

<!-- The smallest complete end-to-end fix. One finding class per PR.

     Handing over a reproduction instead of a fix? Title this
     "F-NNN · red test only — needs a fix", keep it a draft, say so here, and
     link it from the issue. Whoever picks it up pushes the fix onto this branch. -->

## Layers touched

<!-- A backend-only fix for a user-facing gap is not complete. -->

- [ ] UI / UX
- [ ] frontend
- [ ] API contract (OpenAPI + generated client regenerated, not hand-edited)
- [ ] backend
- [ ] persistence / migrations
- [ ] permissions / RLS
- [ ] observability
- [ ] docs

## Red-before / green-after

<!-- REQUIRED for any fix. A test that passes before the fix is not a test.
     Commit the red test FIRST, on its own, so the proof is in `git log` and a
     reviewer can check out that commit and watch it fail. Paste both transcripts. -->

```text
# red on the unfixed code

# green after the fix

```

## Gate output

```text
# bun run build

# bun run arch:fitness

# the individual gates — the && chain short-circuits, so the chain alone
# proves nothing about the gates after the first failure

# bun run test

```

## Residual risk

<!-- Or "none". Do not leave blank. -->

## Who should review, and what to look at

<!-- Not "please review". Point at the part you are least sure about. -->

---

- [ ] Base branch is `develop` (**never `main`** — a push to `main` deploys to the production VPS)
- [ ] CI is green (`gh pr checks <n> --watch`); no gate was weakened, skipped, or deleted to get here
- [ ] `allow-plan-edits` label applied **if and only if** this PR intentionally edits `docs/plans/**`
- [ ] Generated reports regenerated rather than hand-edited
- [ ] Review requested from `Jacobson-svg`
- [ ] P0/P1: left ready-for-review rather than self-merged
