// apps/backend/src/modules/39-consent/access-scope.ts — GAP-109 (M39 spec §4.1 ABAC column, §4.11).
//
// The ONE place M39's per-route access rules live as plain decisions, so the ROUTE guards
// (`./routes/consent-guards.ts` via the predicates registered in `./abac-predicates.ts`) and the SERVICE
// layer (`./scoped-consent-service.ts`) cannot drift apart. Every rule is a function of server-derived
// facts only: the session (org, user, roles, session-pinned patient, break-glass flag) and the STORED
// consent row (its patient, its drafter) — never a body / query / path claim.
//
//   caseload_or_scope  — an org-wide scope role, a session pinned to the patient, or an open care-team
//                        assignment (the M5 `CaseloadProvider` seam; fail-CLOSED when the seam throws).
//   compliance / privacy officer, org admin — role rules; the role set is the authenticated session's.
//   bereavement window — org-scope bereavement oversight, or a membership assigned to the patient's
//                        bereavement plan (an injected port; with none bound that arm DENIES).
//
//   discipline scope  — §4.11: which member roles (disciplines) may read a given consent surface.
//                       Compliance / privacy officers bypass it (and ONLY it).
//   on-call window    — §4.11: an on-call clinician (primary or backup of an ACTIVE shift, per the M19
//                       `OnCallProvider` seam) outside the caseload may READ inside the window. Never a
//                       write, never the post-mortem surface; with no answer from the seam it DENIES.
//                       KNOWN DIVERGENCE: §4.11 scopes this to a session of class `on_call`, but no such
//                       session class exists yet, so the window is NOT session-bound — any member with a
//                       clinical role who is primary/backup of an active shift reads org-wide (Part 2
//                       content included). Product/spec call pending; tighten once the class exists.
//
// INTERNAL callers (outbox consumers, crons, workers) pass the typed {@link CONSENT_SYSTEM_ACTOR}
// marker. It is a distinct `kind`, not a role string: no role set — however it is spelled — satisfies it.
import { hasOrgWideScope } from "@wardenx/auth";
import { getSeam } from "../../bootstrap/index";

/** The explicit marker an internal/system caller passes instead of an authenticated staff actor. */
export const CONSENT_SYSTEM_ACTOR = Object.freeze({
  kind: "system",
  system: "m39_internal",
} as const);
export type ConsentSystemActor = typeof CONSENT_SYSTEM_ACTOR;

/** An authenticated staff session, assembled from `request.context` (never from the request body). */
export interface ConsentStaffActor {
  readonly kind: "staff";
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The one patient a collaborator / portal session is pinned to (server-assembled), else null. */
  readonly sessionPatientId: string | null;
  /** The acting ACTIVE membership (server-assembled from the session), else null. */
  readonly membershipId?: string | null;
  /** Set when the §2.2 break-glass branch opened THIS request; opens consent READS only. */
  readonly breakGlassEventId: string | null;
}

export type ConsentAccessActor = ConsentStaffActor | ConsentSystemActor;

/** The subject facts the pure decisions need (a staff actor, or an `AbacContext` projected onto one). */
export type ConsentAccessSubject = Pick<
  ConsentStaffActor,
  "organizationId" | "userId" | "roles" | "sessionPatientId"
> & {
  /** The acting ACTIVE membership (server-assembled); absent ⇒ the on-call window cannot apply. */
  readonly membershipId?: string | null;
};

