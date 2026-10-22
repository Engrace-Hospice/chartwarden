# Workflow Conformance Report

## Persona Inventory

| Persona | Primary workflows |
|---|---|
| Clinician / hospice aide | Census, chart, assessments, care plan, orders, encounters, eMAR, IDG, documents |
| Intake / admissions | Referrals, election/certification, admission/discharge, document intake |
| Biller / revenue manager | Medicare, Medicaid, remittance/denials, cap, cost report |
| Quality / compliance / privacy | HOPE/HQRP, QAPI/CAHPS, audit, consent, incidents, reporting |
| Field / on-call staff | Scheduling, EVV, triage, safety, supplies |
| Patient / caregiver | Portal records, messaging, telehealth, forms/consent-related views |
| Organization administrator | Members, roles, settings, integrations, subscription, credentials |
| Platform operator / security owner | Tenant lifecycle, support, feature flags, keys, exports, destruction |

## Workflow Matrix

| Workflow | Persona | Trigger / preconditions | Main path | Alternate/failure paths | Completion state | Missing elements / status |
|---|---|---|---|---|---|---|
| Sign in and select organization | Staff | Valid account/membership | Better Auth -> org session -> guarded SPA | Reset, TOTP, passkey, invalid org | Active org-bound session | Live-tested; browser E2E missing; Conditional complete |
| Admit patient | Intake | Permission, patient facts | Form -> M6 route -> DB/outbox -> census | Dedup/MBI conflict, validation | Active admission | API/live integration evidence present; browser failure paths unverified |
| Document upload | Intake/clinician | Patient/document metadata | UI/API creates document/version | No real byte transfer/download | Metadata row only | **Broken, BUG-001** |
| Capture/revoke consent | Clinician/privacy | Authorized signer/evidence | Intended capture -> sign -> render -> evaluator | Revoke, expire, supersede | Operative immutable consent | **No write implementation/UI, FLOW-003** |
| Medicare submit/ack | Biller | Valid assembled claim/credentials | Route -> enqueue -> X12 -> MAC -> ack -> status | Retry, timeout, reject | Accepted/paid lifecycle | **Fails in worker, FLOW-002** |
| Medicaid submit | Biller | Launch-state credentials/EVV | Claim -> state adapter -> ack | State outage/rate limit | State accepted | **Adapter not wired, FLOW-004** |
| Remittance/denial | Biller | Payer 835 | Receive -> validate -> post -> denial | Duplicate/malformed/partial | Posted and reconciled | **Transport missing, FLOW-005** |
| Quality recompute/CAHPS | Quality manager | Active org/period/vendor | Schedule -> input -> measure/export -> alert | Partial input/vendor failure | Measure/sample result | **Multiple ports unbound, FLOW-006** |
| Scheduled report/export | Manager/compliance | Saved view, entitled recipients | Schedule -> consent recheck -> snapshot -> M22 render/deliver | Recipient revoked, replica lag | Delivered artifact/history | **Worker/render ports unbound, FLOW-006/ARCH-001** |
| Tenant provisioning | Platform operator | Approved signup/account | Enqueue -> key/storage/org/tasks/invite -> active | Retry/compensation | First admin can sign in | **Multiple ports unbound, FLOW-001** |
| Tenant destruction | Security owner | Retention end, certificate, no hold, co-sign | Erasers -> storage -> key shred -> certificate -> destroyed | Part 2 refusal, crash/replay | Audited destroyed tenant | **Multiple ports unbound, FLOW-001** |
| AI-assisted recommendation | Authorized staff | Feature enabled/policy | Capability invocation -> review | Provider unavailable/refusal | Provenanced suggestion | Phase-1 unavailable; AI-001 |

## Detailed Trace: Medicare Submission

Navigation `/billing/claims/:claimId` -> submit action -> route authorization/step-up -> DB state/outbox/job enqueue -> BullMQ M23 processor -> X12 generation -> MAC transport -> acknowledgment polling -> persisted claim/submission -> UI status.

The trace breaks after enqueue: `buildM23WorkerDeps` receives only DB/connection and the transport/application ports throw lazily. The API should not offer or accept submission until runtime capability is green.

## Detailed Trace: Consent

Patient/chart context -> expected “capture consent” action -> signer/evidence form -> authorization + step-up -> draft -> sign -> encrypted evidence -> M22 render -> immutable version -> disclosure evaluator -> record manager/renewal UI.

The first screen/action is absent. Existing record/recipient/renewal screens read data, but all mutation methods throw. Recovery, concurrent revocation, render failure, and offline capture paths therefore do not exist.

## Detailed Trace: Tenant Provision

Platform signup/tenant action -> platform authorization -> enqueue `tenant.provision` -> current-state read -> tenant key ring -> storage prefix -> organization -> onboarding tasks -> first-admin invitation -> lifecycle/outbox -> organization selection/sign-in.

Only key-ring creation and organization seam portions are partly bound. Required surrounding steps throw. A process restart/retry is modeled by pure processors but cannot complete against live ports.

## Experience Principle Violations

| Principle | Violation |
|---|---|
| Long-running actions show progress | Queue-backed actions lack a canonical job detail/progress/retry surface |
| Failures provide recovery | Unbound jobs primarily surface through DLQ/log/metrics, not an actionable user state |
| Leave and resume | Durable ledgers exist, but UI resume is inconsistent for worker-backed workflows |
| Suggestions vs execution | AI is safely unavailable; future UI must retain explicit suggestion/approval boundary |
| Permissions explained | Shared denied pages exist; workflow-specific denied/step-up messaging varies |
| Partial provider failure | Billing/vendor actions are not consistently preflight-disabled by capability |
| Security/cost visible | Step-up is common; AI/provider cost estimates are not a live experience |

## Workflow Priorities

1. Contain false success and silent event loss.
2. Complete tenant lifecycle, documents, consent, and launch payer transports.
3. Complete report/quality/cost dependencies and user-visible retry/resume.
4. Add browser E2E for main, authorization-denied, provider-down, duplicate, cancel, and restart paths.
