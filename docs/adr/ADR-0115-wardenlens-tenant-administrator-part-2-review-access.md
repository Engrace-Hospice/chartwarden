# ADR-0115 — Administrators may inspect Part 2 evidence in WardenLens intake review

- **Status:** **Accepted and implemented** (2026-11-23), by the product owner, who explicitly chose `administrator`, `org_admin`, and `superadmin` access after observing the WardenLens review workspace redact the synthetic 19-document referral. Production activation remains subject to the Privacy/Compliance applicability review and privileged-factor prerequisite below.
- **Date:** 2026-11-23
- **Phase:** WardenLens Unified Review V3.2 authorization correction.
- **Related:** [ADR-0090](ADR-0090-administrator-and-org-admin-org-wide-patient-scope.md) (tenant administrators have org-wide patient scope); [ADR-0112](ADR-0112-superadmin-platform-role.md) (platform `superadmin` normally reaches another tenant only through the consented support-session path); Module 22 §7.4; Security Hardening §5.1.2.

## Context

WardenLens redacted a Part 2/SUD source from a tenant's `administrator` even though that actor had `intake.review` and org-wide patient scope. The existing M22 read gate required a clinical high-risk-review credential for a pending detection and both that credential and patient consent for confirmed content. That rule prevented the tenant administrator responsible for intake operations from inspecting and routing the source packet.

The owner directed that tenant administrators and the platform `superadmin` be able to access all evidence needed to administer the intake review. This is a deliberate widening of internal PHI access. It does not alter the stricter rules for disclosure outside the covered entity.

## Decision

1. A human actor holding the tenant-owned `administrator` or `org_admin` role may read SUD candidate values, detection evidence, and source-page images inside the two WardenLens intake-review read routes without satisfying `extraction_reviewer_eligible(sudReview)` or `sud_consent_present`.
2. The platform-owned `superadmin` uses two dedicated read-only platform routes, never the generic tenant route: `GET /api/v1/platform/organizations/:organizationId/intake/uploads/:id/workspace` and `GET /api/v1/platform/organizations/:organizationId/intake/uploads/:id/pages/:page/image`. M34 proves an exact human superadmin, the actor-bound support-session id, target organization, open/unexpired session, active unrevoked consent grant, and organization- or patient-scope before M22 discloses through its normal tenant-RLS service.
3. The active tenant-admin bypass is limited to `GET /api/v1/intake/uploads/:id/workspace` and `GET /api/v1/intake/uploads/:id/pages/:page/image`. It does not apply to exports, portal access, external disclosures, signed URLs outside this workspace, writeback, or any other module.
4. `intake.review`, an active org-bound membership, tenant RLS, and normal PHI read auditing remain mandatory. The override does not acquire review ownership, approve a candidate, resolve SUD status, release a review, complete a review, or weaken any candidate-level clinical rule.
5. An AI or system principal cannot use either bypass. The generic tenant route denies every reserved platform role, including `superadmin` and `platform_ops`. The platform routes require the exact `superadmin` role and reject tenant administrators, other platform roles, and every non-human actor.
6. The ordinary licensed-reviewer and patient-consent paths remain unchanged for every other actor. A missing or failed role resolution denies the bypass.
7. This is internal treatment/health-care-operations access. Patient consent remains authoritative for downstream disclosure and redisclosure; this decision does not treat administrator access as patient authorization.
8. Production activation requires the designated Privacy/Compliance authority to record its minimum-necessary/applicability review and requires privileged-factor enforcement (`CHARTWARDEN_MFA_ENFORCEMENT=true`, with the existing passkey requirement for future `superadmin` use). This ADR records the engineering and product decision; it does not manufacture that governance approval or make a legal conclusion.
9. M34's `session.elevate` ceremony is a separate, two-minute **PHI-write** elevation and is not required by these GET-only routes. Part 2-heightened sessions deliberately cannot receive that write elevation. Read authority instead comes from the tenant's active PHI-capable consent grant plus the passkey-protected support-session start; the platform UI stays read-only. Adding any platform decision, safeguard, completion, release, writeback, export, or download operation requires a new decision and the appropriate write-elevation policy.
10. Before each disclosure M34 appends an `ops.read` support-session event and a critical `support_session.wardenlens_read` platform audit naming only identifiers and authorization basis. A client-supplied organization id or session id is a lookup key, not authority: it must match the authenticated actor's live session and its grant. M22 then reads the tenant through its ordinary org-explicit RLS service; the platform credential never reads the clinical tables.

## Alternatives considered

- **Keep the licensed-reviewer and consent gate for administrators.** Rejected by the owner because it prevents the tenant administrator from operating the intake queue and reproduces the reported blocked workflow.
- **Give the administrator a synthetic clinical credential or consent.** Rejected because it would falsify clinical and patient-authority records.
- **Let every platform/support role inherit the bypass.** Rejected because it would turn broad platform authority into implicit tenant PHI access. The exception names `superadmin` alone and leaves the ADR-0112 tenant-context/support-session boundary intact.
- **Use break-glass.** Rejected for ordinary intake administration; break-glass is an emergency, time-limited exception and the M22 read gate deliberately remains non-break-glass-bypassable.

## Consequences and accepted risks

- A compromised tenant-administrator account can read Part 2 content for every WardenLens intake packet in its tenant. A compromised `superadmin` can do the same only while it owns a still-open tenant-consented support session whose grant covers the packet's patient. Grant these roles sparingly and enforce their existing passkey/MFA policy.
- Until Privacy/Compliance approval and deployment evidence for privileged-factor enforcement are attached to the release record, this change must remain unmerged/undeployed. The code review and synthetic regression evidence are not substitutes for those administrative controls.
- Successful workspace and page reads continue to produce M4 read-audit events containing the actor, tenant, resource, request, source IP and user agent. The read audit does not currently snapshot the authorization basis as a distinct `administrator_override` field; role history and this deterministic policy reconstruct the basis. A dedicated marker is a follow-up detective-control enhancement, not a condition of access.
- The UI no longer shows “source restricted” solely because Ada Administrator or an org admin lacks an RN/NP/PA/MD credential or Part 2 consent. For a superadmin, the unified workspace accepts only a complete support context and labels the whole experience read-only; a restriction remains correct when the session/grant/scope check fails, and for non-admin users, other platform principals, missing tenant context, or another access failure.
- No database migration, new permission, or batch-decision operation is introduced.
- The platform routes are composed at the application root through a narrow M34-owned port. M22 does not import support-session tables, and M34 does not read clinical tables. This keeps ADR-0112's rule intact: `superadmin` remains a platform-org member and gains no tenant membership or general RLS bypass.

## Verification

`m22-doclens-sud-gate.test.ts` pins pending and confirmed behavior for `administrator`, `org_admin`, licensed and unlicensed staff, `superadmin`, `platform_ops`, and AI actors (including an AI principal carrying the expanded superadmin role set). It verifies both generic routes, proves that tenant-administrator admission does not call the consent predicate, proves that generic routes keep platform roles denied, and proves that only a human superadmin reaches the injected platform port. The unified-workspace DOM suite verifies platform workspace/image URLs and the absence of every write/lifecycle action. The existing F-237 live suite continues to prove tenant RLS, review ownership, decision controls, and the standard non-admin SUD gate. M34 adapter integration must additionally prove grant expiry/revocation, session closure/expiry, actor binding, patient scope, ledger insertion, and critical audit before production activation.
