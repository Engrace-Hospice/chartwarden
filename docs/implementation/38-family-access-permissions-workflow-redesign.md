# ChartWarden — Workflow 38: Family Access & Permissions

**Repository destination:** `docs/implementation/38-family-access-permissions-workflow-redesign.md`  
**Executor:** Claude Code  
**Status:** PROPOSED — mandatory WP0 and approval gate  
**Evidence:** Static path verification against uploaded `chartwarden-main.zip`; not a live runtime audit.

## Mission and boundaries

Redesign **Family Access & Permissions** as a safe, understandable, task-first experience. Preserve existing backend authorization, patient/agency scoping, clinical and legal controls, event semantics, and auditability. Do not create a second backend workflow or assume capabilities are operational from file names.

## Verified repository starting points

| Existing file | WP0 responsibility |
|---|---|
| `apps/backend/src/modules/02-identity/portal-invitee-user.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/31-portal/abac-predicates.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/31-portal/permission-keys.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/31-portal/routes/guards.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/39-consent/access-scope.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/backend/src/modules/31-portal/outbox-consumers/m39-consent-revoked.ts` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/portal/src/portal-shell.tsx` | Trace real routes, callers, guards, mutations, state and tests |
| `apps/portal/src/screens/preferences.tsx` | Trace real routes, callers, guards, mutations, state and tests |

## Proposed end-to-end user journey

1. Staff opens patient family-access management.
2. Selects patient and authorized representative; verifies relationship and documented authority.
3. Creates a scoped, expiring invitation using existing backend mechanisms.
4. Recipient redeems invitation and completes required authentication.
5. Recipient sees only authorized patient resources and permitted actions.
6. Staff reviews active access, changes scope or revokes; dependent sessions and caches are invalidated.

## Proposed information architecture

| Surface | User-facing goal |
|---|---|
| 1. Invitation and access roster | Clear next action, owner, status, safe exception path and contextual help |
| 2. Invite / verify authority | Clear next action, owner, status, safe exception path and contextual help |
| 3. Invitation acceptance | Clear next action, owner, status, safe exception path and contextual help |
| 4. Access scope detail | Clear next action, owner, status, safe exception path and contextual help |
| 5. Revoke / expired access resolution | Clear next action, owner, status, safe exception path and contextual help |

## Domain-specific non-negotiable safeguards

- Unverified relationship cannot grant access.
- Cross-tenant patient or invitee enumeration.
- Invitation replay, expiry and wrong recipient.
- Consent revoked while session remains active.
- Family member linked to multiple patients.
- Death, discharge and post-discharge access policies.
- Caregiver identity change and DPOA dispute.
- No PHI in invitation links, notifications or logs.

## Workflow-specific acceptance scenarios

- [ ] **S01:** Prove the system handles: unverified relationship cannot grant access, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S02:** Prove the system handles: cross-tenant patient or invitee enumeration, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S03:** Prove the system handles: invitation replay, expiry and wrong recipient, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S04:** Prove the system handles: consent revoked while session remains active, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S05:** Prove the system handles: family member linked to multiple patients, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S06:** Prove the system handles: death, discharge and post-discharge access policies, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S07:** Prove the system handles: caregiver identity change and dpoa dispute, with correct user-facing state, backend authorization and audit evidence.
- [ ] **S08:** Prove the system handles: no phi in invitation links, notifications or logs, with correct user-facing state, backend authorization and audit evidence.
- [ ] **J01:** Demonstrate journey step 1 using synthetic data: staff opens patient family-access management; record expected server response and UI state.
- [ ] **J02:** Demonstrate journey step 2 using synthetic data: selects patient and authorized representative; verifies relationship and documented authority; record expected server response and UI state.
- [ ] **J03:** Demonstrate journey step 3 using synthetic data: creates a scoped, expiring invitation using existing backend mechanisms; record expected server response and UI state.
- [ ] **J04:** Demonstrate journey step 4 using synthetic data: recipient redeems invitation and completes required authentication; record expected server response and UI state.
- [ ] **J05:** Demonstrate journey step 5 using synthetic data: recipient sees only authorized patient resources and permitted actions; record expected server response and UI state.
- [ ] **J06:** Demonstrate journey step 6 using synthetic data: staff reviews active access, changes scope or revokes; dependent sessions and caches are invalidated; record expected server response and UI state.
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
8. Write `docs/implementation/evidence/38-current-state-audit.md`, `docs/implementation/evidence/38-proposed-ux.md`, API/permission matrix, test baseline, risks and open questions. **STOP for explicit approval before WP1.**

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
