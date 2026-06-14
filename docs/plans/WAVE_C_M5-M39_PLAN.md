# WardenX — Wave C: M5 Patient & Demographics + M39 Consent (Archon task plan)

Wave C from `PHASE_1_PLAN.md` — the **patient record + consent** layer; the first PHI clinical
modules and the first real SUD / 42 CFR Part 2 surface. Build order **M5 → M39** (M39 `dependsOn`
M5). M5 depends on Wave A (M2–M4) + Wave B (M36/M38/M40); M39 depends on M1–M5. **Conventions,
determinism rules, the validate gate, and the legend are inherited from
`M01-M02_VERTICAL_SLICE_PLAN.md`** — read its header first.

Specs: `docs/modules/WARDENX_MODULE_05_PATIENT_SPEC_v0_4.md` (has §10 Implementation Tasks + §12
Sign-Off), `WARDENX_MODULE_39_CONSENT_SPEC_v0_3.md`.

> **Wave-C interplay (read first).**
> 1. **M5 closes three boot-gate deny-stubs.** The Phase-0/Wave-A bootstrap deny-stubbed
>    `CaseloadProvider` (M3 declares it, M5 §4.1 **implements** it), `PatientReader` (§4.8), and
>    `PatientMutator` (§4.9) — all **required by `validateSeams()`**. M5 replaces them with real impls.
> 2. **M5 ↔ M39 is non-circular.** M39 `dependsOn` M5 (compile-imports `PatientReader`). M5 consumes
>    `m39.consent.signed` / `m39.consent.revoked` **via outbox (no edge)** to recompute
>    `patient_privacy_flag_snapshot` (M5 D10). That consumer is wired in M5 but **inert until M39
>    emits** — so build M5 first, M39 second; no cycle.
> 3. **First SUD / 42 CFR Part 2 chain end-to-end.** M5's `patient_privacy_flag_snapshot` + M39's
>    `ConsentEvaluator` + M4's `sud_value` denylist (Wave A) make SUD gating testable now. Full
>    DocLens-driven SUD *detection* (W-CON-04) needs M22 (Wave F) — M39 consumes M22's
>    `DocumentRenderer`/`DocumentStorageProvider` via a **deny-stub forward seam** (ADR-0006, the 22→39
>    edge was dropped).
> 4. **M5 has no package** — code lives only in `apps/backend/src/modules/05-patient`; its seam
>    interfaces + outbox types go in `packages/types` (leaf), consumed without importing the module.
> 5. **Phase-1 deny-stubs:** M5's **M29 proposal consumer** (§4.10, inbound HL7 ADT apply) is
>    deny-stubbed (M29 is Wave H); Phase-1 patients are created via the UI. SSN is **ignored even if
>    present** in matching (W-M5-17, defense-in-depth).
> 6. **PHI discipline is now real, not theoretical:** envelope encryption (M1 KEK/DEK helper) for MBI
>    and protected fields; append-only address with `effective_from/effective_to` (M5 D5); the geocode
>    job for `geocoded_lat/lng`; deceased cascade (M5 D7).

---

## Module 5 — Patient & Demographics (deps: M2,M3,M4,M36,M38,M40 · codePaths: apps/backend/src/modules/05-patient)

ownedTables (16): patient, patient_identifier, patient_name_alias, patient_address, patient_phone,
patient_email, patient_payer, caregiver, patient_caregiver, emergency_contact, patient_assignment,
patient_communication_preference, patient_privacy_flag_snapshot, patient_amendment_request,
patient_match_review, patient_merge.

### M5-T01 — Enums, module layout, identifier strategy
- deps: Wave A+B done · files: `apps/backend/src/modules/05-patient`, `packages/types` · spec §3.1, §3.2, §2.2
- do: enums; the patient-identifier strategy (§2.2); seam/outbox interface types in `packages/types`.
- accept: `tsc -b` green.

