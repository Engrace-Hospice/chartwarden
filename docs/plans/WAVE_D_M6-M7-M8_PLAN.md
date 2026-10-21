# ChartWarden — Wave D: M6 Admission + M7 Care Plan + M8 Encounters (Archon task plan)

Wave D from `PHASE_1_PLAN.md` — the **admission + care-plan + documentation spine**: the first modules
that admit a real patient, build a CoP 418.56 plan of care, and chart on it. Strict build order
**M6 → M7 → M8** (M7 `dependsOn` M6; M8 `dependsOn` M6+M7). All prerequisites (Waves A–C) are `done`.
**Conventions, determinism rules, the validate gate, and the legend are inherited from
`M01-M02_VERTICAL_SLICE_PLAN.md`** — read its header first.

Specs: `docs/modules/CHARTWARDEN_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md`,
`CHARTWARDEN_MODULE_07_CARE_PLAN_SPEC_v0_3.md`, `CHARTWARDEN_MODULE_08_ENCOUNTERS_SPEC_v0_2.md`.

> **Wave-D interplay (read first).**
> 1. **Strict chain.** M6 publishes the reader seams + outbox the rest of the system keys off
>    (`ElectionPeriodReader`, `CertificationReader`, `FaceToFaceReader`, `LevelOfCareReader`,
>    `AdmissionStatusReader`, `AdmissionCensusReader`; `m6.election.signed`, `m6.cti.signed`,
>    `m6.f2f.attested`, `m6.loc.changed`, `m6.revocation.created`, `m6.transfer.created`,
>    `m6.discharge.created`, `m6.discharge.death`, `m6.bereavement.eligible`). M7 publishes
>    `CarePlanReader`; M8 publishes `SignedEncountersReader`/`BillableEncounterReader`/
>    `MileagePayrollReader`/`EncounterCreator`.
> 2. **Forward-seam / outbox deny-stubs (later waves):**
>    - M6 — the **M29 inbound HL7 ADT** proposal path (`AdmissionEventApplier`, §4.8) is **deny-stub**
>      (M29 is Wave H; §7.7 wires live then). Phase-1 admissions are UI-driven.
>    - M7 — `idg.decision_recorded` from **M14** (§7.9) is consumed **via outbox, inert** (M14 is Wave
>      F). M7 D4: M14 produces, M7 consumes — no edge.
>    - M8 — visit seeding from **M17** (`m17.visit.published`) and the **M18 EVV bracket** for
>      `encounter.period` (§4.7, M8 D9) are **deny-stub forward seams / inert consumers** (M17/M18 are
>      Wave F); the **M32 Layer-2 AI** `narrativeEnhancement` is a deny-stub behind a flag (see #3).
> 3. **Phase-1 flag: `hearthnote.layer2` is OFF.** M8 ships **HearthNote Layer 1 only** (deterministic
>    templating from `packages/narrative-vocab`); Layer 2 (LLM polish via M32) is built behind the flag
>    as a deny-stub. No Phase-1 route depends on the flag being on.
> 4. **First multi-module clinical scenario:** an integration test should stitch **M5 admit → M6 elect
>    Medicare + CTI + F2F → M7 care plan → M8 signed encounter** on one patient.
> 5. **Track B screens (ADR-0030) — built in-task, not deferred.** Each module owns
>    `apps/web/src/modules/NN-*`: its **T01** adds that web codePath to the manifest and runs
>    `bun run scaffold` (empty placeholder slice, keeping `arch:parity` 1:1); its **terminal screen
>    task** (M6-T12 / M7-T09 / M8-T12) builds the §5 screens against the module's generated client
>    (`packages/ui/src/api`) and registers them into the M1 shell screen registry, flipping the
>    matching `docs/design/DEFERRED_SCREENS.md` row → `done`. Backend-first is preserved — the screen task
>    still `deps: all MN`, so routes/seams land before UI. No new authz on the frontend; the server
>    stays the only enforcement point.

---

## Module 6 — Admission, Election & Certification (deps: 5,38,40,39 · codePaths: apps/backend/src/modules/06-admission, apps/web/src/modules/06-admission)

ownedTables (12): admission, election_period, election_statement, certification_of_terminal_illness,
face_to_face_encounter, level_of_care_period, revocation_event, discharge_event, transfer_event,
referral, notice_of_rights_acknowledgment, compliance_window.

### M6-T01 — Enums, layout, per-entity fields/constraints
- deps: Wave C done · files: `apps/backend/src/modules/06-admission`, `apps/web/src/modules/06-admission`, `packages/types`, `architecture/module-manifest.ts` · spec §3.1, §3.2, §2.2
- do: enums; per-entity fields/constraints/indexes (§2.2); seam/outbox types in `packages/types`.
  **Track B (ADR-0030):** add `apps/web/src/modules/06-admission` to M6's manifest `codePaths` and run
  `bun run scaffold` so the empty web slice dir exists (screens land in M6-T12).
- accept: `tsc -b` + `arch:parity` green.

### M6-T02 — Tables (all 12)
- deps: M6-T01 · files: `packages/db/src/schema` · spec §3.3
- do: all 12 tables (§3.3); no new top-level entities for the M29 consumer path (§3.4).
- accept: `arch:tables` (M6 owns 12), `arch:ddl` green.

### M6-T03 — RLS, audit triggers, migration
- deps: M6-T02 · files: `packages/db/migrations` · spec §3.6, §3.7
- do: RLS & grants (§3.6, three-column on PHI); write-audit triggers via the M4 generator; migration.
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` green; RLS isolation test drafted.

### M6-T04 — State machines + validation
- deps: M6-T02 · files: module · spec §2.3, §2.4, §2.5
- do: admission / election / CTI / discharge state machines (§2.3); validation (§2.4); side-effect
  rules (§2.5).
- accept: state-machine unit tests; `tsc -b` green.

### M6-T05 — Reader seams
- deps: M6-T04, M1-T09 · files: module, `apps/backend/src/bootstrap` · spec §4.7
- do: register `ElectionPeriodReader`, `CertificationReader`, `FaceToFaceReader`, `LevelOfCareReader`,
  `AdmissionStatusReader`, `AdmissionCensusReader` into the M1 registry.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M6-T06 — Routes, permissions, ABAC
- deps: M6-T02, M6-T04 · files: module · spec §4.1–4.2, §4.5, §4.6
- do: route inventory + TypeBox (§4.2) behind `requirePermission`/`requireAbac` + `withOrgContext`;
  register permission keys (§4.5) + ABAC predicates (§4.6) into M3; bind M5 (Patient/Payer/PrivacyFlag),
  M38 (ICD-10 + hospice-dx value sets + LOC revenue/Q-code mapping), M40 (ExternalPhysician/Facility/
  ReferralSource), M39 (election authority + DPOA gating + Part 2).
- accept: `arch:boundaries` green; route smoke tests.

### M6-T07 — Referral & intake + admission wizard
- deps: M6-T06 · files: module · spec §6.1, §7.1, §7.2
- do: receive & triage referral (§7.1); admission wizard (§7.2).
- accept: §7.1/§7.2 integration tests.

### M6-T08 — Certification (CTI) + Face-to-Face
- deps: M6-T06 · files: module · spec §7.3, §7.4, §7.5
- do: recert CTI sign by medical director (§7.3); F2F attest by NP/physician (§7.4); compliance-officer
  F2F window override (§7.5).
- accept: §7.3/§7.4/§7.5 tests.

### M6-T09 — Discharge / revocation / transfer / LOC
- deps: M6-T06 · files: module · spec §6.3, §7.6
- do: discharge workflows with reason-specific permission mapping (§6.3); revocation + transfer; LOC
  change (drives `m6.loc.changed`).
- accept: §7.6 tests; reason-specific permission tests.

### M6-T10 — Outbox + jobs
- deps: M6-T04, M6-T07, M6-T08, M6-T09 · files: module, `packages/types` · spec §4.4, §4.3
- do: publish the full `m6.*` outbox contract (§4.4); jobs (§4.3, compliance-window scans).
- accept: `arch:gaps` event-catalog (m6. naming) green.

### M6-T11 — AdmissionEventApplier + M29 consumer (deny-stub)
- deps: M6-T05, M6-T10 · files: module · spec §4.8, §3.4, §7.7
- do: the `AdmissionEventApplier` service (§4.8); the **M29 inbound HL7 ADT consumer as a deny-stub**
  (M29 is Wave H — §7.7 external HL7 workflows wire live then).
- accept: applier unit tests; deny-stub present; gates green.

### M6-T12 — Screens, permissions, eraser, DR/INT, tests
- deps: all M6 · files: `apps/web/src/modules/06-admission`, module · spec §5, §6, §7
- do: **Track B screens (ADR-0030) — build, do not defer:** implement the §5 screens under
  `apps/web/src/modules/06-admission` against M6's generated client methods (`packages/ui/src/api`),
  registered into the M1 shell screen registry; flip the matching `docs/design/DEFERRED_SCREENS.md`
  row(s) → `done`. Permissions matrix (§6) incl. cross-tenant denial (§6.6); eraser; DR tier + INT
  inventory; full workflow tests (§7).
- accept: `docs:ui` + `arch:parity` + `arch:boundaries` green; `validateErasers()` passes; `bun run
  test` + full `arch:fitness` green.

---

## Module 7 — Care Plan (IPOC) (deps: 6,38,39 · codePaths: apps/backend/src/modules/07-care-plan, apps/web/src/modules/07-care-plan)

ownedTables (6): care_plan, care_plan_version, care_plan_signature, problem, goal, intervention.

### M7-T01 — Enums + package layout
- deps: M6 done · files: `apps/backend/src/modules/07-care-plan`, `apps/web/src/modules/07-care-plan`, `packages/types`, `architecture/module-manifest.ts` · spec §3.1, §3.2
- do: enums; layout; seam/outbox types in `packages/types`.
  **Track B (ADR-0030):** add `apps/web/src/modules/07-care-plan` to M7's manifest `codePaths` and run
  `bun run scaffold` so the empty web slice dir exists (screens land in M7-T09).
- accept: `tsc -b` + `arch:parity` green.

### M7-T02 — Schema, RLS, audit triggers, migration
- deps: M7-T01 · files: `packages/db/src/schema`, `packages/db/migrations` · spec §3.3–3.6
- do: 6 tables (§3.3); RLS (§3.4); write-audit triggers via M4 generator (§3.5); migration
  `0007_care_plan.sql` (§3.6).
- accept: `arch:tables` (M7 owns 6), `arch:tenancy`, `arch:ddl`, `arch:gaps` green.

### M7-T03 — Lifecycle + versioning + signature
- deps: M7-T02 · files: module · spec §2.2, §2.3
- do: care-plan lifecycle (§2.2), versioning + signature, validation (§2.3).
- accept: lifecycle unit tests.

### M7-T04 — CarePlanReader seam
- deps: M7-T03, M1-T09 · files: module, `apps/backend/src/bootstrap` · spec §2.1, §7.8
- do: publish `CarePlanReader` incl. `relevantElementsForEncounter()` and `isReviewOverdue()` (the
  surface M8/M15/M17 consume); register into the M1 registry.
- accept: `validateSeams()` passes; seam unit tests.

### M7-T05 — Routes + idempotency + concurrency
- deps: M7-T02, M7-T03 · files: module · spec §4.1–4.3, §4.5, §7.7
- do: route inventory + TypeBox (§4.3) behind guards; **Idempotency-Key on PATCH** (§4.1.1); register
  permission keys (§4.5); optimistic concurrency (§7.7).
- accept: §7.7 concurrency test; `arch:boundaries` green.

### M7-T06 — Problems / goals / interventions authoring
- deps: M7-T05 · files: module · spec §7.3–7.6
- do: authoring of problems/goals/interventions (M38 ICD-10/SNOMED bindings); patient-stated goal
  preservation (§7.3); discipline contribution + cross-discipline view (§7.4); DPOA-attributed
  decisions (§7.5); SUD problem confidentiality via M39/M5 snapshot (§7.6).
- accept: §7.3–7.6 tests.

### M7-T07 — 5-day clock + 15-day review + outbox/jobs
- deps: M7-T03 · files: module · spec §7.1, §7.2, §2.4, §4.6
- do: initial-care-plan-within-5-days clock (§7.1); 15-day IDG review (§7.2); outbox events (§2.4);
  BullMQ jobs (§4.6).
- accept: §7.1/§7.2 tests; `arch:gaps` event-catalog green.

### M7-T08 — IDG-decision consumer (inert) + encounter-relevance surface
- deps: M7-T04, M7-T07 · files: module · spec §7.9, §7.8
- do: wire the `idg.decision_recorded` (M14) outbox consumer **inert** (M14 is Wave F, no edge);
  finalize the encounter-relevance lookup surface M8 will consume (§7.8).
- accept: consumer wired-but-inert; gates green.

### M7-T09 — Screens, STRIDE, DR, eraser, tests
- deps: all M7 · files: `apps/web/src/modules/07-care-plan`, module · spec §5, §4.7, §4.8, §8
- do: **Track B screens (ADR-0030) — build, do not defer:** implement the §5 screens under
  `apps/web/src/modules/07-care-plan` against M7's generated client methods (`packages/ui/src/api`),
  registered into the M1 shell screen registry; flip the matching `docs/design/DEFERRED_SCREENS.md`
  row(s) → `done`. STRIDE (§4.7); DR tier + degraded mode (§4.8); eraser; audit events (§8.1);
  tests (§7).
- accept: `docs:ui` + `arch:parity` + `arch:boundaries` green; `validateErasers()` passes; `bun run
  test` + full `arch:fitness` green.

---

## Module 8 — Encounters & Visit Notes (deps: 6,7,36,38 · codePaths: apps/backend/src/modules/08-encounters, packages/hearthnote, packages/narrative-vocab, apps/web/src/modules/08-encounters)

ownedTables (10): encounter, encounter_signature, encounter_addendum, encounter_care_plan_link,
cosignature_request, vitals, mileage, hearthnote_selection, hearthnote_assembled_output,
hearthnote_llm_modification.

### M8-T01 — Enums, owned-tables overview, encounter types/disciplines
- deps: M7 done · files: `packages/hearthnote`, `packages/narrative-vocab`, `apps/web/src/modules/08-encounters`, module, `packages/types`, `architecture/module-manifest.ts` · spec §3.1, §3.2, §2.2
- do: enums; the 10 owned tables overview (§3.1); encounter types + disciplines (§2.2).
  **Track B (ADR-0030):** add `apps/web/src/modules/08-encounters` to M8's manifest `codePaths` and run
  `bun run scaffold` so the empty web slice dir exists (screens land in M8-T12).
- accept: `tsc -b` + `arch:parity` green.

### M8-T02 — Schema, migration, indexes, eraseFn
- deps: M8-T01 · files: `packages/db/src/schema`, `packages/db/migrations` · spec §3.3–3.6
- do: 10 tables (§3.3); migration `0008_encounters` (§3.4); index summary (§3.5); destruction
  `eraseFn` (§3.6, M4 D9).
- accept: `arch:tables` (M8 owns 10), `arch:ddl` green.

### M8-T03 — RLS + audit triggers (PHI)
- deps: M8-T02 · files: `packages/db/migrations` · spec §3.3/§3.4
- do: RLS + three-column rule on PHI tables; write-audit triggers via M4 generator (note free-text
  PHI denylist on narrative columns).
- accept: `arch:tenancy` + `arch:gaps` (phi-guards) green; RLS isolation test drafted.

### M8-T04 — Encounter lifecycle + validation
- deps: M8-T02 · files: module · spec §2.3, §2.7, §2.8
- do: the encounter lifecycle state machine (§2.3); sync + async validation (§2.7); side-effects (§2.8).
- accept: state-machine unit tests.

### M8-T05 — HearthNote Layer 1 (Layer 2 flag-gated deny-stub)
- deps: M8-T01 · files: `packages/narrative-vocab`, `packages/hearthnote` · spec §2.6
- do: `packages/narrative-vocab` + **HearthNote Layer 1 deterministic assembly** (§2.6); Layer 2 (M32
  `narrativeEnhancement`) built **behind `hearthnote.layer2` (OFF)** as a deny-stub.
- accept: Layer-1 assembly tests; Layer-2 route returns flag-disabled in Phase 1.

### M8-T06 — Cosignature workflow
- deps: M8-T04 · files: module · spec §2.4, §7.2, §7.3
- do: cosignature_request lifecycle (§2.4, D3); LPN 24-hour cosignature (§7.2); 48-hour hard cap +
  supervisor release (§7.3).
- accept: §7.2/§7.3 tests.

### M8-T07 — Late-entry tiers
- deps: M8-T04 · files: module · spec §2.5, §7.5, §7.6
- do: late-entry tiers (§2.5, D4); significant late entry 3–14 days (§7.5); administrative override
  >14 days (§7.6).
- accept: §7.5/§7.6 tests.

### M8-T08 — Seams owned + consumed
- deps: M8-T04, M1-T09 · files: module, `apps/backend/src/bootstrap` · spec §4.7
- do: publish `SignedEncountersReader`, `BillableEncounterReader`, `MileagePayrollReader`,
  `EncounterCreator` into the M1 registry; consume M7 `CarePlanReader`.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M8-T09 — Routes, permissions, ABAC
- deps: M8-T02, M8-T04 · files: module · spec §4.1–4.2, §4.5, §4.6
- do: route inventory + TypeBox (§4.2) behind guards + `withOrgContext`; register permission keys
  (§4.5) + the `cosigner_role_match` ABAC predicate (§4.6) into M3.
- accept: `arch:boundaries` green; route smoke tests.

### M8-T10 — Vitals, mileage, F2F dual-write, happy path
- deps: M8-T09 · files: module · spec §7.1, §7.4
- do: vitals + mileage authoring; RN routine visit happy path (§7.1); MD/NP F2F dual-write with M6
  (§7.4, D1).
- accept: §7.1/§7.4 tests.

### M8-T11 — Outbox + EVV/visit forward seams (inert)
- deps: M8-T04, M8-T08 · files: module, `packages/types` · spec §4.4, §4.7
- do: publish `m8.encounter.signed`/`m8.encounter.cosigned` (§4.4); wire the **M17 visit-seeding
  consumer (inert)** and the **M18 EVV-bracket forward seam (deny-stub)** for `encounter.period`
  (§4.7, M8 D9) — both wire live in Wave F.
- accept: `arch:gaps` event-catalog (m8. naming) green; deny-stubs present.

### M8-T12 — Screens, realtime, eraser, DR/INT, tests
- deps: all M8 · files: `apps/web/src/modules/08-encounters`, module · spec §5, §4.3, §7
- do: **Track B screens (ADR-0030) — build, do not defer:** implement the §5 screens (authoring,
  finalize/Layer-2 review, sign, cosign queue) under `apps/web/src/modules/08-encounters` against M8's
  generated client methods (`packages/ui/src/api`), registered into the M1 shell screen registry; flip
  the matching `docs/design/DEFERRED_SCREENS.md` row(s) → `done`. Socket.IO surface via M36 (§4.3); eraser
  (§3.6); DR tier + INT inventory; tests (§7).
- accept: `docs:ui` + `arch:parity` + `arch:boundaries` green; `validateErasers()` passes; `bun run
  test` + full `arch:fitness` green.

---

## Wave D acceptance (the workflow's final gate)
1. M6 (12) + M7 (6) + M8 (10) ownedTables exist with RLS + migrations; the **only** manifest change is
   the Track B `apps/web/src/modules/{06-admission,07-care-plan,08-encounters}` codePath additions
   (ADR-0030), each scaffolded so `arch:parity` stays 1:1.
2. `validateSeams()` passes with M6's reader seams, M7's `CarePlanReader`, and M8's
   `SignedEncountersReader`/`BillableEncounterReader`/`MileagePayrollReader`/`EncounterCreator`.
3. The first **multi-module clinical scenario** passes in integration: M5 admit → M6 elect Medicare +
   CTI + F2F → M7 care plan (5-day + 15-day clocks) → M8 signed encounter (cosignature where required).
4. **Phase-1 discipline holds:** `hearthnote.layer2` OFF (Layer 1 only); M6 M29 consumer, M7 M14
   consumer, and M8 M17/M18 seams are deny-stubbed/inert (Wave F/H).
5. **Track B screens shipped (ADR-0030):** each module's §5 screens are built under
   `apps/web/src/modules/NN-*`, registered into the M1 shell, and the matching
   `docs/design/DEFERRED_SCREENS.md` rows are `done` — not deferred.
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
7. **Wave D complete → Wave E (M9 Assessments, M10 HOPE, M11 Orders, M12 DoseSpot, M13 eMAR)
   unblocked** — clinical depth from assessments through medication administration.

> Run per module via Archon, e.g.:
> `archon workflow run chartwarden-piv --branch feat/m6-admission "Use the plan at docs/plans/WAVE_D_M6-M7-M8_PLAN.md (Module 6 only)"`
