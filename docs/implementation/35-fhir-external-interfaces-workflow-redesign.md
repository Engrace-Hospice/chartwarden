# ChartWarden — Workflow 35: FHIR & External Interfaces — Implementation Plan

**Repository destination:** `docs/implementation/35-fhir-external-interfaces-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — WP0 evidence and approval required
**Evidence:** File paths verified against the user-provided `chartwarden-main.zip` snapshot. This is a static inventory; functionality and runtime behavior are not verified.

## Mission

Redesign **FHIR & External Interfaces** as a clear, task-oriented workflow using ChartWarden’s existing Lantern design system. Preserve existing backend contracts, authorization, state machines, audit controls and clinical/financial safeguards. Avoid building parallel workflows.

## Verified repository entry points

| File | Audit requirement |
|---|---|
| `apps/backend/src/modules/28-fhir/index.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/jobs/bulk-export-worker.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/jobs/bulk-export-sweeper.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/jobs/capability-snapshot.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/abac-predicates.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/__tests__/m28-routes.test.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/src/modules/28-fhir/__tests__/m28-client-gates.test.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/__tests__/fhir-contracts.test.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |
| `apps/backend/__tests__/m28-fhir-gateway.live.test.ts` | Trace imports, routes, permissions, APIs, UI states and tests; record observed behavior |

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

- `docs/implementation/evidence/35-current-state-audit.md` (verified routes, screens, APIs, tests, gaps and screenshots).
- `docs/implementation/evidence/35-proposed-ux.md` (desktop/mobile wireframes, interaction states, acceptance criteria).
- Decision log: KEEP / MODIFY / CONSOLIDATE / DEPRECATE for each existing surface.
- Explicit evidence labels: VERIFIED IN CODE, VERIFIED BY TEST, OBSERVED IN RUNTIME, PROPOSED, UNKNOWN.

## Target user journey (proposal)

1. Show each interface with verified status: configured, tested, active, degraded or disabled.
2. Explain resource and operation support from actual capability statement and contract tests, not marketing assumptions.
3. Track async export/import lifecycle with job ID, cursor, outcome and safe retry options.
4. Present validation failures with field path, expected terminology and source context without disclosing credentials.
5. Require operator approval for high-risk replay or bulk export; record actor, scope and destination.

## Proposed information architecture

| Surface | Required behavior |
|---|---|
| 1. Integration connection inventory | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 2. FHIR capability and resource explorer | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 3. Import/export job tracking | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 4. Mapping and validation errors | Primary action, visible progress, clear status, direct resolution path and safe fallback |
| 5. Authorization, consent and incident operations | Primary action, visible progress, clear status, direct resolution path and safe fallback |

## Non-negotiable safeguards

- Do not claim R4, R5 or R6 features beyond tested support; preserve exact resource version and profile constraints.
- OAuth/SMART scopes, consent, tenant context and patient authorization must be checked at the server.
- No PHI or credentials in URLs, errors, logs or observability payloads.
- Bulk export requires rate limiting, scoped authorization, signed/expiring delivery and cancellation behavior.
- Inbound deduplication, idempotency and conflict handling must be proved before enabling writes.
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
| 35-T01 | Unauthorized bulk export | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T02 | External token expired mid-job | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T03 | Duplicate inbound resource | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T04 | Unsupported FHIR resource | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T05 | Remote endpoint timeout after request | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T06 | Cross-tenant reference in imported bundle | Correct authorization and authoritative state; safe UX, no false success; auditable outcome |
| 35-T07 | Different tenant accesses record or API | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T08 | Unauthorized role attempts mutation | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T09 | Two users change same record concurrently | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T10 | Deep link and refresh during active workflow | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T11 | Keyboard-only and screen-reader completion | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T12 | Timeout after server accepts request | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T13 | Network offline then reconnect | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |
| 35-T14 | Legacy route and migration compatibility | Deterministic behavior; no PHI leakage or duplicate mutation; accessible recovery |

## Proposed pull request sequence

1. **PR-35-0 Audit only:** current-state inventory, risk register and approved UX; no application changes.
2. **PR-35-1 Shell:** worklist, navigation, shared components and routing.
3. **PR-35-2 Workspace:** primary guided journey and server-backed status.
4. **PR-35-3 Exceptions:** review, failure, recovery and approval states.
5. **PR-35-4 Integration:** downstream contracts, idempotency and focused tests.
6. **PR-35-5 Release:** E2E/accessibility, flagging, monitoring and rollback.

## Definition of done

- G0 audit and design explicitly approved.
- Core user journeys require fewer context switches than the documented baseline; measure with synthetic tasks.
- All critical actions have clear success, failure and unknown-outcome states.
- No regression in tenant isolation, role permissions, evidence retention or regulatory requirements.
- Focused automated tests and accessible interaction tests pass, or documented blockers prevent rollout.
- Product owner, clinical/compliance owner and security reviewer approve release.
- Rollback steps are tested and documented.

## Claude Code execution instruction

> Implement Workflow 35 — FHIR & External Interfaces. First perform **WP0 only** against the currently checked-out repository. Verify every path and assumption, cite actual source lines in your audit, run safe targeted checks, and deliver a concrete UI/navigation proposal. **Stop and request approval before editing application code.** After approval, execute WP1–WP6 in small PRs, preserving backend contracts and clinical/security safeguards. Do not assert production readiness without runtime evidence.