### M5-T02 — Core tables + envelope encryption
- deps: M5-T01 · files: `packages/db/src/schema` · spec §3.3
- do: `patient`, `patient_identifier`, `patient_name_alias`, `patient_address`, `patient_phone`,
  `patient_email`; envelope-encrypt protected fields (MBI/SSN) via the M1 KEK/DEK helper; append-only
  address with `effective_from/effective_to` (M5 D5). Bind demographics value sets from M38 (race/
  ethnicity SNOMED, language ISO-639, SOGI, state codes).
- accept: `arch:tables` (M5 owns), `arch:ddl`; encrypted columns on the M4 audit denylist.

### M5-T03 — Coverage, caregiver, contact tables
- deps: M5-T01 · files: `packages/db/src/schema` · spec §3.4
- do: `patient_payer` (resolves M40 `Payer`), `caregiver`, `patient_caregiver`, `emergency_contact`,
  `patient_communication_preference`.
- accept: `arch:tables`, `arch:ddl` green.

### M5-T04 — Caseload, privacy, match, merge, amendment + seam schema
- deps: M5-T01 · files: `packages/db/src/schema` · spec §3.5, §3.8
- do: `patient_assignment`, `patient_privacy_flag_snapshot`, `patient_match_review`, `patient_merge`,
  `patient_amendment_request`; schema additions for the external-resolution seams (§3.8).
- accept: `arch:tables`, `arch:ddl`, `arch:tenancy` green.

