# ChartWarden — Workflow 41: Staff Identity & Authentication

**Repository destination:** `docs/implementation/41-staff-identity-authentication-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — mandatory WP0 and approval gate  
**Evidence:** Static path verification against uploaded `chartwarden-main.zip`; not a live runtime audit.

## Mission and boundaries

Redesign **Staff Identity & Authentication** as a safe, understandable, task-first experience. Preserve existing backend authorization, patient/agency scoping, clinical and legal controls, event semantics, and auditability. Do not create a second backend workflow or assume capabilities are operational from file names.

## Verified repository starting points

| Existing file | WP0 responsibility |
|---|---|
| `apps/admin/src/shell/auth-client.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/admin/src/shell/auth-screens.tsx` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/credential-lifecycle.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/mfa-enrolment-gate.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/hooks/login-mfa-completed.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/audit/auth-event-audit.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/audit/step-up-audit.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/policy/step-up-resolver.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/02-identity/device-attestation-verifier.ts` | Trace real routes, callers, guards, mutations, state and tests |

## Proposed end-to-end user journey

1. Staff enters agency-specific sign-in without tenant ambiguity.
2. Backend authenticates via current supported provider and requires configured MFA.
3. Staff selects permitted organization context when multiple memberships exist.
4. Session receives server-authoritative permissions and expiry.
5. Sensitive action triggers step-up authentication where policy requires.
6. Staff manages trusted devices, recovery and session revocation.
7. Security staff investigate failed login, lockout, suspicious session and offboarding.

## Proposed information architecture

| Surface | User-facing goal |
|---|---|
| 1. Sign in and organization context | Clear next action, owner, status, safe exception path and contextual help |
| 2. MFA challenge and enrollment | Clear next action, owner, status, safe exception path and contextual help |
| 3. Recovery and account lockout | Clear next action, owner, status, safe exception path and contextual help |
| 4. Sessions and trusted devices | Clear next action, owner, status, safe exception path and contextual help |
| 5. Step-up authorization | Clear next action, owner, status, safe exception path and contextual help |
| 6. Offboarding and access audit | Clear next action, owner, status, safe exception path and contextual help |

## Domain-specific non-negotiable safeguards

- No bypass of MFA or step-up during redesign.
- Account recovery must resist takeover and enumeration.
- Revoked staff membership terminates or invalidates effective access.
- Cross-organization session switching cannot retain prior tenant context.
- Session fixation, CSRF, token replay and refresh rotation.
- Break-glass is separate from ordinary login.
- No secret, token or PHI in telemetry.
- Rust migration/Bun login ownership must be checked at checked-out SHA.

## Workflow-specific acceptance scenarios

- [ ] **S01:** Prove the system handles: no bypass of mfa or step-up during redesign, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S02:** Prove the system handles: account recovery must resist takeover and enumeration, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S03:** Prove the system handles: revoked staff membership terminates or invalidates effective access, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S04:** Prove the system handles: cross-organization session switching cannot retain prior tenant context, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S05:** Prove the system handles: session fixation, csrf, token replay and refresh rotation, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S06:** Prove the system handles: break-glass is separate from ordinary login, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S07:** Prove the system handles: no secret, token or phi in telemetry, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S08:** Prove the system handles: rust migration/bun login ownership must be checked at checked-out sha, with correct user-facing state, backend authorization and audit evidence.
- [ ] **J01:** Demonstrate journey step 1 using synthetic data: staff enters agency-specific sign-in without tenant ambiguity; record expected server response and UI state.
- [ ] **J02:** Demonstrate journey step 2 using synthetic data: backend authenticates via current supported provider and requires configured mfa; record expected server response and UI state.
- [ ] **J03:** Demonstrate journey step 3 using synthetic data: staff selects permitted organization context when multiple memberships exist; record expected server response and UI state.
- [ ] **J04:** Demonstrate journey step 4 using synthetic data: session receives server-authoritative permissions and expiry; record expected server response and UI state.
- [ ] **J05:** Demonstrate journey step 5 using synthetic data: sensitive action triggers step-up authentication where policy requires; record expected server response and UI state.
- [ ] **J06:** Demonstrate journey step 6 using synthetic data: staff manages trusted devices, recovery and session revocation; record expected server response and UI state.
- [ ] **J07:** Demonstrate journey step 7 using synthetic data: security staff investigate failed login, lockout, suspicious session and offboarding; record expected server response and UI state.
- [ ] **X01:** Cross-tenant IDs and cross-patient links are rejected without disclosing record existence.
- [ ] **X02:** Interrupted or concurrent operations never silently overwrite authoritative state.
- [ ] **X03:** Keyboard, screen-reader, responsive and high-zoom paths are verified.
- [ ] **X04:** Audit logs and client telemetry do not leak PHI, tokens or secrets.

## Mandatory WP0 — Evidence-based current-state audit (STOP GATE G0)

