// apps/backend/src/modules/20-field-safety/routes/index.ts — M20 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed
// builders the composition root binds (the M15/M16/M19/M21/M24/M25/M26 routes/index.ts precedent).
export type {
  ActiveSosView,
  CheckInFilters,
  DashboardFilters,
  HighRiskAreaFilters,
  IncidentFilters,
  LocationStreamFilters,
  M20ReadService,
  SafetyCheckInView,
  SafetyConsentSurface,
  SafetyConsentView,
  SafetyHighRiskAreaView,
  SafetyIncidentView,
  SafetyMyDayView,
  SafetySosAlertView,
  SafetySubscriptionView,
  SosLocationStreamPage,
  SubscriptionFilters,
} from "./read-service";
export type {
  AcknowledgeSosInput,
  AlertPort,
  AmendCheckInInput,
  CancelSosInput,
  CancelSosResult,
  CoordinateInput,
  CreateHighRiskAreaInput,
  CreateIncidentInput,
  CreateSubscriptionInput,
  DeleteSubscriptionResult,
  GrantConsentInput,
  M20WriteService,
  OshaSignoffInput,
  OutboxEmission,
  PatchHighRiskAreaInput,
  PatchIncidentInput,
  PatchPolicyInput,
  RaiseSosInput,
  RaiseSosResult,
  RecordCheckInInput,
  RecordCheckInResult,
  ResolveSosInput,
  RevokeConsentInput,
  SafetyCipherPort,
  SubmitIncidentInput,
  TransitionIncidentInput,
  WriteOutboxPort,
} from "./write-service";
export {
  type M20ReadDeps,
  type SafetyDecipherPort,
  CHECK_IN_AMENDMENT_GRACE_MINUTES,
  buildDrizzleM20ReadService,
  denyStubSafetyDecipherPort,
} from "./read-service-drizzle";
export { type M20WriteDeps, buildDrizzleM20WriteService } from "./write-service-drizzle";
export {
  type M20MutatingActor,
  type M20ReadActor,
  type M20WriteActor,
  actorOf,
  mutatingActorOf,
  providerEntityOf,
  writeActorOf,
} from "./actor";
export {
  type StoredCoordinates,
  SAFETY_NO_COORDINATE_SENTINEL,
  coordinatesCaptured,
  decodeCoordinates,
  encodeCoordinates,
} from "./coordinates";
export {
  type CursorPage,
  InvalidCursorError,
  M20_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  encodeCursor,
  ifMatchVersion,
  rejectOffsetPagination,
  requireIdempotencyKey,
  toCursorPage,
} from "./concurrency";
export {
  type EffectContext,
  type EffectPatch,
  type SosStateHistoryInsert,
  type SosStateHistoryPort,
  CALLER_OWNED_EFFECT_KINDS,
  MissingSafetyOutboxPayloadError,
  UnknownSafetyEffectError,
  runEffects,
} from "./effects-runner";
export {
  ABAC_ANY,
  ABAC_DASHBOARD,
  ABAC_FIELD_ELIGIBLE,
  ABAC_IN_ORG,
  ABAC_INCIDENT_EDIT,
  ABAC_INCIDENT_SUBJECT,
  ABAC_SELF,
  ABAC_SELF_OR_SUPERVISOR,
  ABAC_SOS_COORDS,
  ABAC_SOS_RESPONDER,
  ABAC_SUPERVISOR,
  ABAC_SUPERVISOR_OR_SELF,
  P,
  STEP_UP,
} from "./guards";

import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

/** The two services every M20 route plugin composes over (bound to Drizzle at the composition root). */
export interface M20RouteServices {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}
