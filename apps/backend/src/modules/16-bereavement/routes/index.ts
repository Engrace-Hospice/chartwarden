// apps/backend/src/modules/16-bereavement/routes/index.ts — M16 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M15/M24/M25/M26 routes/index.ts precedent).
export type {
  BereavedContactRowView,
  BereavementClosureView,
  BereavementOutreachRowView,
  BereavementPlanDetail,
  BereavementPlanListItem,
  BereavementRiskScoreView,
  CounselorDashboardView,
  M16ReadService,
  SupervisorDashboardView,
} from "./read-service";
export type {
  AlertPort,
  BereavementContactLogView,
  M16WriteService,
  OutboxEmission,
  PlanActivationView,
  ScheduleRegenerationView,
  WriteOutboxPort,
} from "./write-service";
export { type M16ReadDeps, buildDrizzleM16ReadService } from "./read-service-drizzle";
export { type M16WriteDeps, buildDrizzleM16WriteService } from "./write-service-drizzle";
export {
  type M16MutatingActor,
  type M16ReadActor,
  type M16WriteActor,
  actorOf,
  mutatingActorOf,
  writeActorOf,
} from "./actor";
export {
  type CursorPage,
  M16_PAGE_SIZES,
  decodeCursor,
  encodeCursor,
  ifMatchVersion,
  toCursorPage,
} from "./concurrency";
export {
  type BereavementDisclosureDecision,
  type BereavementDisclosurePort,
  type BereavementRedactedCategory,
  PORTAL_SELF_DISCLOSURE,
  isBereavementVolunteer,
  resolveBereavementDisclosure,
  seamBereavementDisclosurePort,
} from "./disclosure";
export {
  type EffectContext,
  type EffectPatch,
  MissingOutboxPayloadError,
  UNHANDLED_EFFECT_KINDS,
  runEffects,
} from "./effects-runner";

import type { M16ReadService } from "./read-service";
import type { M16WriteService } from "./write-service";

/** The two services every M16 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M16RouteServices {
  readonly readService: M16ReadService;
  readonly writeService: M16WriteService;
}