1. Read `AGENTS.md`, repository architecture/ADRs, module README files, existing plans 31/37/21/41 if present, and the actual checked-out branch/commit SHA. This uploaded ZIP is a historical snapshot, **not** the authoritative current checkout.
2. Trace each verified starting file through imports, route registration, API handlers, database models, event consumers, auth guards, background jobs, integration adapters and tests. Record actual behavior and distinguish implemented, stubbed, disabled, untested and proposed.
3. Build a user-task map for staff and patient/family roles: entry point, navigation, authoritative state, mutation, actor, permission, source of truth, error, retry and downstream effects.
4. Inventory all existing screens and data contracts. Identify duplicate steps, missing back navigation, stale states, unclear labels, false success, inaccessible dialogs, role confusion and any workflow that requires cross-module navigation.
5. Run only authorized focused static checks and tests. Record commands, exit codes, environmental blockers and whether tests were unit, DOM, integration, live-DB or manual. Never assert a green test without evidence.
6. Produce a KEEP / MODIFY / CONSOLIDATE / DEPRECATE matrix and a before/after journey with mobile and desktop wireframes using **Lantern** design tokens and shared UI components.
7. Identify any backend contract changes separately; prefer a frontend orchestration layer over a second state machine. Note regulatory assumptions requiring compliance approval.
8. Write `docs/implementation/evidence/41-current-state-audit.md`, `docs/implementation/evidence/41-proposed-ux.md`, API/permission matrix, test baseline, risks and open questions. **STOP for explicit approval before WP1.**

**Evidence labels:** `VERIFIED_IN_CODE`, `VERIFIED_BY_TEST`, `OBSERVED_IN_RUNTIME`, `PROPOSED`, `UNKNOWN`. Never present source-file existence as production readiness.

## UX contract

- One obvious entry point and one primary action per stage; preserve current patient, agency and task context across navigation.
- Human-readable status labels must map to **existing authoritative server statuses**; never introduce shadow frontend lifecycle state.
- Surface next action, why it matters, who can perform it, and the direct resolution link.
- Make loading, empty, forbidden, stale, offline, partial, failed and retry states explicit; never imply external delivery or completion without evidence.
- Desktop: clear worklist + focused detail. Mobile: accessible single-column tasks, readable text, large touch targets and reduced cognitive load.
- Use `@chartwarden/ui`, Lantern colors/typography, no generic purple gradients, and preserve screen-reader, keyboard, zoom and high-contrast usability.
- Audit all mutations; protect PHI in analytics, URLs, browser storage, screenshots, email/push previews and errors.

## Engineering packages (after G0 approval)

### WP1 — Navigation and task inventory

- Consolidate entry points into the approved worklist without deleting supported deep links.
- Provide actionable statuses, actor-specific filters, ownership and contextual patient/agency breadcrumbs.
- Add contract tests for routes, back/forward, unauthorized and missing-resource states.

### WP2 — Guided primary workspace

- Implement progressive disclosure using the **existing** API and backend state transitions.
- Present source evidence, required information, edit/review actions and clearly labeled next steps.
- Implement draft handling, stale-data refresh, concurrency conflict messages and safe interruption recovery where backend permits.

### WP3 — Exceptions, safety and authorization

- Add explicit resolution UI for failed, expired, revoked, mismatched, duplicate, unavailable and disputed states relevant to this workflow.
- Maintain backend fail-closed authorization, tenancy and consent checks; do not silently bypass any validation.
- Prove retries are idempotent or clearly document unsupported retry semantics.

### WP4 — Cross-module integration

- Connect existing downstream workflows via authoritative identifiers, API calls and outbox/events rather than copying state.
- Add traceable status and recovery for asynchronous consumers and notifications.
- Verify integration with the adjacent numbered plans before merging; avoid competing UI flows.

### WP5 — Accessibility, reliability and security verification

- Automated unit, component, contract and permission tests; live-DB tests only in permitted safe environments.
- Test desktop and mobile viewports, keyboard navigation, accessible names, focus management, screen reader labels, 200%/400% zoom and error recovery.
- Verify tenant isolation, IDOR, stale session, privilege escalation, audit event completeness and no PHI leakage.

### WP6 — Controlled rollout and documentation

- Release behind existing feature-flag infrastructure if present; avoid inventing new config frameworks.
- Maintain old routes during migration, instrument non-PHI operational outcomes, and document rollback without destructive migrations.
- Update operator instructions, screenshots, user guidance, ADRs and workflow diagrams only after verified behavior.

## Pull request and approval sequence

| PR | Deliverable | Gate |
|---|---|---|
| PR0 | Audit evidence and UX proposal, **no app code changes** | G0: user approval |
| PR1 | Navigation/worklist and accessible empty/error states | Route, authorization and UI checks |
| PR2 | Guided workspace with existing APIs | State and contract parity |
| PR3 | Exception handling and cross-module integrations | Security, concurrency and event tests |
| PR4 | Accessibility, integration tests and rollout documentation | Acceptance and rollback signoff |

Do not start PR1 until G0 is approved. If an integration is missing or a vendor is stubbed, report the gap and request a decision; do not fabricate an operational integration.

## Definition of done

- A real authorized user can complete the target workflow without getting lost or duplicating data entry.
- The new UI has no weaker backend permissions, clinical/consent safeguards or tenant isolation than the original.
- No false status claims; incomplete or unverified external actions are clearly labeled.
- Test evidence, screenshots, known limitations, migration/rollback instructions and operator documentation are attached.
- Relevant reviewers approve UX, security and clinical/legal requirements; production behavior is validated separately from static code inspection.

## Claude Code execution instruction

> Begin with WP0 only. Verify the current repository and every referenced path. Produce the evidence artifacts, a proposed UI journey, API/permission reuse matrix and risk register. Do not change application code or claim a feature works because a file exists. Stop and ask for approval before implementing WP1–WP6.
