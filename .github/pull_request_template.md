<!-- Audit PRs: see docs/reviews/PROMPT_5_WARDENX_PRODUCTION_READINESS_AUDIT.md §8b. -->

Closes #

## What changed

<!-- The smallest complete end-to-end fix. One finding class per PR. -->

## Layers touched

<!-- UI/UX · frontend · API contract · backend · persistence · permissions · observability · docs.
     A backend-only fix for a user-facing gap is not complete. -->

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
     Paste both transcripts. -->

```text
# red on the unfixed code

# green after the fix

```

## Gate output

```text
# bun run build

# bun run arch:fitness    (run the gates individually too — the && chain short-circuits)

# bun run test

```

## Residual risk

<!-- Or "none". Do not leave blank. -->

---

- [ ] Base branch is `develop` (**never `main`** — a push to `main` deploys to the production VPS)
- [ ] CI is green (`gh pr checks <n> --watch`); no gate was weakened, skipped, or deleted to get here
- [ ] `allow-plan-edits` label applied **if and only if** this PR intentionally edits `docs/plans/**`
- [ ] Generated reports regenerated rather than hand-edited
