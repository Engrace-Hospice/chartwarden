# Screen and UI Inventory

## Canonical Inventory

The complete machine-checked inventory is `audit/ui-parity/UI_PARITY.md`. It lists every screen id, route path, application, module, and required permission. At this revision it contains **271 registered screens**: 244 staff web, 13 portal, and 14 admin, across 37 module screen sets. This report adds functional status, states, and backend conformance that the registry cannot infer.

## Application Inventory

| App | Routes | Persona | Purpose | Data source | Structural status | Functional qualification |
|---|---:|---|---|---|---|---|
| Staff web | 244 | Clinical, intake, revenue, quality, org admin | Full EHR operating surface | Generated OpenAPI client | Reachable/permission-resolved | Mixed; critical backend and write gaps below |
| Portal | 13 | Patient/family/bereaved | Portal home, records, messages, visits, telehealth | M31 APIs | Reachable/permission-resolved | No browser E2E; seam casts and provider states need verification |
| Admin | 14 | Platform operator/security/billing admin | Tenants, support, feature flags, keys, exports, subscription | M34/M35 platform APIs | Reachable/permission-resolved | Tenant operations workers incomplete |

## Module Screen Status

| Modules / area | Existing screen surface | Implemented states | Missing or misleading states | Status |
|---|---|---|---|---|
| M2-M6 identity/audit/patient/admission | Login/MFA/reset/org select/staff/roles/audit/census/chart/referrals/admissions | Loading/error/empty patterns vary; auth utility states exist | Browser authorization/session-expiry workflow tests | Functionally broad, unverified E2E |
| M7-M18 clinical | Care plan, encounters, assessments, HOPE, orders, medications/eMAR, IDG, discipline, bereavement, schedule, EVV | Large read/worklist surface | Several frame-mapped DTO/write placeholders; no complete cross-module browser journeys | Partial to functionally complete |
| M19-M21 field/ops | Triage, on-call, safety, supplies | Dense worklists/detail/admin | Vendor/provider outage and offline/recovery E2E | Partial |
| M22 documents | Explorer, patient list, history, intake, templates | Read/empty surfaces | Real upload progress, digest, content download, interruption/retry | **Backend misleading; production blocker** |
| M23 Medicare | 18 billing screens | Claims/worklists/config/status views | Capability unavailable, executable submit/ack, durable job retry | **Backend missing** |
| M24 Medicaid | 16 billing screens | Claims/config/trading partner UI | Launch-state adapter unavailable/retry | **Backend missing** |
| M25-M27 revenue | Remittance/denials/cap/cost report screens | Broad records/workbenches | 835 ingest and cost-report worker completion | **Partial/backend missing** |
| M28-M29 integrations | Admin/API integration screens are registered outside status heuristics where applicable | Config/read surfaces | Contract response schemas and operational readiness | Partial |
| M30 quality | Quality hub and incidents | Read/workbench surface | CAHPS/export/recompute provider failure/retry | **Partial/backend missing** |
| M31 portal | 13 portal routes | Portal layouts and domain views | Full provider/telehealth/offline/session recovery E2E | Partial |
| M32 AI | AI admin/capability route surface | Disabled/shell posture | Real provider config, provenance, run/failure/cost views | Phase-1 shell |
| M33 reporting | Catalog, dashboard, schedules, admin | Read/config surfaces | Live scheduled render/delivery, progress, retry | **Partial/backend missing** |
| M34 platform | Tenant/support/key/export/feature flag screens | Platform operations UI | Operations preflight, reliable job progress/retry; workers incomplete | **Backend missing** |
| M35 subscription | Billing overview/plan/invoices/payment/dunning/promo/usage | Commercial UI | 15 mutation contracts absent; lint defect in service | Partial |
| M36-M40 | Messaging, IPU, terminology, consent, MDM | Broad read/workbench surface | M39 capture lifecycle; some M36 auto-sync/M40 canonical writes | Mixed; M39 blocker |

## System and Operational States

| State | Existing evidence | Gap |
|---|---|---|
| 404 / 403 / 500 | Matched system utility frames | Preserve correlation/support context |
| Offline / maintenance / session expired / suspended | Registered utility pages | No browser connectivity transition suite |
| Loading / empty / error | Shared patterns and per-screen implementations | Registry does not enforce all states; behavioral inventory must be added |
| Permission denied | Chromed-route guard plus utility page | Workflow-specific reason/recovery not consistently tested |
| Step-up | Dedicated route and ceremonies | End-to-end focus/session-return coverage incomplete |
| Provider unavailable / rate limited | Some API error mappings | No canonical capability banner and recovery across integrations |
| Job queued/running/failed/cancelled/partial | Domain ledgers exist | No canonical cross-workflow job detail/retry/resume UI |
| Unsaved changes | Per-form behavior | No common blocker/coverage inventory |

## Unreachable, Duplicate, and Obsolete Assessment

- UI parity found no duplicate route/screen ids, unknown permissions, or unwired `screens.ts` registries.
- Structural reachability does not prove navigation discoverability. Navigation-to-route parity should become a separate report.
- M39’s capture flow is not merely inaccessible: no capture screen exists and backend writes throw.
- M22’s “upload” API exists but is semantically incomplete; UI must not present it as a completed upload.
- Frame registry covers 17/271 screens only. “Unmapped” is not “obsolete,” but visual conformance is unknown.

## Completeness Rule

No screen in this audit is called complete solely because it appears in `screens.ts`. Production completion requires route, navigation/workflow transition, permission denial, loading/empty/error/success, real backend integration, responsive/keyboard behavior, and risk-appropriate tests. That evidence is currently absent for most of the 271-screen surface.
