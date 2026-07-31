// apps/backend/src/modules/15-discipline-care-plans/routes/index.ts — M15 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M24/M25/M26 routes/index.ts precedent).
export type {
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanDetail,
  DisciplinePlanListItem,
  DisciplinePlanSummary,
  DisciplinePlanVersionDetail,
  DisciplinePlanVersionListItem,
  M15ReadService,
  RelevantElementsView,
  SupervisoryCadenceRowView,
  VolunteerAssignmentView,
  VolunteerComplianceGateView,
  VolunteerEffectiveStatusView,
} from "./read-service";
export type {
  M15WriteService,
  OutboxEmission,
  VolunteerHourEntryView,
  WriteOutboxPort,
} from "./write-service";
export { type M15ReadDeps, buildDrizzleM15ReadService } from "./read-service-drizzle";
export { type M15WriteDeps, buildDrizzleM15WriteService } from "./write-service-drizzle";
export { type M15ReadActor, type M15WriteActor, actorOf, writeActorOf } from "./actor";
export {
  type CursorPage,
  M15_PAGE_SIZES,
  decodeCursor,
  encodeCursor,
  ifMatchVersion,
  toCursorPage,
} from "./concurrency";
export {
  type CaseloadPort,
  type DisclosureDecision,
  type DisclosurePort,
  type RedactedCategory,
  SUMMARY_DISCLOSURE,
  actorMayReadPatient,
  resolveDisclosure,
  seamCaseloadPort,
  seamDisclosurePort,
} from "./disclosure";

import type { M15ReadService } from "./read-service";
import type { M15WriteService } from "./write-service";

/** The two services every M15 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M15RouteServices {
  readonly readService: M15ReadService;
  readonly writeService: M15WriteService;
}
