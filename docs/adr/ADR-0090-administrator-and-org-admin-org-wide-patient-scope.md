# ADR-0090 — `administrator` and `org_admin` read every patient in the org

- **Status:** **Accepted** (2026-10-22), by the product owner, who accepted that this widens PHI access against the previously documented design.
- **Date:** 2026-10-22
- **Phase:** Post-build authorization change.
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md); `docs/history/gates-authz-and-routes.md` (F-092, F-096, the origin of the shared list); Module 3 spec §6 `caseload_or_scope`.

## Context

`packages/auth/src/roles/org-wide-scope.ts` is the one shared answer to "does this actor read the whole org's patients without a caseload assignment?" Until now it named `compliance_officer`, `medical_director` and `survey_coordinator`, plus every role whose CoP floor locks `patient.read`. `administrator` and `org_admin` were excluded on purpose: neither carries a `patient.read` floor, so the platform had never asserted that they read charts.

The effect was visible in the demo: the tenant administrator saw 7 of 18 patients (their caseload only), and the New admission patient picker could not find the rest. The product owner decided that tenant administrators must see all patients.

## Decision

1. Add `administrator` and `org_admin` to `ORG_WIDE_SCOPE_ROLES`, as one shared rule applied everywhere the list is consumed. There are no per-module exceptions.
2. No new permission, role or migration. Only the answer to the scope question changes; permission checks, step-up, MFA and audit are unchanged. But that answer is shared by reads AND writes: where a module uses it to waive the caseload check on a mutating route, the waiver now applies to these roles too.

## Consequences (the cost, stated plainly)

Both roles now read **every patient in the org, in every module that asks this question**: census and patient search, admissions, assessments, care plans, HOPE, encounters, orders, **eMAR**, **prescribing (DoseSpot)**, consent, IDG, scheduling, on-call triage, quality, lab lists, FHIR, the portal staff view, discipline care plans and the identity context (`orgWidePatientScope`). **Writes are widened as well as reads** wherever the shared decision gates a mutation: discipline care-plan writes (`actorMayWritePatient`), the order write guards (`actor.orgWide` skips the caseload guard and the draft-supervisor requirement), and care-plan, assessment and HOPE predicates composed on mutating routes. Discipline gates (for example the eMAR administering-clinician check) stay separate and still apply. A write by one of these roles outside a caseload no longer produces the 404 that break-glass audits, so write audit rests on the normal audit trail. It also widens SSN reveal and identifier edit to every chart for those roles (the permission and step-up still apply).

- Any compromised or over-granted tenant-admin account now exposes the whole patient population, not one caseload. Grant these roles sparingly and keep MFA enforced for them.
- Reads are still audited. Reads that were previously a 404 (outside caseload) now succeed and write read-audit rows.
- This reverses the earlier deliberate exclusion recorded in F-096. That history entry is updated to point here.
- Tests that asserted the exclusion (`org-wide-scope.test.ts`, `ssn-grants.test.ts`) now assert the opposite.

## Alternatives not taken

- Org-wide for the census list only, with per-chart reads still caseload-bound. Rejected by the owner in favour of one shared rule.
- A tenant-configurable flag. Rejected for now: a second configuration axis on a PHI control. Revisit if a tenant needs the narrow behaviour.
