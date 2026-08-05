# Bugs and Runtime Risks

## Confirmed Defects

## BUG-001 - Document upload returns success without storing document content

- Severity: High
- Priority: P0
- Confidence: Confirmed
- Category: Runtime / data integrity
- Production blocker: Yes
- Affected workflow: New document and new document-version upload
- Affected persona: Intake specialist, clinician, records staff
- Evidence: Routes accept metadata only. DB writes an active version with `byteSize="0"`, `sha256Hex` of 64 zeroes, and a constructed key. User-facing content uses a separately refusing presigner.
- File(s): `apps/backend/src/modules/22-documents/routes/documents-routes.ts:127-205`; `apps/backend/src/modules/22-documents/documents-route-service-db.ts:63-66,443-523`; `apps/backend/src/modules/22-documents/index.ts:39-55`
- Symbol(s): `uploadDocument`, `uploadVersion`, `mountDocumentRoutes`
- Description: A 201 response asserts a durable version that does not exist in object storage.
- Root cause: Metadata CRUD was enabled before upload/presign composition.
- User impact: Users believe a clinical document is on file; it cannot be retrieved.
- Technical impact: Invalid active-version references, misleading retention/history, and difficult later reconciliation.
- Security or data impact: Clinical record incompleteness and false evidence of document custody.
- Recommended remediation: Immediately make the endpoints return 503 until a staged/multipart upload is live; then commit metadata only after verified object persistence.
- Tests required: Real MinIO happy path; failure before/after object put; hash/size mismatch; retry/idempotency; tenant separation; download and shred.
- Dependencies: ARCH-003, PARAM-001.
- Acceptance criteria: A 201 response proves the exact bytes, digest, size, MIME, and object version are durable and authorized retrieval succeeds.

## FLOW-001 - Tenant platform accepts jobs whose required ports are unbound

- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Category: Runtime / SaaS lifecycle
- Production blocker: Yes
- Affected workflow: Tenant provision, key rotation, shred, DSAR/export, onboarding advance
- Affected persona: Platform operator, security officer, new organization administrator
- Evidence: `registerM34Workers` registers seven workers. `buildM34WorkerPorts` injects typed throws for current status, storage prefixes, onboarding tasks, first-admin invitation, provision transition, KEK material, outbox/audit, shred erasers/storage/certificate/lifecycle, DSAR/export, and onboarding ports.
- File(s): `apps/backend/src/index.ts:2502-2524`; `apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts:115-123,133-220,223-294,296-421,459-483`; `apps/backend/src/modules/34-saas-tenant-platform/wiring.ts:94-110`
- Symbol(s): `buildM34WorkerPorts`, `registerM34Workers`, `registerLiveM34Seams`
- Description: Queue producers and workers exist, but normal operations cannot reach completion.
- Root cause: Pure processors and typed ports landed before production adapters; boot intentionally tolerates the gap.
- User impact: New organizations cannot be reliably onboarded; deletion/export/key operations fail after acceptance.
- Technical impact: Partial key-ring records, DLQ entries, and lifecycle states that need manual repair.
- Security or data impact: KMS-backed DEK resolution is unavailable; required data destruction/export obligations cannot be met.
- Recommended remediation: Disable command routes until capability preflight passes; bind and transactionally test every required port in dependency order.
- Tests required: Provision through first login; rotation; legal-hold/refusal shred; DSAR/export; crash/retry/redeploy; audit and outbox assertions.
- Dependencies: M1 object/KMS/outbox, M2 organization/invitation, M4 certificates/audit, M36 delivery.
- Acceptance criteria: Every M34 command completes exactly once with live dependencies or refuses synchronously before enqueue with an actionable error.

## FLOW-002 - Medicare jobs fail after enqueue because payer ports are unbound

