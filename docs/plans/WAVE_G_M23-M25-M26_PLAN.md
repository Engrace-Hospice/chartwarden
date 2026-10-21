# ChartWarden — Wave G: Revenue cycle (M23 Billing-Medicare · M25 Remittance · M26 Cap)

Wave G from `PHASE_1_PLAN.md` — **how money comes in.** M23 is the go-live gate (the §11.A
Pre-Submission Validation Framework, 30+ rules). **Conventions, determinism rules, the validate gate,
and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends with a §12
Acceptance Sign-Off Checklist — the authoritative sub-steps.

Specs (all `docs/modules/`): `CHARTWARDEN_MODULE_23_BILLING_MEDICARE_SPEC_v0_2.md`,
`CHARTWARDEN_MODULE_25_REMITTANCE_SPEC_v0_2.md`, `CHARTWARDEN_MODULE_26_CAP_MANAGEMENT_SPEC_v0_3.md`.

> **Build order + the non-circular bidirectionals (read first).** Deps: M23←[6,8,22,38,40],
> M25←[23,36], M26←[23,36]. Build **M23 first → M25 ∥ M26**. Two handshakes are bidirectional in
> *behavior* but acyclic in *imports*:
> - **M23 ↔ M25:** M25 compile-imports M23 `ClaimReader` (edge M25→M23). M23 consumes
>   `m25.remittance.*` **via outbox (no edge)** to advance the claim state machine (PAID/DENIED/
>   PARTIAL). So build M23 with that outbox consumer **inert**, then M25 emits live.
> - **M23 ↔ M26:** M26 compile-imports M23 `ClaimReader`/`ClaimLineReader` (edge M26→M23). M23's
>   §11.A "aggregate cap projection" rule consumes M26 `CapProjectionProvider` **via a boot seam
>   deny-stub (no edge)** — warn-only — that M26 makes real at its lock (closes the stub).
>
> **Phase-1 flag (default OFF):** `cap.full_projection` (M26 — **basic projection only**; full
> agency-wide watch is Phase 3).
>
> **External INT — the X12 worker.** 837I generation + 999/277CA + 835 parsing run in the shared
> **Python `x12-worker` sidecar** (architecture §12), invoked over internal HTTP via two single-owner
> adapter packages (ADR-0029): **`packages/x12-837-client` (M23)** = 837I gen + 999 + 277CA parse;
> **`packages/x12-835-client` (M25)** = 835 ERA parse only. 277CA is M23-owned — M25 seeds denials from
> `m23.claim.rejected`, not by parsing 277CA. Both declare the worker in their INT inventory; **MAC
> submission requires step-up** (M23).
>
> **Still deferred:** M24 Medicaid + commercial remittance (Phase 2); M28 FHIR `Claim`/`EOB`
> projection (Wave H forward seam, M23 ships the contract); M27 Cost Report consumption of M26 (Phase 2).
>
> **EVV in §11.A respects ADR-0008:** `documented_missing` allows submission with the in-encounter
> attestation; only `unresolved_missing` blocks. EVV is never a `regulatory_required` claim rule.
>
> **Revenue-loop acceptance closes the Phase-1 end-to-end scenario:** …bill Medicare (§11.A clean
> 837I) → post 835 → cap projection.

> **Track B screens (ADR-0030) — built in-task, not deferred.** Each UI-owning module owns
> `apps/web/src/modules/NN-*`: its first task adds that web codePath to the manifest + runs
> `bun run scaffold` (`arch:parity` 1:1); its screen task builds the §5 screens against the
> generated client and registers them into the M1 shell, flipping the matching
> `docs/design/DEFERRED_SCREENS.md` row → `done`. Backend-first preserved.

---

## Module 23 — Billing, Medicare (deps: 6,8,22,38,40 · codePaths: packages/billing, apps/backend/src/modules/23-billing-medicare, apps/web/src/modules/23-billing-medicare)
ownedTables (17): claim, claim_acknowledgment, claim_line, claim_state_history, claim_submission, eligibility_check, hipps_calculation, mac_submitter_credential, noe_record, notr_record, sequestration_policy, sia_calculation, validation_override, validation_result, validation_rule_config, validation_run, wage_index_factor.

