// apps/backend/src/modules/06-admission/routes/discharge-worklist-service.ts — the route-service CONTRACT of the
// end-of-episode worklist. The Drizzle implementation is `../discharge-worklist-service-db.ts`; route tests inject
// fakes.
import type { DischargeWorklistPage, DischargeWorklistQuery } from "./discharge-worklist-typebox";
import type { AdmissionReadScope } from "./service";

export interface DischargeWorklistService {
  /** One bucket page, narrowed to `scope.patientIds` when it is not null (GAP-020, as the census). */
  list(
    organizationId: string,
    query: DischargeWorklistQuery,
    scope: AdmissionReadScope,
  ): Promise<DischargeWorklistPage>;
}
