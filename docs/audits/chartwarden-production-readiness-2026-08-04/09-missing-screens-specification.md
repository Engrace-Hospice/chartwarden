# Missing Screens Specification

Only workflow-required screens are proposed. Backend completion is a prerequisite where noted; these screens must not paper over an unavailable service.

## Consent Capture and Signature

- Proposed route: `/patients/:patientId/consents/new`
- Persona: Clinician, privacy officer, authorized representative
- Workflow: FLOW-003 consent capture
- Purpose: Create, review, sign, and render a legally operative consent with signer authority and evidence.
- Preconditions: Active patient, signer relationship, `consent.create`, recent step-up where required, live KMS and document renderer.
- Required data: Patient/representative identity, purpose, data categories, recipients, effective/expiry dates, evidence method, disclosures.
- Required API support: Draft create/update, validate, sign, render status, signer-authority lookup.
- Primary action: Sign consent.
- Secondary actions: Save draft, cancel, preview, change signer.
- Permissions: M39 consent create/sign plus patient scope and ABAC.
- Loading state: Load patient, signer, policy, and template independently with retry.
- Empty state: No authorized signer; explain required resolution.
- Error state: Validation, step-up expired, KMS/render unavailable, concurrent change.
- Success state: Immutable consent id/version, signed timestamp, rendered artifact, effective disclosure status.
- Responsive behavior: Single-column ceremony on small screens; sticky review/action region without hiding terms.
- Accessibility requirements: Logical headings, labelled inputs, error summary/focus, signature-method instructions, no color-only status.
- Dependencies: M39 lifecycle, M34 KMS, M22 render, M4 audit.
- Acceptance criteria: Authorized main path and all failure paths persist no partial operative consent; revocation evaluator sees the new record.
- Priority: P0
- Production blocker: Yes

## Consent Lifecycle Detail

- Proposed route: `/patients/:patientId/consents/:consentId`
- Persona: Clinician, privacy officer
- Workflow: Review, revoke, supersede, renew consent
- Purpose: Present immutable evidence and guarded lifecycle actions.
- Preconditions: Consent exists and caller has minimum-necessary access.
- Required data: Versions, signatures, recipients, disclosures, expiry, revocation/supersession links, rendered artifact.
- Required API support: Detail/history, revoke, supersede, renew, download.
- Primary action: Contextual lifecycle action (renew/revoke/supersede).
- Secondary actions: Download, inspect audit history, return to patient.
- Permissions: M39 read plus per-action permission/ABAC/step-up.
- Loading state: Skeleton for record and history.
- Empty state: Artifact not yet rendered with retry/status.
- Error state: Access revoked, stale version, render failed, dependency unavailable.
- Success state: New immutable lifecycle state with visible effective time.
- Responsive behavior: Timeline below summary on small screens.
- Accessibility requirements: Status announced, confirmation dialog focus trap, destructive consequence text.
- Dependencies: Consent capture, M22, audit.
- Acceptance criteria: Revocation/supersession is immediate, immutable, auditable, and reflected by disclosure checks.
- Priority: P1
- Production blocker: Yes

## Verified Document Upload

- Proposed route: `/patients/:patientId/documents/new`
- Persona: Intake specialist, clinician, records staff
- Workflow: BUG-001 / PARAM-001 document ingestion
- Purpose: Transfer document bytes and commit a verified version.
- Preconditions: Live object storage, upload permission, patient scope, file policy.
- Required data: File, title, type, retention class, patient/admission link, patient-facing setting.
- Required API support: Staged upload or multipart initiation, completion/digest verification, abort, status, retry.
- Primary action: Upload and verify.
- Secondary actions: Replace file, cancel, resume, choose metadata.
- Permissions: `documents.upload`, caseload/owner ABAC.
- Loading state: Byte progress, server verification, metadata commit shown separately.
- Empty state: Drop/select file with accepted formats and limits.
- Error state: Network loss, type/size/digest rejection, object-store unavailable, duplicate, authorization expiry.
- Success state: Active version with verified size/hash and working preview/download.
- Responsive behavior: Full-width file row/progress; no horizontally clipped controls.
- Accessibility requirements: Keyboard file selection, progressbar semantics, live error/status announcements.
- Dependencies: Unified M22 application service and S3 adapter.
- Acceptance criteria: No success before object and metadata are durable; safe retry never creates duplicate active versions.
- Priority: P0
- Production blocker: Yes

## Background Job Detail and Recovery

