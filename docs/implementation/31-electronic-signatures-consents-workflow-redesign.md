# ChartWarden — Workflow 31: Electronic Signatures & Consents — Implementation Plan

**Repository destination:** `docs/implementation/31-electronic-signatures-consents-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — WP0 audit and approval required  
**Evidence basis:** Static inspection of paths in user-uploaded `chartwarden-main.zip`; functionality, runtime behavior and integrations not independently validated.

## Objective

Redesign **Electronic Signatures & Consents** as a coherent, task-first workspace, eliminating avoidable navigation and duplicate entry while preserving clinical, regulatory, financial, and security controls. Do not rewrite the backend solely to achieve visual consistency.

## Verified repository entry points

| Layer | File | WP0 inspection goal |
|---|---|---|
| Frontend | `apps/web/src/modules/39-consent/consent-capture.tsx` | Verify current use, routes, permissions, states and tests |
| Frontend | `apps/web/src/modules/39-consent/consent-detail.tsx` | Verify current use, routes, permissions, states and tests |
| Frontend | `apps/web/src/modules/39-consent/consent-record-manager.tsx` | Verify current use, routes, permissions, states and tests |
| Frontend | `apps/web/src/modules/39-consent/consent-recipients-dpoa.tsx` | Verify current use, routes, permissions, states and tests |
| Frontend | `apps/web/src/modules/31-portal/patient-signatures.tsx` | Verify current use, routes, permissions, states and tests |
| Backend | `apps/backend/src/modules/39-consent/routes/consent-routes.ts` | Verify current use, routes, permissions, states and tests |
| Backend | `apps/backend/src/modules/39-consent/routes/consent-guards.ts` | Verify current use, routes, permissions, states and tests |
| Backend | `apps/backend/src/modules/31-portal/routes/signature.routes.ts` | Verify current use, routes, permissions, states and tests |
| Backend | `apps/backend/src/modules/31-portal/routes/signature-staff.routes.ts` | Verify current use, routes, permissions, states and tests |
| Backend | `apps/backend/src/modules/39-consent/consent-crypto.ts` | Verify current use, routes, permissions, states and tests |

These paths exist in the supplied ZIP. They are investigation starting points, not assertions that the associated features work in production.

## Target user journey — proposed

1. Identify required document, consent purpose, signer and authority.
2. Prepare request and validate current document version and signer eligibility.
3. Deliver secure signing invitation and verify signer identity as supported.
4. Capture explicit informed action and evidence; record authoritative status.
5. Handle refusal, expiration, renewal, revocation and downstream access changes.

## Proposed screens and information architecture

| Surface | UX contract |
|---|---|
| 1 | Signatures inbox for staff and family with waiting-on and deadline filters |
| 2 | Document preview beside plain-language consent purpose and signer authority |
| 3 | Signing flow with accessible review, affirmation, confirmation and receipt |
| 4 | Consent history showing scope, recipients, version, expiration and revocation |
| 5 | Exceptions for unavailable signer, DPOA conflicts, invalid links and expired requests |

## Domain-specific safeguards

- Do not conflate document signature with legal consent or Medicare election.
- Preserve evidence integrity, signer identity and authorization checks.
- Do not pre-check consent boxes or imply agreement by navigating away.
- Revoke downstream access through authoritative cascade; verify failures and retries.
- Preserve original signed artifact; amendments create new versions, not silent replacement.

## Implementation work packages (after G0 approval)

### WP1 — Worklist and navigation

- Introduce a single entry point, actionable status groups, owner/priority/deadline filters and deep links into the selected record.
- Map existing routes and server statuses to user-facing language; do not create new state enums.
- Use existing design tokens and shared UI; retain legacy links and navigation compatibility.
- Add loading, empty, forbidden, stale and retry states.

### WP2 — Guided record workspace

- Implement the proposed target journey as a guided, resumable experience using existing APIs and forms.
- Keep record context visible, identify the primary next action, and expose related details only when needed.
- Confirm source-of-truth status and relevant permissions before allowing consequential actions.
- Provide non-destructive drafts and safe cancellation/unsaved-change handling.

### WP3 — Review, exceptions and approvals

- Surface actionable blockers with reason, required actor, evidence link and direct resolution route.
- Separate warnings from hard blockers and internal progress from external acknowledgment.
- Preserve audit evidence and immutable signed/submitted events; implement safe concurrency and retry semantics.
- Obtain explicit domain-owner approval for any newly proposed transition or API change.

### WP4 — Integrations and downstream handoffs

- Trace every downstream event, queue, worker, notification and external connector; record observed outcomes.
- Handle delayed, failed, duplicated, unknown and out-of-order events without showing false success.
- Preserve existing event schemas and idempotency; add contract tests before changing an interface.

### WP5 — Accessibility, QA and staged rollout

- Build desktop/tablet/mobile variants consistent with Lantern.
- Test role-based views, keyboard and screen-reader paths, error summaries, high zoom, and network interruption.
- Add telemetry for completion time, context switches, error recovery and blocked cases, without PHI.
- Compare baseline vs redesigned task completion with synthetic scenarios; gate rollout on clinical/compliance approval.

## Required scenario matrix

| ID | Scenario | Expected outcome |
|---|---|
| 31-T01 | Unauthorized family member signs | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T02 | Expired link and replay attempt | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T03 | Document changed after invitation | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T04 | Consent revoked while downstream share is queued | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T05 | Signer declines and workflow resumes | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T06 | Audit proof for identity, document hash, time and intent | Safe, authorized outcome; correct server state; audit evidence; no false success |
| 31-T07 | Unauthorized role attempts write | 403 or equivalent; no mutation; audited where appropriate |
| 31-T08 | Different tenant attempts access | No PHI or metadata leakage; RLS/ABAC enforced |
| 31-T09 | Two users edit same record | Deterministic conflict or safe merge; no lost update |
| 31-T10 | Refresh/deep link during active work | Correct record context and authoritative status restored |
| 31-T11 | Keyboard-only and screen reader journey | Accessible labels, focus order and error feedback |
| 31-T12 | Service timeout after action | Outcome unknown until reconciliation; no blind duplicate |

## Definition of done

- G0 evidence and approved design decision are committed.
- No duplicated server lifecycle or loss of existing patient/provider/tenant scoping.
- All previously supported tasks remain accessible, with improved task-oriented navigation.
- Domain-specific safety scenarios and regression tests pass in permitted test environments.
- Security and compliance reviewers approve consequential actions and disclosures.
- Feature-flag rollback demonstrated; user documentation and support notes updated.


## Non-negotiable engineering rules

- **WP0 is read-only. Stop and request approval at Gate G0.** Do not interpret this plan as authorization to edit production code, deploy, run destructive migrations, or use real PHI.
- Pin `git rev-parse HEAD`; verify every listed path still exists. Record findings with `path:line`, commit SHA, test output, and screenshots using synthetic patients only. A source file is not proof of a working feature.
- Preserve authoritative backend state machines, server-side authorization, PostgreSQL RLS, immutable audit trails, idempotency, signatures, version history, and domain events. Do not replace server checks with client checks.
- Use the current Lantern design tokens, shared `@chartwarden/ui`, accessible form controls, and established route patterns. No invented theme, purple gradients, or duplicated navigation.
- Classify each capability **working/tested**, **present/unverified**, **stub/disabled**, or **missing**. Never label external transmission, signature, submission, or notification as successful without authoritative confirmation.
- No secrets or PHI in logs, analytics, AI prompts, screenshots, tests, or error traces. Honor minimum-necessary access, break-glass controls, retention, and tenant scoping.
- Verify current CMS, HIPAA, state, payer, and applicable program requirements from authoritative sources with compliance owners before modifying rules. The proposal is not a regulatory specification.
- Respect ongoing Rust migration: do not introduce new backend dependencies or schema changes without architecture approval; maintain API parity and existing frontend contracts where possible.

## WP0 — Current-state evidence package (read-only)

1. Identify current routes, screens, navigation, API endpoints, DTOs, database tables, workers, flags, permission keys, and event consumers. Trace all core journeys and error paths.
2. Record a screen-by-screen usability audit: number of clicks, context switches, repeated data entry, hidden actions, confusing labels, missing empty/loading/error states, and inaccessible controls.
3. Trace each consequential action from UI → API → permission/RLS → domain state transition → event → audit record; identify any orphaned or duplicate interfaces.
4. Verify supported integrations with non-PHI test environments and evidence; list unsupported assumptions and required vendor contracts.
5. Run existing focused unit, integration, UI and E2E tests where feasible. Record actual pass/fail/blocked counts; do not claim production validation.
6. Produce `docs/implementation/evidence/31-current-state-audit.md`, `31-route-contract-matrix.md`, `31-ux-findings.md`, `31-risk-register.md`, `31-design-decision.md` using this workflow number.
7. Propose keep/modify/consolidate/retire decisions, exact file impact, backend-change requests (if any), rollout, and rollback.

**Gate G0 — STOP:** Present evidence, UX wireframes, proposed route map, compliance signoffs required, and PR boundaries for approval before changing application code.

## Shared UX acceptance contract

- A new user can find the next required action without interpreting internal module numbers or raw state enums.
- Show task owner, deadline when applicable, current authoritative status, blocker reason, and one primary action; secondary details stay accessible.
- Preserve context and deep links when moving between list, patient/record workspace, review, and history. Provide safe back navigation and unsaved-change protection.
- Every asynchronous operation has pending, confirmed, failed, stale/conflicted, and **outcome unknown** handling where appropriate. Never imply success based only on HTTP request initiation.
- Support keyboard-only operation, visible focus, screen readers, error summaries, 200% zoom, responsive layouts, and role-based task visibility.
- UI status must derive from existing server state; never create a second independent lifecycle in frontend local state.

## PR and approval strategy

| PR | Deliverable | Merge gate |
|---|---|---|
| 0 | Evidence-only WP0 audit and design decision | G0 owner approval; no application code changes |
| 1 | New workspace shell, worklist and navigation | Snapshot, routing, accessibility and permission tests |
| 2 | Guided core workflow and review surfaces | Contract tests and scenario-based E2E |
| 3 | Exception recovery, audit visibility and integration states | Negative-path, concurrency and idempotency tests |
| 4 | Hardening, feature flag, telemetry and rollout | Security review, rollback rehearsal and clinical owner signoff |

**Deployment:** Default to feature-flagged opt-in, synthetic pilot, shadow comparison where appropriate, limited agency pilot, then staged rollout. Preserve legacy route fallback until parity and user acceptance are demonstrated. Roll back UI flag first; never roll back signed records or immutable financial/clinical events.

## Claude Code execution instruction

Start at **WP0 only**. Read this file, inspect repository HEAD and the relevant source, create the evidence artifacts, run only safe focused tests, and report a factual audit with file:line references and a proposed design. **Stop for approval.** Do not implement WP1–WP5, change database schema, alter regulatory logic, or connect live external services until authorized.

