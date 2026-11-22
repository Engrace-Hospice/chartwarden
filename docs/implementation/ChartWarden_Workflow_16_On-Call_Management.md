# ChartWarden — Workflow 16: On-Call Management — Implementation Plan

**Destination:** `docs/implementation/16-on-call-management-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — WP0 audit and approval mandatory  
**Baseline:** Static inspection of user-provided `chartwarden-main.zip` (November 2026); no runtime, live database, vendor connectivity, or production behavior verified.  
**Scope:** Existing workflow UX and safe integration with adjacent ChartWarden modules; **not** an unapproved backend rewrite.

## Executive decision

One safe after-hours operating console connecting coverage, incoming calls, triage, urgent escalation, clinical follow-up, and closed-loop handoff.

**Desired outcome:** Clinicians should always know the patient's context, current state, next authorized action, outstanding blockers, and what happens after completion. Prefer consolidating navigation over inventing new clinical data or APIs.

## A. Source evidence to revalidate on the current branch

The following files were **confirmed present in the supplied archive**. Their existence does not establish that a capability works in production.

| Layer | Source file | Audit question |
|---|---|---|
| frontend | `apps/web/src/modules/19-oncall/my-oncall.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/oncall-shifts.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/triage-intake.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/triage-queue.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/triage-panel.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/escalation-inbox.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/triage-transcript.tsx` | Trace actual behavior, state, authorization, and callers |
| frontend | `apps/web/src/modules/19-oncall/paper-reentry.tsx` | Trace actual behavior, state, authorization, and callers |
| backend | `apps/backend/src/modules/19-oncall/clinical/triage-summary.ts` | Trace actual behavior, state, authorization, and callers |
| backend | `apps/backend/src/modules/19-oncall/clinical/verbal-order.ts` | Trace actual behavior, state, authorization, and callers |
| backend | `apps/backend/src/modules/19-oncall/clinical/encounter-link.ts` | Trace actual behavior, state, authorization, and callers |
| backend | `apps/backend/src/modules/19-oncall/consumers/m36-delivery-failed.ts` | Trace actual behavior, state, authorization, and callers |
| backend | `apps/backend/src/modules/19-oncall/consumers/m17-no-show.ts` | Trace actual behavior, state, authorization, and callers |
| test | `apps/backend/__tests__/oncall-clinical.test.ts` | Trace actual behavior, state, authorization, and callers |
| test | `apps/backend/__tests__/oncall-lifecycle.test.ts` | Trace actual behavior, state, authorization, and callers |
| test | `apps/backend/__tests__/oncall-roster.test.ts` | Trace actual behavior, state, authorization, and callers |
| test | `apps/backend/__tests__/oncall-routes.test.ts` | Trace actual behavior, state, authorization, and callers |

**Adjacent-module search:** inspect routes, navigation registrations, patient context, `packages/db` schema, module inventories, shared `@chartwarden/ui` components, event/outbox consumers, API clients, design specifications, and test fixtures. Document exact path and line numbers in WP0. Do not rely on this file list as a complete dependency graph.

## B. Proposed user journey (subject to WP0)

1. **Identify covering clinician and shift availability.**
2. **Receive call and verify caller/patient context.**
3. **Capture complaint, urgency, red flags and initial disposition.**
4. **Escalate to authorized on-call staff with delivery/acknowledgment evidence.**
5. **Document intervention, callback, verbal order or visit linkage.**
6. **Close loop and hand off unresolved work to day team.**

### Screen model

| Surface | Primary purpose | Behavior and constraints |
|---|---|---|
| Worklist | Prioritize today's tasks, overdue items and unresolved exceptions | Filterable, deep-linkable, server-derived status; role-aware |
| Patient/record workspace | Complete one authorized task in context | Clear next action; source facts, timestamps and validation visible |
| Review and sign/resolve | Confirm consequences and preserve attestation | Explicit identity, authoritative server validation, no silent auto-approval |
| History and exceptions | Trace outcomes and recover from failure | Immutable audit context, safe retries and role-gated correction |

## C. Workflow-specific safety and regulatory guardrails

- Emergency triage must not rely on unverified AI suggestions or a silent notification; display emergency escalation instructions clearly.
- Distinguish sent, delivered, acknowledged, accepted and clinically resolved.
- Do not disclose PHI in lock-screen or third-party notifications.
- Verbal orders must follow existing authentication/cosign rules; call logs are not clinical orders.


## 0. Execution contract and non-negotiable constraints

- **WP0 is audit-only.** Record the pinned commit SHA, file/line evidence, actual route contracts, feature flags, schema owners, migrations, permissions, existing tests, and screenshots. **STOP for human approval** before application changes.
- Preserve existing domain state machines, server-authoritative validation, RLS/tenant isolation, RBAC+ABAC, patient-scoped authorization, immutable clinical signatures, event/outbox contracts, and audit history. Never move security or compliance decisions to the browser.
- Do not introduce duplicate canonical data, parallel state machines, silent clinical autofill, invented vendor acknowledgements, or optimistic success for clinical writes. Preserve backend compatibility unless an explicitly approved contract change is necessary.
- Use ChartWarden's existing **Lantern** design tokens and `@chartwarden/ui`; inspect the current source of truth before modifying colors or spacing. No generic purple dashboard styling. Design desktop, tablet, and mobile states; support keyboard navigation, readable labels, WCAG 2.2 AA targets, error recovery, and clear loading/empty/error states.
- Never send PHI to external AI tools, telemetry, logs, screenshots, test fixtures, or analytics. Use synthetic patients and safe identifiers. Protect confidential clinical details, Part 2 data, and minimum-necessary views.
- Do not equate source-code presence with deployed, licensed, integrated, or production-verified functionality. Explicitly mark **verified working / code present unverified / stub / disabled / missing**.
- Avoid new dependencies, database migrations, or backend rewrites unless WP0 establishes a specific need and the owner approves the tradeoff.

## 1. Required WP0 deliverables — no application changes

Create an evidence report under `docs/implementation/evidence/` with the workflow number in the filename. It must include:

1. **Screen map:** all current entry points, route paths, links, modal transitions, role-dependent surfaces, mobile behavior, and dead ends.
2. **Data and state ownership:** canonical entities/tables, read/write routes, DTOs, status transitions, event/outbox consumers, jobs, version/concurrency rules, and adjacent module seams.
3. **Role matrix:** what each relevant role can view, create, edit, approve, sign, override, reopen, export, and audit; include negative access tests.
4. **Usability evidence:** screenshots or recordings from synthetic-data sessions, click counts for common tasks, confusing labels, duplicated controls, stale states, accessibility issues, and error handling.
5. **Compliance and safety matrix:** each applicable rule or policy, source authority, current enforcement location, test evidence, and any unresolved interpretation. Never turn an assumed rule into a hard-coded clinical gate.
6. **Testing inventory:** commands, existing unit/integration/E2E tests, environment prerequisites, failures, skipped/blocked tests, and whether live DB/external systems were actually exercised.
7. **Design decision record:** what will be kept, consolidated, modified, or retired; route compatibility plan; rollout/rollback; exact acceptance criteria and risks.

**Approval gate G0:** Stop and present WP0 findings, proposed screen map, contract impact, and any safety blockers. Do not implement until explicitly approved.

## 2. Target interaction principles

- A single obvious **primary action** per stage; context and exception actions are secondary.
- Patient identity, current status, responsible clinician, and time-critical tasks remain visible without clutter.
- Separate **clinical truth**, **operational progress**, and **external delivery/acknowledgement** statuses. Show who/what established each status.
- Worklists answer: *What needs attention? Why? Who owns it? When is it due? What happens next?*
- Details open in context; returning from a task restores the user's place, filters, and patient selection.
- Show validation errors next to the relevant input, preserve drafts on recoverable failure, and prevent duplicate writes through existing server semantics.
- Use accessible plain-language descriptions while retaining precise clinical terminology where required.

## 3. Standard delivery work packages

### WP1 — Navigation and workflow shell

Build a coherent workflow landing page, patient-context header, next-action summary, task filters, and deep links using existing routes. Avoid introducing a second independent workflow engine. Include desktop/tablet/mobile designs and empty/loading/error states.

### WP2 — Core guided experience

Refactor existing pages into smaller components and stage-oriented views. Reuse existing form contracts, status derivations, clinical validation, and role checks. Preserve direct links and refresh behavior. Do not alter underlying lifecycle semantics to make the UI appear simpler.

### WP3 — Exceptions and safety

Create first-class views for blockers, overdue work, conflicts, rejected actions, and partial/uncertain outcomes. Include accessible recovery instructions and authorized escalation; never hide an unresolved clinical safety condition behind a success badge.

### WP4 — Integration and audit visibility

Make adjacent-module handoffs, authoritative updates, timestamps, responsible actors, provenance, and audit events understandable. Do not perform cross-module database writes in the UI or duplicate backend-owned calculations.

### WP5 — Automated verification and usability

Add focused component tests, API contract tests, authorization/tenant-negative tests, failure/retry/concurrency tests, and synthetic-data E2E paths. Run repository-standard lint, typecheck, relevant tests, and design-token gates; report exact commands/results rather than saying 'all tests pass' without evidence.

### WP6 — Controlled release

Use a reversible feature flag if the repository supports it. Test in a non-production environment, gather clinician feedback, record before/after task completion time and error rate, verify accessibility, and document rollback. No automatic clinical data migrations or hidden status rewrites.

## 4. Pull request sequence

- **PR0:** WP0 audit/evidence/design decision only; mandatory approval.
- **PR1:** Shell, navigation, read-only summary and existing-route compatibility.
- **PR2:** Guided core workflow using existing APIs and permissions.
- **PR3:** Exceptions, clinical safety, provenance, and adjacent workflow handoffs.
- **PR4:** E2E, accessibility, mobile, regression, and release instrumentation.
- **PR5:** Documentation, rollout controls, clinician sign-off, and rollback instructions (if needed).

Each PR must include: scope, screenshots with synthetic data, changed paths, API/state impact, negative tests, commands/results, known limitations, migration/flag status, and rollback plan. Never merge clinical-signature or safety-gate changes based solely on frontend tests.

## 5. Global acceptance criteria

- Existing signed clinical records, source documents, patient identity, audit history, and tenant boundaries remain unchanged by the redesign.
- Every displayed status corresponds to an authoritative server fact or is explicitly labeled as a local draft/proposed action.
- Every clinical write has deterministic loading, success, error, duplicate-submit, and refresh behavior; failures do not fabricate success.
- Roles without permission cannot access actions via direct API calls, not merely hidden buttons.
- Common workflows are completable with keyboard and screen reader; mobile screens do not require horizontal scrolling for primary actions.
- No new critical or high-severity security, clinical safety, or accessibility regressions; unresolved risks are documented and approved.
- Production release requires a tested rollback path and evidence from representative clinical users.

## 6. Claude Code start instruction

> You are implementing the ChartWarden workflow redesign described here. Begin **only with WP0** on the current checkout. Print commit SHA and branch; inspect all listed paths and search for related entry points and contracts. Produce the evidence report and a proposed before/after screen map. Distinguish observed behavior from assumptions. Run safe read-only inspection and relevant non-mutating tests if environment permits. **STOP and request approval before editing application code.** After approval, deliver PRs in order, preserve backend authority, and report test evidence precisely.

## 7. Workflow-specific verification scenarios

Use synthetic data. Implement assertions against **server-side** permissions, not just UI visibility. Add test references and exact results to the evidence report.

1. **T01:** Inbound call opens with correct covering shift.
2. **T02:** No coverage produces explicit escalation fallback.
3. **T03:** Emergency red flag requires appropriate urgent handling.
4. **T04:** Failed delivery never displays as acknowledged.
5. **T05:** Duplicate inbound trigger deduplicates.
6. **T06:** Caller verification protects patient confidentiality.
7. **T07:** Callback deadline and escalation retry are server-driven.
8. **T08:** Shift change preserves open cases and ownership.
9. **T09:** Verbal order remains pending proper authentication.
10. **T10:** Paper reentry records provenance and timestamps.
11. **T11:** Unauthorized users cannot see patient triage notes.
12. **T12:** Cross-tenant notification and patient access blocked.

## 8. Handoff and rollback checklist

- [ ] WP0 evidence report approved by clinical, product, engineering, and security owners.
- [ ] Screens and navigation reviewed with at least one representative authorized user for each relevant discipline.
- [ ] Current routes/API contracts and event consumers preserved or changes explicitly approved.
- [ ] Test matrix includes failure paths, concurrency, unauthorized actor, wrong tenant, and incomplete clinical documentation.
- [ ] All changed pages follow current Lantern tokens and shared components; responsive and keyboard-tested.
- [ ] No PHI in analytics, fixtures, screenshots, AI prompts, or logs.
- [ ] Rollback rehearsed; no destructive data migration; feature flag and deep links documented.
- [ ] Release notes identify verified capabilities separately from stubs/deferred integrations.

## 9. Stop conditions

**Stop and escalate** if the current code differs materially from the assumed module boundaries, if server permissions or signed-record semantics would need to change, if a regulatory requirement is ambiguous, if a third-party integration is not bound, if required live test environments are unavailable, or if tenant isolation cannot be demonstrated. Produce a decision memo rather than guessing.
