# WardenLens V3.2 — Part 2 Administrator Access Approval

- Review date: 2026-11-23
- Reviewer: Fabrice Adjam
- Reviewer role: Privacy Officer / Compliance Officer
- Decision: APPROVED
- Scope: ADR-0115 and PR #1112
- Repository commit reviewed: 707874893
- Effective environments: production
- Re-review date: 2026-11-23

## Access reviewed

The reviewer considered:

- Tenant `administrator` and `org_admin` access to Part 2/SUD evidence in the WardenLens workspace and page-image routes.
- Platform `superadmin` access through an active, actor-bound, tenant-consented M34 support session.
- The exclusion of exports, external disclosure, writeback, candidate decisions, completion, release and other write operations.
- Fail-closed target-tenant M4 read auditing.
- Passkey/MFA requirements for privileged roles.
- The accepted risks documented in ADR-0115 and `docs/compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`.

## Minimum-necessary determination

> Drafted by engineering from ADR-0115; adopted by the reviewer on signing (2026-11-23).

- Tenant `administrator` / `org_admin`: needs to inspect Part 2 evidence to route and administer the intake queue. Without it the source packet is redacted and the intake workflow is blocked. Scope is the WardenLens workspace and source-page image routes only: no exports, portal, external disclosure, writeback, candidate decisions, completion or release. Requires `intake.review`, an active org-bound membership, tenant RLS, a human actor and a fail-closed M4 read audit.
- Platform `superadmin`: no standing access. Reads only through the dedicated read-only platform routes, with an actor-bound open support session, an active unrevoked tenant-consented grant covering the organization or patient, a passkey-protected session start, and per-read audit (`ops.read` ledger event, critical `support_session.wardenlens_read`, and the target-tenant M4 event).
- Not minimized: administrators reach every WardenLens intake packet in their tenant (org-wide patient scope, ADR-0090). The audit does not record the page number.

## Part 2 applicability determination

> Drafted by engineering from ADR-0115; adopted by the reviewer on signing (2026-11-23). ADR-0115 itself makes no legal conclusion.

- Proposed basis: internal access by the tenant's own workforce for treatment and health-care operations (ADR-0115 decision 7). It is not patient authorization. Patient consent stays authoritative for disclosure and redisclosure, and every export, portal and external path keeps its consent and redaction controls.
- Reviewer determination: platform `superadmin` access under a tenant-consented support session is covered by the tenant's agreements with ChartWarden (qualified service organization / business associate terms). No change required.

## Accepted risk

> Drafted by engineering from ADR-0115; accepted by the reviewer on signing (2026-11-23).

- A compromised tenant-administrator account can read Part 2 content in every WardenLens intake packet of its tenant.
- A compromised `superadmin` can do the same only while it owns an open, tenant-consented support session whose grant covers the patient.
- The read audit does not record the page number or a separate `administrator_override` basis field. Role history and the deterministic policy reconstruct the basis. A dedicated non-PHI marker is a follow-up, not a condition of access.
- Mitigations relied on: privileged-role assignment, passkey/MFA, tenant and support-session isolation, route scoping, read auditing, and the quarterly access review in `docs/compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`.

## Conditions

- None.

## Privileged-factor prerequisite

Production access is conditioned on:

- `CHARTWARDEN_MFA_ENFORCEMENT=true`
- passkey enrollment for every `superadmin`
- passkey-protected support-session start
- retained deployment verification evidence

## Approval

I approve the access policy described above subject to the recorded conditions.

- Reviewer name: Fabrice Adjam
- Reviewer role: CEO/ Privacy/Compliance
- Approval date: 2026-11-23
- Signature or approval-system reference: I approve

The designated Privacy/Compliance reviewer must fill this out. It must not be self-attested by engineering unless that person is formally the designated authority.