### M5-T05 — RLS, audit triggers, migration
- deps: M5-T02, M5-T03, M5-T04 · files: `packages/db/migrations` · spec §3.6, §3.7
- do: RLS & grants (§3.6, three-column rule on every PHI table); write-audit triggers via the M4
  generator; migration.
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` (phi-guards) green; RLS isolation test drafted.

### M5-T06 — Patient matching pipeline
- deps: M5-T02, M5-T04 · files: module · spec §2.3, §7.2, §7.3, §7.12
- do: deterministic-first, probabilistic-queued matching; hard-duplicate block (§7.2); soft-duplicate
  queue → `patient_match_review` (§7.3); **SSN ignored even if present** (W-M5-17).
- accept: §7.2/§7.3 + W-M5-17 tests; matcher unit coverage ≥95% (§9.1).

### M5-T07 — CaseloadProvider seam (closes M3 boot-gate)
- deps: M5-T04, M1-T09 · files: module, `apps/backend/src/bootstrap`, `packages/types` · spec §4.1, §7.5
- do: implement `CaseloadProvider` (§4.1) — M3 declared it, M5 registers the resolver; replace the
  bootstrap deny-stub; caseload narrowing enforced (§7.5).
- accept: `validateSeams()` passes with real CaseloadProvider; §7.5 test; `arch:gaps` seam green.

### M5-T08 — PatientReader + PatientMutator seams (close boot-gate)
- deps: M5-T06, M1-T09 · files: module, `apps/backend/src/bootstrap`, `packages/types` · spec §4.8, §4.9
- do: implement `PatientReader` (§4.8) and `PatientMutator` (§4.9); register into the M1 registry,
  replacing the Wave-A deny-stubs (both required by `validateSeams()`).
- accept: `validateSeams()` passes with real impls; seam unit coverage ≥95% (§9.1).

### M5-T09 — Routes, permission keys, capture contract
- deps: M5-T05, M5-T06 · files: module · spec §4.2, §4.3–4.4, §4.7, §7.1, §7.4, §7.7
- do: route inventory + complete TypeBox schemas (§4.4) behind `requirePermission`/`requireAbac` +
  `withOrgContext`; the capture contract (§4.2); register permission keys into M3 (§4.7); admit-no-dup
  (§7.1), address-change cascade (§7.4), right-to-amend in 60 days (§7.7).
- accept: §7.1/§7.4/§7.7 integration tests; `arch:boundaries` green.

### M5-T10 — Outbox, jobs, privacy-flag recompute, SUD enforcement
- deps: M5-T05, M5-T09 · files: module, `packages/types` · spec §4.5, §4.6, §7.6
- do: publish `m5.patient.*` outbox events (§4.6); jobs (§4.5, geocode → `geocoded_lat/lng`); wire the
  `patient_privacy_flag_snapshot` recompute consumer on `m39.consent.*` (inert until M39); SUD-flag
  enforcement on reads (§7.6).
- accept: `arch:gaps` event-catalog (m5. naming) green; §7.6 SUD test.

### M5-T11 — M29 proposal consumer (deny-stub) + deceased cascade
- deps: M5-T08, M5-T10 · files: module · spec §4.10, §7.8
- do: the M29 proposal-accept consumer (§4.10) as a **deny-stub** (M29 is Wave H — W-M5-15/16/18/19
  wire live then); deceased cascade (§7.8, M5 D7).
- accept: deceased-cascade test (§7.8); deny-stub present; gates green.

### M5-T12 — Screens, audit/SLO, eraser, DR/INT, tests
- deps: all M5 · files: UI per spec, module · spec §5, §8, §9, §10, §12
- do: screens (§5, WCAG 2.1 AA); audit events (§8.1) + SLO-breach alert via M36 (§8.3); register
  eraser (merger/snapshot); DR tier + INT inventory; tests §9 — matcher/merger/eraser/snapshot/seams
  ≥95% (§9.1), security independence (§9.3), **RLS isolation (§9.4)**, E2E (§9.5); walk §12 sign-off.
- accept: `docs:ui` green; `validateErasers()` passes; `bun run test` + full `arch:fitness` green.

---

## Module 39 — Consent & Authorization Management (deps: M1–M5 · codePaths: packages/consent, apps/backend/src/modules/39-consent)

ownedTables (11): consent_document_link, consent_eval_audit, consent_expiration_reminder, consent_record,
consent_record_dpoa_agent, consent_record_recipient, consent_renewal_cycle, consent_revocation,
consent_type_catalog, delegated_access, tenant_consent_type_overlay.

### M39-T01 — Enums + package layout
- deps: M5 done · files: `packages/consent` · spec §3.1, §3.2
- do: enums (consent kinds, recipient classes, etc.) + package layout.
- accept: `tsc -b` green.

### M39-T02 — Schema (all 11 tables) + partition strategy
- deps: M39-T01 · files: `packages/db/src/schema` · spec §3.3, §3.6
- do: all 11 tables (§3.3); partition strategy for the high-volume eval-audit (§3.6).
- accept: `arch:tables` (M39 owns 11), `arch:ddl` green.

### M39-T03 — RLS, trigger catalog, migration
- deps: M39-T02 · files: `packages/db/migrations` · spec §3.4, §3.5, §3.7
- do: RLS (§3.5); trigger catalog incl. write-audit via the M4 generator (§3.7); migration
  `0039_consent.sql` (§3.4).
- accept: `arch:tenancy` + `arch:ddl` + `arch:gaps` green; RLS isolation test drafted.

### M39-T04 — Lifecycle + validation (consent state machine)
- deps: M39-T02 · files: `packages/consent` · spec §2.2, §2.3
- do: per-entity lifecycle (§2.2) and validation rules (§2.3) — the consent state machine.
- accept: lifecycle unit tests; `tsc -b` green.

### M39-T05 — ConsentEvaluator seam (published)
- deps: M39-T04, M1-T09 · files: `packages/consent`, `apps/backend/src/bootstrap` · spec §4.3
- do: publish `ConsentEvaluator` (§4.3) — the disclosure/redaction gate every PHI-egress module
  imports (FHIR, portal, messaging, billing); register into the M1 registry.
- accept: `validateSeams()` passes; `arch:gaps` seam-registry green.

### M39-T06 — Consumed seams (real PatientReader, deny-stub M22)
- deps: M39-T05, M5-T08 · files: `packages/consent` · spec §4.4
- do: consume M5 `PatientReader` (now real); consume M22 `DocumentRenderer`/`DocumentStorageProvider`
  as **deny-stub forward seams** (ADR-0006, M22 is Wave F).
- accept: seam wiring compiles; `arch:boundaries` green (no 22→39 edge).

### M39-T07 — Routes, permissions, ABAC, pagination
- deps: M39-T02, M39-T04 · files: `apps/backend/src/modules/39-consent` · spec §4.1–4.2, §4.7, §4.8, §4.11, §4.12
- do: route inventory + TypeBox (§4.2) behind `requirePermission`/`requireAbac` + `withOrgContext`;
  register permission keys (§4.7) + ABAC predicate resolvers (§4.8) into M3; ABAC attribute sets on
  PHI reads (§4.11); cursor pagination on PHI list/audit routes (§4.12).
- accept: integration tests; `arch:boundaries` green.

### M39-T08 — Outbox, subscriptions, alerts, jobs
- deps: M39-T05, M39-T07 · files: `packages/consent`, module · spec §4.5, §4.6, §4.9, §4.10
- do: publish `m39.consent.signed`/`m39.consent.revoked` etc. (§4.5) — these drive M5's snapshot
  recompute; outbox subscriptions (§4.6); M36 typed alert payloads (§4.10); BullMQ expiration-reminder
  queue (§4.9).
- accept: `arch:gaps` event-catalog (m39. naming) green; M5 snapshot-recompute integration test passes.

### M39-T09 — Consent flows (the regulatory core)
- deps: M39-T07, M39-T08 · files: module · spec §7.1–7.9
- do: initial admission capture (§7.1 W-CON-01); 42 CFR Part 2 per-recipient over time (§7.2 W-CON-02);
  revocation cascade (§7.3 W-CON-03); expiring-consent reminder cadence (§7.5 W-CON-05); tenant overlay
  tightening cannot loosen (§7.6 W-CON-06); DPOA chain-of-authority (§7.8 W-CON-08, D5 refusal);
  post-death termination (§7.7 W-CON-07, D13); right-of-access export gate §164.524 (§7.9 W-CON-09).
- accept: W-CON-01/02/03/05/06/07/08/09 tests green.

### M39-T10 — Screens, eraser, STRIDE, DR/INT, audit
- deps: M39-T07 · files: UI per spec, module · spec §5.1–5.2, §3.8, §8.1, §8.5
- do: web + Capacitor screens (§5.1–5.2; portal variants are Phase 2 §5.3); eraser registration with
  the **Part 2 refuse-during-patient-lifetime** semantic (§3.8, per M4); STRIDE map (§8.5); audit
  events (§8.1); DR tier + INT inventory.
- accept: `docs:ui` green; `validateErasers()` passes (incl. Part 2 refusal).

### M39-T11 — Test plan
- deps: all M39 · files: module + `packages/consent` · spec §7, §8
- do: the full W-CON-01..12 set incl. self-revocation by portal (§7.12, deferred portal UI noted);
  RLS isolation; SUD-redaction chain with M5.
- accept: `bun run test` green; full `arch:fitness` green.

---

## Wave C acceptance (the workflow's final gate)
1. M5 (16) + M39 (11) ownedTables exist with RLS + migrations; manifest unchanged.
2. **`validateSeams()` passes with M5's real `CaseloadProvider`, `PatientReader`, `PatientMutator`**
   (three Wave-A deny-stubs closed) and M39's real `ConsentEvaluator`.
3. The SUD / 42 CFR Part 2 chain works end-to-end: `m39.consent.*` → M5 `patient_privacy_flag_snapshot`
   recompute → SUD-gated reads; the M4 `sud_value` denylist scrubs audit.
4. Non-circular by construction: M39→M5 compile edge; M5←M39 via outbox only.
5. Phase-1 deny-stubs intact: M5 M29 proposal consumer; M39 M22 document seams.
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
7. **Wave C complete → Wave D (M6 Admission, M7 Care Plan, M8 Encounters) unblocked** — the admission
   + documentation spine, the first modules to admit and chart on a real patient.

> Run per module via Archon, e.g.:
> `archon workflow run wardenx-piv --branch feat/m5-patient "Use the plan at docs/plans/WAVE_C_M5-M39_PLAN.md (Module 5 only)"`
