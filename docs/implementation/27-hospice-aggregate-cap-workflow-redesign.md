# ChartWarden — Workflow 27: Hospice Aggregate Cap — Implementation Plan

**Destination:** `docs/implementation/27-hospice-aggregate-cap-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — audit and approval before code changes  
**Source:** Static file-path inspection of user-uploaded `chartwarden-main.zip` (November 2026); no runtime or live integration verified.

## Objective

Redesign **Hospice Aggregate Cap** into an accessible, task-oriented ChartWarden workspace using existing Lantern tokens and established backend contracts. Reduce navigation overhead and unclear next actions without weakening payer rules, authorization, financial integrity or tenant isolation.

## Verified source starting points

| Layer | Existing source file | Investigation |
|---|---|---|
| UI | `apps/web/src/modules/26-cap/cap-dashboard.tsx` | Trace routes, actions, states, data loading, empty/error states |
| UI | `apps/web/src/modules/26-cap/cap-periods.tsx` | Trace routes, actions, states, data loading, empty/error states |
| UI | `apps/web/src/modules/26-cap/cap-psr-workbench.tsx` | Trace routes, actions, states, data loading, empty/error states |
| UI | `apps/web/src/modules/26-cap/cap-settlement.tsx` | Trace routes, actions, states, data loading, empty/error states |
| UI | `apps/web/src/modules/26-cap/cap-events.tsx` | Trace routes, actions, states, data loading, empty/error states |
| UI | `apps/web/src/modules/26-cap/cap-actions.tsx` | Trace routes, actions, states, data loading, empty/error states |
| Backend | `apps/backend/src/modules/26-cap/routes/cap.routes.ts` | Trace authorization, contracts, state transitions, persistence and tests |
| Backend | `apps/backend/src/modules/26-cap/cap-period-selection.ts` | Trace authorization, contracts, state transitions, persistence and tests |
| Backend | `apps/backend/src/modules/26-cap/psr/psr-reconcile.ts` | Trace authorization, contracts, state transitions, persistence and tests |
| Backend | `apps/backend/src/modules/26-cap/consumers/handlers.ts` | Trace authorization, contracts, state transitions, persistence and tests |
| Backend | `apps/backend/src/modules/26-cap/jobs/m26-jobs.ts` | Trace authorization, contracts, state transitions, persistence and tests |

**Evidence standard:** File existence proves only source presence, not correctness or production readiness. All assumptions below require verification against pinned HEAD and relevant external payer requirements.

## Target user journey (proposed; validate in WP0)

1. **Select cap year, provider and applicable cap method.**
2. **Ingest and validate PS&R and other authoritative inputs.**
3. **Reconcile beneficiaries, patient days and payments.**
4. **Calculate cap position and explain discrepancies.**
5. **Review projections separately from finalized figures.**
6. **Authorize settlement and retain audit evidence.**

## Proposed information architecture

| Surface | Purpose | Required controls |
|---|---|---|
| Work queue | Identify actionable cases | Search, payer/provider scope, priority, owner, deadlines, filters, saved view |
| Case workspace | Work without context switching | Patient/claim context, evidence, authoritative status, one primary next action |
| Review and authorization | Safe consequential actions | Explicit confirmation, server validation, permission-aware actions, conflict handling |
| Timeline and reconciliation | Understand outcomes | Source timestamps, external acknowledgment, event history, immutable audit |
| Exceptions | Recover from failed or ambiguous steps | Clear reason, owner, retry policy, no fabricated success |

### Interaction and design contract

- Use Lantern tokens, shared `@chartwarden/ui` components and existing application navigation; no new purple/AI-styled theme.
- Preserve deep links, browser back/forward, unsaved-change warnings and current patient/agency context.
- Use plain-language task titles while retaining exact financial and regulatory terms in details.
- Always display **who must act, why, and what happens next**; distinguish informational warnings from hard blockers.
- Support keyboard, screen reader, zoom, responsive layouts, focus return and accessible validation.
- Provide loading, no-data, unauthorized, stale-data, transport-unknown and server-error states.

## Domain safeguards and known unknowns

- Do not use projections as final liability.
- Keep inpatient cap distinct from aggregate cap.
- Validate CMS cap year and methodology against current authoritative guidance.
- Protect PS&R source provenance and corrections.
- Enforce multi-tenant RLS, RBAC/ABAC, patient and provider scoping on the server, never only in UI.
- Do not expose PHI in logs, telemetry, AI prompts, screenshots or fixtures; use synthetic records.
- Do not alter payer rules, payment calculations, submission semantics or clinical records without domain-owner signoff.
- Separate **implemented and tested**, **code present but unverified**, **stub**, **disabled**, and **missing**.

## WP0 — Mandatory current-state audit (no application edits)

1. Pin commit SHA and identify module owner, UI routes, backend routes, DTOs, database tables, permission keys, feature flags, jobs and event consumers.
2. Draw current click path for each core journey; record screen-to-screen jumps, duplicated forms, unclear status labels, missing empty states and inaccessible controls.
3. Map every UI action to its server-side endpoint, permission and authoritative state transition.
4. Trace external payer/clearinghouse interfaces; classify operational status from integration tests and documented credentials without accessing secrets.
5. Inspect relevant existing unit, integration, E2E and tenant-isolation tests. Run permitted tests, record failures and blocked cases; never imply passing tests not run.
6. Verify current applicable CMS, Medicaid/state or payer rules using authoritative references; do not encode rules from this proposal alone.
7. Create the audit artifacts below; propose precise keep/modify/consolidate/retire decisions with file:line evidence.

**Required WP0 artifacts** (`docs/implementation/evidence/27-*`):

- `27-current-state-audit.md` — route graph, user journey and evidence. 
- `27-contracts-and-permissions.md` — states, DTOs, endpoints, ABAC/RLS, jobs, integrations. 
- `27-ux-findings.md` — task walkthroughs, friction, screenshots with synthetic data only. 
- `27-compliance-risk-register.md` — applicable rules, assumptions, safety and financial risks. 
- `27-redesign-decision.md` — proposed screens, API impact, rollout, rollback and approval requests.

**G0 STOP:** Present audit and decision package for approval. Do not implement until approved.

## WP1 — Navigation and case worklist

- Create one discoverable workflow entry point, with a role-aware actionable work queue.
- Preserve legacy routes and deep links; use adapters rather than breaking existing callers.
- Show status, payer, patient/claim context, owner, due date, last event and the next permissible action.
- Distinguish external statuses from internal queue states; label uncertain states explicitly.
- Add clear return-to-worklist behavior and preserve filter/scroll state.
- Acceptance: representative users can locate and resume cases without opening unrelated modules.

## WP2 — Guided case workspace

- Build a stable context header, task progression, evidence panel and server-backed blocker list.
- Consolidate existing UI sections without moving business rules into React components.
- Provide explicit draft/save/submit boundaries; require confirmation for irreversible actions.
- Prevent stale writes with existing version/concurrency mechanism; if absent, propose a backend contract change for approval.
- Never auto-resolve conflicting clinical or financial evidence.
- Acceptance: users can complete primary happy path and recover from interruption without duplicate writes.

## WP3 — Validation, exceptions and recovery

- Map server error codes to actionable, accurate messages with links to correct screen/field.
- Add dedicated handling for unavailable integrations, rejected transactions, ambiguous matches and stale evidence.
- Preserve durable idempotency keys and retry/backoff semantics in existing job architecture.
- Provide timeline with evidence of submission, acknowledgment and decision as distinct milestones.
- Acceptance: failed or uncertain external actions never display as completed; retries do not duplicate financial transactions.

## WP4 — Permissions, audit and financial safety

- Review role matrix for billers, supervisors, administrators and auditors; enforce server authorization.
- Verify tenant and provider scoping for list, detail, export, batch and background jobs.
- Keep audit history append-only and include before/after, actor, reason, source reference and timestamp where applicable.
- Validate redaction, logging, retention, and download authorization for source documents.
- Require independent approval for regulatory calculation or payment-posting changes.
- Acceptance: cross-tenant and unauthorized actions fail closed in integration tests.

## WP5 — Tests and usability validation

Create synthetic fixtures and tests for:

1. Missing PS&R.
2. Overlapping cap periods.
3. Beneficiary count discrepancy.
4. Late claim adjustment.
5. Revised cap-year input.
6. Settlement approval by unauthorized actor.
7. Permission denied for an otherwise valid action.
8. Cross-tenant patient, provider, claim and file access denied.
9. Refresh/back navigation during unsaved work.
10. Keyboard-only and screen-reader workflow.
11. Server conflict between two concurrent editors.
12. External integration timeout with unknown outcome and safe reconciliation.
13. Audit and source evidence retained after correction.
14. Mobile/tablet responsive layout with large text.

**Validation:** Run relevant unit, integration, typecheck, lint, and browser tests with documented commands. Include test counts, exact failures and environment limitations; do not claim production validation from mocks.

## WP6 — Controlled rollout and handoff

- Ship behind existing feature flag if available; otherwise propose a reversible rollout mechanism.
- Pilot with synthetic cases, then authorized internal test data only after security review.
- Compare old/new completion time, clicks, errors, abandoned tasks and support tickets.
- Maintain rollback without schema/data loss and ensure in-flight work can be resumed.
- Document screenshots, role-specific instructions, known gaps and operations runbook.

## Pull request sequence

| PR | Scope | Gate |
|---|---|
| PR0 | WP0 evidence only | G0: approve architecture and risk register |
| PR1 | Worklist/navigation | G1: route/permission parity |
| PR2 | Guided case workspace | G2: domain state and API parity |
| PR3 | Exceptions and timeline | G3: idempotency and reconciliation |
| PR4 | Accessibility, tests and security | G4: quality and tenant isolation |
| PR5 | Feature-flag rollout and docs | G5: pilot signoff and rollback readiness |

## Definition of done

- No new competing canonical state or duplicate billing source of truth.
- Every significant action traces to an authorized server operation with an auditable result.
- External statuses are shown accurately; unknown outcomes remain unknown until reconciled.
- Core tasks are understandable, accessible and completable with fewer navigation detours.
- Regulatory and payer-specific rules are validated by accountable subject-matter owners.
- Regression tests and rollback are documented; no blocked tests represented as passed.

## Copy/paste instruction for Claude Code

```text
Implement the ChartWarden Workflow 27 (Hospice Aggregate Cap) plan in docs/implementation/27-hospice-aggregate-cap-workflow-redesign.md.
First perform WP0 only against the current repository commit.
Do not modify application code, change schema, add dependencies or rewrite payer rules.
Produce the five evidence documents with file:line references, route/state/permission maps,
integration status classification, actual test evidence and a prioritized UX redesign.
Stop and request approval at G0 before beginning WP1.
```
