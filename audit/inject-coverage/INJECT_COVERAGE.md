# WardenX — Inject-Suite (HTTP-layer) Coverage

> **Generated** (`bun run inject:coverage`). Do not hand-edit — `arch:inject-coverage` (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

A module's pure-function permission/ABAC tests prove its DECISIONS are correct; they prove nothing about the route wiring, schema validation, or service composition around them (the M30 dead-`inOrg` class, the Claim Workbench 404). `covered` requires a real Fastify `.inject()` call through the module's route registrar.

**Totals:** 23/39 modules covered (59%) · 560/1214 route defs sit behind a covered module

| Module | Routes | Covered | Suite file(s) |
|---|--:|:--:|---|
| 02-identity | 17 | ✅ | apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-validation.test.ts, apps/backend/__tests__/session-step-up.test.ts, apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/identity-routes.test.ts, apps/backend/__tests__/audit-routes.test.ts, apps/backend/__tests__/authz-routes.test.ts |
| 03-authorization | 17 | ✅ | apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-validation.test.ts, apps/backend/__tests__/authz-routes.test.ts |
| 04-audit | 4 | ✅ | apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/audit-routes.test.ts |
| 05-patient | 14 | ✅ | apps/backend/__tests__/patient-routes.test.ts |
| 06-admission | 47 | ✅ | apps/backend/__tests__/admission-routes.test.ts, apps/backend/__tests__/admission-intake.test.ts, apps/backend/__tests__/admission-certification.test.ts, apps/backend/__tests__/admission-discharge.test.ts |
| 07-care-plan | 19 | ✅ | apps/backend/__tests__/care-plan-routes.test.ts |
| 08-encounters | 31 | ✅ | apps/backend/__tests__/encounter-routes.test.ts, apps/backend/__tests__/encounter-authoring.test.ts |
| 09-assessments | 18 | ✅ | apps/backend/__tests__/assessment-routes.test.ts |
| 10-hope | 20 | ✅ | apps/backend/__tests__/hope-routes.test.ts |
| 11-orders | 28 | ✅ | apps/backend/__tests__/orders-routes.test.ts |
| 12-dosespot | 31 | ✅ | apps/backend/__tests__/dosespot-routes.test.ts |
| 13-emar | 28 | ✅ | apps/backend/__tests__/emar-caregiver-barcode.test.ts, apps/backend/__tests__/emar-routes.test.ts |
| 14-idg | 27 | ✅ | apps/backend/__tests__/idg-inject.test.ts |
| 15-discipline-care-plans | 28 | ✅ | apps/backend/__tests__/discipline-plans-inject.test.ts |
| 16-bereavement | 33 | ✅ | apps/backend/__tests__/bereavement-inject.test.ts |
| 17-scheduling | 29 | ✅ | apps/backend/__tests__/scheduling-inject.test.ts |
| 18-evv | 25 | ✅ | apps/backend/__tests__/evv-inject.test.ts |
| 19-oncall | 38 | ✅ | apps/backend/__tests__/oncall-inject.test.ts |
| 20-field-safety | 30 | ❌ | — |
| 21-supplies | 37 | ❌ | — |
| 22-documents | 35 | ✅ | apps/backend/__tests__/document-routes.test.ts, apps/backend/__tests__/document-doclens.test.ts, apps/backend/__tests__/document-workflow-acceptance.test.ts |
| 23-billing-medicare | 43 | ❌ | — |
| 24-billing-medicaid | 39 | ❌ | — |
| 25-remittance | 31 | ❌ | — |
| 26-cap | 27 | ❌ | — |
| 27-cost-report | 45 | ❌ | — |
| 28-fhir | 35 | ❌ | — |
| 29-external-interfaces | 33 | ❌ | — |
| 30-quality | 60 | ❌ | — |
| 31-portal | 53 | ❌ | — |
| 32-ai-platform | 32 | ❌ | — |
| 33-reporting | 42 | ❌ | — |
| 34-saas-tenant-platform | 48 | ❌ | — |
| 35-subscription | 54 | ❌ | — |
| 36-messaging | 22 | ✅ | apps/backend/__tests__/messaging-routes.test.ts, apps/backend/__tests__/messaging-routes-mount.test.ts, apps/backend/__tests__/messaging-webhooks.test.ts |
| 37-ipu | 45 | ❌ | — |
| 38-terminology | 8 | ✅ | apps/backend/__tests__/terminology-routes.test.ts, apps/backend/__tests__/terminology-routes-mount.test.ts |
| 39-consent | 27 | ✅ | apps/backend/__tests__/consent-routes-mount.test.ts, apps/backend/__tests__/consent-routes.test.ts, apps/backend/__tests__/consent-surface.test.ts |
| 40-mdm | 14 | ✅ | apps/backend/__tests__/mdm-routes-mount.test.ts, apps/backend/__tests__/mdm-routes.test.ts |
