# 00 — Repository inventory

## Baseline architecture

ChartWarden is a Bun workspace monorepo containing four applications (`backend`, `web`, `admin`,
`portal`), 49 packages, a Python Docling/OCR service, 41 manifest modules, 603 SQL migrations, and
deployment/architecture-fitness tooling. TypeScript project references build the monorepo; Vite and
React power the three SPAs; Fastify/TypeBox/OpenAPI provide the HTTP layer; Drizzle/PostgreSQL with
RLS provides persistence; Better Auth provides identity; BullMQ/Valkey provides queues; Socket.IO
provides real-time transport; MinIO provides object storage. Vitest covers unit/live tests and
Playwright/axe supplies browser/accessibility tests. GitHub Actions and Docker Compose define CI and
the single-host production topology.

Authoritative generated inventories: `architecture/module-manifest.ts`,
`audit/implementation-status/IMPLEMENTATION_STATUS.md`, `audit/ui-parity/UI_PARITY.md`,
`audit/openapi-coverage/`, and `audit/e2e-coverage/E2E_COVERAGE.md`. “Implemented” below means the
generated structural heuristic, not audited workflow completeness.

| Module | Purpose | Frontend | Backend | Database | Tests | Status |
|---|---|---|---|---|---|---|
| M01 Foundation | tenancy, orgs, outbox, platform | shell | bootstrap | owned schema/RLS | live baseline | Implemented; targeted live pass |
| M02 Identity & Org | sessions, MFA, invitations, auditors | web | routes/services | owned | unit/live | Implemented; targeted live pass |
| M03 Authorization | RBAC, ABAC, break-glass | web | guards/routes | owned | unit/live | Implemented; broad runtime not complete |
| M04 Audit & Compliance Log | audit, holds, disclosure | web | routes/services | owned | unit/live | Implemented; operational evidence unverified |
| M05 Patient & Demographics | patient, coverage, caregivers | web | routes/seams | owned | unit/live | Implemented; payer defect CW-QA-0001 |
| M06 Admission, Election & Certification | hospice lifecycle entry | web | routes/services | owned | unit/live | Implemented; targeted live pass |
| M07 Care Plan (IPOC) | plan-of-care management | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M08 Encounters & Visit Notes | notes, signatures, addenda | web | routes/services | owned | unit/live | Implemented; privacy risk CW-QA-0014 |
| M09 Clinical Assessments Suite | assessments/scales | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M10 HOPE Engine | HOPE capture/validation/submission | web | routes/engine | owned | unit/live | Implemented; CW-QA-0006/0015 |
| M11 Orders | orders/results/transmission | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M12 DoseSpot Integration | prescribing/eRx | web | adapter/routes | owned | unit/live | Implemented; vendor sandbox blocked |
| M13 eMAR & Med Administration | medication administration | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M14 IDG | interdisciplinary group workflow | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M15 Discipline Care Plans | discipline/volunteer plans | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M16 Bereavement | eligibility/caseload/follow-up | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M17 Scheduling & Route Optimization | visits/routes/rotation | web | routes/adapter | owned | unit/live | One table unproven; CW-QA-0016 |
| M18 EVV | visit verification | web | routes/services | owned | unit/live | Implemented; aggregator runtime blocked |
| M19 On-Call Triage | triage/roster/escalation | web | routes/adapter | owned | unit/live | Implemented; runtime unverified here |
| M20 Field Safety | SOS/check-ins/incidents | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M21 Supplies, DME & Comfort Kits | inventory/dispatch/returns | web | routes/services | owned | unit/live | Implemented; runtime unverified here |
| M22 Document Management | intake/forms/storage/DocLens | web | routes/services | owned | unit/live | Worker risks CW-QA-0009/0010 |
| M23 Billing — Medicare | notices/claims/DDE/rates | web | routes/workers | owned | unit/live | P1 defect CW-QA-0001 |
| M24 Billing — Medicaid | Medicaid claims/adapters | web | routes/adapter | owned | unit/live | State/vendor breadth unverified |
| M25 Remittance & Denials | 835/payments/denials/appeals | web | routes/workers | owned | unit/live | Targeted live pass |
| M26 Cap Management | cap projections/settlements | web | routes/services | owned | unit/live | Runtime unverified here |
| M27 Cost Report | cost reporting | web | routes/adapter | owned | unit/live | Runtime unverified here |
| M28 FHIR Gateway | FHIR interface | none | routes/services | owned | unit/live | Headless; external conformance blocked |
| M29 External Interfaces | HL7/lab/interface engine | none | routes/services | owned | unit/live | Headless; external endpoints blocked |
| M30 HQRP & Quality | quality measures/submission | web | routes/adapter | owned | unit/live | CMS submission blocked |
| M31 Portal & Telehealth | patient/family portal | portal/web | routes/adapter | owned | unit/live | Portal browser run blocked |
| M32 AI Platform | governed AI routing/invocation | web | routes/services | owned | unit/live | Vendor runtime blocked |
| M33 Reporting & Dashboards | reports/schedules/materialized data | web | routes/services | owned | unit/live | Scale unverified |
| M34 SaaS Tenant Platform | onboarding/tenant administration | web/admin | routes/services | owned | unit/live | Runtime unverified here |
| M35 Subscription Billing | tenant subscription billing | web | Stripe routes | owned | unit/live | Vendor runtime blocked |
| M36 Secure Messaging & Alerts | messaging/alerts/export/retention | web | routes/workers | owned | unit/live | Demo restore only |
| M37 IPU Management | inpatient units/census | web | routes/services | owned | unit/live | Runtime unverified here |
| M38 Clinical Terminology Service | terminology/value sets | web | API/package | owned | unit/live | Matrix route heuristic conflicts |
| M39 Consent & Authorization | consents/authorizations | web | routes/services | owned | unit/live | Runtime unverified here |
| M40 Master Data Management | provider/discipline master data | web | routes/services | owned | unit/live | Runtime unverified here |
| M41 Billing — Commercial | commercial claims/enrollment/remittance | web | routes/services | owned | unit/live | Structural implementation; guide conflict |

## Inventory risks

- Payer-period semantics are split between M5 and M23 (`CW-QA-0001`); narrative and generated
  status disagree (`CW-QA-0018`).
- Architecture reachability passed for route registrars, but no whole-program dead-code proof was
  available. No package was labeled unused solely because a textual import search found none.
- Vendor adapters and external submissions were not exercised and remain unverified.
- Bun advisory checks found no high-or-higher match; maintenance, license, and Python-lock analysis
  are separate in report 24.
- Dependency-cruiser passed; runtime coupling remains through seams, events, queues, and shared
  status/date semantics.