- Proposed route: `/operations/jobs/:jobId`
- Persona: Biller, quality/compliance manager, organization admin; scoped operator variant
- Workflow: Medicare/Medicaid/report/quality/tenant job progress and recovery
- Purpose: Show durable state, attempts, dependency status, safe retry/cancel/resume, and resulting record.
- Preconditions: Caller can view the owning resource and job class.
- Required data: Queue, tenant, resource, status, attempt history, sanitized failure code, progress, timestamps, result links, idempotency key.
- Required API support: Tenant-safe job read, retry, cancel where supported, DLQ reason, capability status.
- Primary action: Retry or resume when safe.
- Secondary actions: Cancel, open source/result, copy correlation id, contact support.
- Permissions: Per-domain job read/retry; platform jobs require platform role and audited bypass.
- Loading state: Poll/SSE reconnect with last-updated time.
- Empty state: Job purged/not found with source record link.
- Error state: Dependency unavailable, retry prohibited, authorization lost.
- Success state: Completion with result/navigation.
- Responsive behavior: Attempt timeline stacks; controls remain visible.
- Accessibility requirements: `aria-live` status, no rapid focus changes, explicit progress text.
- Dependencies: Typed job status API, capability registry, DLQ/retry policy.
- Acceptance criteria: Refresh/redeploy preserves state; retries are idempotent and permission-audited.
- Priority: P1
- Production blocker: Yes for queued launch workflows

## Integration Readiness

- Proposed route: `/admin/integrations/readiness`
- Persona: Organization administrator, biller, platform operator
- Workflow: Preflight payer/vendor/object/KMS/provider dependencies
- Purpose: Prevent actions that are known to fail and explain the exact remediation owner.
- Preconditions: Integration-read permission.
- Required data: X12 837/835, MAC, HETS, Medicaid, CAHPS, MinIO, KMS, messaging, AI capability state; last successful check; launch tier.
- Required API support: Sanitized capability/readiness endpoint with no secret material.
- Primary action: Test/retest integration.
- Secondary actions: Open credential/settings, view last failure, disable capability.
- Permissions: Split org and platform views; secret values never returned.
- Loading state: Independent checks with timeouts.
- Empty state: No configured integration, with setup action.
- Error state: Unknown/degraded/rate-limited with retry guidance.
- Success state: Ready with last verified timestamp and scope.
- Responsive behavior: Table becomes labelled rows on small screens.
- Accessibility requirements: Text status plus icon; keyboard-operable actions.
- Dependencies: ARCH-002 capability manifest.
- Acceptance criteria: A command button is enabled only when its mandatory capability is ready or an explicit supported degraded path exists.
- Priority: P1
- Production blocker: Yes

## Outbox and Dead-Letter Operations

- Proposed route: `/platform/operations/events`
- Persona: Platform operator, security/operations engineer
- Workflow: ARCH-001 event delivery inspection and recovery
- Purpose: Inspect pending/deferred/failed events, classified consumers, and controlled replay.
- Preconditions: Platform operations role, recent step-up for replay.
- Required data: Event type/id, tenant, classification, consumer attempts, sanitized error, next retry, source resource, age.
- Required API support: Audited cross-tenant aggregate, event detail, replay/defer/dead-letter controls.
- Primary action: Replay a failed event.
- Secondary actions: Filter, pause consumer, open source, export sanitized incident evidence.
- Permissions: Platform-only; tenant context shown but PHI payload hidden/redacted.
- Loading state: Paginated polling with stale indicator.
- Empty state: “No failed/deferred events,” with depth summary.
- Error state: Platform DB unavailable, replay conflict, consumer still unready.
- Success state: Replay accepted and traceable to the new attempt.
- Responsive behavior: Dense table on desktop, summary/detail split on mobile.
- Accessibility requirements: Table headers, keyboard detail navigation, confirmation focus trap.
- Dependencies: Exhaustive event registry and dispatcher attempt ledger.
- Acceptance criteria: Operators can prove why an event is pending and replay it exactly once without viewing PHI.
- Priority: P1
- Production blocker: No, but required before operational launch

## AI Provider and Capability Configuration

- Proposed route: `/admin/ai/providers`
- Persona: AI safety owner, organization administrator
- Workflow: AI-001 enable governed model capability
- Purpose: Configure provider-neutral capabilities, policy, budgets, and failure state before any AI feature is enabled.
- Preconditions: Live provider adapters and governance approval.
- Required data: Provider/model capability matrix, BAA/region, policy version, budgets, timeout, status, provenance requirements.
- Required API support: Credential reference (write-only), test, capability binding, policy approval, usage/cost.
- Primary action: Approve and enable a capability.
- Secondary actions: Test, disable, rotate credential, view evaluations.
- Permissions: AI admin plus step-up; clinical approval separated from technical configuration.
- Loading state: Provider checks independent and cancellable.
- Empty state: AI remains disabled with setup prerequisites.
- Error state: Provider refusal/outage/schema incompatibility/budget exceeded.
- Success state: Versioned approved binding with audit record.
- Responsive behavior: Capability table collapses to per-capability sections.
- Accessibility requirements: Explicit suggestion/execution labels; provenance and confidence readable by assistive tech.
- Dependencies: Real M32 adapters, eval gates, usage metering.
- Acceptance criteria: No capability invokes a model until an approved binding exists; output remains untrusted and cannot directly execute privileged writes.
- Priority: P2
- Production blocker: No if AI remains disabled
