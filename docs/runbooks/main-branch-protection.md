# Runbook: protect `main` (CW-CM-01, CW-SEC-01)

`main` deploys on every push (`deploy.yml`). Today nothing on GitHub stops an unreviewed, unscanned or force-pushed
change from landing there. The repo now carries everything that can be committed; **the ruleset itself is a
repository setting and is not applied.** This runbook is the owner's procedure to apply it, verify it and undo it.
Nothing here has been run.

## 0. What is committed, what is not

| Piece | Where | State |
|---|---|---|
| Ruleset definition (review, code-owner review, required checks, no force-push, no deletion) | `.github/rulesets/main.json` | committed, **not applied** |
| Server-side secret/PHI scan and cheap register gates on every PR into `main` | `.github/workflows/pr-gate.yml` (jobs `Secret and PHI scan`, `Compliance gates`) | committed; reports on PRs, blocks nothing until the ruleset is applied |
| Code-owner coverage of the harness, the register, the scanners, the deploy path and the gates | `.github/CODEOWNERS` | committed; takes effect with the ruleset |
| Offline check that the definition still demands what the register claims and that its checks report | `bun run arch:branch-protection` (in `arch:fitness`) | enforced |
| Live check that GitHub enforces the committed definition | `bun run ops:verify-branch-protection` | by hand, after step 3 |
| Hooks installed in every clone | `prepare` / `setup:hooks`, `bun run arch:hooks-installed`, fail-closed `.githooks/pre-commit` | enforced locally |

## 1. Decisions to make first

1. **Plan.** Rulesets and Environment reviewers on a private repository need a paid GitHub plan. At the time of
   writing `gh api orgs/Engrace-Hospice --jq .plan.name` answers `free`, so step 3 fails with HTTP 403 until the
   organization is upgraded (GitHub Team). This is the gap #16 recorded; it is an account and billing decision, not
   an engineering one.
2. **Sole code owner.** `CODEOWNERS` names one person, and GitHub never lets an author approve their own pull
   request. With code-owner review required and no bypass, that person could merge nothing they wrote. The committed
   definition therefore lets the **Repository admin role** bypass **by pull request only** (`bypass_actors`, mode
   `pull_request`: it can merge a PR without the approval, but cannot push to `main`, force-push or delete it; each
   use is in the audit log). Once a second code owner exists, delete that `bypass_actors` entry and re-apply (step 7),
   and the review becomes independent. `arch:branch-protection` rejects a bypass actor with mode `always`.
3. **#870 (full CI on PRs).** The ruleset requires only the two cheap `pr-gate.yml` checks. Running `ci.yml`'s matrix
   on PRs into `main` is a separate, metered-minutes decision; if it is made, add that workflow's job names as required
   checks in `main.json` (same `integration_id`), merge, then re-apply (step 7).
4. **Working agreement after it is applied.** Every change reaches `main` through a pull request, including the
   owner's. The `pre-push` fitness gate for `main` becomes a second line, not the only one. Deploy-on-merge is
   unchanged (`deploy.yml`).

## 2. Pre-flight (read-only)

```sh
REPO=Engrace-Hospice/chartwarden
bun run arch:branch-protection                            # the committed definition is sound
gh api "orgs/Engrace-Hospice" --jq .plan.name             # must not be "free"
gh run list --repo "$REPO" --workflow pr-gate.yml --limit 5   # both jobs have run, green, on a PR into main
gh api "repos/$REPO/actions/runners" --jq '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv'
                                                          # a runner labelled self-hosted,Linux,X64,ci is online
gh api "repos/$REPO/codeowners/errors" --jq '.errors'     # must be []
gh api "repos/$REPO/rulesets" --jq '.[] | [.id, .name, .enforcement] | @tsv'   # note any ruleset that exists
```

A required check that never reports blocks every merge, and the owner is the only person who could lift it, so do not
skip the `pr-gate.yml` run: merge the PR that adds it, open any small PR into `main`, and see both checks go green.

## 3. Apply the ruleset

```sh
REPO=Engrace-Hospice/chartwarden
gh api --method POST "repos/$REPO/rulesets" --input .github/rulesets/main.json
RULESET_ID=<the "id" in the answer>      # keep it: steps 6 and 7 use it
```

It takes effect at once on `main` (`enforcement: active`; the dry-run mode `evaluate` is an Enterprise feature).

## 4. Environment reviewers (the second half of the CW-CM-01 gap)

`production` should need a human approval before `deploy` runs, so a workflow edit or re-run cannot reach the VPS by
itself. Read what is configured first, because a `PUT` replaces the environment's settings:

