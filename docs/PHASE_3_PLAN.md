# ChartWarden — Phase 3 Plan (v1.2): Multi-Tenant Scale + Inpatient

**Status:** Plan — sequencing of architecture §20.A Phase 3. Depends on Phase 2 shipped.
**Authority:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §20.A Phase 3.
**Goal:** the capabilities that only matter at scale — full multi-tenancy, inpatient units, full
quality reporting, and the controlled/bidirectional integrations gated behind certification paths.
This is the "ChartWarden is a real SaaS business with multiple agencies" moment.

> **Count: 2 new modules (1 of them, M37, is genuinely new build) + 4 upgrades.** ~6–12 months after
> Phase 2.

---

## 1. Entry criteria

- All Phase-1 and Phase-2 modules at Definition of Done and in production.
- Multiple paying tenants live (M34 single-tenant proven; M35 billing live).
- Phase-3 feature flags exist and are wired but default-off (from Phase 1/2):
  `saas.multi_tenant`, `dosespot.epcs`, `fhir.write`, `quality.cahps`/`quality.hvldl_hci`,
  `cap.full_projection`.

---

## 2. New build

| M | Module | Deps | Scope | Notes |
|---|---|---|---|---|
| 37 | Inpatient Unit (IPU) Management | 6,8,11,13,17,23 | Beds/rooms/units, GIP + IRC admissions, 24/7 RN coverage enforcement, restraint/visitor/meal/equipment tracking, body-release coordination, daily census. | `packages/inpatient`. Activated only for tenants operating IPUs. Built late — it's the most self-contained large module. **Convert the spec's raw `CREATE TABLE` blocks to Drizzle `pgTable` first** (see roadmap; M37 is the lone format outlier). |

---

## 3. Upgrades to existing modules (flag activations)

Each re-runs the full DoD gate for the new surface and flips its flag on.

| M | Module | Activation | Notes |
|---|---|---|---|
| 34 | SaaS Tenant Platform | **`saas.multi_tenant`** — full multi-tenant mode | Tenant onboarding, self-serve, ops-console maturity. RLS was on from Phase 1, so this is activation, not retrofit. `apps/admin`. |
| 30 | HQRP & Quality | **`quality.cahps` + `quality.hvldl_hci`** | CAHPS vendor integration (SHP default per ADR-005), HVLDL/HCI tracking. `packages/cahps-vendors`. M27 Cost Report (Phase 2) now feeds it. |
| 26 | Cap Management | **`cap.full_projection`** — agency-wide cap watch + alerts | Beyond the Phase-1 basic projection. |
| 28 | FHIR Gateway | **`fhir.write`** — R4 write + R5 stub | Full bidirectional FHIR. |
| 12 | DoseSpot | **`dosespot.epcs`** — EPCS certification path complete | Controlled-substance e-prescribing; gated on DEA certification, not just code. |

> M28 `fhir.write` and M12 `dosespot.epcs` carry external **certification** dependencies (FHIR
> conformance / DEA EPCS audit). Treat certification as an explicit gate task, not a code-only deliverable.

---

## 4. Sequence

- **M37 IPU** is independent of the upgrades — start it first (longest build) and run it in parallel
  with the flag activations.
- **M34 full multi-tenant** before broadly onboarding tenants; it gates self-serve growth.
- **M30 CAHPS/HVLDL/HCI** depends on M27 (Phase 2) being live and on at least one full reporting
  period of data.
- **M12 EPCS** and **M28 write** are independent activations gated by their certifications.

---

## 5. Scope discipline (ADR-0009)

- Phase-3 is the last v1-horizon phase. Anything beyond (additional state Medicaid adapters, advanced
  analytics, multi-CCN, HITRUST/SOC2) is **Phase 4 / v2** — see [`PHASE_4_PLAN.md`](./PHASE_4_PLAN.md).
- M37 must hold the no-cross-module-schema-write discipline (D17): it never writes M6/M23/M26/M27/M30
  schema and they never write M37 — all coordination via outbox/seams.

---

## 6. Acceptance criteria (Phase 3)

1. M37 IPU at Definition of Done (schema converted to `pgTable`; `arch:tables` green for its 26 tables);
   24/7 RN-coverage block-severity enforcement demonstrated.
2. M34 multi-tenant: a second/third tenant onboards self-serve with full RLS isolation; cross-tenant
   isolation tests pass across the whole corpus.
3. M30 full quality: CAHPS decedent sampling exports to the SHP adapter; HVLDL/HCI measures compute
   against a full reporting period.
4. M28 FHIR write: a US Core R4 resource round-trips (write + read-back) with conformance tests green.
5. M12 EPCS: controlled-substance prescription flows through with EPCS assertions (post-DEA cert).
6. M26 full cap: agency-wide projection + alerts fire at configured thresholds.
7. `bun run arch:fitness` green; RLS isolation tests pass for all new PHI tables (IPU especially).

---

## 7. Risks & mitigations

- **Multi-tenant data isolation at scale** → RLS-on-from-Phase-1 plus corpus-wide cross-tenant test
  suite; per-tenant key handling for M30/M35 sensitive fields.
- **Certification timelines (EPCS/FHIR)** → modeled as explicit gate tasks; the code can be flag-ready
  before the cert lands, but the flag stays off until certified.
- **IPU scope size** → it's the largest single module; convert schema format first, build behind its
  own activation, and keep it fully outbox-decoupled so it can't destabilize Phase-1/2 modules.

---

## 8. Exit → Phase 4 / v2

Multiple agencies, some with IPUs, full quality + bidirectional interop. Beyond this is state
expansion and enterprise/certification work. See [`PHASE_4_PLAN.md`](./PHASE_4_PLAN.md).
