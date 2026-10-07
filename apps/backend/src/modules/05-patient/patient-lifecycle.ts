// apps/backend/src/modules/05-patient/patient-lifecycle.ts — GAP-018 / GAP-019 / GAP-012 (backend): the
// port + pure rules behind the §4.3 routes that were specified and never registered — PATCH patient,
// status transition, record-death, identifiers, caregivers, the soft-duplicate review queue (merge /
// not-a-match), unmerge, and the amendment list / staff inbox / statement of disagreement.
//
// Like `merges-db.ts` / `deceased-db.ts` this is NOT part of `PatientRouteService`: the route layer takes
// this port and the composition root (`index.ts`'s `mountPatientRoutes`) binds the Drizzle one
// (`patient-lifecycle-db.ts`), so the in-memory `PatientRouteService` slice is untouched.

/** §2.4.1 edges a human may take through `POST /patients/:id/status`. The M6-driven edges
 *  (prospective→active on admission approval, active/on_hold→discharged on revoke/transfer) stay
 *  reachable for an admin correcting a lagging chart; `deceased` has its own route (cascade + step-up)
 *  and `merged` is reachable only through a merge. */
const MANUAL_EDGES: Readonly<Record<string, ReadonlySet<string>>> = {
  prospective: new Set(["active"]),
  active: new Set(["on_hold", "discharged"]),
  on_hold: new Set(["active", "discharged"]),
  discharged: new Set(["active"]),
  deceased: new Set(),
  merged: new Set(),
};

export const MANUAL_STATUS_TARGETS = ["active", "on_hold", "discharged"] as const;
export type ManualStatusTarget = (typeof MANUAL_STATUS_TARGETS)[number];

export function isAllowedManualTransition(from: string, to: string): boolean {
  return MANUAL_EDGES[from]?.has(to) ?? false;
}

/** Unmerge: a merge may be reversed with `patient.merge` + step-up within this window; beyond it the
 *  spec requires a platform_ops break-glass, which is not built (documented deferral). */
export const UNMERGE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export function isWithinUnmergeWindow(performedAt: Date, now: Date): boolean {
  return now.getTime() - performedAt.getTime() <= UNMERGE_WINDOW_DAYS * DAY_MS;
}

/** The status a source chart returns to on unmerge: the one recorded at merge time, else the safest
 *  non-clinical state (a chart never silently re-enters `active` without an admission). */
export const UNMERGE_FALLBACK_STATUS = "prospective";
/** Key under `patient_merge.merged_field_diff` where the merge records the source's pre-merge status. */
export const SOURCE_PRIOR_STATUS_KEY = "__sourcePriorStatus";

export class InvalidStatusTransitionError extends Error {
  constructor(
    readonly fromStatus: string,
    readonly toStatus: string,
  ) {
    super(`patient status cannot move from '${fromStatus}' to '${toStatus}'`);
    this.name = "InvalidStatusTransitionError";
  }
}
export class MatchReviewNotFoundError extends Error {
  constructor(readonly reviewId: string) {
    super(`match review '${reviewId}' not found`);
    this.name = "MatchReviewNotFoundError";
  }
}
export class MatchReviewClosedError extends Error {
  constructor(
    readonly reviewId: string,
    readonly status: string,
  ) {
    super(`match review '${reviewId}' is already ${status}`);
    this.name = "MatchReviewClosedError";
  }
}
export class MatchReviewNotMergeableError extends Error {
  constructor(readonly reviewId: string) {
    super(`match review '${reviewId}' has no created patient to merge`);
    this.name = "MatchReviewNotMergeableError";
  }
}
export class MergeNotFoundError extends Error {
  constructor(readonly mergeId: string) {
    super(`merge '${mergeId}' not found`);
    this.name = "MergeNotFoundError";
  }
}
export class MergeAlreadyReversedError extends Error {
  constructor(readonly mergeId: string) {
    super(`merge '${mergeId}' was already reversed`);
    this.name = "MergeAlreadyReversedError";
  }
}
export class UnmergeWindowExpiredError extends Error {
  constructor(readonly mergeId: string) {
    super(
      `merge '${mergeId}' is older than ${UNMERGE_WINDOW_DAYS} days; unmerge needs break-glass`,
    );
    this.name = "UnmergeWindowExpiredError";
  }
}
export class SensitiveIdentifierUnsupportedError extends Error {
  constructor(readonly kind: string) {
    super(
      `'${kind}' identifiers are written only through the envelope-encrypted SSN path (deferred)`,
    );
    this.name = "SensitiveIdentifierUnsupportedError";
  }
}
export class IdentifierConflictError extends Error {
  constructor(readonly kind: string) {
    super(`a '${kind}' identifier with that value already exists in this organization`);
    this.name = "IdentifierConflictError";
  }
}
export class PrimaryCaregiverExistsError extends Error {
  constructor() {
    super("the patient already has an open primary caregiver");
    this.name = "PrimaryCaregiverExistsError";
  }
}
export class LegalRepresentativeProofError extends Error {
  constructor() {
    super("a legal representative requires an lrAuthority other than 'none' and a proof document");
    this.name = "LegalRepresentativeProofError";
  }
}
export class AmendmentNotFoundError extends Error {
  constructor(readonly amendmentId: string) {
    super(`amendment '${amendmentId}' not found`);
    this.name = "AmendmentNotFoundError";
  }
}
export class AmendmentNotDeniedError extends Error {
  constructor(readonly amendmentId: string) {
    super(`amendment '${amendmentId}' is not denied; a statement of disagreement follows a denial`);
    this.name = "AmendmentNotDeniedError";
  }
}
export class AmendmentAlreadyDecidedError extends Error {
  constructor(readonly amendmentId: string) {
    super(`amendment '${amendmentId}' was already decided`);
    this.name = "AmendmentAlreadyDecidedError";
  }
}

