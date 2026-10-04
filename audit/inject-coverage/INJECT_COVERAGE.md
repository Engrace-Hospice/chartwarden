# WardenX — Inject-Suite (HTTP-layer) Coverage

> **Generated** (`bun run inject:coverage`). Do not hand-edit — `arch:inject-coverage` (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.

A module's pure-function permission/ABAC tests prove its DECISIONS are correct; they prove nothing about the route wiring, schema validation, or service composition around them (the M30 dead-`inOrg` class, the Claim Workbench 404). `covered` requires a real Fastify `.inject()` call through the module's route registrar.

**Totals:** 39/39 modules covered (100%) · 1359/1359 route defs sit behind a covered module · 1306/1359 route defs are directly referenced by path in a covering suite (TEST-002 — approximate, advisory, not ratcheted; see the directRoutesReferenced field's doc comment in this script for its limits)

| Module | Routes | Covered | Direct refs | Suite file(s) |
|---|--:|:--:|--:|---|
| 02-identity | 25 | ✅ | 24/25 | apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/audit-routes.test.ts, apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-routes.test.ts, apps/backend/__tests__/authz-validation.test.ts, apps/backend/__tests__/device-attestation-routes.test.ts, apps/backend/__tests__/identity-routes.test.ts, apps/backend/__tests__/session-step-up.test.ts, apps/backend/__tests__/step-up-mount.test.ts |
| 03-authorization | 17 | ✅ | 16/17 | apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/authz-idor.test.ts, apps/backend/__tests__/authz-routes.test.ts, apps/backend/__tests__/authz-validation.test.ts |
| 04-audit | 13 | ✅ | 13/13 | apps/backend/__tests__/audit-accounting.test.ts, apps/backend/__tests__/audit-routes-mount.test.ts, apps/backend/__tests__/audit-routes.test.ts, apps/backend/__tests__/gap-003-compliance-routes-mount.test.ts, apps/backend/__tests__/gap-003-compliance-routes.live.test.ts |
| 05-patient | 23 | ✅ | 23/23 | apps/backend/__tests__/auth.live.test.ts, apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts, apps/backend/__tests__/gap-030-visit-create-abac.live.test.ts, apps/backend/__tests__/gap-093-membership-credential-live.test.ts, apps/backend/__tests__/m12-vendor-boundary.live.test.ts, apps/backend/__tests__/m28-fhir-gateway.live.test.ts, apps/backend/__tests__/m5-privacy-officer.test.ts, apps/backend/__tests__/patient-routes.test.ts |
| 06-admission | 68 | ✅ | 68/68 | apps/backend/__tests__/admission-certification.test.ts, apps/backend/__tests__/admission-discharge.test.ts, apps/backend/__tests__/admission-intake.test.ts, apps/backend/__tests__/admission-routes.test.ts |
| 07-care-plan | 25 | ✅ | 24/25 | apps/backend/__tests__/assessment-routes.test.ts, apps/backend/__tests__/care-plan-conformance.live.test.ts, apps/backend/__tests__/care-plan-routes.test.ts, apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts, apps/backend/__tests__/f238-problem-proposal-routes.test.ts, apps/backend/__tests__/gap-013-care-plan-consent-wiring.live.test.ts, apps/backend/__tests__/patient-routes.test.ts |
| 08-encounters | 37 | ✅ | 33/37 | apps/backend/__tests__/encounter-authoring.test.ts, apps/backend/__tests__/encounter-routes.test.ts |
| 09-assessments | 20 | ✅ | 15/20 | apps/backend/__tests__/assessment-routes.test.ts, apps/backend/__tests__/m9-assessments-write.live.test.ts |
| 10-hope | 29 | ✅ | 27/29 | apps/backend/__tests__/hope-routes.test.ts |
| 11-orders | 34 | ✅ | 27/34 | apps/backend/__tests__/orders-routes.test.ts, apps/backend/__tests__/orm-recovery.test.ts, apps/backend/__tests__/orm-resend.test.ts, apps/backend/__tests__/stuck-recovery.test.ts |
| 12-dosespot | 32 | ✅ | 23/32 | apps/backend/__tests__/dosespot-routes.test.ts, apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts, apps/backend/__tests__/m12-f230-vendor-boundary-unit.test.ts, apps/backend/__tests__/m12-vendor-boundary.live.test.ts |
| 13-emar | 28 | ✅ | 19/28 | apps/backend/__tests__/emar-caregiver-barcode.test.ts, apps/backend/__tests__/emar-routes.test.ts |
| 14-idg | 36 | ✅ | 36/36 | apps/backend/__tests__/idg-discipline-notes.test.ts, apps/backend/__tests__/idg-enrichment.test.ts, apps/backend/__tests__/idg-inject.test.ts, apps/backend/__tests__/idg-packet-content.test.ts, apps/backend/__tests__/idg-routes.test.ts, apps/backend/__tests__/idg-schedule-meeting.test.ts, apps/backend/__tests__/m12-f230-vendor-boundary-unit.test.ts |
| 15-discipline-care-plans | 28 | ✅ | 28/28 | apps/backend/__tests__/discipline-plans-inject.test.ts |
| 16-bereavement | 33 | ✅ | 33/33 | apps/backend/__tests__/bereavement-inject.test.ts |
| 17-scheduling | 33 | ✅ | 33/33 | apps/backend/__tests__/gap-030-visit-create-abac.live.test.ts, apps/backend/__tests__/gap-093-membership-credential-live.test.ts, apps/backend/__tests__/scheduling-inject.test.ts |
| 18-evv | 25 | ✅ | 25/25 | apps/backend/__tests__/evv-inject.test.ts |
| 19-oncall | 40 | ✅ | 39/40 | apps/backend/__tests__/oncall-inject.test.ts |
| 20-field-safety | 30 | ✅ | 30/30 | apps/backend/__tests__/field-safety-inject.test.ts |
| 21-supplies | 38 | ✅ | 38/38 | apps/backend/__tests__/supplies-inject.test.ts |
| 22-documents | 57 | ✅ | 52/57 | apps/backend/__tests__/document-doclens.test.ts, apps/backend/__tests__/document-routes.test.ts, apps/backend/__tests__/document-workflow-acceptance.test.ts, apps/backend/__tests__/f225-portal-document-access-log.live.test.ts, apps/backend/__tests__/f238-doclens-clinical-writeback.live.test.ts, apps/backend/__tests__/f238-pending-address.test.ts, apps/backend/__tests__/f238-prospect-summary.test.ts, apps/backend/__tests__/f238-records-request-expiry.test.ts, apps/backend/__tests__/f238-records-request.test.ts |
| 23-billing-medicare | 56 | ✅ | 55/56 | apps/backend/__tests__/billing-medicare-inject.test.ts, apps/backend/__tests__/m23-rate-table-routes.test.ts, apps/backend/__tests__/m23-sequestration-policy-routes.test.ts, apps/backend/__tests__/m23-wage-index-routes.test.ts |
| 24-billing-medicaid | 39 | ✅ | 39/39 | apps/backend/__tests__/billing-medicaid-inject.test.ts |
| 25-remittance | 32 | ✅ | 31/32 | apps/backend/__tests__/remittance-inject.test.ts |
| 26-cap | 27 | ✅ | 27/27 | apps/backend/__tests__/cap-inject.test.ts, apps/backend/__tests__/gap-079-read-audit-emission.live.test.ts |
| 27-cost-report | 45 | ✅ | 45/45 | apps/backend/__tests__/cost-report-inject.test.ts |
| 28-fhir | 35 | ✅ | 35/35 | apps/backend/__tests__/fhir-inject.test.ts, apps/backend/__tests__/m28-fhir-gateway.live.test.ts |
| 29-external-interfaces | 33 | ✅ | 33/33 | apps/backend/__tests__/external-interfaces-inject.test.ts |
| 30-quality | 60 | ✅ | 60/60 | apps/backend/__tests__/quality-inject.test.ts |
| 31-portal | 53 | ✅ | 53/53 | apps/backend/__tests__/f225-portal-document-access-log.live.test.ts, apps/backend/__tests__/portal-inject.test.ts |
| 32-ai-platform | 32 | ✅ | 32/32 | apps/backend/__tests__/ai-platform-inject.test.ts |
| 33-reporting | 42 | ✅ | 42/42 | apps/backend/__tests__/reporting-inject.test.ts |
| 34-saas-tenant-platform | 50 | ✅ | 49/50 | apps/backend/__tests__/saas-tenant-platform-inject.test.ts |
| 35-subscription | 54 | ✅ | 54/54 | apps/backend/__tests__/subscription-inject.test.ts |
| 36-messaging | 23 | ✅ | 22/23 | apps/backend/__tests__/messaging-routes-mount.test.ts, apps/backend/__tests__/messaging-routes.test.ts, apps/backend/__tests__/messaging-webhooks.test.ts |
| 37-ipu | 52 | ✅ | 52/52 | apps/backend/__tests__/ipu-inject.test.ts |
| 38-terminology | 14 | ✅ | 14/14 | apps/backend/__tests__/terminology-admin-routes.test.ts, apps/backend/__tests__/terminology-routes-mount.test.ts, apps/backend/__tests__/terminology-routes.test.ts |
| 39-consent | 27 | ✅ | 27/27 | apps/backend/__tests__/consent-routes-mount.test.ts, apps/backend/__tests__/consent-routes.test.ts, apps/backend/__tests__/consent-surface.test.ts, apps/backend/__tests__/gap-013-care-plan-consent-wiring.live.test.ts, apps/backend/__tests__/gap-079-read-audit-emission.live.test.ts |
| 40-mdm | 14 | ✅ | 10/14 | apps/backend/__tests__/mdm-routes-mount.test.ts, apps/backend/__tests__/mdm-routes.test.ts |
