# WardenX — Inject-Suite (HTTP-layer) Coverage

> **Generated** (`bun run inject:coverage`). Do not hand-edit — `arch:inject-coverage` (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

A module's pure-function permission/ABAC tests prove its DECISIONS are correct; they prove nothing about the route wiring, schema validation, or service composition around them (the M30 dead-`inOrg` class, the Claim Workbench 404). `covered` requires a real Fastify `.inject()` call through the module's route registrar.

**Totals:** 39/39 modules covered (100%) · 1218/1218 route defs sit behind a covered module · 1159/1218 route defs are directly referenced by path in a covering suite (TEST-002 — approximate, advisory, not ratcheted; see the directRoutesReferenced field's doc comment in this script for its limits)

| Module | Routes | Covered | Direct refs | Suite file(s) |
|---|--:|:--:|--:|---|
| 02-identity | 17 | ✅ | 17/17 | apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/audit-routes.test.ts, apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-routes.test.ts, apps/backend/__tests__/authz-validation.test.ts, apps/backend/__tests__/identity-routes.test.ts, apps/backend/__tests__/session-step-up.test.ts |
| 03-authorization | 17 | ✅ | 16/17 | apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-routes.test.ts, apps/backend/__tests__/authz-validation.test.ts, apps/backend/__tests__/encounter-authoring.test.ts, apps/backend/__tests__/encounter-routes.test.ts |
| 04-audit | 4 | ✅ | 4/4 | apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/audit-routes.test.ts |
| 05-patient | 14 | ✅ | 14/14 | apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/patient-routes.test.ts |
| 06-admission | 48 | ✅ | 48/48 | apps/backend/__tests__/admission-certification.test.ts, apps/backend/__tests__/admission-discharge.test.ts, apps/backend/__tests__/admission-intake.test.ts, apps/backend/__tests__/admission-routes.test.ts |
| 07-care-plan | 19 | ✅ | 18/19 | apps/backend/__tests__/care-plan-conformance.live.test.ts, apps/backend/__tests__/care-plan-routes.test.ts |
| 08-encounters | 31 | ✅ | 26/31 | apps/backend/__tests__/encounter-authoring.test.ts, apps/backend/__tests__/encounter-routes.test.ts |
| 09-assessments | 18 | ✅ | 13/18 | apps/backend/__tests__/assessment-routes.test.ts |
| 10-hope | 20 | ✅ | 16/20 | apps/backend/__tests__/hope-routes.test.ts |
| 11-orders | 28 | ✅ | 22/28 | apps/backend/__tests__/orders-routes.test.ts |
| 12-dosespot | 31 | ✅ | 19/31 | apps/backend/__tests__/dosespot-routes.test.ts |
| 13-emar | 28 | ✅ | 16/28 | apps/backend/__tests__/emar-caregiver-barcode.test.ts, apps/backend/__tests__/emar-routes.test.ts |
| 14-idg | 27 | ✅ | 27/27 | apps/backend/__tests__/idg-inject.test.ts |
| 15-discipline-care-plans | 28 | ✅ | 28/28 | apps/backend/__tests__/discipline-plans-inject.test.ts |
| 16-bereavement | 33 | ✅ | 33/33 | apps/backend/__tests__/bereavement-inject.test.ts |
| 17-scheduling | 29 | ✅ | 29/29 | apps/backend/__tests__/scheduling-inject.test.ts |
| 18-evv | 25 | ✅ | 25/25 | apps/backend/__tests__/evv-inject.test.ts |
| 19-oncall | 38 | ✅ | 38/38 | apps/backend/__tests__/oncall-inject.test.ts |
| 20-field-safety | 30 | ✅ | 30/30 | apps/backend/__tests__/field-safety-inject.test.ts |
| 21-supplies | 37 | ✅ | 37/37 | apps/backend/__tests__/supplies-inject.test.ts |
| 22-documents | 38 | ✅ | 30/38 | apps/backend/__tests__/document-doclens.test.ts, apps/backend/__tests__/document-routes.test.ts, apps/backend/__tests__/document-workflow-acceptance.test.ts |
| 23-billing-medicare | 43 | ✅ | 43/43 | apps/backend/__tests__/billing-medicare-inject.test.ts |
| 24-billing-medicaid | 39 | ✅ | 39/39 | apps/backend/__tests__/billing-medicaid-inject.test.ts |
| 25-remittance | 31 | ✅ | 31/31 | apps/backend/__tests__/remittance-inject.test.ts |
| 26-cap | 27 | ✅ | 27/27 | apps/backend/__tests__/cap-inject.test.ts |
| 27-cost-report | 45 | ✅ | 45/45 | apps/backend/__tests__/cost-report-inject.test.ts |
| 28-fhir | 35 | ✅ | 35/35 | apps/backend/__tests__/fhir-inject.test.ts |
| 29-external-interfaces | 33 | ✅ | 33/33 | apps/backend/__tests__/external-interfaces-inject.test.ts |
| 30-quality | 60 | ✅ | 60/60 | apps/backend/__tests__/quality-inject.test.ts |
| 31-portal | 53 | ✅ | 53/53 | apps/backend/__tests__/portal-inject.test.ts |
| 32-ai-platform | 32 | ✅ | 32/32 | apps/backend/__tests__/ai-platform-inject.test.ts |
| 33-reporting | 42 | ✅ | 42/42 | apps/backend/__tests__/reporting-inject.test.ts |
| 34-saas-tenant-platform | 48 | ✅ | 48/48 | apps/backend/__tests__/saas-tenant-platform-inject.test.ts |
| 35-subscription | 54 | ✅ | 54/54 | apps/backend/__tests__/subscription-inject.test.ts |
| 36-messaging | 22 | ✅ | 21/22 | apps/backend/__tests__/messaging-routes-mount.test.ts, apps/backend/__tests__/messaging-routes.test.ts, apps/backend/__tests__/messaging-webhooks.test.ts |
| 37-ipu | 45 | ✅ | 45/45 | apps/backend/__tests__/ipu-inject.test.ts |
| 38-terminology | 8 | ✅ | 8/8 | apps/backend/__tests__/terminology-routes-mount.test.ts, apps/backend/__tests__/terminology-routes.test.ts |
| 39-consent | 27 | ✅ | 27/27 | apps/backend/__tests__/consent-routes-mount.test.ts, apps/backend/__tests__/consent-routes.test.ts, apps/backend/__tests__/consent-surface.test.ts |
| 40-mdm | 14 | ✅ | 10/14 | apps/backend/__tests__/mdm-routes-mount.test.ts, apps/backend/__tests__/mdm-routes.test.ts |
