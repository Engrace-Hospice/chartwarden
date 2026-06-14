# WardenX — Wave P2-1: M15 Discipline Plans · M16 Bereavement · M21 Supplies/DME · M24 Medicaid

Phase 2 Part B, Wave P2-1 from `PHASE_2_PLAN.md` §3 — independent operational modules; all
dependencies satisfied by Phase 1, so **buildable in parallel** (with two intra-wave seam orderings
noted). **Conventions, determinism rules, the validate gate, and the legend are inherited from
`M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends with a §12 Acceptance Sign-Off Checklist.

Specs (all `docs/modules/`): `WARDENX_MODULE_15_DISCIPLINE_CARE_PLANS_SPEC_v0_2.md`,
`WARDENX_MODULE_16_BEREAVEMENT_SPEC_v0_5.md`, `WARDENX_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md`,
`WARDENX_MODULE_24_BILLING_MEDICAID_SPEC_v0_2_1.md`.

> **Build order.** Deps: M15←[7,8], M16←[5,6,36], M21←[11,40], M24←[23,40]. Parallel, but seam
> ordering inside the wave: **M15 before M16** (M16 risk rubric reads M15 `MswRiskFactorReader` — else
> deny-stub).
>
> **Seams that go LIVE this wave (closing Phase-1 deny-stubs):**
> | Now real | Closes |
> |---|---|
> | M15 `VolunteerComplianceProvider` + `SupervisoryCadenceReader` | M17 (Wave F) volunteer-gate + supervisory-advisory deny-stubs |
> | M21 consumes `m11.order.supply_fulfillment_requested` + `m13.comfort_kit.*` | M11 (Wave E) + M13 (Wave E) supply/comfort-kit deny-stubs |
> | M16 consumes `m6.bereavement.eligible` | M6 (Wave D) bereavement outbox |
>
> **AI dependency:** M16's risk **narrative** (Layer 2) and the deterministic risk rubric — the rubric
> works without AI; the narrative needs Part-A `ai.full` (M32). Gate the narrative behind it.

## Module 15 — Discipline Care Plans (deps: 7,8 · apps/backend/src/modules/15-discipline-care-plans) — 11 tables
- **M15-T01** Enums + layout + domain (§2); outbox events (§2.4); types in `packages/types`. → `tsc -b`.
- **M15-T02** Schema (11 tables, §3): discipline_care_plan(_version/_signature), discipline_goal/intervention, discipline_assessment, aide_supervisory_visit, volunteer_assignment/compliance_gate/hour_entry/hour_ledger; RLS + M4 audit + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M15-T03** Lifecycle (§2.2): discipline plans referencing M7 problems/goals (consume `CarePlanReader`); aide POC + **14-day supervisory cadence** (§7.1); discipline assessments via M8 `SignedEncountersReader`.
- **M15-T04** Volunteer compliance (§7.4/7.5): `volunteer_compliance_gate` + hours ledger; CoP 418.78(e) 5% ratio; gate-expiry → inactive.
- **M15-T05** Seams published (§4.3): `DisciplinePlanReader`, **`VolunteerComplianceProvider`**, **`SupervisoryCadenceReader`** into M1 — closes M17's Wave-F deny-stubs. → `validateSeams`.
- **M15-T06** Routes (§4.1) + permission keys (§4.4) + ABAC (§4.5: `aide_supervisor_eligible`/`volunteer_compliance_active`/`family_violence_disclosure_allowed`) into M3; M39 SUD + family-violence gating; M22 plan PDF.
- **M15-T07** Screens + tests (§9 incl. RLS §9.3) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 16 — Bereavement (deps: 5,6,36 · apps/backend/src/modules/16-bereavement) — 9 tables  (build after M15)
- **M16-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M16-T02** Schema (9 tables, §3) + partition strategy (§3.6) + RLS + M4 audit (clinical_record retention, ADR-0004; contact-notes cipher denylisted) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M16-T03** Lifecycle state machines (§2.2–2.4): `bereavement_plan`/`bereaved_contact`/`bereavement_outreach`; intake on **`m6.bereavement.eligible`** (closes M6 outbox); 13-month window; opt-out (§D9).
- **M16-T04** Deterministic risk rubric (`bereavement_risk_score`) from M9 `ScaleSeriesProvider` + M15 `MswRiskFactorReader`; **Layer-2 risk narrative gated on `ai.full`** (§7.3, partial-data §7.17).
- **M16-T05** Seams published (§4.6): `BereavementPlanProvider` (M36 channel), `BereavementOutreachProvider`/`BereavementRiskTierProvider` (M33 Phase 2) into M1. → `validateSeams`.
- **M16-T06** Routes (§4.1–4.2) + permission keys (§4.7) + ABAC (§4.8: `bereavement_window`/`discipline_can_provide_bereavement`) into M3; M22 outreach artifacts; M36 bereavement channel; M39 bereavement-outreach consent.
- **M16-T07** Screens + tests (§9 incl. RLS) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 21 — Supplies, DME & Comfort Kits (deps: 11,40 · apps/backend/src/modules/21-supplies) — 11 tables
- **M21-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M21-T02** Schema (11 tables, §3.1/§3.2, single-source per M21-F04/ADR-0023): supply_item + tenant_supply_item_extension, comfort_kit_template(_medication), vendor_routing_rule, par_stock, supply_request, comfort_kit_dispatch(_content)/return(_content); RLS + M4 audit + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M21-T03** Supply-request lifecycle (§2.2 XState); comfort-kit template (§2.3) + dispatch/per-med content (§2.5) + return/reconciliation (§2.6); par-stock monitoring (§2.7).
- **M21-T04** **Consume `m11.order.supply_fulfillment_requested`** (closes M11 deny-stub) + **`m13.comfort_kit.*`** (closes M13 deny-stub); emit `m21.supply_request.status_changed` + `m21.comfort_kit.*` back; M11 `OrderProvider` for context.
- **M21-T05** Seams published (§4.8) into M1; routes (§4.1–4.2) + permission keys (§4.3) + ABAC (§4.4: `controlled_substance_dispatcher_eligible`/`comfort_kit_return_reconciler_eligible`) into M3; M22 BOL/return-receipt + DEA 1304 perpetual log; M40 DmeVendor.
- **M21-T06** Screens (§5) + tests + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 24 — Billing, Medicaid (Oregon) (deps: 23,40 · packages/medicaid-adapters, apps/backend/src/modules/24-billing-medicaid) — 14 tables
- **M24-T01** Enums + `packages/medicaid-adapters` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M24-T02** Schema (14 tables, §3.3): medicaid_claim(_line/_line_encounter/_state_history), medicaid_submission/acknowledgment, medicaid_validation_* , medicaid_eligibility_check, **rb_arrangement/rb_day** (NF room & board), state_medicaid_trading_partner_credential; RLS + M4 audit + eraser (§3.7) + migration (§3.2). → `arch:tables/tenancy/ddl/gaps`.
- **M24-T03** Claim lifecycle (§2.2); `MedicaidAdapter` seam (§4.5 D1, **Oregon adapter only**, pluggable per-state — other states Phase 4) in `packages/medicaid-adapters`.
- **M24-T04** Medicaid Validation Rule Registry (§4.6 D10): `medicaid_rb_arrangement_required_for_nf_resident` (§7.2), `medicare_primary_required_for_dual` (§7.3), `medicaid_evv_bracket_coherence` (§7.5, consume M18 `EvvComplianceReader`).
- **M24-T05** Consume M23 (claim base, Medicare-primary for dual-eligible), M40 `PayerCatalogReader`, M5/M6/M8/M38; eight published reader seams (§4.3) into M1. → `validateSeams`.
- **M24-T06** Routes (§4.1–4.2) + permission keys (§4.7) + ABAC (§4.8) into M3; outbox (§4.11); state trading-partner submission.
- **M24-T07** Screens + workflows (§7.1 Oregon FFS combined hospice+R&B dual-eligible) + tests + §12 sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave P2-1 acceptance
1. M15(11)+M16(9)+M21(11)+M24(14) ownedTables exist with RLS + migrations; manifest unchanged.
2. `validateSeams()` passes; **M15→M17, M21→M11/M13, M16→M6 deny-stubs closed** (`arch:boundaries` green).
3. Medicaid (Oregon) produces a clean claim for a dual-eligible NF-resident test patient (PHASE_2 §5.4).
4. Phase-3 flags stay OFF; M16 risk narrative gated on Part-A `ai.full`.
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
6. **→ Wave P2-2 (M19 On-Call Triage, M20 Field Safety)** — both consume M17 (and M19's `OnCallProvider`
   feeds M20).

> Run per module via Archon, e.g.: `archon workflow run wardenx-piv --branch feat/m24-medicaid "Use the plan at docs/plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md (Module 24 only)"`