- Severity: Critical
- Priority: P0
- Confidence: Confirmed
- Category: Runtime / revenue cycle
- Production blocker: Yes
- Affected workflow: Claim, NOE/NOTR submission and retry; acknowledgments; eligibility
- Affected persona: Biller, revenue-cycle manager
- Evidence: Composition passes only connection and DB. Source names X12 837, MAC portal, HETS, validation, active-org, jurisdiction, outbox, and alert integrations as follow-ups; the port bundle throws `M23WorkerPortUnbound` lazily.
- File(s): `apps/backend/src/index.ts:2675-2703`; `apps/backend/src/modules/23-billing-medicare/jobs/m23-jobs.ts:73-81,338-467,1393-1402`; `packages/x12-837-client/src/client.ts:53-108`
- Symbol(s): `buildM23WorkerDeps`, `buildM23WorkerPorts`, `unboundWorkerPort`
- Description: API acceptance and durable enqueue are not equivalent to an executable claim pipeline.
- Root cause: Worker shells were composed without launch-state payer transports.
- User impact: Claims and notices fail instead of reaching the MAC, risking cash flow and regulatory deadlines.
- Technical impact: Retries cannot repair a missing adapter; acknowledgment polling also fails.
- Security or data impact: Fail-closed transport is safe, but deadline/compliance integrity is unacceptable.
- Recommended remediation: Launch-scope one MAC/X12/HETS path; capability-gate submit actions; bind outbox/audit/alert and idempotent status transitions.
- Tests required: X12 fixture generation; sandbox submit; duplicate/retry; 999/277CA; timeout; MAC outage; deadline escalation.
- Dependencies: M22 confirmation document, M36 alerts, credential/KMS path.
- Acceptance criteria: A submitted sandbox claim traverses generation, transport, acknowledgment, persistence, UI status, and audit without a stub.

## FLOW-003 - Consent lifecycle writes are entirely unavailable

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Workflow / privacy
- Production blocker: Yes
- Affected workflow: Capture, sign, revoke, supersede, renew consent; bereavement outreach consent
- Affected persona: Clinician, privacy officer, patient representative
- Evidence: Routes exist, but DB service delegates every legally operative mutation to `lifecycleNotWired`; web module registers only three read-oriented screens.
- File(s): `apps/backend/src/modules/39-consent/routes/consent-routes.ts:165-269,449-470`; `apps/backend/src/modules/39-consent/consent-store-db.ts:191-196,338-380`; `apps/web/src/modules/39-consent/screens.ts:1-31`
- Symbol(s): `createDbConsentStore`, `lifecycleNotWired`
- Description: Disclosure evaluation can read consent rows, but staff cannot lawfully create or maintain them through WardenX.
- Root cause: Read/evaluator slice landed before evidence capture, signature, encryption, supersession, and render workflow.
- User impact: Required disclosure and outreach workflows are blocked or must occur outside the system.
- Technical impact: UI/backend capability mismatch and no authoritative lifecycle trail.
- Security or data impact: Consent-dependent disclosures correctly fail closed, reducing availability; external workarounds create privacy risk.
- Recommended remediation: Implement the lifecycle service and capture UI together, with step-up, signer authority, immutable evidence, DEK encryption, render/outbox, and revocation propagation.
- Tests required: Lifecycle state machine, concurrent supersede/revoke, expired consent, Part 2, proxy signer, document render, disclosure negative tests.
- Dependencies: M22, M34 KMS, M4 audit, M5 patient relationships.
- Acceptance criteria: An authorized signer completes and revisits an immutable consent; revocation immediately changes disclosure decisions.

## FLOW-004 - Medicaid state adapter and processing worker are not launch-ready

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Runtime / revenue cycle
- Production blocker: Yes for Medicaid launch
- Affected workflow: Eligibility, claim assembly/submission, acknowledgment/remittance, rate lookup
- Affected persona: Medicaid biller
- Evidence: Oregon is the founding adapter but every I/O method throws `ADAPTER_NOT_WIRED`; other states are deny-stubs. No M24 worker set appears in the composition worker runner.
- File(s): `packages/medicaid-adapters/src/oregon/index.ts:1-9,60-88`; `apps/backend/src/modules/24-billing-medicaid/index.ts:1-12`; `apps/backend/src/modules/24-billing-medicaid/routes/write-service-drizzle.ts:1006-1011`
- Symbol(s): Oregon adapter methods, state sandbox test
- Description: Configuration and claim UI exist without an executable state transport.
- Root cause: State-specific infrastructure was deliberately deferred.
- User impact: Medicaid billing cannot complete.
- Technical impact: Credentials and records can exist with no operational consumer.
- Security or data impact: Safe fail-closed behavior, but launch claims would be misleading.
- Recommended remediation: Limit launch geography and bind one end-to-end state adapter before exposing actions.
- Tests required: State sandbox, X12 fixtures, replay, credential rotation, rate limits, outage handling.
- Dependencies: M24 credential encryption, M18 EVV, M25 remittance.
- Acceptance criteria: Launch-state sandbox claim and acknowledgment complete end to end.

