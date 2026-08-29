// packages/auth/src/roles/org-wide-scope.ts — the ONE answer to "does this actor read the whole org's
// patients without a caseload assignment?" (§6 `caseload_or_scope`, §7.5).
//
// F-096. This list existed FOUR times — M7's care-plan predicates, M9's assessment predicates, M10's
// HOPE predicates and M15's disclosure gate — and the four disagreed. F-092 found `director_of_nursing`
// missing from M7's copy and fixed it by DERIVING the list from the CoP floors, which is the right
// mechanism and was applied to one file: M9 and M10 kept a three-name literal, so a DON went on being
// refused every assessment and every HOPE record outside their own caseload. M15 happened to carry the
// correct four, by hand, which is the same defect waiting for the next floor to change.
//
// A copied constant is not a shared decision. This is the shared decision.
//
// The first three are the platform's oversight roles. The fourth arm is DERIVED, and had to be: M3's
// `SYSTEM_LOCKED_FLOORS` is the platform's statement of which CoP-required roles may never LOSE a
// permission, and two of those floors lock `patient.read` on — `medical_director` (CoP 418.102) and
// `director_of_nursing` (CoP 418.64(a)). A role the platform refuses to let a tenant strip
// `patient.read` from is a role the platform has already decided reads patients; denying it every chart
// it is not personally assigned to contradicts that decision in the same codebase. The DON's floor also
// carries `patient.assign` — the permission to PUT clinicians on caseloads — which cannot be exercised
// against patients the holder may not see. Deriving means the next CoP floor that locks `patient.read`
// on does not have to be found by hand, in four files.
//
// `org_admin` is deliberately NOT here, even though ~10 predicates across M20/M22/M23/M24/M25/M32/M33/
// M34 treat it as the tenant's top authority and the demo admin holds it. It carries no `patient.read`
// floor, so the platform has never asserted that role reads charts, and an org-wide PHI bypass for a
// business role is the kind of quiet widening this control exists to prevent. An org_admin who needs a
// chart holds a clinical role, holds an assignment, or breaks glass — which is audited.
import { SYSTEM_LOCKED_FLOORS } from "./templates";

/** The permission whose CoP floor makes a role an org-wide patient reader. */
const PATIENT_READ = "patient.read";

/**
 * Roles that read the whole org's patients without a caseload assignment.
 *
 * Sorted and de-duplicated so the value is stable regardless of how the floors are declared — the
 * oversight names and the derived names overlap (`medical_director` is both), and a list whose contents
 * depend on declaration order is a list two readers can disagree about.
 */
export const ORG_WIDE_SCOPE_ROLES: readonly string[] = [
  ...new Set([
    "medical_director",
    "compliance_officer",
    "survey_coordinator",
    ...Object.entries(SYSTEM_LOCKED_FLOORS)
      .filter(([, floor]) => (floor as readonly string[]).includes(PATIENT_READ))
      .map(([role]) => role),
  ]),
].sort();

/**
 * Does this actor's role set grant org-wide patient scope?
 *
 * Exported as a FUNCTION as well as a list because the two consumers need different things and both
 * need the same answer: an ABAC predicate asks it of an `AbacContext.roles`, and a read path asks it to
 * decide whether to narrow a query at all. §7.5's list half cannot be enforced by a preHandler — a
 * guard can refuse a collection but cannot filter one — so the determination has to be callable from
 * outside the predicate registry, which is why it no longer lives inside a predicate.
 */
export function hasOrgWideScope(roles: readonly string[]): boolean {
  return roles.some((role) => ORG_WIDE_SCOPE_ROLES.includes(role));
}
