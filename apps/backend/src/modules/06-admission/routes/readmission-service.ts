// apps/backend/src/modules/06-admission/routes/readmission-service.ts — the route-service CONTRACT of the readmission
// / new-admission benefit-period plan. The Drizzle implementation is `../readmission-service-db.ts`; the in-memory
// slice and route tests inject fakes.
import type { BenefitPeriodPlan, BenefitPeriodPlanQuery } from "./readmission-typebox";

export interface ReadmissionService {
  /** The plan for readmitting `admissionId` (`null` = not found / not visible → 404). */
  getReadmissionContext(
    organizationId: string,
    admissionId: string,
    query: BenefitPeriodPlanQuery,
  ): Promise<BenefitPeriodPlan | null>;
  /** The plan for any new admission of `patientId` (a patient we never served gets period 1). */
  getPatientBenefitPeriodPlan(
    organizationId: string,
    patientId: string,
    query: BenefitPeriodPlanQuery,
  ): Promise<BenefitPeriodPlan>;
}

/**
 * The prior election's Medicare close-out (an M23 fact): has a NOTR (8xB) or a final claim been filed for the
 * admission? Bound at the composition root to M23's own query; M6 never reads M23's tables.
 */
export interface PriorElectionClosurePort {
  closureFor(
    organizationId: string,
    q: { readonly admissionId: string; readonly patientId: string },
  ): Promise<{ readonly notrFiled: boolean; readonly finalClaimFiled: boolean }>;
}
