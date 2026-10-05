// apps/backend/src/modules/19-oncall/routes/index.ts — M19 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M15/M16/M21/M24/M25/M26 routes/index.ts precedent).
export type {
  CurrentOnCallView,
  EscalationFilters,
  EscalationInboxItem,
  M19ReadService,
  OnCallShiftView,
  OncallPolicyView,
  PaperReentryWorklistView,
  PortalRecentFilters,
  ProtocolFilters,
  ShiftFilters,
  TriageAnswerView,
  TriageCallDetail,
  TriageCallFilters,
  TriageCallListItem,
  TriageCallReadScope,
  TriageEscalationView,
  TriageProtocolQuestionView,
  TriageProtocolView,
  TriageRedactedCategory,
  TriageStateHistoryView,
  TriageTranscriptView,
  VendorBindingView,
  VendorTriageCallView,
} from "./read-service";
export type {
  AlertPort,
  M19WriteService,
  OpenTriageCallResult,
  OutboxEmission,
  AnswerWriteResult,
  WriteOutboxPort,
} from "./write-service";
export {
  type M19ReadDeps,
  type TranscriptCipherPort,
  buildDrizzleM19ReadService,
  denyStubTranscriptCipherPort,
  layDispositionSummary,
} from "./read-service-drizzle";
export {
  type M19WriteDeps,
  type TriageCipherPort,
  buildDrizzleM19WriteService,
} from "./write-service-drizzle";
export {
  type M19MutatingActor,
  type M19ReadActor,
  type M19WriteActor,
  actorOf,
  disciplineOf,
  isPortalActor,
  isVendorActor,
  mutatingActorOf,
  writeActorOf,
} from "./actor";
export {
  type CursorPage,
  InvalidCursorError,
  M19_PAGE_SIZES,
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
  type StateHistoryInsert,
  type StateHistoryPort,
  CALLER_OWNED_EFFECT_KINDS,
  MissingOutboxPayloadError,
  UnknownTriageEffectError,
  runEffects,
} from "./effects-runner";
export {
  ABAC_CALL_ACTOR,
  ABAC_CASELOAD_OR_SCOPE,
  ABAC_ESCALATION_RECIPIENT,
  ABAC_ESCALATION_SCOPE,
  ABAC_IN_ORG,
  ABAC_ONCALL_ELIGIBLE,
  ABAC_PORTAL_CONSENT,
  P,
  STEP_UP,
} from "./guards";

import type { M19ReadService } from "./read-service";
import type { TriageCallRouteDeps } from "./triage-calls.routes";
import type { VendorSessionBindReader } from "./vendor-sessions.routes";
import type { M19WriteService } from "./write-service";

/** The two services every M19 route plugin composes over (bound to Drizzle at the composition root). */
export interface M19RouteServices {
  readonly readService: M19ReadService;
  readonly writeService: M19WriteService;
  /**
   * F-030 — the vendor-session bind gate's narrow read. OPTIONAL: without it the bind route does not
   * mount at all, which is the honest posture for a deployment that has not wired the Drizzle reader
   * (the M25 `ingestService` precedent — absent, never a deny-stub 501 pretending the feature is there).
   */
  readonly vendorSessionBindReader?: VendorSessionBindReader;
  /** GAP-059 — caseload resolver for the triage-call list; defaults to M5's `CaseloadProvider` seam. */
  readonly caseloadPatientIds?: TriageCallRouteDeps["caseloadPatientIds"];
}
