// apps/backend/src/modules/16-bereavement/routes/index.ts — M16 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M15/M24/M25/M26 routes/index.ts precedent).
export type {
  BereavedContactRowView,
  ContactTimelineEntry,
  ContactTimelinePage,
  BereavementAssessmentTaskList,
  BereavementAssessmentTaskView,
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
export { type M16DraftDeps, buildDrizzleM16DraftService } from "./draft-service-drizzle";
export type {
  M16DraftService,
  PreDeathDraftView,
  PutPreDeathDraftInput,
} from "./draft-service";
export { type M16LetterDeps, buildDrizzleM16LetterService } from "./letter-service-drizzle";
export { type M16MailingDeps, buildDrizzleM16MailingService } from "./mailing-service-drizzle";
export {
  type M16GroupDeps,
  buildDrizzleM16GroupService,
  withdrawLapsedGroupEnrollments,
} from "./group-service-drizzle";
export type {
  AttendanceResultView,
  CreateGroupInput,
  GroupDetailView,
  GroupEnrollmentView,
  GroupRosterEntry,
  GroupRosterView,
  GroupSessionView,
  GroupView,
  M16GroupService,
  UpdateGroupInput,
} from "./group-service";
export type {
  ListMailingItemsInput,
  ListMailingRunsInput,
  M16MailingService,
  MailingConfigView,
  MailingDownloadView,
  MailingItemCounts,
  MailingItemView,
  MailingRunView,
  PutMailingConfigInput,
} from "./mailing-service";
export type {
  ApprovePhysicianLetterInput,
  DeclinePhysicianLetterInput,
  ListPhysicianLettersInput,
  M16LetterService,
  PhysicianLetterStatus,
  PhysicianLetterView,
} from "./letter-service";
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

import type { M16DraftService } from "./draft-service";
import type { M16GroupService } from "./group-service";
import type { M16LetterService } from "./letter-service";
import type { M16MailingService } from "./mailing-service";
import type { M16ReadService } from "./read-service";
import type { M16WriteService } from "./write-service";

/** The services every M16 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M16RouteServices {
  readonly readService: M16ReadService;
  readonly writeService: M16WriteService;
  /** ADR-0109 D5 — the pre-death risk-assessment draft (addressed by admission, before any plan). */
  readonly draftService: M16DraftService;
  /** ADR-0109 D6 — the physician condolence letter review queue (bereavement oversight only). */
  readonly letterService: M16LetterService;
  /** ADR-0109 D10 — the mailing program: configs, runs, the batch download and confirm-mailed (bereavement oversight only). */
  readonly mailingService: M16MailingService;
  /** ADR-0109 D10 (PR 3) — support groups: groups, sessions, enrollment, roster and attendance. */
  readonly groupService: M16GroupService;
}