```sh
gh api "repos/$REPO/environments/production"
REVIEWER_ID=$(gh api users/<reviewer-login> --jq .id)
gh api --method PUT "repos/$REPO/environments/production" --input - <<JSON
{"reviewers":[{"type":"User","id":$REVIEWER_ID}],"prevent_self_review":false}
JSON
```

Leave `prevent_self_review` false while there is one reviewer; set it true when there are two. This needs a person to
click "Approve" on each deploy: say so to whoever is on call.

## 5. Verify

```sh
bun run ops:verify-branch-protection                  # ruleset + the rules GitHub applies to main + Environment reviewers
bun run ops:verify-branch-protection --ruleset-only   # if step 4 is not done yet
```

It exits 1 and names each difference (not applied, not active, weaker rule, extra bypass actor, no reviewers).
Then check behaviour **without touching `main`**: open a draft PR that edits a file under `compliance/`, confirm
GitHub shows "Code owner review required" and the two required checks, and that `gh pr merge` is refused until they
pass. Do **not** test by pushing to `main`: if the ruleset were not active, that push would deploy.

Keep as the change record: the `ops:verify-branch-protection` output, `gh api repos/$REPO/rulesets/$RULESET_ID`, the
date and the change ticket id.

## 6. Roll back

| To undo | Command | Effect |
|---|---|---|
| Pause the ruleset, keep it defined | `gh api --method PUT "repos/$REPO/rulesets/$RULESET_ID" -f enforcement=disabled` | nothing is enforced; step 7 re-enables |
| Remove it | `gh api --method DELETE "repos/$REPO/rulesets/$RULESET_ID"` | back to today |
| Remove Environment reviewers | `gh api --method PUT "repos/$REPO/environments/production" --input - <<< '{"reviewers":[]}'` | `deploy` runs without approval |

A rollback makes the register's claim false: in the same change, put CW-CM-01 / CW-SEC-01 back to the wording before
this was applied, and say why in the ticket.

**Locked out** (a required check cannot report, for instance because the `ci` runner is down): the admin bypass lets the
owner use "Merge without waiting for requirements" on the PR. If the bypass entry was removed, pause the ruleset (above),
merge, and re-enable it the same day.

## 7. Change the definition later

Edit `.github/rulesets/main.json`, open a PR (it needs code-owner review once applied), merge, then:

```sh
gh api --method PUT "repos/$REPO/rulesets/$RULESET_ID" --input .github/rulesets/main.json
bun run ops:verify-branch-protection
```

`arch:branch-protection` runs on the PR and fails if the edit drops review, code-owner review, the scan check, the
force-push or deletion rules, pins no GitHub Actions app, or names a check no PR-triggered job reports.

## 8. After it is applied: close the register

In `compliance/controls.yaml`:

- **CW-SEC-01** → `status: implemented` and drop `gap` (the gap was this ruleset plus an enforced hook install; the
  hook install is enforced in the repo). Keep the evidence list.
- **CW-CM-01** stays `partial`: edit its `reason` to delete the sentence that says `main` has no branch protection
  and the `production` Environment has no required reviewers. The classifier-heuristic, Rust-image, Postgres-image and
  backup-image items are separate and remain until their own evidence exists.

### The backup image (#993) is the same row's other open item

`backup-image.yml` already scans, signs and SBOM-attests the image, and `compose.backup.yml` takes one digest-pinned
reference. What is missing is runtime evidence, all operator steps (`deploy/production/README.md`, "Backups and
restore" and "Postgres image"): run `backup-image.yml` on `main` once, `cosign verify` and `cosign verify-attestation`
the digest against `https://github.com/Engrace-Hospice/chartwarden/.github/workflows/backup-image.yml@refs/heads/main`,
pin `CHARTWARDEN_BACKUP_IMAGE` to that digest on the host, and keep the output as the change record.

## 9. What this does not close

- A PR that edits `pr-gate.yml` runs its own edited copy. The ruleset pins the check to the GitHub Actions app and
  requires code-owner review of `.github/workflows/`, but with one owner and the admin bypass, that review is the
  owner reviewing their own change. A second code owner is what makes it independent.
- `git commit --no-verify`, or `CI=1` for `arch:hooks-installed`, still skip the local scan on purpose. The required
  `Secret and PHI scan` check is what stops a commit made that way from reaching `main`, once step 3 is done.
- `.gitleaks.toml` disables `generic-api-key` (documented there); the scan is gitleaks' default rules plus
  `harness:phi-scan`, not a proof that no secret is present.
