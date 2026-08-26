# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit + staged implementation monorepo**: Phase 0 gates/scaffold are in place, and **all 40 modules
now have real implementation on `main`** — the clinical core (M1–M14, M17, M18, M22), the field/ops
tier (M15 Discipline Plans · M16 Bereavement · M19 On-Call Triage · M20 Field Safety · M21 Supplies/DME),
the **complete revenue cycle (M23 Billing-Medicare · M24 Billing-Medicaid · M25 Remittance & Denials ·
M26 Cap Management · M27 Cost Report)**, **M28 FHIR Gateway**, **M29 External Interfaces**,
**M30 HQRP & Quality**, **M31 Patient/Family Portal & Telehealth**, **M32 AI Platform**, M33 Reporting,
M34 SaaS Platform, **M35 Subscription Billing**, **M37 Inpatient Unit (IPU) Management**, plus the
platform services M36/M38/M39/M40. The generated **implementation-status matrix**
(`bun run status:matrix` → `audit/implementation-status/IMPLEMENTATION_STATUS.md`) is the per-module
truth — currently **🟢 40 · 🟡 0 · ⚪ 0** (the module set is complete; the last three placeholders —
M29, M35, and M37 — are now merged). Every module is enrichment-complete (matrix `Enriched`
full-ratio ✅, corpus 1219/1226 routes carry request/response contracts —
`audit/openapi-coverage/OPENAPI_COVERAGE.md` is the generated, authoritative count; re-check there
before citing a number here, since this line is hand-maintained prose and the generated report is
not). The `Live` column (cross-tenant RLS proof) is also full-ratio ✅ across all 40 modules,
including the three newest — **M29 (11/11), M35 (21/21), M37 (26/26)** — whose live-RLS suites
completed in the Phase 0-2 remediation pass. **M30 is merged (PR #106)**: 18 frozen
`quality/` tables + migrations 0062–0068; the `@wardenx/quality` domain core + `@wardenx/cahps-vendors`;
60 routes in `apps/backend/src/modules/30-quality`; the `MEASURE_CATALOG`/measure registry (HCI 10
indicators + composite, HVLDL, HOPE-derived TFP, operational); and CAHPS/QAPI/SRA/incident/mortality/
infection surveillance — status matrix 🟢. A follow-up wiring batch (**issue #107, PRs #108–#118**) then
made M30's cross-module seams real: the M1-T10 transactional outbox-row emit (M30+M33 events emit), the
M40-free provider-entity resolver, the M33 `MetricsProvider` registration, the HOPE-rollup + HVLDL measure
inputs (computing end-to-end, incl. a new M6 `DeathDischargeReader` + a Drizzle-backed M8
`SignedEncountersReader`), per-job `withOrgContext` RLS on the recompute/outbreak workers, and the cron
allowlist + active-org enumerator. M23 and M27 are now **merged** (no longer placeholders); the M23/M26→M27
forward-seam binds for the CMS-1984-14 cap calc (`CapAccrualReader` et al.) and M27's own forward seam into
M30 (`CostReportFilingStatusReader`) are **live and tested**, not deny-stubs (`m30-forward-seam-binds.test.ts`,
`m26-cost-report-cap-seam.live.test.ts`, `m27-validation-context.live.test.ts`) — this un-suppresses the CoP
418.310 failure-to-file indicator and half of HCI 5/6/7's inputs. **`hci_composite`'s real remaining blocker
is DATA, not wiring**: 9 of its 10 indicators need M6/M8 aggregate seams
(per-election-period LOC-days, discharge timing, cross-setting transition sequences, per-day
skilled-nursing minutes) that were never built — only `hci_indicator_10` computes. All 10 of the
remaining operational measures are now bound, including `bereavement_coverage_rate` (M16) and the two
that needed an M15 producer-side fix first — `volunteer_compliance_gate_rate` /
`supervisory_visit_on_time` used to return a pre-divided rate (no denominator, so CMS small-N suppression
couldn't apply); M15's `DisciplineComplianceProvider` now exposes the count pair beside each rate method
(`supervisoryOnTimeCounts`/`volunteerGateComplianceCounts`), the same store round-trip, no new query.
`opioid_on_admission_rate` remains genuinely blocked — it needs an M38 RxCUI→therapeutic-class capability
that doesn't exist yet.

The **2026-06-27 security/compliance audit remediation is merged** (PRs #103/#104, see
[`audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`](./audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md)):
production ABAC-evaluator + `step_up_recent` boot wiring; PHI-safe Fastify logging + no PHI in
browser storage; chromed-route auth guard with fail-closed nav; a fail-closed **PHI read-audit
coverage gate** (`apps/backend/src/bootstrap/plugins/read-audit.ts`) + request-time emission;
fail-closed **production env validation** (`apps/backend/src/bootstrap/env.ts`); the real M34
`platform.bypass_invoked` auditor; **durable break-glass persistence** (Drizzle store + live §2.2
branch); and dependency-vuln bumps (`bun audit` 7→1, drizzle-orm SQL-injection fix).
Use this guide to locate authoritative documents.

> **Building/extending the code?** Start at [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
> (runbook + "how to add a module") and [`docs/PHASE_0_SCAFFOLD_PLAN.md`](./docs/PHASE_0_SCAFFOLD_PLAN.md).
> One-time: `bun install && bun run build && bun run arch:fitness && bun run test` (all green).
> The `apps/`+`packages/` tree is **generated from the manifest** via `bun run scaffold`; the
> `arch:parity` gate keeps tree↔manifest 1:1. See [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Document map

> **Single entry point:** [`docs/README.md`](./docs/README.md) is the master index of every
> document under `docs/` — architecture, module specs, design/UI corpus, ADRs, the AI capability
> catalog, roadmap, wave plans, and reference sources — each linked to its canonical location.
> The sections below call out the load-bearing directories.

### Module specifications → `docs/modules/`

**All 40 module specs live in [`docs/modules/`](./docs/modules/).** Start at the index:
[`docs/modules/README.md`](./docs/modules/README.md) — every module, its version, and a link.
The Module 29 forward-engineering sub-tasks are in
[`docs/modules/module-29-tasks/`](./docs/modules/module-29-tasks/) — 12 files spanning
T-29.01–T-29.13 (tasks 12 and 13 share one file, `WARDENX_T-29.12_13_FRONTEND.md`).

> When you need a module spec, **resolve it under `docs/modules/`**, not the repo root.

### UI screen specifications → `docs/design/`

The UI screen specs (core/app-shell, clinical, revenue, admin, portal, platform/ops) live under
[`docs/design/screens/`](./docs/design/screens/), indexed by
[`docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md).
Every spec declares a named layout pattern (`Use <name>.`) defined in
[`docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`](./docs/design/WARDENX_UI_LAYOUT_PATTERNS.md) — the
authoritative glossary of layout patterns, shared regions, and composition rules. Like module
specs, **UI screen specs are implementation proposals** (architecture wins on conflict).
Run `bun run docs:ui` (`scripts/check-ui-screens.ts`) to verify corpus consistency —
index parity, layout-heading hygiene, pattern resolution against the glossary, and (2026-08-14)
corpus-wide ADR-citation + relative-link integrity including the root docs.

### Authoritative architecture documents → `docs/architecture/`

These **win over module specs** in any conflict (module specs are implementation proposals).
All live in [`docs/architecture/`](./docs/architecture/):

- `WARDENX_ARCHITECTURE_v0_11.md` — system architecture (authoritative)
- `WARDENX_SYSTEM_DESIGN_v0.3.md`
- `WARDENX_SECURITY_HARDENING_v0_2.md`
- `WARDENX_AI_GOVERNANCE_v0.2.md`
- `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`
- `ARCHITECTURE_25_15_FITNESS.md` — architecture-fitness rules

> When you need an architecture document, **resolve it under `docs/architecture/`**, not the repo
> root. (Older docs reference these by bare filename or version — same files, new location.)

### Architecture-fitness kit (enforcement code under the repo-root `architecture/`)

Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.

- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (460 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/check-tenancy.ts` — **tenancy & RLS invariants** (`bun run arch:tenancy`, in
  `arch:fitness`): the three-column rule, the canonical `app.org_id` session variable, and the
  dangerous policy shapes ADR-0010 D3 bans. Its Rule 2 exemptions — M4 audit attribution, the M34
  key-ring SECURITY DEFINER GUCs — are scoped to the **statement** they were written for and never
  reach a policy predicate. They used to be tested against the whole FILE, and the repo's own
  convention puts a module's RLS policies in the same migration as its audit triggers
  (`*_rls_audit_triggers.sql`), so one `INSERT INTO audit_event` exempted every `app.user_id` in the
  file — policy bodies included. That is how `user_notif_pref_self` (#21: an org-unscoped `FOR ALL`
  policy on an org-scoped table, a confirmed cross-tenant read AND write) sat green in `0017` while
  the gate reported only the two migrations that happened not to contain a trigger. Policy
  predicates are now judged on the migrations' **net effect** — the files replayed in apply order,
  so a violation a later migration drops and replaces stops counting, which is what lets a
  remediated policy go green without the offending text ever leaving its original file. Deliberately
  a static replay and not a `pg_policies` read: `arch:fitness` runs where there is no database (the
  same reason the live suites are `skipIf`-guarded), so a catalog-reading gate would skip in CI —
  `m1-rls-isolation.live.test.ts` is the catalog-side complement and runs in `rls-live`. A policy
  created through dynamic SQL inside a `DO` block is the known limit, and the plain text scan still
  sees the session variables inside it.
- `scripts/check-migration-numbering.ts` — **migration ordinal uniqueness** (F-026,
  `bun run arch:migration-numbering`, in `arch:fitness`). The four-digit prefix in
  `packages/db/migrations/NNNN_name.sql` IS the migration's position in the apply order, and
  `scripts/db/migrate.ts` applies files in plain lexicographic `.sort()` order — yet nothing
  enforced that two files do not claim the same number. With a duplicate, which one runs first is
  decided by the rest of the filename (`0216_admission_…` before `0216_m36_…` because "a" < "m"),
  a coin flip nobody chose; two independent migrations survive it, a backfill and the migration
  adding the column it backfills do not. It is a WHEN on a branch-per-change workflow: every branch
  picks "the next number" against `main`, so two opened the same afternoon pick the same one — four
  audit branches had already collided in pairs on 0215 and 0216 with every gate green on all four.
  Duplicates are a hard error naming **every** claimant (the fix is a rename, and which file to
  rename is the reader's judgement); **gaps are reported, never fatal**, because a branch that
  leaves 0215 for a sibling PR and takes 0216 is doing the right thing.
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
- `scripts/check-abac-predicates.ts` — **ABAC named-predicate resolution** (`bun run arch:abac-predicates`). Every `requireAbac(_, "<name>")` — including through each module's
  local `guards.ts` factory — must name a predicate some module declares. M3's registry fails
  closed on an unknown name, so a typo'd or never-registered name is a permanently dead endpoint
  (403 for every caller) with the whole build green; that is exactly how M30's 15 `inOrg` guards
  sat unreachable across 7 route files. There is **no deferral allowlist**: a predicate whose
  inputs do not exist yet is expressed as a *registered* predicate that denies and says why
  (`deviceAttestationValid` in `packages/auth/src/abac/registry.ts`), never as an unregistered
  name — both refuse identically, only the first is distinguishable from a mistake.
- `scripts/check-request-header-auth.ts` — **request-header authorization gate** (F-028,
  `bun run arch:request-header-auth`, in `arch:fitness`). A request header is whatever the caller
  typed; deciding an AUTHORIZATION question from one, unverified, hands the decision to the party
  being gated. Four commit-point routes did exactly that — M14's IDG adjourn (the D13 commit point),
  M17's self-attested visit start, and M18's retroactive correction-of-record + D6 supervisor
  override each gated their fresh-step-up requirement on `request.headers["x-step-up"] === "fresh"`,
  so anyone who could reach the route could satisfy the re-authentication ceremony by typing the
  header. Eight other modules gated the same requirement correctly the whole time, through
  `requireStepUp(opKey)` → M3's `step_up_recent` predicate → M2's `SessionContextResolver` seam.
  Nothing caught it because every gate was self-consistent about it: the routes carried
  request/response contracts, so `arch:openapi-coverage` counted them enriched; `openapi:check`
  proves the contract was *regenerated*, not that it is *true*; and `client:gen` was clean because a
  header nothing declares is simply one the client cannot send — the published API and the code
  agreed with each other and both were wrong about what the route required. It surfaced only when
  F-012 type-checked `scripts/` and broke a seed that had been passing the header as a typed
  parameter. The gate requires every `request.headers[...]` read in `apps/backend/src` to name a
  header REGISTERED as either `verified` (the server checks the value against state it holds — a
  signature, a constant-time secret compare, a server-minted single-use token, a double-submit
  cookie) or `not-authorization` (concurrency control, telemetry; a forged value earns a 412 or a bad
  log line, never access). There is deliberately **no third classification** for "trusted because the
  caller is nice" — a header that would need one is the bug. Response headers and comments are not
  inputs and are skipped; test files are excluded (a harness legitimately drives its own fake
  authenticate hook off headers); a name reached through a module constant is resolved to the real
  header, and the one generic accessor whose name arrives as a parameter is declared in
  `DYNAMIC_READERS` with the constants its callers pass, each of which must itself be registered.
  The resolution the four routes now use is `stepUpFreshFor` /`requestStepUpFresh`
  (`apps/backend/src/bootstrap/step-up.ts`), shared with M3's predicate so the guard form and the
  boolean form cannot drift.
- `scripts/check-context-attributes.ts` — **request-context attribute producer gate** (F-030,
  `bun run arch:context-attributes`, in `arch:fitness`). `request.context.attributes` is the untyped
  bag the authenticate hook fills with server-assembled facts about the caller and that ABAC
  predicates and route actors read back out. It is `Record<string, unknown>`, so a read of a key
  nothing writes compiles, evaluates, and yields `undefined` — and every reader treats that as deny,
  which makes the failure silent, permanent, and indistinguishable from working code. Four instances
  had already been found and fixed one at a time before anyone looked for the pattern:
  `membershipId` (7 modules' §4.x ownership predicates saw null and denied), `providerEntityIds` /
  `locationIds` (every PE/location predicate denied unconditionally, ARCH-008/009), `stepUpRecent`
  (15 modules — M23/M27/M37 mount `requireStepUp`, which PASSES, then refuse in the DOMAIN on the
  always-false flag, so the guard allowed and the machine refused, F-029), and `systemPrincipal`
  (one fact under two names: `actorKind` was stamped and checked by M15/M23's
  `requireSystemPrincipal()`, while M23's seam predicate and M25's `/internal` guard checked a name
  nothing wrote — those service-to-service endpoints refused every caller, a diagnosis
  `seed-scenario-billing.ts`'s header had already written down and worked around by skipping M25).
  `arch:abac-predicates` cannot see any of this: it proves a predicate NAME resolves, not that the
  FACTS the predicate reads are ever produced. The gate requires every key read off the bag to be
  declared as either `{ producer }` — and it verifies a write actually EXISTS, since a declared
  producer that stops writing is the exact regression — or `{ blocked }`, carrying the reason and
  what it needs (the `deviceAttestationValid` rule again: a fact whose source does not exist yet is
  a *declared* absence, never an undeclared one). A blocked key that gains a writer fails, so an
  entry cannot outlive its reason; a declared key nothing reads fails, so the registry cannot go
  stale. Tests are excluded from the scan on purpose — every historical instance was invisible
  precisely BECAUSE each suite wrote the attribute in its own fake authenticate hook, so counting
  those as producers would make the gate agree with the bug. The scanner resolves string constants
  **across** files (`attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]` is read in M14's routes and
  declared in its predicate file), the SCREAMING_CASE identifier-index write form (how both
  in-request producers actually write), and whole-bag aliases (`const attrs = ctx.attributes ?? {}`,
  which is the only way two of the unproduced keys are read at all). **4 keys are currently
  declared blocked** and the gate prints them on every run — they are the standing finding, not a
  passing state. The largest is `sessionClass`: M16/M31/M39 read it and default to `"staff"`, and
  M31's portal predicates gate on it being one of `patient_portal`/`caregiver_portal`/
  `bereaved_portal`, none of which the M1 `session_class` enum contains — so the whole portal ABAC
  surface denies. **Resolved (2026-08-26):** migration 0219 extends `session_class` with the three
  portal classes + M19's two vendor classes, 0220 teaches `session_scope_chk` what scope each
  requires, and M2 publishes a `PortalSessionBinder` seam so M31 can hand it the account/patient
  binding its `select-patient` route always claimed to. Blocked keys: **13 → 10**. Writing 0220
  against a real database also surfaced a **pre-existing** hole in the same constraint: `scope ?
  'patientId'` on a NULL `scope` is NULL, `NULL OR false` is NULL, and a CHECK **passes** on NULL —
  so the collaborator/funeral branch never bound on a row with no scope, and a one-time magic-link
  session whose whole purpose is to be pinned to ONE patient could be written unpinned. The
  app-layer mirror (`isSessionScopeValid`) never had the hole, so the defense-in-depth layer was the
  strict one and the DB floor was the loose one — which is why nothing going through the auth layer
  ever hit it. Both are proven by `session_scope_chk (F-030) — live` in `auth.live.test.ts`, which
  is that constraint's only executable coverage. **Resolved next (2026-08-26):** the session's
  pinned patient, which was read under THREE names and written under none — M31/M19 as
  `portalPatientId`, M19's portal-triage guard as `portalPatientId ?? patientId` (a `??` chain of
  two undefineds, shaped like a safety net), and M7's `caseload_or_scope` as a `scopePatientIds`
  ARRAY, so a collaborator session's scope grant never fired and every collaborator fell through to
  a caseload they are not in. One key now, `sessionPatientId`, named for the fact rather than for
  one of its three readers — M7's readers are `external_collaborator` sessions, so a `portal…` name
  would have become the fourth rather than the last. It resolves through `sessionPinnedPatientId`,
  so the CLASS decides and a staff session carrying a stray `scope.patientId` pins nothing (reading
  the jsonb key directly, as the store did, would have widened the one predicate whose job is to
  narrow). Blocked keys: **10 → 8**. Then `organizationName`, the one entry that was never an
  authorization control: M2's invitation routes read it and fell back to the literal `Organization`,
  so with nothing writing it the fallback was not a fallback but the only branch — every invitation
  row stored that string, the pre-auth `GET /invitations/:token` preview served it back to the
  invitee's browser, and the email said "invited to join your organization". It now resolves from
  the INVITER's own active membership in the org they are inviting into (`findActive`, the same read
  `/auth/context` already projects the name through), which is org-scoped by construction and adds
  no dependency. Blocked keys: **8 → 7**. Then `permissions`, whose blocked entry had assumed a COST
  decision — whether to stamp the actor's whole grant set on every request — when there was none to
  make: `resolveActorPermissions` is the check-don't-gate seam, its doc comment names this exact case
  ("consumers that must *check* a permission rather than gate on it") and states an assembled
  `AbacContext` is a valid argument, and the resolver behind it is TTL-cached per (org, user) with
  the TTL capped by the soonest grant expiry — so by the time M27/M30's predicates ask, the route's
  own `requirePermission` preHandler has already resolved the same set and it is a cache hit. Nothing
  is stamped; the two `actorHoldsPermission` helpers resolve through the seam. Blocked keys:
  **7 → 6**. Then `phiFullRead`, where the entry was not merely mis-reasoned but wrong on the facts:
  it recorded the role-token arm as working, so the attribute was "the dead half". BOTH arms were
  dead. `context.roles.includes("phi.full_read")` asks a list of ROLE keys (`compliance_officer`,
  `medical_director`, …) for a `resource.action` PERMISSION key — a namespace error nothing can make
  true — and `phi.full_read` was in no permission catalog either, so it could not be granted to
  anyone. M32's §164.528 disclosure ledger (R16/R17) therefore masked the patient identity for every
  caller, always, including the compliance officer the ledger exists for. Masking fails SAFE, which
  is why nothing surfaced it: a permanently masked ledger and a correctly masked one are
  indistinguishable. The key is now registered in M5's `phi.*` family (`abac: "none"`, a
  check-don't-gate key like `cost_report.edit_any_provider`) and resolved through the same seam, and
  it is deliberately assigned to NO default role template — who reads unmasked PHI by default is a
  tenant policy decision, and choosing one here would have granted it silently on every existing org.
  Blocked keys: **6 → 5**. Then `licensure`, the third entry in a row whose stated blocker was wrong:
  it said no column or seam existed for the clinical licence M22's §4.7 high-risk-field review gate
  needs. M17's `membership_credential` + the `CredentialReader` seam are that fact under another
  name, already applying the status/effective/expiry logic and deliberately orthogonal to the RBAC
  role grant (a clinician can hold the `rn` ROLE while the LICENCE has lapsed). Only the vocabulary
  was short, and only by one value: **`md` already means PHYSICIAN — MD *or* DO**, which
  `VISIT_PURPOSE_DISCIPLINES` has documented as "MD/DO or NP" all along, so giving DO its own enum
  value would have stopped four CoP-relevant visit purposes (`f2f`/`recert`/`loc_change`/
  `pronouncement`) accepting osteopathic physicians — a regression bought with a distinction no
  consumer makes. `pa` was genuinely absent (a physician assistant could not be recorded as licensed
  at all) and migration 0221 adds it, in NO `VISIT_PURPOSE_DISCIPLINES` list: holding a licence is
  not visit authority, and the Medicare hospice face-to-face encounter is physician-or-NP only
  (42 CFR 418.22(a)(4)). Blocked keys: **5 → 4**. Then `isPlatformOperator`, the fourth entry running
whose recorded blocker had expired: it quoted M29's own read site ("Until a platform-operator caller is
provisioned this reads false and the predicate denies (W-XI-12)") and filed it as correct-by-design. A
platform-operator caller HAS been provisioned since ADMIN-T02 registered the six `platform_staff`
templates, and M35's `platform_billing_scope` has gated its whole cross-tenant `/api/admin` surface on
exactly that role set the entire time — so M29's `nppes_platform_job_caller` was asking the same question
under a second name, and refusing the platform operators it exists to admit. It now re-derives from
`PLATFORM_OPS_ROLE_KEYS`, the same single source M35 re-derives from, so the codebase's two platform-only
gates cannot drift on who counts as an operator. Both tests that covered it supplied the attribute
themselves — the unit test set `isPlatformOperator: true` on the context and the inject suite stamped it
off an `x-test-platform-operator` header — so each demonstrated the shim, not the gate; the allow arms are
now real catalog roles, and the inject suite's platform session differs from its tenant session by that
role alone, so the 403→202 flip can only be the predicate. Blocked keys: **4 → 3**. Then `disciplines`,
which needed a DECISION rather than a diagnosis: seven modules (M7–M13) each assembled the caller's
clinical discipline set by unioning `attributes.disciplines` with the session role keys, so the union was
with the empty set on every request the codebase has ever served and the role arm was the whole answer in
all seven. Unlike every other F-030 key, NO test ever supplied this one — it did not need faking, because
the derivation degraded instead of dying. The reads are gone rather than the fact produced, because the
platform already has one derivation and two modules had written down why: M19's
`TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states the rule ("M3's `RoleGrant.roleKey` is the platform's one
authority-derivation input") and **M17 — which owns both the discipline vocabulary and
`membership_credential` — resolves its own D8 pre-schedule gate exactly this way** (`resolveDisciplinesTx`:
active role grants ∩ the scheduling vocabulary), reading the credential only for the deliberately
orthogonal question of whether the licence is currently active. Producing an eighth answer to a question
three modules already answer identically would have been the drift, not the fix. `discipline-derivation.
test.ts` pins both halves — each module answers from role keys, and a stray `disciplines` attribute cannot
change the answer, so a future producer of that key cannot silently widen seven clinical floors
(controlled-substance prescribing, medication administration, order authoring, scale recording) without a
deliberate edit; 8 of its 21 cases fail against the pre-change code. Blocked keys: **3 → 2**, and both
survivors are genuine declared absences of the `deviceAttestationValid` kind: `deviceAttestation` (M2 owns
no attestation table per ADR-0023 D2 and the mobile client doing the §12.4 posture check is unbuilt per
ADR-0035 — widening it would disable a SecHardening control) and `externalActorId` (M19's binding Phase
boundary ships the Hybrid/Centralized models feature-flagged-OFF; producing it means building the §7.5
vendor SSO binding and the `packages/triage-vendors` adapter, i.e. M19 Phase 2). Then
`deviceAttestation` — the one entry the registry itself held up as its own model, and the only one that
needed a SURFACE built rather than a name rewired. **ADR-0023 D2 named exactly this and offered two exits:
add it to M2 with a real manifest `ownedTables` edit (the `tenant_step_up_policy_override` precedent) or
declare it vapor and delete the consuming specs.** It is added, because it had two consumers and one of
them already wrote to it — M18's `evv_device.m2_device_attestation_id`, documented in that table as "M2 row
(app-validated; no FK)", a logical foreign key to a table that did not exist and which M18's own
registration path satisfies with `randomUUID()`. Migration 0222 adds `device_attestation` (org-scoped RLS,
audit trigger, one LIVE row per device via a partial unique index, revoked/failed rows retained as the
trail) plus `session.device_attestation_id`; the authenticate hook stamps the fact from
`ResolvedActor.deviceAttestation`, which is RE-CHECKED off the row (`liveDeviceAttestation`: verdict,
revocation, expiry) rather than trusted from the pointer — so a revoked handset stops satisfying the gate
on its NEXT request. The write path is real, not a stub: M2's `managed_enrollment` verifier recomputes an
HMAC over a **server-minted, single-use** nonce keyed by a per-org derivation of the platform enrolment
secret, and the MAC covers the reported §12.2 posture, so the assertion is unforgeable, unreplayable and
unmalleable — the device reports its own posture (§12.4's detector runs on the handset, so it must) but
the server will not believe the report unless it arrives authenticated, and then applies the §12.2 policy
itself, where an UNREPORTED requirement counts as unmet. The two hardware providers (App Attest / Play
Integrity) report `unavailable` rather than denying, and an unconfigured deployment answers 501, so "this
deployment does not do device enrolment" never looks like "this fleet is compromised". This un-closes M33's
`report.drilldown.bulk_export`, which had been refused to every caller since it was written. Blocked keys:
**2 → 1**.
- `scripts/check-live-suite-coverage.ts` — **live-suite CI coverage** (`bun run arch:live-suites`).
  Every live-database / live-Redis / browser suite in `package.json` must be invoked by a job in
  `.github/workflows/ci.yml`. A live suite is `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`, so
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
  Chromium over a migrated, `db:seed:all`-seeded full stack (18 critical-workflow specs + the six
  axe-core WCAG 2A/AA scans that are the repo's only automated accessibility coverage). The gate
  now checks **both directions** (F-025/#59): script → CI, and **file → script**. The second was
  never asked, so 29 suite files (112 tests) were named by no script and therefore run by nothing —
  not CI, not a hook, not `bun run test`, which never sets the live env vars. Several were the only
  live proof of a seam this document cites by filename (`m26-cost-report-cap-seam`,
  `m27-validation-context`, `m25-835-ingestion`, `m31-portal-eraser`). Twenty-eight passed when run;
  the one that did not — `m6-abac-scope-resolver` (GAP-011), green on `main` and red on the F-017
  stack once that branch's fail-closed provider-entity check landed — is why this is a gate and not
  a note. All 29 now have `test:…:live` scripts and `lifecycle-live` runners, and that job gained a
  Valkey service because four of them gate on `WARDENX_TEST_REDIS_URL` too and would otherwise have
  reported SKIPPED. Exclusions on either side are **named** — `DEFERRED` and `NOT_A_SUITE_FILE` —
  never a file or script that quietly fails to be found.
- `scripts/check-outbox-bindings.ts` — **outbox binding ↔ event-catalog agreement**
  (`bun run arch:outbox-bindings`, in `arch:fitness`). Every live `OutboxConsumerBinding` must bind a
  catalogued event, must not bind one catalogued record-only (`declaredConsumers: []`), and its module
  must be named in that event's `declaredConsumers`. The dispatcher asserts exactly this already — by
  THROWING before `server.listen()` — but it is only constructed when `DATABASE_PLATFORM_URL` is set,
  so no test, local run or CI job ever reached the check. Two mismatches accumulated in two modules
  (`m23.claim.submission_failed` omitted M23's own retry consumer; `m25.edi.835_received` was
  catalogued record-only while M25 bound it live), and the only symptom was a backend that refused to
  start in the documented production configuration (F-020, issue #49). Unlike the other static gates
  this one EVALUATES rather than parses: it imports each consumer module and calls its
  `build…Consumer` factory with an absorbing stub, so the six different indirections the bindings use
  to express their event lists resolve to their real values. A binding file that yields no binding is
  an error, never a skip. The runtime half is the `outbox-boot` CI job
  (`bun run check:boot:platform`), which boots the backend with a real provisioned platform login and
  proves the relay starts.
- `scripts/check-architecture-docs.ts` — **architecture-corpus freshness gate**
  (`bun run arch:architecture-docs`, in `arch:fitness` since 2026-08-14). The authority rule makes
  `docs/architecture/` binding, yet it was the only ungated documentation body and drifted for two
  months (63 dead cited paths, stale companion citations — see
  `audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`). Enforces: cited repo paths exist
  (paths on a line that says they don't exist are exempt — documented absence is correct), version
  headers parse (filename-version drift needs the "FILENAME still reads" note), `Companion to:`
  citations match on-disk header versions, and four-digit `ADR-NNNN` citations resolve
  (ARCHITECTURE §21's short `ADR-00N` open-decision register is a separate, deliberately ungated
  namespace). Warn-only `<!-- verified-against: sha · date -->` staleness stamps. The six build
  divergences the 2026-08-13 audit surfaced are recorded as ADR-0036…0040 (+ ADR-0030/0032/0035
  for the frontend stack).
- `scripts/check-module-docs.ts` — **module-spec corpus gate** (`bun run arch:module-docs`, in
  `arch:fitness`). Different contract from the architecture gate because specs are PROPOSALS:
  no cited-path rule (planned paths are legal); enforces index parity (40 rows ↔ 40 files),
  the **re-lock-in-place versioning convention** (filename version is pinned; the HEADER is
  authoritative and the index "Spec ver" column must track it — it sat 1–2 re-locks stale for
  26 of 40 modules before this gate), four-digit ADR-citation resolution (audit-era
  "ADR-NNNN / ARCH-nnn" composite citations exempt as a historical namespace), relative-link
  integrity, and the "implementation proposal" authority marker every spec now carries.
- `scripts/check-adr-docs.ts` — **ADR corpus gate** (`bun run arch:adr-docs`, in `arch:fitness`).
  ADRs are immutable once Accepted, so this never checks prose freshness — it checks the corpus as
  a decision REGISTER: contiguous unique numbering 0001…max, index parity, a parseable Status line
  (Accepted/Proposed/Superseded/Rejected/Deprecated; Superseded must cite its successor), the
  index row's status cell AGREEING with the file (a decision must not sit formally Proposed while
  the register calls it Accepted), cross-citations and links resolving. Code-vs-Decision
  compliance is the audit layer (audit/ADR_COMPLIANCE_AUDIT_*.md), not this gate.
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
  The **`Enriched` column is a ratio** (`n/m`), joined route-by-route against the enrichment
  registry — it used to be a per-module boolean that flipped ✅ on a single entry anywhere in the
  module (M06 once sat at 6-of-46 showing ✅). As of the **2026-08-01 enrichment sweep every 🟢
  *feature* module reads a full-ratio ✅** (0 unenriched routes; M01 Foundation reads ❌ because it
  owns tables but no feature routes). The **`Live` column** (owned tables named in a
  `*.live.test.ts`) is likewise full-ratio ✅ for every 🟢 module now — **20 modules carry executed
  cross-tenant RLS suites** (M1–M14, M17, M18, M22, M27, M34, M36, M38, M39, M40, plus M4/M5/M7/
  M15/M16/M19–M21/M23–M26/M30/M32/M33). Both columns are advisory; `arch:openapi-coverage` is what
  fails the build.
- `scripts/report-openapi-coverage.ts` — **OpenAPI enrichment-coverage report + ratchet**
  (`bun run openapi:coverage`; `arch:openapi-coverage` runs `--check`). `openapi:check` proves
  openapi.json was *regenerated* and that no enrichment targets a dead route — it says nothing
  about the reverse, so an **unenriched route is legal** and a routes task can ship 30+ routes
  carrying zero request contracts with every gate green (this is what M20-T06 did). The emitted
  contract does not look absent, it looks *satisfied*: `emit.ts` still writes those routes with
  `parameters: []`, no `requestBody`, and a bare `200: OK`, and `client:gen` types their bodies
  as `never`. This gate ratchets, per module, the count of routes with **no** enrichment entry
  against `audit/openapi-coverage/baseline.json`: the deficit may never **rise** (new routes must
  ship their contracts), and when it **falls** the baseline must be re-tightened
  (`bun run openapi:coverage --update`) so progress is locked in. A module absent from the
  baseline has an implied floor of **0** — a brand-new module's first unenriched route fails.
  The 2026-08-01 sweep retro-enriched the corpus from **478 unenriched → 6** (currently **1219/1226
  enriched**; only bootstrap's health/infra routes remain unenriched) and re-tightened the baseline — the gate
  never *required* that backfill, but the progress is now locked in. Writes
  `audit/openapi-coverage/OPENAPI_COVERAGE.md` (+ `.json`).
  `client:check` (generated typed client ↔ openapi.json) is now in `arch:fitness` too.
- `scripts/report-ui-parity.ts` — **UI implementation-parity report**: bridges the documented
  screen-spec corpus (`docs/design`) and the implemented web surface (registered `screens.ts`), so a
  green `docs:ui` is not mistaken for "the UI is built". Regenerate with `bun run ui:parity`;
  `arch:fitness` runs it in `--check` mode (`arch:ui-parity`) to keep `audit/ui-parity/` fresh and
  to hard-fail on duplicate screen id/path, an unknown `requiredPermission`, or a `screens.ts` not
  wired into `main.tsx`. Writes `audit/ui-parity/UI_PARITY.md` (+ `.json`).
- `scripts/report-frame-fidelity.ts` — **frame-fidelity report**: tracks how far each *built* screen
  has been visually matched to its Pencil frame — the layout-fidelity gap the R0/R1 Lantern
  reconciliation left open (it matched the design *language*, not each screen's *composition*). The
  hand-maintained `scripts/frame-fidelity/registry.ts` maps a built screen → its `SCREENS.md` frame
  node → status (`pending`/`partial`/`matched`); the process is in
  `docs/design/FRAME_FIDELITY_PLAYBOOK.md`. Regenerate with `bun run frame:fidelity`; `arch:fitness`
  runs `--check` mode (`arch:frame-fidelity`) to keep `audit/frame-fidelity/` fresh and to hard-fail
  on an unknown frame node, a duplicate mapping, or a dangling screen id. Writes
  `audit/frame-fidelity/FRAME_FIDELITY.md` (+ `.json`).

### Governance & history

- `docs/adr/` — Architecture Decision Records (ADR-0001…).
- `docs/reviews/` — audit/review prompt templates.
- `docs/REMEDIATION_SUMMARY.md`, `audit/` — point-in-time audit reports. These reference module
  specs **by filename**; resolve those filenames under `docs/modules/`. The latest external review is
  `audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`; its findings are remediated and merged (PRs #103/#104).

## Authority rule

Architecture documents are authoritative. Module and UI screen specifications are
implementation proposals.
**If a module or screen spec conflicts with architecture, architecture wins.**
