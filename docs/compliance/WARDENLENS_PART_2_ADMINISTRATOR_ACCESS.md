# WardenLens Part 2 tenant-administrator access policy

**Product decision recorded:** 2026-11-23

**Production effective status:** Pending designated Privacy/Compliance approval and privileged-factor deployment evidence

**Decision authority:** Product owner, recorded in [ADR-0115](../adr/ADR-0115-wardenlens-tenant-administrator-part-2-review-access.md); Privacy/Compliance applicability review not yet recorded

**Applies to:** Module 22 WardenLens intake review only

## Policy statement

A human actor who holds the tenant-owned `administrator` or `org_admin` role may inspect Part 2/SUD information when needed to administer an intake review. The platform-owned `superadmin` is approved for the same purpose only through the deferred, support-session-aware path described below; it remains denied on the generic tenant route. This is internal treatment/health-care-operations access within the tenant. It is not patient authorization for a disclosure or redisclosure.

The active tenant-administrator exception is limited to the WardenLens workspace response and its source-page image response. It does not grant access through exports, portal views, external interfaces, platform operations, or any other document surface. The separately deferred superadmin design depends on a consented support session but is not active under this exception.

## Required controls

- The request must have an active tenant-bound staff membership and `intake.review`.
- Tenant RLS remains authoritative; the exception never changes `app.org_id` or uses a bypass-RLS connection.
- The actor must be human. AI and system principals are denied.
- Every reserved platform role, including `superadmin` and `platform_ops`, is denied on the generic tenant route. The approved future `superadmin` path must first prove an active, actor-bound, target-tenant support session with valid consent and current PHI elevation; it must not select a tenant from an unverified client claim or bypass RLS.
- Every successful workspace or page-image read remains subject to the M4 PHI read-audit hook, which records the tenant, actor, resource, request/correlation identifiers, source IP, user agent and time.
- The exception grants read access only. Review ownership, candidate decisions, SUD adjudication, high-risk clinical licensing, source confirmation, completion, release, provenance, writeback and audit rules are unchanged.
- Consent and redaction controls remain mandatory on every downstream disclosure, redisclosure, portal, export and external-interface path.
- Production activation requires `CHARTWARDEN_MFA_ENFORCEMENT=true`; the existing passkey requirement for `superadmin` must be operational. Release evidence must show both conditions. This policy does not claim that the current route independently verifies a fresh factor.

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

The generic intake route currently has no M34 support-session identifier/elevation in its authenticated request context, and a platform `superadmin` cannot be a tenant member under ADR-0112. The role is included in the approved policy, but no cross-tenant superadmin access may be exposed until a server-derived support-session composition verifies the actor, tenant, consent grant, expiry and PHI elevation and persists the override audit before disclosure. The tenant `administrator` and `org_admin` paths do not depend on that deferred platform composition.

## Evidence and verification

- Authorization implementation: `apps/backend/src/modules/22-documents/extraction/review-workspace-routes.ts`
- Service fail-closed gate: `apps/backend/src/modules/22-documents/extraction/sud-content-gate.ts`
- Regression suite: `apps/backend/__tests__/m22-doclens-sud-gate.test.ts`
- Tenant-isolation and lifecycle suite: `test:f237:doclens-review:live`
- Architecture policy: `docs/architecture/CHARTWARDEN_ARCHITECTURE_v0_11.md`
- Security policy: `docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md`

The regression suite must continue to prove access for human `administrator` and `org_admin` actors and denial for unlicensed non-admin staff, `superadmin`, other platform roles and AI actors (including AI with superadmin-shaped roles), across both generic workspace and page-image reads. The eventual superadmin platform route requires its own support-session and RLS matrix.
