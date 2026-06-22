# WardenX — Module Implementation-Status Matrix

> **Generated, advisory report** (`bun run status:matrix`). A green `arch:fitness` proves the
> architecture is coherent, NOT that a module is built. This matrix shows per-module build progress.
> Do not hand-edit — the `status:matrix --check` gate (in `arch:fitness`) keeps it in sync with source.

**Totals:** 🟢 19 Implemented · 🟡 1 Partial · ⚪ 20 Placeholder (of 40 modules)

Columns: Spec · Schema (Drizzle defs for owned tables) · Migration (all owned tables in a `CREATE TABLE`) · Routes (non-placeholder backend `routes/`) · Enriched (OpenAPI bodies, *heuristic*) · Screens (registered web `screens.ts`) · Tests (package `__tests__` or slug-matched backend test, *heuristic*) · Adapter (vendor/client package built; — = none owned, *heuristic*) · Live (owned table named in a `*.live.test.ts`, *heuristic*). Headline status keys off the placeholder marker + schema + routes only.

| Module | Status | Spec | Schema | Migration | Routes | Enriched | Screens | Tests | Adapter | Live |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| M01 Foundation | 🟡 Partial | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ | — | ✅ |
| M02 Identity & Org | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M03 Authorization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ | — | ✅ |
| M04 Audit & Compliance Log | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ |
| M05 Patient & Demographics | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M06 Admission, Election & Certification | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M07 Care Plan (IPOC) | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ |
| M08 Encounters & Visit Notes | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M09 Clinical Assessments Suite | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M10 HOPE Engine | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M11 Orders | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M12 DoseSpot Integration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M13 eMAR & Med Administration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M14 IDG | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M15 Discipline Care Plans | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M16 Bereavement | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M17 Scheduling & Route Optimization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| M18 EVV | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ❌ |
| M19 On-Call Triage | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M20 Field Safety | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M21 Supplies, DME & Comfort Kits | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M22 Document Management | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M23 Billing — Medicare | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M24 Billing — Medicaid | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M25 Remittance & Denials | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M26 Cap Management | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M27 Cost Report | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M28 FHIR Gateway | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M29 External Interfaces | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M30 HQRP & Quality | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M31 Patient/Family Portal & Telehealth | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| M32 AI Platform | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M33 Reporting & Dashboards | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M34 SaaS Tenant Platform | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M35 Subscription Billing | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M36 Secure Messaging & Alerts | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M37 Inpatient Unit (IPU) Management | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ |
| M38 Clinical Terminology Service | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| M39 Consent & Authorization Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | — | ✅ |
| M40 Master Data Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |

## Hard-fail consistency checks

- ✅ No orphan schema/migration tables (every defined table is owned by a module).
