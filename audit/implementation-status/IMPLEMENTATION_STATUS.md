# WardenX — Module Implementation-Status Matrix

> **Generated, advisory report** (`bun run status:matrix`). A green `arch:fitness` proves the
> architecture is coherent, NOT that a module is built. This matrix shows per-module build progress.
> Do not hand-edit — the `status:matrix --check` gate (in `arch:fitness`) keeps it in sync with source.

**Totals:** 🟢 40 Implemented · 🟡 0 Partial · ⚪ 0 Placeholder (of 40 modules)

Columns: Spec · Schema (Drizzle defs for owned tables) · Migration (all owned tables in a `CREATE TABLE`) · Routes (non-placeholder backend `routes/`) · Enriched (routes carrying an OpenAPI contract / routes scanned — a RATIO, not a tick; ⚠️ = some route publishes no request/response schema. `arch:openapi-coverage` ratchets it) · Screens (registered web `screens.ts`) · Tests (package `__tests__` or slug-matched backend test, *heuristic*) · Adapter (vendor/client package built; — = none owned, *heuristic*) · Live (owned tables NAMED in a `*.live.test.ts` / owned tables — a RATIO, and still a name match, not an executed proof; ⚠️ marks any module with an unproven table). This column was a boolean `some()` and read ✅ for M35, a placeholder with zero migrations. Headline status keys off the placeholder marker + schema + routes only.

| Module | Status | Spec | Schema | Migration | Routes | Enriched | Screens | Tests | Adapter | Live |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| M01 Foundation | 🟢 Implemented | ✅ | ✅ | ✅ | ❌ | — | ❌ | ✅ | — | 17/17 ✅ |
| M02 Identity & Org | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 17/17 ✅ | ✅ | ✅ | — | 4/4 ✅ |
| M03 Authorization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 17/17 ✅ | ✅ | ❌ | — | 6/6 ✅ |
| M04 Audit & Compliance Log | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 4/4 ✅ | ✅ | ✅ | — | 7/7 ✅ |
| M05 Patient & Demographics | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 14/14 ✅ | ✅ | ✅ | — | 16/16 ✅ |
| M06 Admission, Election & Certification | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 47/47 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M07 Care Plan (IPOC) | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 19/19 ✅ | ✅ | ✅ | — | 7/7 ✅ |
| M08 Encounters & Visit Notes | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/31 ✅ | ✅ | ✅ | — | 10/10 ✅ |
| M09 Clinical Assessments Suite | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 18/18 ✅ | ✅ | ✅ | — | 5/5 ✅ |
| M10 HOPE Engine | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 20/20 ✅ | ✅ | ✅ | ✅ | 6/6 ✅ |
| M11 Orders | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 28/28 ✅ | ✅ | ✅ | — | 8/8 ✅ |
| M12 DoseSpot Integration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/31 ✅ | ✅ | ✅ | ✅ | 7/7 ✅ |
| M13 eMAR & Med Administration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 28/28 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M14 IDG | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 27/27 ✅ | ✅ | ✅ | — | 9/9 ✅ |
| M15 Discipline Care Plans | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 28/28 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M16 Bereavement | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 33/33 ✅ | ✅ | ✅ | — | 10/10 ✅ |
| M17 Scheduling & Route Optimization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 29/29 ✅ | ✅ | ✅ | ✅ | 7/7 ✅ |
| M18 EVV | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 25/25 ✅ | ✅ | ✅ | — | 7/7 ✅ |
| M19 On-Call Triage | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 38/38 ✅ | ✅ | ✅ | ✅ | 10/10 ✅ |
| M20 Field Safety | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 30/30 ✅ | ✅ | ✅ | — | 13/13 ✅ |
| M21 Supplies, DME & Comfort Kits | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 37/37 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M22 Document Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 38/38 ✅ | ✅ | ✅ | — | 18/18 ✅ |
| M23 Billing — Medicare | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 43/43 ✅ | ✅ | ✅ | ✅ | 17/17 ✅ |
| M24 Billing — Medicaid | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 39/39 ✅ | ✅ | ✅ | ✅ | 14/14 ✅ |
| M25 Remittance & Denials | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 31/31 ✅ | ✅ | ✅ | ✅ | 11/11 ✅ |
| M26 Cap Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 27/27 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M27 Cost Report | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 45/45 ✅ | ✅ | ✅ | ✅ | 14/14 ✅ |
| M28 FHIR Gateway | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 35/35 ✅ | ❌ | ✅ | — | 8/8 ✅ |
| M29 External Interfaces | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 33/33 ✅ | ❌ | ✅ | — | 11/11 ✅ |
| M30 HQRP & Quality | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 60/60 ✅ | ✅ | ✅ | ✅ | 18/18 ✅ |
| M31 Patient/Family Portal & Telehealth | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 53/53 ✅ | ❌ | ✅ | ✅ | 3/3 ✅ |
| M32 AI Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 32/32 ✅ | ❌ | ✅ | — | 13/13 ✅ |
| M33 Reporting & Dashboards | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 42/42 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M34 SaaS Tenant Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 48/48 ✅ | ✅ | ✅ | — | 17/17 ✅ |
| M35 Subscription Billing | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 54/54 ✅ | ✅ | ✅ | — | 21/21 ✅ |
| M36 Secure Messaging & Alerts | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 22/22 ✅ | ✅ | ✅ | — | 15/15 ✅ |
| M37 Inpatient Unit (IPU) Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 45/45 ✅ | ✅ | ✅ | — | 26/26 ✅ |
| M38 Clinical Terminology Service | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 8/8 ✅ | ✅ | ✅ | — | 13/13 ✅ |
| M39 Consent & Authorization Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 27/27 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M40 Master Data Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 14/14 ✅ | ✅ | ✅ | — | 11/11 ✅ |

## Hard-fail consistency checks

- ✅ No orphan schema/migration tables (every defined table is owned by a module).