- **M23-T01** Enums + `packages/billing` layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/23-billing-medicare` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M23-T02** Schema (17 tables, §3.3) + RLS + M4 audit triggers (MBI + `mac_submitter_credential.client_secret_cipher` denylisted) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M23-T03** Claim lifecycle state machine (§2.2) + validation rules (§2.3); `claim`/`claim_line`/`claim_state_history`.
- **M23-T04** Rate/calc engines: HIPPS (`hipps_calculation`), SIA (`sia_calculation`), sequestration (`sequestration_policy`), wage index (`wage_index_factor`).
- **M23-T05** Consumed seams (§4.4): M5 `PatientReader`/`PatientPayerReader` (MBI decrypted only at submission), M6 `ElectionPeriodReader`/`CertificationReader`/`FaceToFaceReader`/`LevelOfCareReader`, M8 `BillableEncounterReader` (holds `awaiting_cosignature`), M18 `EvvComplianceReader` (ADR-0008), M38 `TerminologyProvider`, M40 `MdmEntityProvider`, M22 `DocumentRenderer`; **M26 `CapProjectionProvider` as a deny-stub** (warn-only, wired live at M26 lock).
- **M23-T06** **§11.A Validation Rule Registry (§4.5)** — 30+ rules; overridable (`validation_override`, §7.2) vs **regulatory-required cannot be tenant-disabled** (§7.3); EVV rule per ADR-0008; cap-projection rule warn-only (§7.13). `validation_run`/`validation_result`.
- **M23-T07** `packages/x12-837-client` (ADR-0029): 837I generation + 999 + 277CA parse via the Python sidecar (INT inventory); 277CA partial acceptance → TOB 817 (§7.12).
- **M23-T08** Eligibility (§7.14, `eligibility_check`, fresh 270/271 at submission); MAC submission + `mac_submitter_credential` + **step-up on submit**; `claim_submission`/`claim_acknowledgment`.
- **M23-T09** NOE/NOTR windows (§7.4–7.6): `noe_record` on `m6.election.signed`, `notr_record` on `m6.discharge.created`; day-3 warning / day-5+1 breach blocks submission.
- **M23-T10** Five published reader seams (§4.3: `ClaimReader`, `ClaimDayProjectionProvider` for M26, `ClaimMetricsProvider` for M33, …) into M1 registry. → `validateSeams`.
- **M23-T11** Routes (§4.1–4.2) behind guards + step-up; permission keys (§4.6) + ABAC (§4.7) into M3; outbox (§4.10): `m23.claim.*` + **inert** `m25.remittance.*` consumer; M28 FHIR `Claim` projection forward-seam (Wave H); M24 Medicaid Phase 2.
- **M23-T12** Screens (§5) — **Track B/ADR-0030**: build under `apps/web/src/modules/23-billing-medicare` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; tests (§9: RLS §9.3, IDOR §9.4, §11.A rule suite, **clean 837I** §7) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 25 — Remittance & Denials (deps: 23,36 · codePaths: apps/backend/src/modules/25-remittance, apps/web/src/modules/25-remittance) — BASIC (835 posting + denial worklist)
ownedTables (11): appeal_case, appeal_case_event, denial_case, denial_case_assignment, denial_taxonomy_overlay, patient_responsibility_ledger, remittance_adjustment, remittance_advice, remittance_line, remittance_remark, remittance_service_line.

- **M25-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/25-remittance` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M25-T02** Schema (11 tables, §3.3) + RLS + M4 audit + eraser (§3.7) + migration (§3.2). → `arch:tables/tenancy/ddl/gaps`.
- **M25-T03** Remittance lifecycle (§2.2) + validation (§2.3); 835 posting (`remittance_advice`/`remittance_line`/`remittance_service_line`/`remittance_adjustment`/`remittance_remark`) + `patient_responsibility_ledger`.
- **M25-T04** `packages/x12-835-client` (ADR-0029): parse **835 only** via the sidecar; emit `m25.edi.835_received`. (277CA-derived denials arrive via `m23.claim.rejected` — M25 does not parse 277CA.)
- **M25-T05** Auto-match 835 → claim: consume M23 `ClaimReader.findByControlNumbers`; `m23.claim.rejected` (277CA) seeds the denial worklist (§7.3).
- **M25-T06** Denial worklist (`denial_case`/`denial_case_assignment`/`denial_taxonomy_overlay`) + appeals (`appeal_case`/`appeal_case_event`, next-tier auto-spawn §7.10); CARC/RARC via M38; M40 `PayerCatalogReader`.
- **M25-T07** Eight published reader seams (§4.3: `RemittanceReader`, `DenialMetricsProvider`, …) into M1; emit `m25.remittance.*` (→ **closes M23's inert consumer**: PAID/DENIED/PARTIAL); appeal packets via M22 `DocumentRenderer`. → `validateSeams`.
- **M25-T08** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7, step-up on `appeal.submit`/`remittance.adjustment.override`); screens (§5: inbox, worklist Kanban, appeal builder) — **Track B/ADR-0030**: build under `apps/web/src/modules/25-remittance` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`. M24 Medicaid 835 + commercial = Phase 2.
- **M25-T09** Tests (§9: RLS §9.3, IDOR §9.4, E2E §9.6, happy-path 835 §7.1, 277CA→denial→appeal §7.3) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 26 — Cap Management (deps: 23,36 · codePaths: apps/backend/src/modules/26-cap, apps/web/src/modules/26-cap) — BASIC projection (cap.full_projection OFF)
ownedTables (12): cap_beneficiary_accrual, cap_beneficiary_accrual_line, cap_inpatient_accrual, cap_inpatient_day_line, cap_period, cap_period_methodology_lock, cap_period_platform_constant, cap_projection_snapshot, cap_psr_import, cap_psr_reconciliation, cap_settlement, cap_threshold_event.

- **M26-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/26-cap` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M26-T02** Schema (12 tables, §3.3) + RLS + M4 audit + eraser (§3.7: **retains per-cap aggregates, redacts `patient_id`→[ERASED]** per D14) + migration (§3.2). → `arch:tables/tenancy/ddl/gaps`.
- **M26-T03** Accrual model (§2.2): `cap_beneficiary_accrual(_line)`, `cap_inpatient_accrual`/`cap_inpatient_day_line`; `cap_period` + `cap_period_methodology_lock`; `cap_period_platform_constant` (CMS-published cap amounts).
- **M26-T04** Consumed seams (§4.4): M23 `MedicareClaimReader`/`ClaimLineReader` (rev-code 0655/0656 inpatient days), M25 `RemittanceReader.postedRemittanceLinesForPatient` (paid amounts; trigger on `m25.remittance.advice_posted`), M5 `PatientReader`/deceased, M6 `ElectionPeriodReader`/`MedicareBeneficiaryIdProvider`/revocation/transfer.
- **M26-T05** Projection engine (**BASIC**, `cap.full_projection` OFF): per-patient + aggregate projection (`cap_projection_snapshot`); threshold events (`cap_threshold_event`) at watch/warn/breach bands (§7.4–7.6).
- **M26-T06** `CapProjectionProvider` seam (§4.3) + `CapAccrualReader`/`InpatientCapProvider`/`CapSettlementProvider`/`CapMetricsProvider` into M1 — **wires live M23's §11.A warn-only cap rule** (closes the M23 deny-stub). → `validateSeams`.
- **M26-T07** Cap-year lifecycle (§4.5): auto-open new cap year (§7.7); PS&R import/reconciliation (`cap_psr_import`/`cap_psr_reconciliation`); settlement proposal/finalize (§7.9/7.10, `cap_settlement`) with step-up.
- **M26-T08** Alerts via M36 **generic `AlertEmitter` + `CapAlertSubscriberProvider`** (no `cap_watch` channel — M36-F03); routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7) into M3.
- **M26-T09** Outbox (§4.10): `m26.cap.*` watch/warn/breach; nightly projection batch (§7.2); screens (§5.1 web, Phase 1) — **Track B/ADR-0030**: build under `apps/web/src/modules/26-cap` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`. Full agency-wide watch deferred to Phase 3.
- **M26-T10** Tests (§9: RLS §9.3, IDOR §9.4, E2E §9.5, accrual→projection §7.1, warn-only validation §7.12, **enum-drift snapshot §9.9**) + §12 sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave G acceptance (the workflow's final gate)
1. M23(17)+M25(11)+M26(12) ownedTables exist with RLS + migrations; manifest unchanged **except the
   Track B (ADR-0030) web codePaths** (`apps/web/src/modules/{23-billing-medicare,25-remittance,26-cap}`)
   added by each module's first task (`arch:parity` 1:1).
2. `validateSeams()` passes with M23's five reader seams, M25's eight, M26's `CapProjectionProvider`
   et al.; **the M23↔M25 (`m25.remittance.*`) and M23↔M26 (`CapProjectionProvider`) handshakes are live
   and acyclic** (no `dependsOn` cycle — `arch:boundaries` green).
3. **The §11.A framework gates go-live:** a Medicare **837I produces a clean claim** through the 30+
   rules; regulatory-required rules cannot be tenant-disabled; overridable rules log a
   `validation_override`; the EVV rule honors ADR-0008.
4. **Revenue loop closes:** election → NOE → claim → MAC submit → **835 posted (M25)** → claim state
   PAID/DENIED/PARTIAL → **cap projection updated (M26)**; the full Phase-1 end-to-end scenario passes.
5. **Phase-1 flag holds:** `cap.full_projection` OFF (basic projection). M24/commercial/M28-FHIR/M27
   deferred per the map.
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
7. **Wave G complete → Wave H (M28 FHIR, M29 External Interfaces, M30 HQRP/Quality, M32 AI Platform,
   M34 SaaS) unblocked** — interop, accounting, quality, AI shell, and single-tenant SaaS; Wave H
   closes the M23/M25/M11/M13/M12 FHIR + HL7 forward seams.

> Run per module via Archon, e.g.:
> `archon workflow run chartwarden-piv --branch feat/m23-billing "Use the plan at docs/plans/WAVE_G_M23-M25-M26_PLAN.md (Module 23 only)"`