export interface CaseloadPort {
  isInCaseload(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
}

export interface BereavementWindowPort {
  /** True when `userId` is assigned to the patient's ACTIVE bereavement plan (counselor / volunteer). */
  isAssignedInWindow(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
}

export interface OnCallWindowPort {
  /** True when `membershipId` is the primary or backup of an ACTIVE on-call shift covering `asOfIso`. */
  isOnCallNow(input: {
    organizationId: string;
    membershipId: string;
    asOfIso: string;
  }): Promise<boolean>;
}

export interface ConsentAccessDeps {
  readonly caseload?: CaseloadPort;
  readonly bereavementWindow?: BereavementWindowPort;
  readonly onCallWindow?: OnCallWindowPort;
  /** Injected clock for the on-call window (tests pin it). */
  readonly now?: () => Date;
}

/** The production caseload port: lazy `getSeam` per call, fail-CLOSED on any throw (§8.7). */
export const seamCaseloadPort: CaseloadPort = {
  async isInCaseload(input) {
    try {
      return await getSeam("CaseloadProvider").isInCaseload(input);
    } catch {
      return false;
    }
  },
};

/**
 * The production on-call port: lazy `getSeam("OnCallProvider")` per call (M19 owns the schedule). A shift
 * counts only while `active` AND `asOf` lies inside its window; a throw (unbound seam deny-stub, outage)
 * is "not on call" — fail-CLOSED.
 */
export const seamOnCallWindowPort: OnCallWindowPort = {
  async isOnCallNow(input) {
    try {
      const shifts = await getSeam("OnCallProvider").activeShiftsAt(
        input.organizationId as never,
        input.asOfIso as never,
      );
      const at = Date.parse(input.asOfIso);
      return shifts.some(
        (shift) =>
          shift.status === "active" &&
          Date.parse(shift.shiftStartsAt) <= at &&
          at < Date.parse(shift.shiftEndsAt) &&
          (shift.primaryOnCallMembershipId === input.membershipId ||
            shift.backupMembershipId === input.membershipId),
      );
    } catch {
      return false;
    }
  },
};

/** Deny-by-default stand-in (no schedule seam bound): nobody is on call. */
export const denyOnCallWindowPort: OnCallWindowPort = {
  async isOnCallNow() {
    return false;
  },
};

/** No bereavement-plan seam resolves a plan from a patient yet, so the assigned arm denies. */
export const denyBereavementWindowPort: BereavementWindowPort = {
  async isAssignedInWindow() {
    return false;
  },
};

const COMPLIANCE_ROLES = ["compliance_officer"] as const;
const PRIVACY_ROLES = ["privacy_officer", "hipaa_privacy_officer"] as const;
const ORG_ADMIN_ROLES = ["org_admin"] as const;
/** Mirror of M16's organization-scoped bereavement-oversight roles (M16 spec §4.8). */
const BEREAVEMENT_OVERSIGHT_ROLES = [
  "clinical_supervisor",
  "director_of_nursing",
  "bereavement_program_coordinator",
  "compliance_officer",
] as const;

const holdsAny = (roles: readonly string[], wanted: readonly string[]): boolean =>
  roles.some((role) => wanted.includes(role));

export const isComplianceOfficer = (roles: readonly string[]): boolean =>
  holdsAny(roles, COMPLIANCE_ROLES);
export const isComplianceOrPrivacyOfficer = (roles: readonly string[]): boolean =>
  holdsAny(roles, COMPLIANCE_ROLES) || holdsAny(roles, PRIVACY_ROLES);
export const isOrgAdminOrCompliance = (roles: readonly string[]): boolean =>
  holdsAny(roles, ORG_ADMIN_ROLES) || holdsAny(roles, COMPLIANCE_ROLES);
export const hasBereavementOversightRole = (roles: readonly string[]): boolean =>
  holdsAny(roles, BEREAVEMENT_OVERSIGHT_ROLES);

/** §4.1 `caseload_or_scope` over a patient. An empty / missing id is nobody's patient: deny. */
export async function decideCaseloadOrScope(
  subject: ConsentAccessSubject,
  patientId: string,
  port: CaseloadPort = seamCaseloadPort,
): Promise<boolean> {
  if (!patientId || !subject.organizationId) return false;
  if (hasOrgWideScope(subject.roles)) return true;
  if (subject.sessionPatientId === patientId) return true;
  if (!subject.userId) return false;
  return port.isInCaseload({
    organizationId: subject.organizationId,
    userId: subject.userId,
    patientId,
  });
}

/**
 * §4.1 `consent_owner_or_compliance` over a consent's patient. The "owner" of a consent is the patient's
 * care team (§4.11: the same caseload attributes as the patient-keyed read), NOT merely whoever drafted
 * it — a drafter who has rotated off the chart must not keep reading Part 2 content. Compliance and
 * privacy officers are the named alternative.
 */
export async function decideOwnerOrCompliance(
  subject: ConsentAccessSubject,
  patientId: string,
  port: CaseloadPort = seamCaseloadPort,
): Promise<boolean> {
  if (isComplianceOrPrivacyOfficer(subject.roles)) return true;
  return decideCaseloadOrScope(subject, patientId, port);
}

/** §4.1 `bereavement_window` over a patient (post-death scope). */
export async function decideBereavementWindow(
  subject: ConsentAccessSubject,
  patientId: string,
  port: BereavementWindowPort = denyBereavementWindowPort,
): Promise<boolean> {
  if (!patientId || !subject.organizationId) return false;
  if (hasBereavementOversightRole(subject.roles)) return true;
  if (!subject.userId) return false;
  try {
    return await port.isAssignedInWindow({
      organizationId: subject.organizationId,
      userId: subject.userId,
      patientId,
    });
  } catch {
    return false;
  }
}

/** §4.1 `is_consent_drafter`: the authenticated user IS the stored row's drafter. */
export const decideIsDrafter = (subject: { userId: string }, createdById: string): boolean =>
  subject.userId.length > 0 && subject.userId === createdById;

/** The consent surfaces §4.11 names a discipline set for. */
export type ConsentDisciplineScope =
  | "consent_management" // routes 3, 4, 11, 14
  | "dpoa_clinical" // route 17
  | "delegated_access" // route 21
  | "post_mortem"; // route 28

/**
 * §4.11 route 17's literal clinical set.
 *
 * `rn` (the plain staff-RN role key the dev seed / tenants use) is NOT in the spec's literal list; it is
 * admitted as the same RN discipline as `rn_case_manager`, mirroring `IDG_ATTENDANCE_DISCIPLINES_BY_ROLE_KEY`
 * (`rn` → `rn_case_manager`), so a tenant using the bare `rn` key keeps the consent reads it had before
 * discipline scoping. `lpn` / aides / chaplains are deliberately not widened here.
 */
const CLINICAL_DISCIPLINES = [
  "rn_case_manager",
  "rn",
  "msw",
  "medical_director",
  "clinical_supervisor",
  "intake_nurse",
  "idg_coord",
  // Prescribers read the consent record of their own caseload patients (an advance directive or DPOA is
  // exactly what a physician or NP needs at the bedside). The caseload and on-call checks still apply.
  "np",
  "md",
  "hospice_physician",
] as const;

/**
 * Roles per surface. `consent_management` is not spelled out in §4.11 ("licensed discipline must include
 * consent-management"): it is the clinical set plus `director_of_nursing` (an org-wide clinical oversight
 * role). Compliance / privacy officers bypass every set (see {@link decideDisciplineScope}).
 */
const DISCIPLINE_ROLES: Readonly<Record<ConsentDisciplineScope, readonly string[]>> = {
  consent_management: [...CLINICAL_DISCIPLINES, "director_of_nursing"],
  dpoa_clinical: [...CLINICAL_DISCIPLINES, "director_of_nursing"],
  delegated_access: [...CLINICAL_DISCIPLINES, "bereavement_counselor"],
  post_mortem: [
    "bereavement_counselor",
    "bereavement_program_coordinator",
    "msw",
    "clinical_supervisor",
  ],
};

/** §4.11: the on-call window applies to every governed read except the post-mortem surface. */
const ON_CALL_SCOPES: ReadonlySet<ConsentDisciplineScope> = new Set([
  "consent_management",
  "dpoa_clinical",
  "delegated_access",
]);

/** §4.11 discipline scope. Compliance and privacy officers bypass it. */
export const decideDisciplineScope = (
  roles: readonly string[],
  scope: ConsentDisciplineScope,
): boolean => isComplianceOrPrivacyOfficer(roles) || holdsAny(roles, DISCIPLINE_ROLES[scope]);

/** §4.11 on-call window: false unless the scope allows it and the port affirms this membership. */
export async function decideOnCallWindow(
  subject: ConsentAccessSubject,
  scope: ConsentDisciplineScope,
  deps: Pick<ConsentAccessDeps, "onCallWindow" | "now"> = {},
): Promise<boolean> {
  if (!ON_CALL_SCOPES.has(scope)) return false;
  if (!subject.organizationId || !subject.membershipId) return false;
  try {
    return await (deps.onCallWindow ?? seamOnCallWindowPort).isOnCallNow({
      organizationId: subject.organizationId,
      membershipId: subject.membershipId,
      asOfIso: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch {
    return false;
  }
}

/**
 * §4.11 read chain over a patient, short-circuiting: a session pinned to the patient (server-derived,
 * not a staff member) passes; otherwise discipline scope, THEN (caseload / owner-or-compliance) OR the
 * on-call window. Reads only — no write consults the on-call arm.
 */
export async function decideConsentReadScope(
  subject: ConsentAccessSubject,
  patientId: string,
  scope: ConsentDisciplineScope,
  deps: ConsentAccessDeps = {},
): Promise<boolean> {
  if (!patientId || !subject.organizationId) return false;
  if (subject.sessionPatientId === patientId) return true;
  if (!decideDisciplineScope(subject.roles, scope)) return false;
  if (await decideOwnerOrCompliance(subject, patientId, deps.caseload)) return true;
  return decideOnCallWindow(subject, scope, deps);
}
