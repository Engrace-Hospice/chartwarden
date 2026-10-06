// @wardenx/billing — NOTR schemas: route #28 `GET /notr-records` (list), #29 `GET /notr-records/:id`
// (detail), #30 `POST /notr-records/:id:submit` (step-up), #31 `POST /notr-records/:id:cancel` — §4.1.
// The NOTR shares the NOE 7-state shape; exactly one trigger-event id is populated per `trigger_kind`.
import { type Static, Type } from "@sinclair/typebox";
import {
  CursorPageQuery,
  IfVersion,
  IsoDateSchema,
  IsoDateTimeSchema,
  NoticeStateApi,
  NotrTriggerKindApi,
  PageOf,
  Uuid,
} from "./common";

// ── route #30: submit ───────────────────────────────────────────────────────────────────────────────────
export const NotrSubmitRequest = Type.Object({ ifVersion: IfVersion });
export type NotrSubmitRequest = Static<typeof NotrSubmitRequest>;

export const NotrSubmitResponse = Type.Object({
  notrId: Uuid,
  state: Type.Literal("SUBMITTED"),
  notrControlNumber: Type.String(),
  submissionId: Uuid,
  enqueuedAt: IsoDateTimeSchema,
});
export type NotrSubmitResponse = Static<typeof NotrSubmitResponse>;

// Errors mirror NOE submit:
//   422 NOTR_OUTSIDE_WINDOW — windowTargetAt < today (already breached); submission proceeds (warning)
//   409 NOTR_NOT_READY      — state != READY
//   412 STALE_VERSION       — If-Match / ifVersion mismatch
//   403 STEP_UP_REQUIRED    — M2 billing-submit session profile not satisfied

// ── route #31: cancel ───────────────────────────────────────────────────────────────────────────────────
export const NotrCancelRequest = Type.Object({
  ifVersion: IfVersion,
  reason: Type.String({ minLength: 20, maxLength: 2000 }),
});
export type NotrCancelRequest = Static<typeof NotrCancelRequest>;

export const NotrCancelResponse = Type.Object({
  notrId: Uuid,
  state: Type.Literal("CANCELLED"),
  version: Type.Integer(),
});
export type NotrCancelResponse = Static<typeof NotrCancelResponse>;

// ── route #28: list ─────────────────────────────────────────────────────────────────────────────────────
export const NotrListQuery = Type.Composite([
  CursorPageQuery,
  Type.Object({
    state: Type.Optional(NoticeStateApi),
    providerEntityId: Type.Optional(Uuid),
    triggerKind: Type.Optional(NotrTriggerKindApi),
    windowTargetBefore: Type.Optional(IsoDateSchema),
    windowBreached: Type.Optional(Type.Boolean()),
  }),
]);
export type NotrListQuery = Static<typeof NotrListQuery>;

export const NotrView = Type.Object({
  notrId: Uuid,
  providerEntityId: Uuid,
  patientId: Uuid,
  admissionId: Uuid,
  triggerKind: NotrTriggerKindApi,
  state: NoticeStateApi,
  effectiveEndDate: IsoDateSchema,
  windowTargetAt: IsoDateSchema,
  windowBreachedAt: Type.Union([IsoDateSchema, Type.Null()]),
  notrControlNumber: Type.String(),
  payerNotrControlNumber: Type.Union([Type.String(), Type.Null()]),
  /** The MAC's answer (migration 0377): the 277CA acceptance date, or the 999 / 277CA rejection + PHI-free codes. */
  acceptedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  rejectedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  rejectionStage: Type.Union([Type.Literal("999"), Type.Literal("277ca"), Type.Null()]),
  rejectionCodes: Type.Array(Type.String()),
  version: Type.Integer(),
  updatedAt: IsoDateTimeSchema,
});
export type NotrView = Static<typeof NotrView>;

export const NotrListResponse = PageOf(NotrView);
export type NotrListResponse = Static<typeof NotrListResponse>;

// ── route #29: detail ───────────────────────────────────────────────────────────────────────────────────
export const NotrDetailResponse = Type.Composite([
  NotrView,
  Type.Object({
    revocationEventId: Type.Union([Uuid, Type.Null()]),
    transferEventId: Type.Union([Uuid, Type.Null()]),
    dischargeEventId: Type.Union([Uuid, Type.Null()]),
    latestSubmissionId: Type.Union([Uuid, Type.Null()]),
    latestAcknowledgmentId: Type.Union([Uuid, Type.Null()]),
    confirmationDocumentId: Type.Union([Uuid, Type.Null()]),
  }),
]);
export type NotrDetailResponse = Static<typeof NotrDetailResponse>;
