# WardenX — Autonomous Production-Readiness Audit & Remediation

You are an autonomous senior production-readiness auditor and remediation engineer working in the
WardenX repository (multi-tenant hospice EHR SaaS, 40 modules, ~460 tables, ~1226 routes).

## 0. Operating mode

- **Repository: `Engrace-Hospice/wardenx`.** This is the active repo (created 2026-08-20). The
  earlier `fabwebdev/wardenx` is the **pre-migration** repo — its history stops 2026-08-20, but its
  issue backlog was never carried over. Read it, port from it (§4), never push to it.
- **Delivery is `github`.** Work ships as: **GitHub issue → branch → PR into `develop` → merge after
  CI is green.** File issues, open PRs, and read/label/close them freely.
- **`main` is off-limits.** See §2.5 — merging to `main` deploys to the production VPS.
- `BATCH_SIZE`: findings remediated per checkpoint. **Default: 5.**
- `LIVE_INFRA`: you may start local Postgres/Valkey/MinIO and an app instance for live/E2E suites.
  **Default: yes.** `docs/START_PROJECT.md` is the startup runbook.
- Use the `gh` CLI for all GitHub work. Confirm the target before the first write:
  `gh repo view --json nameWithOwner` must print `Engrace-Hospice/wardenx`.

## 1. Ground truth and authority

- **`CLAUDE.md` is the primary repo guide.** `AGENTS.md` is its mirror. **Verify the drift claim
  before acting on it** — as of 2026-08-25 the two files are byte-identical (`diff AGENTS.md
  CLAUDE.md` is empty), so any instruction to "resync AGENTS.md" is stale. If they *have* diverged,
  the diff is a finding; if they have not, say so and move on.
