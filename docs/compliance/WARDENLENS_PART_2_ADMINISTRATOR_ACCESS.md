# WardenLens Part 2 tenant-administrator access policy

**Product decision recorded:** 2026-11-23

**Production effective status:** Pending designated Privacy/Compliance approval and privileged-factor deployment evidence

**Decision authority:** Product owner, recorded in [ADR-0115](../adr/ADR-0115-wardenlens-tenant-administrator-part-2-review-access.md); Privacy/Compliance applicability review not yet recorded

**Applies to:** Module 22 WardenLens intake review only

## Policy statement

A human actor who holds the tenant-owned `administrator` or `org_admin` role may inspect Part 2/SUD information when needed to administer an intake review. The platform-owned `superadmin` is approved for the same purpose only through the dedicated, read-only, support-session-aware platform path; it remains denied on the generic tenant route. This is internal treatment/health-care-operations access within the tenant. It is not patient authorization for a disclosure or redisclosure.

Both exceptions are limited to the WardenLens workspace response and its source-page image response. They do not grant access through exports, portal views, external interfaces, downloads, or any other document surface. The superadmin path additionally depends on an active tenant-consented support session and remains read-only.

## Required controls

- The request must have an active tenant-bound staff membership and `intake.review`.
- Tenant RLS remains authoritative; the exception never changes `app.org_id` or uses a bypass-RLS connection.
- The actor must be human. AI and system principals are denied.
- Every reserved platform role, including `superadmin` and `platform_ops`, is denied on the generic tenant route. The dedicated platform route requires an exact human `superadmin`, then M34 proves an active actor-bound support session, an unexpired/unrevoked non-assist grant, and organization/patient scope. The client organization id and session id are lookup keys only; neither is trusted as authority.
- Each successful platform read appends an `ops.read` support-session ledger event and a critical `support_session.wardenlens_read` audit before disclosure. The event contains identifiers and authorization basis, never extracted values or source-image content.
- M22 performs the clinical read through its org-explicit tenant-RLS service. The M34 platform connection authorizes and audits but never queries clinical document tables.
- Every successful workspace or page-image read remains subject to the M4 PHI read-audit hook, which records the tenant, actor, resource, request/correlation identifiers, source IP, user agent and time.
- The exception grants read access only. Review ownership, candidate decisions, SUD adjudication, high-risk clinical licensing, source confirmation, completion, release, provenance, writeback and audit rules are unchanged.
- Consent and redaction controls remain mandatory on every downstream disclosure, redisclosure, portal, export and external-interface path.
- Production activation requires `CHARTWARDEN_MFA_ENFORCEMENT=true`; the existing passkey requirement for `superadmin` and passkey-protected support-session start must be operational. M34's separate two-minute elevation is a PHI-write window and is not sufficient or required for these GET-only routes; Part 2-heightened sessions remain ineligible for that write elevation. Release evidence must show the privileged-factor conditions.

## Administrative safeguards

- Tenants grant `administrator` and `org_admin` only to workforce members whose intake-administration duties require org-wide access. ChartWarden limits `superadmin` to the named custodians governed by ADR-0112.
- The existing MFA policy for privileged roles must be enforced in production.
- The tenant Privacy/Compliance Officer owns a quarterly review of the complete `administrator` and `org_admin` assignment population and a sample of WardenLens Part 2 reads. The retained evidence records reviewer, period, population, exceptions, remediation owner and due date. ChartWarden's Security/Compliance owner performs the equivalent review for every `superadmin` holder and its WardenLens access events.
- Role assignments are also removed promptly on workforce-status changes; the quarterly review does not replace offboarding.
- Suspected misuse is investigated through the M4 access trail and the tenant's incident-response process.
- The designated Privacy/Compliance authority must approve the Part 2 applicability/minimum-necessary analysis and accepted risk before merge or deployment. The approval, reviewer, date, scope and any conditions are retained with the release evidence.

## Accepted risk and residual

This policy deliberately widens access: compromise or misuse of a tenant-administrator account can expose SUD information in every WardenLens intake packet belonging to that tenant. Once the deferred support-session path is implemented, compromise of `superadmin` could expose the same information in any tenant context the account is otherwise authorized to enter. The mitigating controls are privileged-role assignment, passkey/MFA, tenant/support-session isolation, route scoping and read auditing.

The current read-audit event proves who read which workspace or which intake batch's page-image endpoint, but it does not record the page number or store a separate `administrator_override` authorization-basis field. The deterministic role policy and role history reconstruct the basis. Adding a dedicated non-PHI page/authorization marker is a detective-control enhancement and must not copy PHI or extracted values into the audit event.

The generic intake route has no M34 support-session context and a platform `superadmin` cannot be a tenant member under ADR-0112. The dedicated platform route therefore composes M22 and M34 only at the application root through a narrow port; it does not create tenant membership or a generic bypass. The tenant `administrator` and `org_admin` paths do not depend on that platform composition.

## Evidence and verification

- Authorization implementation: `apps/backend/src/modules/22-documents/extraction/review-workspace-routes.ts`
- Support-session authorization and audit adapter: `apps/backend/src/modules/34-saas-tenant-platform/wardenlens-support-access.ts`
- Service fail-closed gate: `apps/backend/src/modules/22-documents/extraction/sud-content-gate.ts`
- Regression suite: `apps/backend/__tests__/m22-doclens-sud-gate.test.ts`
- Tenant-isolation and lifecycle suite: `test:f237:doclens-review:live`
- Architecture policy: `docs/architecture/CHARTWARDEN_ARCHITECTURE_v0_11.md`
- Security policy: `docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md`

The regression suite must continue to prove access for human `administrator` and `org_admin` actors and denial for unlicensed non-admin staff, `superadmin`, other platform roles and AI actors (including AI with superadmin-shaped roles), across both generic workspace and page-image reads. The platform route must prove exact-human-superadmin admission; session/grant actor, tenant, expiry, revocation and scope enforcement; tenant-RLS clinical reads; ledger and critical audit writes; and a UI with no tenant decision or lifecycle operations.
