// apps/backend/src/modules/41-billing-commercial/eligibility/store.ts - the persistence port of the eligibility and enrollment lane.
//
// Every method runs under the actor's organization (the Drizzle adapter wraps `withOrgContext`, so RLS applies). None of these
// shapes has a member id: the member id exists only inside `EligibilityService.check`, for the one clearinghouse call.
import type {
  CommercialEligibilityOutcome,
  CommercialEligibilityStalenessPolicy,
  CommercialEnrollmentStatus,
} from "@chartwarden/types";
import type { GateEnrollment, GateRoute } from "./send-gate";

/** Who is acting, for RLS (`app.org_id`) and write-audit attribution (`app.user_id`). */
export interface OrgScope {
  readonly organizationId: string;
  readonly userId: string;
}

export interface PlanRef {
  readonly id: string;
  readonly payerId: string;
  readonly eligibilityStalenessPolicy: CommercialEligibilityStalenessPolicy;
  readonly eligibilityMaxAgeDays: number;
}

export interface StoredEligibilityCheck {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly patientId: string;
  readonly planId: string;
  readonly patientPayerId: string;
  readonly clearinghouseKey: string;
  readonly clearinghousePayerId: string;
  readonly serviceDate: string;
  readonly outcome: CommercialEligibilityOutcome;
  readonly asOfDate: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly checkedByUserId: string;
  /** ISO timestamp. */
  readonly checkedAt: string;
}

export type NewEligibilityCheck = Omit<StoredEligibilityCheck, "id" | "checkedAt">;

export interface StoredEnrollment {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly payerId: string;
  readonly clearinghouseKey: string;
  readonly status: CommercialEnrollmentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly evidenceRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewEnrollment {
  readonly providerEntityId: string;
  readonly payerId: string;
  readonly clearinghouseKey: string;
  readonly status: CommercialEnrollmentStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly evidenceRef: string | null;
}

export interface EnrollmentPatch {
  readonly status?: CommercialEnrollmentStatus;
  readonly effectiveTo?: string | null;
  readonly evidenceRef?: string | null;
}

export interface EligibilityStore {
  loadPlan(scope: OrgScope, planId: string): Promise<PlanRef | null>;
  routesFor(scope: OrgScope, planId: string, clearinghouseKey: string): Promise<GateRoute[]>;
  enrollmentsFor(
    scope: OrgScope,
    providerEntityId: string,
    payerId: string,
    clearinghouseKey: string,
  ): Promise<GateEnrollment[]>;
  findCheckByIdempotencyKey(
    scope: OrgScope,
    providerEntityId: string,
    idempotencyKey: string,
  ): Promise<StoredEligibilityCheck | null>;
  /** Inserts, or returns the row a concurrent request with the same idempotency key already wrote. */
  insertCheck(
    scope: OrgScope,
    row: NewEligibilityCheck,
  ): Promise<{ readonly row: StoredEligibilityCheck; readonly replayed: boolean }>;
  /** Newest first. */
  listChecks(
    scope: OrgScope,
    filter: {
      readonly providerEntityId: string;
      readonly patientId: string;
      readonly planId?: string;
      readonly limit: number;
    },
  ): Promise<StoredEligibilityCheck[]>;
  /** Null when no such plan exists in the organization. */
  setPlanEligibilityPolicy(
    scope: OrgScope,
    planId: string,
    policy: CommercialEligibilityStalenessPolicy,
    maxAgeDays: number,
  ): Promise<PlanRef | null>;
  listEnrollments(
    scope: OrgScope,
    filter: { readonly providerEntityId?: string; readonly payerId?: string; readonly limit: number },
  ): Promise<StoredEnrollment[]>;
  createEnrollment(scope: OrgScope, row: NewEnrollment): Promise<StoredEnrollment>;
  /** Null when no such enrollment exists for the provider entity (RLS hides other tenants). */
  patchEnrollment(
    scope: OrgScope,
    providerEntityId: string,
    id: string,
    patch: EnrollmentPatch,
  ): Promise<StoredEnrollment | null>;
}
