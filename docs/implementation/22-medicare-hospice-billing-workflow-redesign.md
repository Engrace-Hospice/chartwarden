# ChartWarden — Workflow 22: Medicare Hospice Billing — Implementation Plan

**Destination:** `docs/implementation/22-medicare-hospice-billing-workflow-redesign.md`
**Executor:** Claude Code
**Status:** PROPOSED — WP0 audit and explicit approval required
**Source:** Static inspection of user-uploaded `chartwarden-main.zip` (November 2026). No running app, production data, or live integration verified.

## Executive objective

Redesign the existing **Medicare Hospice Billing** experience into a task-oriented, accessible workspace that makes the next authorized action obvious, preserves clinical and financial safety gates, and minimizes navigation between disconnected screens. This is a workflow UX program, not authorization to rewrite domain engines.

## A. Evidence: actual source paths present in the uploaded archive

| Layer | Verified source path | WP0 inspection task |
|---|---|---|
| Frontend | `apps/web/src/modules/23-billing-medicare/billing-operations.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/claim-assembly-wizard.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/claim-editor.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/claim-workbench.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/acknowledgments-timeline.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/eligibility-center.tsx` | Trace entry point, actions, API calls, navigation and state |
| Frontend | `apps/web/src/modules/23-billing-medicare/dde-queue.tsx` | Trace entry point, actions, API calls, navigation and state |
| Backend | `apps/backend/src/modules/23-billing-medicare/claimmd-ack/service.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/claimmd-ack/interpret.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/claimmd-capture/service.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/claimmd-evidence/notice-store.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/abac-predicates.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/abac-resolver-drizzle.ts` | Trace authoritative transitions, permission checks, persistence and errors |
| Backend | `apps/backend/src/modules/23-billing-medicare/ai-block.ts` | Trace authoritative transitions, permission checks, persistence and errors |

**Evidence limitation:** Paths are verified present, but functionality, completeness, and deployment status are **not** established. Claude Code must pin its working commit and verify paths on that commit. Find adjacent routes, database schemas, UI tests, outbox consumers, permissions, and job handlers before proposing changes.

## B. Proposed end-to-end journey (subject to WP0)

1. **Identify billable hospice episode and payer.**
2. **Verify eligibility, provider enrollment, benefit periods and notice status.**
3. **Prepare and validate NOE, NOTR or claim as applicable.**
4. **Review 837I assembly, revenue codes and expected payment.**
5. **Queue and transmit via verified clearinghouse/MAC integration.**
6. **Track acknowledgments, payer adjudication, corrections and remittance.**

## C. UX model

| Surface | Purpose | Required behavior |
|---|---|
| Worklist | Show all work needing action | Priority, patient, owner, due date, authoritative status, filters and saved return state |
| Patient-context workspace | Complete one task without losing context | Stable patient banner, clinical context, source facts, one primary action |
| Review and authorize | Make consequences explicit | Role-based review, validation, required signatures, confirmation and safe failure |
| History and exceptions | Recover and investigate | Event timeline, source evidence, immutable audit, retries only when safe |

### Screen design rules

- Use existing Lantern tokens and `@chartwarden/ui`; no invented purple theme or second component system.
- Desktop: worklist + detail; tablet: responsive stacked detail; mobile: focused tasks with safe sticky actions.
- Distinguish operational progress from clinical truth and external acknowledgments.
- Every screen has loading, empty, permission-denied, conflict, validation, and transient-failure states.
- Show patient identity, relevant dates, task owner and source of status before any consequential action.
- Do not replace clinical terminology with ambiguous shorthand; provide plain-language explanations.

## D. Domain-specific safety and compliance

- Never equate local queued/sent status with MAC acceptance or payment.
- Separate NOE/NOTR notices from institutional claims and preserve timely filing rules.
- Prevent duplicate submissions through durable idempotency and reconciliation.
- Verify current CMS rules, fiscal year rates and payer-specific constraints before changing validation.
- Confirm current federal and state rules and agency policy using authoritative sources during WP0; this plan is not a substitute for legal or clinical review.
- Enforce authorization, tenant isolation, patient scoping and write validation on the server; UI controls are not security boundaries.