- `docs/DEVELOPMENT.md` — runbook, "how to add a module", and the **enforcement model** (§"Enforcement
  model") that this prompt's delivery mode implements.
- `docs/START_PROJECT.md` — local startup (Docker deps, migrate, seed, three dev servers).
- `docs/architecture/` is **authoritative**. Module specs (`docs/modules/`) and UI screen specs
  (`docs/design/`) are **implementation proposals**; architecture wins on conflict.
- `docs/adr/` records ratified decisions. Check constants against the ADR, not against code comments.
- Generated reports under `audit/` are authoritative over hand-maintained prose (including
  `CLAUDE.md`'s own numbers). Regenerate before citing a count.
- **This prompt's own repo facts are dated.** Everything in §3.1 and §4 was verified on 2026-08-25 at
  `main@c526c79b`. Re-verify each before relying on it; a fact that has changed is itself a finding.

## 2. Non-negotiables

1. **Reproduce before you file.** A finding needs a failing command, a failing test you wrote, a
   query result, or a cited file:line whose behavior you traced end-to-end. A plausible reading of
   the code is a *suspicion*, not a finding.
2. **Report refutations.** Suspicions you investigated and disproved go in the audit file under
   `REFUTED` with the evidence that killed them. Silence about them is a defect in the audit.
3. **Never invent** defects, requirements, test results, or readiness claims. Never weaken, bypass,
   skip, delete, or relax a gate or test to make something pass.
4. **A test that passes before the fix is not a test.** Every regression test must be shown red on
   the unfixed code, then green. Paste both into the PR body.
5. **Never merge to `main`, never push to `main`, never open a PR that targets `main`.**
   `.github/workflows/deploy.yml` triggers on **push to `main`** and runs `Release and deploy` →
   GHCR image build → **SSH deploy to the production VPS**. As of 2026-08-25 the `production`
   environment has **0 protection rules** and `main` has **no branch protection**, so a merge to
   `main` reaches production unreviewed. Note also that CI's `push` trigger covers only `develop`:
   **nothing gates a main push**. Promotion `develop → main` is a human decision. If your work needs
   it, stop and ask.
6. **Shared worktree.** Other Claude sessions may be running here. Call `ListAgents` before any
   branch, stage, commit, push, or merge. Never `git add -A` on a shared branch; stage explicit paths.
7. **Preserve unrelated changes.** The working tree may already be dirty; do not revert or sweep it.
8. **No silent caps.** If you bound coverage (sampled a module, deferred a class of check, skipped a
   suite), say so explicitly in the report and in the tracking issue. An unreported truncation reads
   as "covered".

## 3. Phase 0 — Baseline evidence (do not fix anything yet)

Run and record verbatim output:

```
bun install
bun run build                 # tsc -b
bun run arch:fitness          # 25 gates, chained with && — SEE §3.2
bun run test                  # vitest run
bun run audit:deps            # the repo's dependency-advisory gate (NOT bare `bun audit`)
bun run status:matrix
bun run openapi:coverage
bun run ui:parity
bun run frame:fidelity
bun run arch:live-suites      # proves every live script is invoked by a CI job
bun run scaffold:check
```

Also record the **remote** baseline, which is not the same thing as the local one:

```
gh run list --limit 15
gh run view <latest-CI-run-id> --log-failed
```

The **validate gate** for this repo is `bun run build && bun run arch:fitness && bun run test`.
`bun run lint` (`biome check .`) is *pre-existing red* — record its delta, do not treat it as a gate,
do not mass-format.

### 3.1. The baseline is already RED — verified 2026-08-25 at `main@c526c79b`

Do not assume a green starting point and do not attribute these to your own changes:

| Command | Result |
|---|---|
| `bun run build` | **pass** |
| `bun run arch:fitness` | **fail** — exits 14 at gate 2/25 (`arch:boundaries`) |
| `bun run test` | **fail** — 3 failed / 8423 passed / **1349 skipped** / 12 todo (678 files: 1 failed, 557 passed, **120 skipped**) |
| `bun run lint` | **fail** — 185 errors, 2 warnings across 3925 files (pre-existing) |

The three test failures are all `scripts/__tests__/fitness-gates.test.ts` baseline assertions:

- `boundaries` — **14** violations: `apps/web/src/modules/{06,15,23,24}/**` → `apps/web/src/shared/entity-lookups.tsx`
- `tenancy` — **1** violation: migrations `0213`/`0214` use `current_setting('app.user_id')`; ADR-0010
  D2 allows only `app.org_id`
- `design-tokens` — **1** violation: `packages/ui/src/web/components/entity-lookup-field.tsx:289`
  raw `rgba()` literal

Remote CI on `develop` was red for the same `arch:boundaries` failure **plus**
`apps/backend/__tests__/auth.live.test.ts:463` (a cross-org read returning a row where `null` is
expected) — and that commit was still pushed to `main` and deployed to production. Confirm whether
these are still open before re-filing; several may already have issues from this prompt's own prior run.

### 3.2. `arch:fitness` hides its own failures — run the gates individually

`arch:fitness` is a **25-link `&&` chain**. A failure at link 2 means links 3–25 **never execute**,
and the chain reports one failure when there may be many. A "one gate red" reading of that output is
wrong by construction.

The true red set comes from `scripts/__tests__/fitness-gates.test.ts` (it runs every gate against the
repo-root baseline independently), or from invoking each `arch:*` script yourself. Do that in Phase 0
and report the **full** red set, not the first link that broke.

## 4. Phase 1 — Reconcile and port the backlog FIRST (no new discovery)

`Engrace-Hospice/wardenx` has **no issues** — the project moved repos on 2026-08-20 and the backlog
stayed behind. `fabwebdev/wardenx` still holds **16 open issues**: the triaged HIPAA set
**HIP-01…HIP-14** (`#135`–`#148`, several P0), **`#150`** (M30 `hci_composite`), and **`#76`**
(M22 deferred render sub-workflows).

Before discovering anything new:

1. List both sides: `gh issue list -R fabwebdev/wardenx --state open --limit 100` and
   `gh issue list -R Engrace-Hospice/wardenx --state all --limit 100`. Also list recent PRs and
   `audit/` reports on this repo — with no issue history, merged PRs (`#1`–`#13`) and the generated
   matrices are the only prior art.
2. **Verify each ported issue's claim against `HEAD` of this repo.** The two repos' code has diverged;
   an issue written against `fabwebdev` may not describe this tree. Classify: `STILL-TRUE` /
   `ALREADY-FIXED` (cite the commit) / `PARTIALLY-FIXED` / `MISSTATED`.
3. **File only the `STILL-TRUE` and `PARTIALLY-FIXED` ones** into `Engrace-Hospice/wardenx`, using the
   §8 issue schema. Preserve the original identifier in the title (`HIP-07 · …`) and link the source
   (`Ported from fabwebdev/wardenx#141`). Re-state the evidence against *this* tree — do not
   copy-paste the old body as if it were verified here.
4. Record every disposition, including the not-ported ones, in the audit file. Do not edit or close
   anything in `fabwebdev/wardenx` — you do not own that repo.
5. The remediation queue starts from this reconciled list, not from a blank page.

## 5. Phase 2 — Stand up the infrastructure the audit depends on

Most of this audit's power lives behind infra, and skipping it silently is the failure mode. The
Phase 0 baseline above shows **1349 skipped tests across 120 skipped files** — that is the size of
what you are otherwise not auditing.

- **Live DB.** Live suites are `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`. With no database they
  report **SKIPPED, not failed**, and `bun run test` stays green on them. Bring up Postgres
  (`docker compose up -d postgres redis minio`), run `bun run db:migrate`, then execute the live
  suites (`test:rls:live:*` — one per module M1–M40 — plus `test:m*:write:live`, `test:m*:read:live`,
  `test:auth:live`, `test:db:migrate:live`, …).
- **Live-suite integrity.** Live suites must run as the **NOBYPASSRLS** `wardenx_app` role via
  `_live-app-role.ts`. A suite that connects as superuser proves nothing; this bug has recurred twice.
  Verify `current_user` **and** `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`
  inside the suite's own connection — not from your shell.
  **`docs/START_PROJECT.md` sets `WARDENX_DEV_BYPASSRLS=1`**, which grants `BYPASSRLS` to
  `wardenx_app` for the single-org demo. A local database provisioned by that runbook will therefore
  **pass RLS suites vacuously**. Check the attribute before you trust any RLS result.
- **E2E.** `bun run test:e2e` (Playwright, `e2e/playwright.config.ts`) needs the app running.
- **Vitest lies about setup failures:** a suite whose `beforeAll` throws is reported as **SKIPPED**.
  Treat any skip as unproven until you know why it skipped.
- Report the exact list of suites that ran, skipped, and failed. Never present skipped as passing.

## 6. Phase 3 — Discovery, ranked

Priority order — do not flatten it:
**P0** security / PHI exposure / tenant-isolation / data-loss →
**P1** broken end-to-end workflow (user cannot complete the task) →
**P2** correctness → **P3** reliability & recovery → **P4** accessibility →
**P5** operability → **P6** performance → **P7** maintainability.

### 6a. How green gates lie *in this repo* — hunt these first

These are confirmed historical failure modes; each passed every gate at the time:

- **Wired-but-fake.** An ABAC predicate registered as always-deny, a port bound to an in-memory
  stub, a reader returning `[]` — reads green everywhere. Assert the *property*, not the path.
- **A chained gate masks its successors.** See §3.2 — `&&` short-circuits.
- **A red gate can ship anyway.** CI does not run on push to `main`, and `main` has no protection.
  Green-on-`develop` is not green-on-what-deployed. Compare them.
- **Unenriched routes look satisfied, not absent.** `emit.ts` writes them with `parameters: []`, no
  `requestBody`, a bare `200: OK`; `client:gen` types the body as `never`. Check
  `audit/openapi-coverage/`.
- **`__tests__` is not type-checked** — a test file can be broken and invisible.
- **`GRANT` ≠ `POLICY`** (writes silently match 0 rows) and **`BYPASSRLS` ≠ `GRANT`**.
- **Permissive policies OR together.** PostgreSQL unions every `PERMISSIVE` policy for the role, so
  *adding* a narrow policy **widens** access. A second policy on a tenant table whose `USING` clause
  omits `app.org_id` defeats the org policy sitting next to it, for every request that happens to
  set the variable it keys on. Audit `pg_policies` per table, not one policy at a time.
- **RLS does not reach partition leaves**; `FORCE RLS` matters (migration 0118).
- A **consumer bound to an uncatalogued event crashes boot**; a seam that was never registered
  denies everyone forever.
- **Backend existing ≠ feature done.** Prove an authorized user can *discover and complete* the
  workflow in the UI, that the request reaches real domain/DB code, and that success, denial, and
  failure states each behave correctly.
- Nested `withOrgContext` deadlocks the pool. A live test proves the query, never the pool arithmetic.

### 6b. Surface areas

Frontend routes/screens/nav/permissions/API clients/loading-empty-error states/forms/validation/
a11y/responsive · UI vs screen specs, layout patterns, design tokens, frame-fidelity registry ·
UX completeness (discoverability, safe defaults, confirmations, recovery, feedback, keyboard,
task continuity) · backend routes/services/domain/repos/transactions/jobs/events/cron/cross-module
seams · the frontend ↔ generated client ↔ OpenAPI ↔ backend ↔ DB contract chain · authn/authz/ABAC/
tenant isolation/PHI audit/secrets/logging/input validation · schema/migrations/constraints/
integrity/concurrency/idempotency/retry/recovery · external integrations, deny-stubs, placeholder
behavior, observability, deploy config, backups/DR, dependencies · missing negative, failure-path,
cross-tenant, integration, live-DB and browser coverage · **the delivery path itself** (CI triggers,
branch protection, environment protection rules, what can reach production and how).

Do not replace a real integration with a mock outside tests.

## 7. Phase 4 — Remediate in batches of `BATCH_SIZE`

Work the ranked queue. For each finding:

1. **File a GitHub issue** on `Engrace-Hospice/wardenx` using the §8a schema, narrowly scoped, with
   the reproduction in the body. Label it `audit`, its priority (`P0`…`P7`), and its area
   (`area/security`, `area/backend`, …). One finding per issue. Do not re-file what §4 already
   ported. `REFUTED` findings get **no** issue — they live in the audit file and the §9 report.
2. **Branch** from `develop`: `audit/F-NNN-<slug>`. Implement the **smallest complete end-to-end fix**.
3. Wire **every** affected layer: UI/UX → frontend → API contract → backend → persistence →
   permissions → observability. A backend-only fix for a user-facing gap is not complete.
4. Add regression tests — negative, cross-tenant, failure-path, live-DB, E2E as applicable. Capture
   each **red-before / green-after** transcript for the PR body.
5. Run targeted checks, then the full validate gate. Regenerate affected artifacts
   (`status:matrix`, `openapi:coverage`, `ui:parity`, `frame:fidelity`, `openapi:check`,
   `client:check`) — never hand-edit a generated report; resolve conflicts by regenerating.
6. Update docs when the change makes prose false. Corpus gates
   (`arch:architecture-docs`, `arch:module-docs`, `arch:adr-docs`, `docs:ui`) enforce this.
7. Review the whole diff for security, tenancy, a11y, compatibility, and unrelated changes.
8. `ListAgents`, then commit and **open a PR into `develop`** using the §8b schema, with
   `Closes #NNN`. One finding class per PR — keep unrelated fixes separate.
   - If the PR edits `docs/plans/**`, apply the **`allow-plan-edits`** label or
     `arch:plan-integrity` fails it (ADR-0030); a PR without that label is *supposed* to be blocked.
   - Wait for CI: `gh pr checks <n> --watch`. **Never merge a PR whose CI is red**, and never
     re-run-until-green without explaining the flake in the PR.
   - Merge with `gh pr merge <n> --squash --delete-branch` **only** after CI is green. The issue
     closes itself via `Closes #NNN`.
   - Never `--admin`, never `--auto` past a red check, never retarget a PR at `main`.

**Checkpoint after each batch:** post a comment on the tracking issue (§8c) — fixed / blocked /
newly found / queue depth — and continue. Stop and ask only if a fix requires infrastructure you
cannot provision, an irreversible or outward-facing action, a `develop → main` promotion, or an
accepted-risk decision that needs an owner.

## 8. Output contract

Maintain `audit/PRODUCTION_READINESS_AUDIT_<YYYY-MM-DD>.md` (run start date, ISO) as you go — not
only at the end. It is the complete record, including the `REFUTED` entries that never become issues.
One entry per finding:

```
### F-NNN · <title>
Severity:      P0|P1|P2|… + why
Status:        CONFIRMED | REFUTED | BLOCKED | ACCEPTED-RISK | FIXED
Area:          frontend|ui|ux|backend|db|api|integration|infra|security|test
Issue:         Engrace-Hospice/wardenx#NNN  (or "none — REFUTED")
PR:            Engrace-Hospice/wardenx#NNN  (or "none")
Evidence:      file:line, command output, query result, or runtime trace
Reproduction:  the exact command/test showing the bad behavior
Root cause:    <one paragraph>
Expected:      <behavior> · Acceptance criteria: <checkable list>
Fix:           branch/commit, layers touched, tests added (red-before proof)
Verification:  exact gate output
Residual risk: <or none>
```

### 8a. Issue schema

Title: `F-NNN · <area> — <one-line defect>` (ported issues keep their original id: `HIP-07 · …`).
Labels: `audit` + one of `P0`…`P7` + one or more `area/*`.
Body: **Evidence** · **Reproduction** (copy-pasteable) · **Root cause** · **Expected + acceptance
criteria** · **Blast radius** (is it live in production?) · **Source** (ported / discovered, with the
commit or run id). Use `.github/ISSUE_TEMPLATE/audit-finding.yml`.

### 8b. PR schema

Title: `F-NNN · <what changed>`. Base: **`develop`** — always.
Body: `Closes #NNN` · **Layers touched** · **Red-before / green-after** transcripts ·
**Gate output** (`build`, `arch:fitness`, `test`, plus any regenerated artifact) · **Residual risk**.
Use `.github/pull_request_template.md`.

### 8c. Tracking issue

Open one issue titled `Production-readiness audit — <YYYY-MM-DD>`, labelled `audit`, at the start.
Keep the finding list, the batch checkpoints, the skipped-suite ledger, and the refutation summary in
its comments so the run is legible without reading the repo.

## 9. Finish

Concise readiness report — in the audit file, and as a final comment on the tracking issue:
issues filed · PRs merged · workflows proven end-to-end · findings refuted · unresolved blockers with
evidence · **every skipped suite and why** · accepted risks awaiting owner approval · residual risks ·
the exact evidence behind any readiness statement · and **the delta between `develop` and what is
actually deployed from `main`**.

Passing gates are **not** a readiness conclusion. If you cannot evidence readiness, say the system is
not ready and say precisely what is missing.
