// apps/backend/src/modules/15-discipline-care-plans/routes/index.ts — M15 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M24/M25/M26 routes/index.ts precedent).
export type {
  AideSupervisionRosterMemberView,
  AideSupervisionRosterView,
  AideSupervisoryVisitView,
  DisciplineAssessmentView,
  DisciplineGoalView,
  DisciplineInterventionView,
  DisciplinePlanActionSummary,
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
  OpenDisciplinePlanVersionView,
  OpenDisciplinePlanVersionKind,
  OpenVersionInput,
  OutboxEmission,
  VolunteerHourEntryView,
  WriteOutboxPort,
} from "./write-service";
export { type M15ReadDeps, buildDrizzleM15ReadService } from "./read-service-drizzle";
export {
  AIDE_ROLE_KEYS,
  AIDE_SUPERVISOR_ROLE_KEYS,
  type AideRosterPort,
  type AideRosterStaffRow,
} from "./aide-supervision-roster";
export { type M15WriteDeps, buildDrizzleM15WriteService } from "./write-service-drizzle";
export { type M15ReadActor, type M15WriteActor, systemM15Actor } from "./actor";
export { M15_PAGE_SIZES } from "./read-service";
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

import type { DisclosurePort } from "./disclosure";
import type { M15ReadService } from "./read-service";
import type { M15WriteService } from "./write-service";

/** The two services every M15 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M15RouteServices {
  readonly readService: M15ReadService;
  readonly writeService: M15WriteService;
  /** Overrides the M39-seam SUD verdict the version routes redact snapshots with (tests only). */
  readonly disclosure?: DisclosurePort;
}