## 0. Execution contract — mandatory

1. **WP0 is audit-only. Do not edit application code.** Document commit SHA, exact source lines, route registrations, DTOs, schemas, status machines, permissions, jobs, integrations, and existing test evidence.
2. Preserve multi-tenancy/RLS, RBAC+ABAC, audit and event/outbox behavior, signatures, timestamps, versioning and record retention.
3. Never create a second canonical state machine, duplicate clinical data, fake vendor acknowledgments or silently autofill verified clinical facts.
4. Do not send PHI to external AI services, telemetry, screenshots or fixtures. Use synthetic records for all tests.
5. Flag integrations as **working and tested**, **code-present unverified**, **stub**, **disabled**, or **missing**.
6. New dependencies, schema migrations, API contract changes and regulatory validation changes require written approval.
7. **Stop after WP0** and present findings and a proposed screen map for human approval.

## WP0 — Current-state investigation (audit PR)

**Deliverables** in `docs/implementation/evidence/`:

- `22-current-state-audit.md`: all screens/routes and clickable navigation graph with file:line evidence.
- `22-state-and-contracts.md`: canonical entities, transitions, endpoints, authorization matrix, downstream event consumers.
- `22-usability-findings.md`: 5–8 representative synthetic-data tasks, clicks, dead ends, duplicate forms, errors, accessibility and mobile findings.
- `22-compliance-and-tests.md`: applicable rules, enforcement locations, test commands/results, skipped/blocked tests and external system limitations.
- `22-redesign-decision.md`: keep/consolidate/modify/retire table, wireframe plan, migration impact, rollout and rollback.

**G0 acceptance:** owner approves documented source evidence, proposed information architecture, risk assessment, scope and any needed backend contract changes. **No implementation until G0.**

## WP1 — Unified workflow navigation

- Introduce a single workflow entry with clear worklist, filters, patient context and next-action summary.
- Preserve legacy routes/deep links and patient selection; avoid route redirects that lose unsaved edits.
- Add role-aware actions based on existing backend permissions; never show an action as permitted solely because a frontend role string matches.
- Include a short task-oriented explanation of what is pending, who can resolve it and what will happen next.
- Test navigation with keyboard, touch, screen reader and browser back/forward.

**Acceptance:** each principal task can be started from the worklist or patient chart and completed without an unrelated screen detour.

## WP2 — Guided task execution

- Split overloaded pages into composable stages while preserving existing API and canonical status transitions.
- Use server-provided validation to show blockers inline and link to their resolution.
- Support save/resume only where the domain allows drafts; prevent duplicate writes, stale updates and accidental submission.
- Preserve source-document access and human review for any extracted or imported data.
- Explicitly distinguish draft, review, approved, completed and externally acknowledged states where applicable.

**Acceptance:** representative synthetic-data tasks succeed, fail safely and resume after refresh with no data loss or unauthorized transition.

## WP3 — Exceptions, handoffs and cross-module integration

- Map all upstream and downstream dependencies and the events that connect them.
- Present errors as actionable messages: what failed, what was saved, who can retry and whether the external outcome is unknown.
- Prevent duplicate effects on retry; preserve outbox/event idempotency and reconcile uncertain external outcomes before resubmitting.
- Add handoff context without replicating source-of-truth records.

**Acceptance:** interrupted, conflicting and partial-success paths are covered by integration tests and have an understandable UI recovery route.

## WP4 — Review, permissions, audit and compliance

- Verify all authorization branches using negative tests for unrelated tenants, patients and roles.
- Preserve signatures, clinician attestations, amendments, event timestamps, audit provenance and retention requirements.
- Confirm each compliance gate is enforced by an authoritative backend service, not a visual checklist.
- Perform privacy review of exports, notifications, URLs, logs and error payloads.

**Acceptance:** no unauthorized read/write, no silent state bypass and no fabricated success for regulated actions.

