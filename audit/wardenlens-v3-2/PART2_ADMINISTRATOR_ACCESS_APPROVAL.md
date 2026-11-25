# WardenLens V3.2 — Part 2 Administrator Access Approval

- Review date: 2026-11-23
- Reviewer: Fabrice Adjam
- Reviewer role: Privacy Officer / Compliance Officer
- Decision: APPROVED WITH CONDITIONS
- Scope: ADR-0115 and PR #1112
- Repository commit reviewed: 9a8740733
- Effective environments: production
- Re-review date: 2027-02-24 (quarterly, per the review cadence in `docs/compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`)

## Access reviewed

The reviewer considered:

- Tenant `administrator` and `org_admin` access to Part 2/SUD evidence in the WardenLens workspace and page-image routes.
- Platform `superadmin` access through an active, actor-bound, tenant-consented M34 support session.
- The exclusion of exports, external disclosure, writeback, candidate decisions, completion, release and other write operations.
- Target-tenant M4 read auditing: fail-closed on the platform superadmin routes, best-effort on the tenant administrator routes.
- Passkey/MFA requirements for privileged roles.
- The accepted risks documented in ADR-0115 and `docs/compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`.

## Minimum-necessary determination

> Drafted by engineering from ADR-0115; adopted by the reviewer on signing (2026-11-23).

- Tenant `administrator` / `org_admin`: needs to inspect Part 2 evidence to route and administer the intake queue. Without it the source packet is redacted and the intake workflow is blocked. Scope is the WardenLens workspace and source-page image routes only: no exports, portal, external disclosure, writeback, candidate decisions, completion or release. Requires `intake.review`, an active org-bound membership, tenant RLS, a human actor and an M4 read audit (best-effort on this path; see Accepted risk).
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
- Tenant-administrator reads are audited best-effort: if the M4 audit write fails, the pages are still returned and the failure is only logged. Only the platform superadmin routes fail closed. Accepted as a known gap; the follow-up is to set `failClosed` on the two tenant workspace and page routes. Review by 2027-01-31.
- The target-tenant read audit records the ChartWarden operator's identity, source IP and user agent, so the tenant can see who read its Part 2 data.
- Reads carry no Part 2 marker on the support-session ledger or the critical audit, and no per-read grantor alert names Part 2 sensitivity. The access does not rely on a Part 2 elevation guard.
- Mitigations relied on: privileged-role assignment, passkey/MFA, tenant and support-session isolation, route scoping, read auditing, and the quarterly access review in `docs/compliance/WARDENLENS_PART_2_ADMINISTRATOR_ACCESS.md`.

## Conditions

- This branch is not merged, and access is not enabled in production, until `PRIVILEGED_FACTOR_DEPLOYMENT.md` records a completed verification of the privileged-factor prerequisite below.
- Staff second factors are enrolled before `CHARTWARDEN_MFA_ENFORCEMENT=true` is set, so enforcement does not lock anyone out.

## Privileged-factor prerequisite

Production access is conditioned on:

- `CHARTWARDEN_MFA_ENFORCEMENT=true`
- passkey enrollment for every `superadmin`
- passkey-protected support-session start
- retained deployment verification evidence

## Approval

I approve the access policy described above subject to the recorded conditions.

Revision 2: corrected the tenant-administrator audit statement, added the conditions, and moved the reviewed commit to `9a8740733`, which adds: a patient-scoped grant reads a batch only when the filed patient is proven; the platform read writes no intake or clinical row; a 403 refusal writes its own denial audit; the target-tenant read audit shows the ChartWarden operator's identity; reads carry no Part 2 marker. Signed 2026-11-24; the first signature is in commit `08bbadf51`.

- Reviewer name: Fabrice Adjam
- Reviewer role: CEO / Privacy/Compliance
- Approval date: 2026-11-24
- Signature or approval-system reference: Fabrice Adjam, Privacy Officer (interim), 2026-11-24

Designated authority: Privacy Officer (interim), `docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md`.

## Addendum 1 — no production `superadmin` exists (drafted by engineering 2026-11-25; not in force until the reviewer signs)

Finding: an operator ran the platform-staff query of OPS_RUNBOOK §16.5 on the production database on 2026-11-25 and
supplied the result. The only platform-role holder is `orgadmin@chartwarden.local` (`platform_ops`, `platform_admin`).
No `superadmin` exists, so the WardenLens superadmin route reaches no tenant evidence in production until one is granted.

Effect on the conditions above:

- The merge and production-enablement condition is met when `PRIVILEGED_FACTOR_DEPLOYMENT.md` records the
  `CHARTWARDEN_MFA_ENFORCEMENT=true` verification and a refused password-only sign-in for the platform account. The
  `superadmin`-specific items (a passkey for every `superadmin`; a passkey-protected support-session start) are recorded
  N/A at that time, because no holder exists.
- New condition: no `superadmin` is granted (OPS_RUNBOOK §16.5, under a change ticket) until the deployment record shows
  the variable verified. That holder's passkey enrolment and a passkey-authenticated support-session start are recorded in
  the deployment record before the holder reads any WardenLens evidence.

I approve Addendum 1.

- Reviewer name: Fabrice Adjam
- Approval date:
- Signature or approval-system reference:
