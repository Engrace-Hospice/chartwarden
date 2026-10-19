# WardenX — Module Implementation-Status Matrix

> **Generated, advisory report** (`bun run status:matrix`). A green `arch:fitness` proves the
> architecture is coherent, NOT that a module is built. This matrix shows per-module build progress.
> Do not hand-edit — the `status:matrix --check` gate (in `arch:fitness`) keeps it in sync with source.

**Totals:** 🟢 40 Implemented · 🟡 0 Partial · ⚪ 0 Placeholder (of 40 modules)

Columns: Spec · Schema (Drizzle defs for owned tables) · Migration (all owned tables in a `CREATE TABLE`) · Routes (non-placeholder backend `routes/`) · Enriched (routes carrying an OpenAPI contract / routes scanned — a RATIO, not a tick; ⚠️ = some route publishes no request/response schema. `arch:openapi-coverage` ratchets it) · Screens (registered web `screens.ts`) · Tests (package `__tests__` or slug-matched backend test, *heuristic*) · Adapter (vendor/client package built; — = none owned, *heuristic*) · Live (owned tables NAMED in a `*.live.test.ts` / owned tables — a RATIO, and still a name match, not an executed proof; ⚠️ marks any module with an unproven table). This column was a boolean `some()` and read ✅ for M35, a placeholder with zero migrations. Headline status keys off the placeholder marker + schema + routes only.

| Module | Status | Spec | Schema | Migration | Routes | Enriched | Screens | Tests | Adapter | Live |
|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| M01 Foundation | 🟢 Implemented | ✅ | ✅ | ✅ | ❌ | — | ❌ | ✅ | — | 18/18 ✅ |
| M02 Identity & Org | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 54/54 ✅ | ✅ | ✅ | — | 9/9 ✅ |
| M03 Authorization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 17/17 ✅ | ✅ | ❌ | — | 6/6 ✅ |
| M04 Audit & Compliance Log | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 13/13 ✅ | ✅ | ✅ | — | 9/9 ✅ |
| M05 Patient & Demographics | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 44/44 ✅ | ✅ | ✅ | — | 18/18 ✅ |
| M06 Admission, Election & Certification | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 87/87 ✅ | ✅ | ✅ | — | 16/16 ✅ |
| M07 Care Plan (IPOC) | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 25/25 ✅ | ✅ | ✅ | — | 9/9 ✅ |
| M08 Encounters & Visit Notes | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 39/39 ✅ | ✅ | ✅ | — | 10/10 ✅ |
| M09 Clinical Assessments Suite | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 20/20 ✅ | ✅ | ✅ | — | 6/6 ✅ |
| M10 HOPE Engine | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 29/29 ✅ | ✅ | ✅ | ✅ | 13/13 ✅ |
| M11 Orders | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 34/34 ✅ | ✅ | ✅ | — | 10/10 ✅ |
| M12 DoseSpot Integration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 34/34 ✅ | ✅ | ✅ | ✅ | 14/14 ✅ |
| M13 eMAR & Med Administration | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 28/28 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M14 IDG | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 39/39 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M15 Discipline Care Plans | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 28/28 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M16 Bereavement | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 34/34 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M17 Scheduling & Route Optimization | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 38/38 ✅ | ✅ | ✅ | ✅ | 8/9 ⚠️ |
| M18 EVV | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 26/26 ✅ | ✅ | ✅ | — | 8/8 ✅ |
| M19 On-Call Triage | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 40/40 ✅ | ✅ | ✅ | ✅ | 11/12 ⚠️ |
| M20 Field Safety | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 33/33 ✅ | ✅ | ✅ | — | 14/14 ✅ |
| M21 Supplies, DME & Comfort Kits | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 40/40 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M22 Document Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 58/58 ✅ | ✅ | ✅ | — | 21/21 ✅ |
| M23 Billing — Medicare | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 90/90 ✅ | ✅ | ✅ | ✅ | 29/29 ✅ |
| M24 Billing — Medicaid | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 39/39 ✅ | ✅ | ✅ | ✅ | 16/16 ✅ |
| M25 Remittance & Denials | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 82/82 ✅ | ✅ | ✅ | ✅ | 23/23 ✅ |
| M26 Cap Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 27/27 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M27 Cost Report | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 45/45 ✅ | ✅ | ✅ | ✅ | 15/15 ✅ |
| M28 FHIR Gateway | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 35/35 ✅ | ❌ | ✅ | — | 9/9 ✅ |
| M29 External Interfaces | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 33/33 ✅ | ❌ | ✅ | — | 12/12 ✅ |
| M30 HQRP & Quality | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 63/63 ✅ | ✅ | ✅ | ✅ | 19/19 ✅ |
| M31 Patient/Family Portal & Telehealth | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 59/59 ✅ | ✅ | ✅ | ✅ | 6/6 ✅ |
| M32 AI Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 32/32 ✅ | ✅ | ✅ | — | 13/13 ✅ |
| M33 Reporting & Dashboards | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 42/42 ✅ | ✅ | ✅ | — | 12/12 ✅ |
| M34 SaaS Tenant Platform | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 58/58 ✅ | ✅ | ✅ | — | 17/17 ✅ |
| M35 Subscription Billing | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 54/54 ✅ | ✅ | ✅ | — | 21/21 ✅ |
| M36 Secure Messaging & Alerts | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 127/127 ✅ | ✅ | ✅ | — | 47/47 ✅ |
| M37 Inpatient Unit (IPU) Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 52/52 ✅ | ✅ | ✅ | — | 27/27 ✅ |
| M38 Clinical Terminology Service | 🟢 Implemented | ✅ | ✅ | ❌ | ✅ | 19/19 ✅ | ✅ | ✅ | — | 22/22 ✅ |
| M39 Consent & Authorization Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 27/27 ✅ | ✅ | ✅ | — | 11/11 ✅ |
| M40 Master Data Management | 🟢 Implemented | ✅ | ✅ | ✅ | ✅ | 25/25 ✅ | ✅ | ✅ | — | 14/14 ✅ |

## Hard-fail consistency checks

- ✅ No orphan schema/migration tables (every defined table is owned by a module).