## WP5 — UI accessibility and automated tests

- Unit tests: stage/status mapping, blockers, button states, formatting, retry policies.
- Component tests: keyboard, focus, screen reader names, errors, loading and empty states.
- Integration tests: permitted and denied transitions, concurrency, tenant isolation, idempotency and cross-module events.
- E2E: complete synthetic-data happy path and at least five negative/exception paths.
- Run repository-native lint, typecheck, relevant tests, design-token gates and build; record actual command and result.
- Use WCAG 2.2 AA as target; verify responsive behavior at phone, tablet and desktop sizes.

**Acceptance:** relevant checks pass; blocked checks are documented with reproduction and owner, not reported as passed.

## WP6 — Controlled rollout and handoff

- Use existing feature flagging where available; no unapproved new flag infrastructure.
- Preserve old navigation as a rollback path until replacement is validated.
- Compare task completion and error rates using PHI-safe aggregate metrics; avoid patient identifiers in analytics.
- Prepare operator guide, screenshots with synthetic data, support runbook, rollback checklist and known limitations.
- Validate release readiness with clinical, billing/compliance (as applicable), security and product reviewers.

**Acceptance:** documented rollback tested; users can complete all essential tasks without data migration or broken deep links.

## E. Required test scenarios

1. Successful end-to-end journey with authorized role.
2. Unauthorized role denied read and write.
3. Cross-tenant and cross-patient access rejected.
4. Missing required information shows actionable blockers.
5. Stale version/concurrent edit does not overwrite newer data.
6. Repeated submission/retry does not duplicate records or events.
7. Network interruption after server commit shows uncertain state safely.
8. Refresh and deep link restore correct patient/task.
9. Incomplete or conflicting external data does not auto-verify.
10. Cancelled or corrected task preserves history.
11. Audit event captures actor, patient, action and timestamp.
12. Responsive mobile and keyboard/screen-reader path works.
13. Domain safeguard: Never equate local queued/sent status with MAC acceptance or payment.
14. Domain safeguard: Separate NOE/NOTR notices from institutional claims and preserve timely filing rules.
15. Domain safeguard: Prevent duplicate submissions through durable idempotency and reconciliation.
16. Domain safeguard: Verify current CMS rules, fiscal year rates and payer-specific constraints before changing validation.

## F. Proposed PR sequence and approval gates

| PR | Scope | Gate |
|---|---|
| 0 | WP0 evidence and architecture proposal only | **G0 owner approval** |
| 1 | Workflow shell, routing, worklist and design-system alignment | G1 UX and accessibility review |
| 2 | Guided task components and server-backed validation | G2 clinical/domain review |
| 3 | Exception handling and cross-module handoffs | G3 security and integration review |
| 4 | E2E, regression, accessibility and release documentation | G4 release approval |

## G. Definition of done

- Current implementation and design decisions are documented with source line evidence.
- One primary path, clear next action and actionable blockers exist for each principal task.
- No change to authoritative clinical/financial transitions without approved contract change.
- Role/tenant/patient isolation, idempotency and audit invariants pass tests.
- Screens are accessible and usable across desktop/tablet/mobile.
- External vendor behavior is never claimed without tested evidence.
- Rollback and support instructions are complete; required reviewers sign off.

## H. Claude Code execution prompt

```text
Implement the approved ChartWarden Workflow 22 — Medicare Hospice Billing redesign plan at docs/implementation/22-medicare-hospice-billing-workflow-redesign.md.
Start with WP0 ONLY. Pin the current commit, inspect the actual repository, and produce the five evidence files listed in this plan with file:line references.
Run only non-destructive audit and tests permitted by the repository policy. Do not modify application code, migrations, permissions, regulatory rules, or vendor integrations.
Classify each feature as working-tested, code-present-unverified, stub, disabled, or missing.
Report the screen map, current workflow, concrete usability defects, proposed workflow, exact backend seams, risks, and test coverage.
STOP and request explicit approval at G0 before beginning WP1.
```
