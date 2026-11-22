# ChartWarden — Workflow 43: Agency Onboarding

**Repository destination:** `docs/implementation/43-agency-onboarding-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — WP0 audit and explicit approval required  
**Source:** Static path verification against uploaded `chartwarden-main.zip`; not a live runtime verification.

## Mission

Redesign **Agency Onboarding** as a coherent, accessible, task-first workflow. Keep existing backend ownership and authorization, expose the next required action, and avoid fragmenting a single user task across unrelated admin and agency screens. This plan is a proposed target state, not an assertion that every listed capability is already operational.

## Verified source-file starting points

The following paths exist in the uploaded ZIP. Their behavior, completeness and runtime wiring **must** be established during WP0.

- `apps/admin/src/modules/34-saas-platform/onboarding/wizard-screen.tsx`
- `apps/admin/src/modules/34-saas-platform/onboarding/go-live-panel.tsx`
- `apps/admin/src/modules/34-saas-platform/tenant-provision.tsx`
- `apps/admin/src/modules/34-saas-platform/tenant-progress.tsx`
- `apps/admin/src/modules/34-saas-platform/onboarding/baa-panel.tsx`
- `apps/admin/src/modules/34-saas-platform/onboarding/clearinghouse-panel.tsx`
- `apps/web/src/modules/34-saas/agency-setup.tsx`
- `apps/web/src/modules/34-saas/wizard/wizard-screen.tsx`
- `apps/backend/src/modules/34-saas-tenant-platform/onboarding/wizard-service.ts`
- `apps/backend/src/modules/34-saas-tenant-platform/onboarding/go-live.ts`
- `apps/backend/src/modules/34-saas-tenant-platform/jobs/provision-job-port.ts`
- `apps/backend/src/modules/34-saas-tenant-platform/routes/platform/activation-guards.ts`

## Target end-to-end journey

1. Tenant signup / invitation and identity verification.
2. Organization, legal entity, locations, NPI/provider identifiers and state configuration.
3. BAA, agreements, officer attestations and contract selection.
4. Roles, initial administrators, staff invitation and tenant boundaries.
5. Clearinghouse choice, agency-owned vs platform-managed account, BAA verification.
6. Provisioning progress, failures, retries and support escalation.
7. Readiness review, go-live approval, audit and post-launch handoff.

## Proposed interface architecture

Use a primary workspace with: (1) task list and searchable work queue, (2) concise summary of authoritative status, (3) guided action panel with only relevant inputs, (4) actionable blockers with direct navigation, (5) evidence/history drawer, and (6) explicit outcomes for pending, rejected, retriable and completed states. Display role-appropriate actions; do not hide critical server-side requirements. Provide desktop and tablet/mobile layouts, using existing Lantern tokens.

## Workflow-specific safeguards

- Agency administrator should see a single checklist with “what remains” and why.
- Do not conflate platform tenant provisioning with Medicare enrollment or clinical readiness.
- Prevent go-live if mandatory agreements or security checks are unverified.
- Keep clearinghouse account and BAA status separate from connectivity status.
- Retry provisioning without creating duplicate tenants, staff or billing accounts.
- No cross-tenant leakage through support sessions or onboarding artifacts.

## Mandatory WP0 — current-state audit (STOP / G0)

1. Read `AGENTS.md`, `.claude/rules/`, current architecture/ADRs, existing workflow plans and current branch SHA. The uploaded ZIP is a historical snapshot; current checkout wins.
2. Trace each starting point through router registration, frontend API clients, backend route handlers, services, stores, database schema/RLS, outbox/events, workers, integrations, feature flags and tests. Build an evidence table (`VERIFIED_IN_CODE`, `VERIFIED_BY_TEST`, `OBSERVED_IN_RUNTIME`, `STUB`, `UNKNOWN`, `PROPOSED`).
3. Inventory every user-visible entry point and task, roles/permissions, authoritative lifecycle states, server transitions, failure paths, data ownership, integrations and downstream effects. Distinguish actual production behavior from mocks, flags and unbound ports.
4. Reproduce the current experience with synthetic data where possible. Capture task completion, click paths, accessibility, errors, and screenshots for desktop and mobile. Do not use real PHI or production secrets.
5. Deliver `docs/implementation/evidence/43-current-state-audit.md`, `43-contract-permission-matrix.md`, `43-before-after-ux.md`, `43-test-baseline.md` and `43-risks-open-questions.md`. Document exact commands, exit codes and blockers.
6. Provide KEEP / MODIFY / CONSOLIDATE / DEPRECATE decisions, dependency impact, and an implementation PR breakdown. **STOP and obtain explicit approval before WP1 or any application-code changes.**

## Shared UX and engineering rules

- Use **Lantern** tokens and shared `@chartwarden/ui` components. Do not introduce generic purple gradients, duplicate design tokens, or an independent visual system.
- One task-first workspace with a clear next action, breadcrumbs, contextual status, consistent save/error/success messages, accessible keyboard and screen-reader paths, responsive layouts and high-zoom behavior.
- Keep the server authoritative. Never create a competing frontend state machine or bypass existing clinical, privacy, financial or authorization checks. Backend contract changes require separate ADR, migration and approval.
- Preserve tenant isolation, least privilege, immutable audit provenance, idempotency, replay protection, concurrency safety and PHI-safe logging. Do not expose secrets, payment tokens, prompts or patient content in analytics.
- Use deterministic synthetic fixtures, negative authorization tests, integration failure injection and rollback-capable feature flags. No live external actions in tests without an explicitly approved sandbox.
- Changes must be incremental and independently reviewable. Every PR includes before/after screenshots, a permission impact matrix, regression tests, rollout/rollback notes and observed test results.

## Cross-cutting verification and release gates

- **G0:** Evidence audit reviewed and approved; no implementation prior to approval.
- **G1:** Design and contract mapping approved; role and tenant boundary review complete.
- **G2:** UI implementation passes targeted unit/DOM tests, keyboard and screen-reader checks, responsive checks, and state/error coverage.
- **G3:** Integration and security checks pass using isolated test data; race, retry, timeout, idempotency and audit assertions documented.
- **G4:** Staged rollout with monitoring, support playbook, rollback drill and sign-off by product, security and relevant operational owners.
- Never claim HIPAA compliance, vendor integration success, payment settlement or clinical safety solely from UI/source code. Require operational evidence.

## Claude Code execution contract

Execute **WP0 only** on first run. Report verified findings with `path:line` evidence and SHA; list every uncertain or missing capability. Stop for approval. After approval, execute one WP/PR at a time, keeping changes scoped and preserving existing APIs unless approved. Do not modify unrelated modules, migrate data without an approved plan, enable external billing/AI capabilities, or suppress failing tests. Provide a final change summary, test matrix, risks and rollback instructions.

## Implementation work packages (after G0 approval)

### WP1 — Navigation and design contracts

- Define canonical user tasks and one entry point for **Agency Onboarding**; map legacy routes to new views without breaking deep links.
- Produce annotated desktop/mobile designs, component inventory and server state → UI state table.
- Identify missing APIs separately, with owners, permissions, error codes and migration impacts. Obtain G1 approval.

### WP2 — Shared workspace shell

- Implement the list/detail workspace with accessible filters, role-aware actions, task status, persistent navigation and source-of-truth refresh.
- Reuse existing route guards and typed API clients. Keep existing screens reachable behind a feature flag.
- Unit-test empty/loading/error/partial and access-denied states.

### WP3 — Guided core journey

- Implement each journey stage against existing authoritative endpoints, reusing current domain validation and audit behavior.
- Show actionable blockers and explanatory help; do not fabricate completion when server returns pending or unknown.
- Preserve drafts, concurrency/version checks, retry-safe mutations and context on back/forward navigation.

### WP4 — Exceptions and operational review

- Consolidate failure, review, correction, retry and escalation into an exceptions queue.
- Make history, evidence, actor, timestamps, error reason and permitted next action visible to authorized users.
- Add safe recovery paths; avoid blind retries for non-idempotent external operations.

### WP5 — Integration, authorization and observability

- Add contract tests for UI ↔ backend ↔ store ↔ workers ↔ external adapters, including disabled/unbound providers.
- Verify role/tenant scoping on every read and mutation; check sensitive data redaction in logs, traces and exports.
- Add non-PHI operational metrics for task completion, failures, latency, abandonment and retry counts.

### WP6 — Rollout and deprecation

- Feature-flag rollout to synthetic/staging tenants, then approved pilot agencies; monitor safety and operational metrics.
- Run usability walkthroughs with actual roles using synthetic cases. Record regressions and rollback drill results.
- Remove or redirect redundant UI only after route, permission and audit parity are proven. Do not delete historical records.

## Workflow-specific acceptance scenarios

- [ ] **S01:** Signup/invite creates or locates the correct tenant without duplicate provisioning.
- [ ] **S02:** Agency profile rejects invalid identifiers and supports safe correction.
- [ ] **S03:** BAA absent/expired blocks required downstream steps without hiding explanation.
- [ ] **S04:** Clearinghouse mode changes preserve evidence and require authorization.
- [ ] **S05:** Provisioning job timeout/retry is idempotent and visible.
- [ ] **S06:** Go-live guard denies incomplete onboarding despite UI manipulation.
- [ ] **S07:** Tenant A cannot view or change Tenant B onboarding.
- [ ] **S08:** Revoked onboarding access is enforced on existing sessions.
- [ ] **S09:** Offline/refresh preserves draft state without false completion.
- [ ] **S10:** Read-only support cannot perform privileged activation.
- [ ] **S11:** A refresh, stale session or network loss does not falsely mark an action complete.
- [ ] **S12:** Accessibility at 200% zoom, keyboard-only navigation and screen-reader announcements is verified.
- [ ] **S13:** Two concurrent operators cannot silently overwrite authoritative state.
- [ ] **S14:** Audit and analytics do not leak PHI, payment secrets or authentication credentials.
- [ ] **S15:** Existing routes, contracts and authorized workflows continue working behind the feature flag.

## Proposed pull requests

| PR | Scope | Required gate |
|---|---|---|
| PR0 | Audit, evidence, UX proposal, contract matrix; no application changes | G0 |
| PR1 | Lantern-based workspace shell and route compatibility | G1–G2 |
| PR2 | Guided core journey and server-backed state mapping | G2 |
| PR3 | Exceptions, audit/history, error recovery | G2–G3 |
| PR4 | Integration/security tests and operational metrics | G3 |
| PR5 | Feature-flag pilot, rollout, legacy navigation cleanup | G4 |

## Definition of done

- User can complete the principal journey without guessing which screen contains the next action.
- All relevant authorization, data provenance, financial/clinical safety and tenant boundaries remain server-enforced.
- No capability is labeled operational without observed integration evidence.
- Negative, concurrent, offline/timeout and recovery cases are tested and documented.
- Pilot feedback, change logs, monitoring, rollback and owner approvals are attached to the final PR.
