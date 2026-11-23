# ChartWarden — Workflow 33: Audit & Compliance Monitoring — Implementation Plan

**Repository destination:** `docs/implementation/33-audit-compliance-monitoring-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — WP0 evidence and approval required
**Evidence:** File paths verified against the user-provided `chartwarden-main.zip` snapshot. This is a static inventory; functionality and runtime behavior are not verified.

## Mission

Redesign **Audit & Compliance Monitoring** as a clear, task-oriented workflow using ChartWarden’s existing Lantern design system. Preserve existing backend contracts, authorization, state machines, audit controls and clinical/financial safeguards. Avoid building parallel workflows.

## Verified repository entry points

| File | Audit requirement |
|---|---|
| `apps/web/src/modules/04-audit/audit-log-viewer.tsx` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/web/src/modules/04-audit/audit-exports.tsx` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/web/src/modules/04-audit/audit-integrity-report.tsx` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/web/src/modules/04-audit/legal-holds.tsx` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/web/src/modules/04-audit/privacy-work-queue.tsx` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/04-audit/routes/audit-routes.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/04-audit/routes/audit-integrity.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/04-audit/routes/audit-exports.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/04-audit/jobs/audit-integrity-job.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/__tests__/audit-routes.test.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |

## WP0 — Mandatory current-state audit (STOP GATE G0)

1. Verify the checked-out branch, commit SHA and current file paths; treat this ZIP as historical reference only.
2. Read repository agent instructions, architecture ADRs, module boundaries, Lantern tokens and test conventions.
3. Build a screen-by-screen inventory: route, role, task, data source, API, mutation, loading/error/empty state, downstream dependency and ownership.
4. Map each backend state and permission to its user-facing presentation. Identify disconnected entry points, duplicate data entry, misleading statuses, dead ends and unnecessary navigation.
5. Run only permitted local lint, typecheck and focused tests; capture command, exit code, failures and environmental blockers. Never claim tests passed if not run.
6. Produce a before/after journey diagram, annotated UI proposals for desktop and mobile, API reuse matrix, risk register and prioritized backlog.
7. Flag proposed backend changes separately with a justification and contract migration plan; default to frontend-first.
8. **STOP and request approval**. Do not implement WP1–WP6 until the user approves G0.

### G0 deliverables

- `docs/implementation/evidence/33-current-state-audit.md` (verified routes, screens, APIs, tests, gaps and screenshots).
- `docs/implementation/evidence/33-proposed-ux.md` (desktop/mobile wireframes, interaction states, acceptance criteria).
- Decision log: KEEP / MODIFY / CONSOLIDATE / DEPRECATE for each existing surface.
- Explicit evidence labels: VERIFIED IN CODE, VERIFIED BY TEST, OBSERVED IN RUNTIME, PROPOSED, UNKNOWN.

## Target user journey (proposal)

1. Search audit events by authorized actor, patient, action and time without leaking PHI in result previews.
2. Open a case, pin relevant events, document reviewer decisions and export an evidence package.
3. Show integrity check outcomes, verification timestamps and failures without equating a completed job to verified integrity.
4. Require step-up authorization and explicit scope for legal holds, exports and destruction actions.
5. Route exceptions to a named reviewer and retain closure evidence.

## Proposed information architecture

| Surface | Required behavior |
|---|---|
| 1. Audit event search and filtering | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 2. Investigation case and event timeline | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 3. Integrity verification and evidence exports | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 4. Privacy requests, legal holds, and retention | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 5. Compliance alerts and exception ownership | Primary action, visible progress, clear status, direct resolution path and safe fallback |

## Non-negotiable safeguards

- Audit records must remain append-only and tamper-evident according to verified repository contracts; never rewrite original event content.
- Legal hold must override routine destruction where required; verify actual retention policy and approval chain.
- No cross-tenant audit search, aggregation or export; test database and application authorization.
- Exports need least privilege, reason codes, traceability, expiration and secure delivery.
- Never expose PHI, tokens, IP addresses or sensitive payloads in generic telemetry or client logs.
- Preserve existing multi-tenant RLS, RBAC/ABAC, immutable evidence and role-specific permissions.
- No fabricated success statuses for asynchronous, external or partially complete operations.
- No PHI in frontend analytics or logs; use synthetic test data.

## WP1 — Navigation and worklist

- Implement one obvious entry point, with meaningful filters, ownership and next-action labels.
- Deep-link to the correct record without losing context; retain legacy routes until validated.
- Add explicit loading, empty, forbidden, partial, stale and retry states.
- Use shared `@chartwarden/ui` components and existing Lantern design tokens.

## WP2 — Guided primary workspace

- Implement the approved journey with progressive disclosure and persistent context.
- Use authoritative server data and existing APIs. Do not create a second lifecycle enum or duplicate database fields.
- Surface next action, why it matters, who can do it and what blocks completion.
- Support draft recovery, unsaved changes, cancellation and browser back/refresh.

## WP3 — Exceptions, review and approvals

- Make errors actionable: reason, severity, responsible role, affected record, and resolution link.
- Preserve review, signatures, step-up auth, provenance and required attestations.
- Handle concurrency with version checks or server-provided conflict handling.
- Distinguish warnings, hard blockers, uncertain outcomes and confirmed completion.

## WP4 — Integration and downstream behavior

- Trace existing jobs, queues, webhooks, exports, notifications and related modules.
- Preserve idempotency, outbox semantics, external acknowledgment states and audit evidence.
- Add contract tests before modifying any API or event payload.
- Use feature flags for behavior that is not proven in production.

## WP5 — UX quality and accessibility

- Deliver desktop, tablet and phone layouts, including keyboard-only operation.
- Verify WCAG 2.2 AA-oriented behavior: labels, focus, error summary, contrast, zoom and touch targets.
- Keep language understandable to the intended staff or family role.
- Add PHI-safe metrics: task completion, time, abandoned workflows, repeated navigation and error recovery.

## WP6 — Verification and controlled rollout

- Add unit, integration, contract and E2E tests with synthetic patients/tenants.
- Verify unauthorized access, cross-tenant isolation, deep links, browser refresh, concurrent edits and degraded service behavior.
- Run repo-prescribed format, lint, typecheck and targeted tests; record evidence and blocked tests.
- Release behind a reversible feature flag where feasible, with legacy route compatibility.
- Obtain clinical, security and compliance approval before enabling for live use.

## Required scenario matrix

| Test | Scenario | Required assertion |
|---|---|
| 33-T01 | Cross-tenant audit search | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T02 | Audit export interrupted then retried | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T03 | Legal hold placed while destruction job is pending | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T04 | Integrity verification reports a mismatch | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T05 | Read-only auditor attempts destructive action | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T06 | Export link expired or revoked | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 33-T07 | Different tenant accesses record or API | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T08 | Unauthorized role attempts mutation | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T09 | Two users change same record concurrently | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T10 | Deep link and refresh during active workflow | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T11 | Keyboard-only and screen-reader completion | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T12 | Timeout after server accepts request | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T13 | Network offline then reconnect | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 33-T14 | Legacy route and migration compatibility | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |

## Proposed pull request sequence

1. **PR-33-0 Audit only:** current-state inventory, risk register and approved UX; no application changes.
2. **PR-33-1 Shell:** worklist, navigation, shared components and routing.
3. **PR-33-2 Workspace:** primary guided journey and server-backed status.
4. **PR-33-3 Exceptions:** review, failure, recovery and approval states.
5. **PR-33-4 Integration:** downstream contracts, idempotency and focused tests.
6. **PR-33-5 Release:** E2E/accessibility, flagging, monitoring and rollback.

## Definition of done

- G0 audit and design explicitly approved.
- Core user journeys require fewer context switches than the documented baseline; measure with synthetic tasks.
- All critical actions have clear success, failure and unknown-outcome states.
- No regression in tenant isolation, role permissions, evidence retention or regulatory requirements.
- Focused automated tests and accessible interaction tests pass, or documented blockers prevent rollout.
- Product owner, clinical/compliance owner and security reviewer approve release.
- Rollback steps are tested and documented.

## Claude Code execution instruction

> Implement Workflow 33 — Audit & Compliance Monitoring. First perform **WP0 only** against the currently checked-out repository. Verify every path and assumption, cite actual source lines in your audit, run safe targeted checks, and deliver a concrete UI/navigation proposal. **Stop and request approval before editing application code.** After approval, execute WP1–WP6 in small PRs, preserving backend contracts and clinical/security safeguards. Do not assert production readiness without runtime evidence.
