# Fitness gates: test typecheck, manifest mirror, merge artifacts, live-suite coverage, branch protection, hook install, vendor agreements

> Rationale for `check-test-typecheck-coverage`, `check-manifest-mirror`, `check-merge-artifacts`, `check-live-suite-coverage`, `check-branch-protection`, `check-hooks-installed`, `check-vendor-agreements`. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

- `scripts/check-test-typecheck-coverage.ts` — **test-tree typecheck coverage gate** (F-098,
  `bun run arch:test-typecheck`, in `arch:fitness`; `bun run typecheck` now runs `tsc -b` PLUS
  `typecheck:tests`). **Every test file vitest runs must be in a typecheck program. None of them were.**
  All four apps and all 51 packages set `"include": ["src"]`, and the convention here puts a suite in a
  sibling `__tests__/`, so `tsc -b` compiled the source of every project and **631 files vitest runs were
  compiled by nothing** — 346 of them in `apps/backend/__tests__` alone. Only `scripts/` (its own tsconfig
  globs everything under it) and `e2e/` were covered. A test file is the only executable statement of what
  a production signature is supposed to be, and when it is not compiled, changing a signature does not
  break its callers — it silently makes them WRONG, and a suite that no longer matches the code it covers
  still reports green for whatever it does instead. **F-096 (#209) is the worked example**: it made
  `PatientRouteService.list`'s caseload-narrowing argument REQUIRED, a two-argument caller survived in
  `auth.live.test.ts`, and a full `typecheck && test` was green on both — invisible on two axes at once,
  since a live suite also self-skips without a database. The census-narrowing control shipped with its own
  proof passing an undefined scope. The gate does not check that the configs EXIST, it checks that they
  RESOLVE to the same file set the runner does: it imports `vitest.config.ts` itself (rather than
  restating its globs — the copy-of-a-list shape F-094/F-095 were about), expands each project's
  include/exclude over the tracked tree, and requires every file to appear in the `fileNames` of the
  `tsc -b` project graph, `tsconfig.tests.json` or `tsconfig.tests.dom.json`. Its glob matcher REFUSES a
  pattern it cannot represent rather than approximating it — an under-matching matcher reports a covered
  file as unchecked, or an unchecked one as covered, both with a green build. It also checks the SPLIT:
  the DOM program is the only one carrying `lib: DOM` + `jsx`, and a jsdom suite compiled without them
  reports itself, while a NODE suite drifting into the DOM program compiles happily and throws at runtime
  on a `document` jsdom was never asked for — so the two programs must be **disjoint**. The test programs
  set `noUncheckedIndexedAccess: false` and nothing else: that one flag accounts for **720 of the 944**
  errors turning this on surfaced, all of them `possibly undefined` on test-local scaffolding where a
  dereference throws and fails the test loudly, which is the correct outcome and not the silent-undefined
  propagation the flag exists to prevent. The **224 that remain are the interface-agreement class**, and
  fixing them found live defects in the corpus: fabricated enum values a database would reject
  (`verbal_threat`/`animal_hazard` for `safety_incident_category`, `rn` for `OncallShiftDiscipline`,
  `scheduled` for `VisitStatus`, `home` for `VisitSetting`, `closed` for `DisciplinePlanStatus`,
  `patient` for `ConsentGrantorKind`, `cloud`/`capability_default` for the two `ai_routing_*` enums,
  `cms.section_i.missing` for a HOPE rule id); `discipline-plans-authz`'s `__resetAbacForTest?.()`, a
  no-op because nothing exports that name, so the registry it clears was never cleared; M14's
  `createInMemoryIdgBackend` returning `drainEvents`/`currentQuorum` through an untyped `Object.assign`
  under an annotation that widened them away (now `IdgBackendInspect`, the M22 `DocumentBackendInspect`
  shape); every `recordDecision` call in the M14 acceptance suite omitting the REQUIRED §2.6 D4 `payload`,
  so the adjournment burst it asserts carried nothing to M7/M11/M12; the M13 comfort-kit suite handing a
  `KitDrawdownInit` (the deployment plan) to `applyKitDrawdown` (which decrements the persisted
  `KitDrawdownState`), running every drawdown with an undefined deployment id and drug name; `SeedIds` in
  the M9 read suite naming two of the five ids `seedOrg` returns; a `json(): never` inject-helper
  declaration that made every response-body read in `hope-routes`/`admission-routes` an error; and ~20
  `SessionContextRecord` fixtures still on the pre-F-030 shape, which is why `identity-seams.test.ts`
  asserted `sessionClass`/`portalAccountId`/`sessionPatientId` as `undefined` — a shape the real store
  cannot return — directly under a comment claiming it pinned the FULL actor.
- `scripts/check-manifest-mirror.ts` — **manifest-mirror agreement gate** (`bun run arch:manifest-mirror`,
  in `arch:fitness`, ordered BEFORE `arch:boundaries`). The manifest exists twice: `module-manifest.ts` is
  what every fitness script imports, and `module-manifest.cjs` is the CommonJS mirror
  `.dependency-cruiser.cjs` requires, because a dependency-cruiser config is plain CJS with no TypeScript
  in the loop. The `.cjs` began as `tsc`'s emit of the `.ts` — the `Object.defineProperty(exports,
  "__esModule", …)` preamble is the giveaway — but its header prose was later condensed by hand, so it is
  no longer byte-reproducible from a transpile and regenerating it would delete writing someone did
  deliberately. Nothing kept the two in agreement after that: every table added to a module since had to
  be written into both files from memory, and two were not — `membership_elevated_approval` (0204) and
  `device_attestation` (0222), the first for the whole of its life. That drift changed no behaviour,
  because dependency-cruiser reads only `codePaths`/`dependsOn` and `ownedTables` is consumed by
  `check-table-ownership.ts` off the `.ts`. **That is the problem, not the mitigation**: a mirror that can
  be wrong in a way nothing notices will eventually be wrong in a way something does, and a missing
  `codePaths`/`dependsOn` entry silently RELAXES an import boundary — the one failure the boundary gate
  exists to prevent and the one shape it cannot detect in itself. The gate compares the DATA (the files
  may and should differ in prose) plus the two FUNCTIONS dependency-cruiser actually calls,
  `allowedImportPaths`/`allowedTables`, evaluated for every module id: agreeing on every input while
  disagreeing on the resolved output would be the worst possible pass.
- `scripts/check-merge-artifacts.ts` — **unresolved-merge-artifact gate** (`bun run
  arch:merge-artifacts`, first in `arch:fitness`). A conflicted file that is `git add`-ed without
  being resolved commits its CONFLICT MARKERS: `add` marks a path resolved whatever is in it, so the
  markers land in the tree and the merge commit looks ordinary. Source files are safe by accident —
  `tsc` will not parse `<<<<<<< HEAD` — but the load-bearing NON-source files have no reader in the
  build. That is how a half-resolved `.github/workflows/ci.yml` sat on `main` across seven merges:
  GitHub parses that file, not the toolchain, and `arch:live-suites` reads it as TEXT (it greps for
  script names), so it found every job name and stayed green while the workflow was syntactically
  dead. A broken workflow does not fail a build, it fails to RUN one. The gate scans every
  `git ls-files` path — YAML, JSON, Markdown and SQL included — for a line-initial `<<<<<<< ` /
  `>>>>>>> `, or a whole-line `=======` (matched exactly, since seven equals signs are also a
  Markdown setext heading; a real conflict always brings a `<<<<<<<` with it).
- `scripts/check-live-suite-coverage.ts` — **live-suite CI coverage** (`bun run arch:live-suites`).
  Every live-database / live-Redis / browser suite in `package.json` must be invoked by a job in
  `.github/workflows/ci.yml`. A live suite is `describe.skipIf(!CHARTWARDEN_TEST_DATABASE_URL)`, so
  with no database it reports SKIPPED rather than failed and `bun run test` stays green either
  way; a script in `package.json` looks wired but nothing distinguishes one CI runs from one
  nothing has ever run. That pairing (GAP-086) left the 25 clinical-core **lifecycle** suites —
  205 assertions over the real Drizzle write paths — unexecuted outside their authors' laptops,
  and 23 of 25 were red once run. Two CI jobs now cover them: `rls-live` (table-level policy
  proof) and `lifecycle-live` (the production route services as the NOBYPASSRLS `wardenx_app`
  role, grouped per module). Detection derives from what a script **runs**, not what it is
  **called** — a command naming a `*.live.test.ts` file or invoking `playwright` is a live suite
  whatever its name. It used to match on the NAME, with a middle segment that allowed hyphens but
  not colons, so `test:m6:t3:write:live` and eight others were invisible to it and six ran in no
  job at all (F-015/#41) — GAP-086's failure mode reintroduced through the gate written to prevent
  it. A suite that genuinely cannot run yet is a **registered** entry in `DEFERRED` carrying its
  blocker, never an unmatched name (the `deviceAttestationValid` rule), and the gate fails the
  moment CI starts running a deferred script so the entry cannot outlive its reason; `DEFERRED` is
  empty today. All **122** suites run in CI, `test:e2e` included — the `e2e` job drives a real
  Chromium over a migrated, `db:seed:all`-seeded full stack (20 browser specs — 13 critical-workflow + the seven
  axe-core WCAG 2A/AA scans that are the repo's only automated accessibility coverage). The gate
  now checks **both directions** (F-025/#59): script → CI, and **file → script**. The second was
  never asked, so 29 suite files (112 tests) were named by no script and therefore run by nothing —
  not CI, not a hook, not `bun run test`, which never sets the live env vars. Several were the only
  live proof of a seam this document cites by filename (`m26-cost-report-cap-seam`,
  `m27-validation-context`, `m25-835-ingestion`, `m31-portal-eraser`). Twenty-eight passed when run;
  the one that did not — `m6-abac-scope-resolver` (GAP-011), green on `main` and red on the F-017
  stack once that branch's fail-closed provider-entity check landed — is why this is a gate and not
  a note. All 29 now have `test:…:live` scripts and `lifecycle-live` runners, and that job gained a
  Valkey service because four of them gate on `CHARTWARDEN_TEST_REDIS_URL` too and would otherwise have
  reported SKIPPED. Exclusions on either side are **named** — `DEFERRED` and `NOT_A_SUITE_FILE` —
  never a file or script that quietly fails to be found.

- `scripts/check-branch-protection.ts` — **`main` ruleset definition gate** (CW-CM-01 / CW-SEC-01,
  `bun run arch:branch-protection`, in `arch:fitness`). `main` deploys on every push, and the control that
  keeps an unreviewed or unscanned change off it is a GitHub ruleset: a repository SETTING, so nothing in the
  tree proved it existed or what it said (the register said "main has no branch protection" and the
  organization is on the free plan, so applying it stays a paid-plan, owner decision). The gate checks the
  committed definition `.github/rulesets/main.json` offline and with no credentials: active on
  `refs/heads/main`, deletion and force-push blocked, a pull request with code-owner review and stale approvals
  dismissed, the `Secret and PHI scan` check required and every check pinned to the GitHub Actions app (another
  app cannot report it), no bypass actor in `always` mode. It also requires every required check to be the
  UNCONDITIONAL job (no `if:`, not a reusable-workflow call) of a workflow that a pull request into `main`
  always starts (no `paths:` filter): a required check nothing reports blocks every merge, and a skipped one
  counts as passing. CODEOWNERS must own the harness list the compliance gate pins plus the deploy path and the
  gates themselves. It cannot prove the ruleset is APPLIED; `bun run ops:verify-branch-protection` compares the
  live ruleset, the rules GitHub reports for `main` and the `production` Environment's reviewers with the
  committed file, by hand (`docs/runbooks/main-branch-protection.md`). The sole code owner cannot approve their own
  PR, so the committed definition lets the admin role bypass by pull request only.
- `scripts/check-hooks-installed.ts` — **hook install gate** (CW-SEC-01, `bun run arch:hooks-installed`, in
  `arch:fitness`). `.githooks/pre-commit` runs only where `core.hooksPath` points at it, which is per clone, and
  `prepare` ended in `|| true` while the hook itself printed "skipped" for a missing `bun` or `gitleaks`: a
  fresh clone, `bun install --ignore-scripts` or a failed install had no scan and said nothing. `prepare` and
  `setup:hooks` now run the script with `--install` (fails when git is present and `git config` fails, skips
  quietly with no git so an image build still works), the check fails when the path or an execute bit is wrong,
  and the hook refuses the commit when a scanner is missing. Skipped on GitHub Actions only (a bare `CI` does not skip it: agent sessions set `CI`
  and are where commits are made) and where there is no `.git` (`.dockerignore` drops it); a `.git` git cannot read
  (dubious ownership, corruption) FAILS instead of reading as "not a work tree". `--install` writes only when the
  value differs, so a read-only config cannot fail a `bun install` that has nothing to change. The deliberate
  bypasses (`--no-verify`, `GITHUB_ACTIONS=true`) remain; only the required
  `Secret and PHI scan` check in `.github/workflows/pr-gate.yml`, once the ruleset is applied, covers those.
- `scripts/check-vendor-agreements.ts` — **vendor-agreement register gate** (CW-BA-01, `bun run arch:vendor-agreements`,
  in `arch:fitness`). BAA status lived only as prose (the §5 table of the integrations document, AI Governance §9, the
  Claim.MD transport contract), so nothing could say that an integration needing a BAA had a row, or that a row reading
  "signed" had a date. `compliance/vendor-agreements.yaml` is the register, METADATA ONLY: vendor, PHI exposure, scope,
  status, evidence files and, once signed, the date, an opaque document reference and the confirming role (the gate
  refuses contract text by length, any email, URL or phone number, and any key outside its closed schema). It
  cross-checks the §2 table of `docs/architecture/CHARTWARDEN_INTEGRATIONS_v0_1.md`, read by its header: every row
  whose `BAA req'd` cell is not "No", "N/A" or "via ..." (or also says "yes") must be claimed by a vendor row's
  `inventory:` list, and an unreadable or ambiguous table fails closed. A `tenant-held` row may name only the
  controls listed in `TENANT_HELD_CONTROLS` and claim only the rows they record. An agent never sets `signed` (a
  person confirms the executed agreement): `pending` is the honest first state of every row. What it cannot prove stays
  in the CW-BA-01 gap: that a document exists or says what the row claims, that a hosting or backup provider missing from
  §2 is listed (the `evidence:` files are the reviewer's trail, not a detector), and that PHI stops flowing to a vendor
  whose row is pending. **Validity and expiry (CW-AC-14, CW-AC-17, extended in this gate, not a second register):** a
  `signed` row is judged as valid, not only filed. `effectiveOn` is required and must not be in the future; `expiresOn`
  (optional: absent = open-ended, its review date is its only clock) fails the gate the day AFTER it (an ended
  agreement is not a signed one) and `vendorAgreementWarnings` prints a warning, still passing, from 90 days before it;
  `covers` (closed set: `phi`, `zero-data-retention`) must include `phi` for a vendor that receives PHI and everything
  the row's own `requires` names (Anthropic's BAA alone does not cover the use without its zero-data-retention
  addendum). A row that is not signed carries none of these. No row is signed, so the rules are proved on synthetic rows
  in the unit tests with an injected `today`; the gate raises no alert between runs (it has no schedule). The tenant-held
  clearinghouse BAA's end date is in the database (migration 1569, `m23` resolver / claims gate / inbox / alerts) and
  the M34 register's go-live guard judges the effective window (`baaTermCoversToday`).
