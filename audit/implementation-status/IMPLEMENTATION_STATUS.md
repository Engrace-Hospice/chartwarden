# WardenX — Module Implementation-Status Matrix

> **Generated, advisory report** (`bun run status:matrix`). A green `arch:fitness` proves the
> architecture is coherent, NOT that a module is built. This matrix shows per-module build progress.
> Do not hand-edit — the `status:matrix --check` gate (in `arch:fitness`) keeps it in sync with source.

**Totals:** 🟢 35 Implemented · 🟡 0 Partial · ⚪ 5 Placeholder (of 40 modules)

Columns: Spec · Schema (Drizzle defs for owned tables) · Migration (all owned tables in a `CREATE TABLE`) · Routes (non-placeholder backend `routes/`) · Enriched (routes carrying an OpenAPI contract / routes scanned — a RATIO, not a tick; ⚠️ = some route publishes no request/response schema. `arch:openapi-coverage` ratchets it) · Screens (registered web `screens.ts`) · Tests (package `__tests__` or slug-matched backend test, *heuristic*) · Adapter (vendor/client package built; — = none owned, *heuristic*) · Live (owned tables NAMED in a `*.live.test.ts` / owned tables — a RATIO, and still a name match, not an executed proof; ⚠️ marks any module with an unproven table). This column was a boolean `some()` and read ✅ for M35, a placeholder with zero migrations. Headline status keys off the placeholder marker + schema + routes only.

| Module | Status | Spec | Schema | Migration | Routes | Enriched | Screens | Tests | Adapter | Live |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| M01 Foundation | 🟢 Implemented | ✅ | ✅ | ✅ | ❌ | — | ❌ | ✅ | — | 10/16 ⚠️ |
| M02 Identity & Org | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 10/14 ⚠️ | ✅ | ✅ | — | 1/4 ⚠️ |
| M03 Authorization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 9/17 ⚠️ | ✅ | ❌ | — | 5/6 ⚠️ |
| M04 Audit & Compliance Log | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 1/4 ⚠️ | ✅ | ✅ | — | 7/7 ✅ |
| M05 Patient & Demographics | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 13/14 ⚠️ | ✅ | ✅ | — | 2/16 ⚠️ |
| M06 Admission, Election & Certification | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 6/46 ⚠️ | ✅ | ✅ | — | 2/12 ⚠️ |
| M07 Care Plan (IPOC) | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 3/19 ⚠️ | ✅ | ✅ | — | 6/6 ✅ |
| M08 Encounters & Visit Notes | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 4/31 ⚠️ | ✅ | ✅ | — | 1/10 ⚠️ |
| M09 Clinical Assessments Suite | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 6/18 ⚠️ | ✅ | ✅ | — | 2/5 ⚠️ |
| M10 HOPE Engine | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 10/20 ⚠️ | ✅ | ✅ | ✅ | 2/6 ⚠️ |
| M11 Orders | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 9/28 ⚠️ | ✅ | ✅ | — | 2/7 ⚠️ |
| M12 DoseSpot Integration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 10/31 ⚠️ | ✅ | ✅ | ✅ | 2/6 ⚠️ |
| M13 eMAR & Med Administration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 10/28 ⚠️ | ✅ | ✅ | — | 2/12 ⚠️ |
| M14 IDG | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 6/26 ⚠️ | ✅ | ✅ | — | 3/9 ⚠️ |
| M15 Discipline Care Plans | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 23/28 ⚠️ | ✅ | ✅ | — | 11/11 ✅ |
| M16 Bereavement | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/33 ⚠️ | ✅ | ✅ | — | 9/9 ✅ |
| M17 Scheduling & Route Optimization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 11/29 ⚠️ | ✅ | ✅ | ✅ | 2/7 ⚠️ |
| M18 EVV | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 7/25 ⚠️ | ✅ | ✅ | — | 6/6 ✅ |
| M19 On-Call Triage | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/38 ⚠️ | ✅ | ✅ | ✅ | 10/10 ✅ |
| M20 Field Safety | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 25/30 ⚠️ | ✅ | ✅ | — | 13/13 ✅ |
| M21 Supplies, DME & Comfort Kits | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/37 ⚠️ | ✅ | ✅ | — | 11/11 ✅ |
| M22 Document Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 6/35 ⚠️ | ✅ | ✅ | — | 2/17 ⚠️ |
| M23 Billing — Medicare | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 43/43 ✅ | ✅ | ✅ | ✅ | 2/17 ⚠️ |
| M24 Billing — Medicaid | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 39/39 ✅ | ✅ | ✅ | ✅ | 14/14 ✅ |
| M25 Remittance & Denials | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 18/31 ⚠️ | ✅ | ✅ | ✅ | 11/11 ✅ |
| M26 Cap Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 19/27 ⚠️ | ✅ | ✅ | — | 12/12 ✅ |
| M27 Cost Report | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 11/45 ⚠️ | ✅ | ✅ | ✅ | 4/14 ⚠️ |
| M28 FHIR Gateway | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | — | ❌ | ❌ | — | 0/8 ⚠️ |
| M29 External Interfaces | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | — | ❌ | ❌ | — | 0/11 ⚠️ |
| M30 HQRP & Quality | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 57/60 ⚠️ | ✅ | ✅ | ✅ | 18/18 ✅ |
| M31 Patient/Family Portal & Telehealth | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | — | ❌ | ❌ | ❌ | 0/3 ⚠️ |
| M32 AI Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 32/32 ✅ | ❌ | ✅ | — | 13/13 ✅ |
| M33 Reporting & Dashboards | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 4/42 ⚠️ | ✅ | ✅ | — | 12/12 ✅ |
| M34 SaaS Tenant Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 9/48 ⚠️ | ✅ | ✅ | — | 14/17 ⚠️ |
| M35 Subscription Billing | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | — | ❌ | ❌ | — | 3/21 ⚠️ |
| M36 Secure Messaging & Alerts | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 4/22 ⚠️ | ✅ | ✅ | — | 11/15 ⚠️ |
| M37 Inpatient Unit (IPU) Management | ⚪ Placeholder | ✅ | ❌ | ❌ | ❌ | — | ❌ | ❌ | — | 0/26 ⚠️ |
| M38 Clinical Terminology Service | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 1/8 ⚠️ | ✅ | ✅ | — | 8/13 ⚠️ |
| M39 Consent & Authorization Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 17/27 ⚠️ | ✅ | ✅ | — | 3/11 ⚠️ |
| M40 Master Data Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 1/14 ⚠️ | ✅ | ✅ | — | 5/11 ⚠️ |

## Hard-fail consistency checks

- ✅ No orphan schema/migration tables (every defined table is owned by a module).