export interface PatientDemographicsPatch {
  readonly legalFirstName?: string;
  readonly legalMiddleName?: string | null;
  readonly legalLastName?: string;
  readonly legalNameSuffix?: string | null;
  readonly dob?: string;
  readonly sexAssignedAtBirth?: string;
  readonly genderIdentityCode?: string | null;
  readonly sexualOrientationCode?: string | null;
  readonly pronounsCode?: string | null;
  readonly maritalStatusCode?: string | null;
  readonly raceCodes?: readonly string[] | null;
  readonly ethnicityCodes?: readonly string[] | null;
}

export type NewIdentifierKind = "mbi" | "prior_mrn" | "hospice_external" | "partner_mrn";
export interface NewIdentifierInput {
  readonly kind: NewIdentifierKind;
  readonly value: string;
  readonly issuer?: string | null;
  readonly effectiveFrom?: string;
}
export interface IdentifierRecord {
  readonly id: string;
  readonly patientId: string;
  readonly kind: string;
  readonly value: string | null;
  readonly issuer: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface NewCaregiverInput {
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly relationship: string;
  readonly isPrimary?: boolean;
  readonly isLegalRepresentative?: boolean;
  readonly lrAuthority?: string;
  readonly lrProofDocRef?: string | null;
  readonly portalInvitationConsented?: boolean;
  readonly involvementFrom?: string;
  readonly notes?: string | null;
}
export interface CaregiverRecord {
  readonly id: string;
  readonly caregiverId: string;
  readonly patientId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly relationship: string;
  readonly isPrimary: boolean;
  readonly isLegalRepresentative: boolean;
  readonly lrAuthority: string;
  readonly involvementFrom: string;
  readonly involvementTo: string | null;
}

export interface MatchReviewRecord {
  readonly id: string;
  readonly status: string;
  readonly score: number;
  readonly newPatientId: string | null;
  readonly candidateExistingPatientId: string;
  readonly createdAt: string;
  readonly reason: string | null;
}

export interface MergeFieldResolutions {
  readonly [field: string]: { keep: "source" | "target" | "custom"; customValue?: unknown };
}

export interface AmendmentRecord {
  readonly id: string;
  readonly patientId: string;
  readonly scope: string;
  readonly rationale: string;
  readonly status: "pending" | "accepted" | "denied" | "withdrawn";
  readonly denialReason: string | null;
  readonly statementOfDisagreement: string | null;
  readonly receivedAt: string;
  readonly decidedAt: string | null;
  readonly slaDueAt: string;
}

export interface PatientLifecyclePort {
  updateDemographics(
    organizationId: string,
    patientId: string,
    patch: PatientDemographicsPatch,
    actorUserId: string,
  ): Promise<{ patientId: string; changed: readonly string[] }>;
  transitionStatus(
    organizationId: string,
    patientId: string,
    input: { toStatus: ManualStatusTarget; reason?: string },
    actorUserId: string,
  ): Promise<{ patientId: string; fromStatus: string; toStatus: string }>;
  recordDeath(
    organizationId: string,
    patientId: string,
    input: { deceasedDate: string },
    actorUserId: string,
  ): Promise<{
    patientId: string;
    status: "deceased";
    deceasedDate: string;
    alreadyDeceased: boolean;
  }>;
  addIdentifier(
    organizationId: string,
    patientId: string,
    input: NewIdentifierInput,
    actorUserId: string,
  ): Promise<IdentifierRecord>;
  listCaregivers(organizationId: string, patientId: string): Promise<CaregiverRecord[] | null>;
  addCaregiver(
    organizationId: string,
    patientId: string,
    input: NewCaregiverInput,
    actorUserId: string,
  ): Promise<CaregiverRecord>;
  listMatchReviews(
    organizationId: string,
    query: { status: string; limit: number },
  ): Promise<MatchReviewRecord[]>;
  mergeMatchReview(
    organizationId: string,
    reviewId: string,
    input: { fieldResolutions: MergeFieldResolutions; reason: string },
    actorUserId: string,
  ): Promise<{
    reviewId: string;
    mergeId: string;
    sourcePatientId: string;
    targetPatientId: string;
  }>;
  markNotAMatch(
    organizationId: string,
    reviewId: string,
    input: { reason?: string },
    actorUserId: string,
  ): Promise<MatchReviewRecord>;
  unmerge(
    organizationId: string,
    mergeId: string,
    input: { reason: string },
    actorUserId: string,
  ): Promise<{
    mergeId: string;
    sourcePatientId: string;
    targetPatientId: string;
    restoredStatus: string;
  }>;
  listAmendments(organizationId: string, patientId: string): Promise<AmendmentRecord[] | null>;
  listPendingAmendments(
    organizationId: string,
    query: { status: string; limit: number },
  ): Promise<AmendmentRecord[]>;
  recordStatement(
    organizationId: string,
    amendmentId: string,
    input: { statement: string },
    actorUserId: string,
  ): Promise<AmendmentRecord>;
}