## FLOW-005 - Automatic remittance ingestion has no live X12-835 transport

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Runtime / revenue cycle
- Production blocker: Yes for automated remittance
- Affected workflow: ERA ingestion, posting, denial creation
- Affected persona: Biller, denial specialist
- Evidence: Default X12-835 client rejects with `X12_835_WORKER_NOT_WIRED`; M25 registered workers cover aging/deadline crons, not a live ingestion sidecar.
- File(s): `packages/x12-835-client/src/client.ts:18-65`; `packages/x12-835-client/src/types.ts:144-151`; `apps/backend/src/index.ts:2704-2744`
- Symbol(s): `X12_835_WORKER_NOT_WIRED`, M25 worker registration
- Description: The remittance data model/UI cannot receive production ERA payloads through the intended transport.
- Root cause: Parser/client contract landed without sidecar/transport composition.
- User impact: Manual posting or missing denials/reconciliation.
- Technical impact: Revenue state lags payer state.
- Security or data impact: No unsafe parse fallback found; operational completeness fails.
- Recommended remediation: Bind secure fetch/webhook/sidecar, deduplicate by interchange/control identifiers, validate, post transactionally, and expose partial-failure recovery.
- Tests required: 835 fixtures, duplicate delivery, malformed segment, partial posting rollback, cross-tenant identifier collision.
- Dependencies: M23/M24 claims, payer credentials.
- Acceptance criteria: A sandbox 835 creates exactly-once posting and denial outcomes visible in UI.

## FLOW-006 - Cost-report, quality, and reporting workers remain partial compositions

- Severity: High
- Priority: P1
- Confidence: Confirmed
- Category: Runtime / compliance and analytics
- Production blocker: Yes for those claimed capabilities
- Affected workflow: Cost report, HQRP/CAHPS, outbreak/risk refresh, scheduled reports, exports
- Affected persona: CFO/biller, quality manager, compliance officer, manager
- Evidence: M27 defaults outbox/alerts/DEK/Xero/Gusto/statistics ports to throws. M30 lacks processing log, CAHPS decrypt/config, some inputs/emits. M33 lacks report build, consent recheck, render emits, encryption, lag state, and alerts.
- File(s): `apps/backend/src/modules/27-cost-report/jobs/m27-jobs.ts:303-425`; `apps/backend/src/modules/30-quality/jobs/m30-jobs.ts:731-1093`; `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts:105-398`; `apps/backend/src/index.ts:2526-2674`
- Symbol(s): `buildM27WorkerPorts`, `buildM30WorkerPorts`, `buildM33WorkerPorts`
- Description: Read/configuration screens and pure calculators exist, but scheduled/queued main paths fail on missing cross-module infrastructure.
- Root cause: Broad feature scaffolds were marked implemented before integration binding.
- User impact: Reports, measures, samples, alerts, and filings fail or remain stale.
- Technical impact: Repeated DLQ and incomplete projections.
- Security or data impact: Encryption/consent ports fail closed, which is correct but prevents service.
- Recommended remediation: Select launch workflows, bind their full dependency graphs, and keep non-launch features disabled and visibly unavailable.
- Tests required: Per-workflow live job, source snapshot, crash/retry, outbox, consent, encryption, delivery, and UI resume.
- Dependencies: ARCH-001/002, M34 keys, M36, M22.
- Acceptance criteria: Enabled jobs have no unbound ports and finish from production-shaped inputs.

## Probable Runtime Risks

| Finding | Confidence | Risk | Evidence / test needed |
|---|---|---|---|
| TYPE-001 | High confidence | Seam/DTO assertion hides producer drift | Compile/runtime schema parity tests |
| PERF-001 | Confirmed configuration, impact unmeasured | Public source maps and portal/admin single main bundles increase exposure/load | Artifact policy and performance budget |
| OPS-004 | Confirmed gap | Operators cannot correlate a request across external adapters without distributed traces | Instrument and exercise an end-to-end trace |
| TEST-002 | Confirmed metric behavior | Inject “coverage” counts a whole module when any route suite exists | Route-level behavior matrix |

No destructive fault injection, payer transmission, real email/SMS, or production KMS operation was performed.
