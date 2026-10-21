// @chartwarden/billing — NOE schemas: route #24 `GET /noe-records` (list), #25 `GET /noe-records/:id` (detail),
// #26 `POST /noe-records/:id:submit` (READY → SUBMITTED; emits `m23.noe.submit_requested`; step-up), and
// #27 `POST /noe-records/:id:cancel` (DRAFT/READY → CANCELLED) — §4.1 / §4.2.
import { type Static, Type } from "@sinclair/typebox";
import {
  CursorPageQuery,
  IfVersion,
  IsoDateSchema,
  IsoDateTimeSchema,
  NoticeStateApi,
  PageOf,
  Uuid,
} from "./common";

// ── route #26: submit ───────────────────────────────────────────────────────────────────────────────────
export const NoeSubmitRequest = Type.Object({ ifVersion: IfVersion });
export type NoeSubmitRequest = Static<typeof NoeSubmitRequest>;

export const NoeSubmitResponse = Type.Object({
  noeId: Uuid,
  state: Type.Literal("SUBMITTED"),
  noeControlNumber: Type.String(),
  submissionId: Uuid,
  enqueuedAt: IsoDateTimeSchema,
});
export type NoeSubmitResponse = Static<typeof NoeSubmitResponse>;

// Errors (per §4.2):
//   422 NOE_OUTSIDE_WINDOW — windowTargetAt < today (already breached); submission still proceeds (warning)
//   409 NOE_NOT_READY      — state != READY
//   412 STALE_VERSION      — If-Match / ifVersion mismatch
//   403 STEP_UP_REQUIRED   — M2 billing-submit session profile not satisfied

// ── route #27: cancel ───────────────────────────────────────────────────────────────────────────────────
export const NoeCancelRequest = Type.Object({
  ifVersion: IfVersion,
  reason: Type.String({ minLength: 20, maxLength: 2000 }),
});
export type NoeCancelRequest = Static<typeof NoeCancelRequest>;

export const NoeCancelResponse = Type.Object({
  noeId: Uuid,
  state: Type.Literal("CANCELLED"),
  version: Type.Integer(),
});
export type NoeCancelResponse = Static<typeof NoeCancelResponse>;

// ── route #24: list ─────────────────────────────────────────────────────────────────────────────────────
export const NoeListQuery = Type.Composite([
  CursorPageQuery,
  Type.Object({
    state: Type.Optional(NoticeStateApi),
    providerEntityId: Type.Optional(Uuid),
    /** Filter NOEs whose timely-filing window targets on/before this date (the watchdog worklist). */
    windowTargetBefore: Type.Optional(IsoDateSchema),
    windowBreached: Type.Optional(Type.Boolean()),
  }),
]);
export type NoeListQuery = Static<typeof NoeListQuery>;

export const NoeView = Type.Object({
  noeId: Uuid,
  providerEntityId: Uuid,
  patientId: Uuid,
  admissionId: Uuid,
  state: NoticeStateApi,
  electionEffectiveDate: IsoDateSchema,
  windowTargetAt: IsoDateSchema,
  windowBreachedAt: Type.Union([IsoDateSchema, Type.Null()]),
  noeControlNumber: Type.String(),
  payerNoeControlNumber: Type.Union([Type.String(), Type.Null()]),
  /** The MAC's answer (migration 0377): the 277CA acceptance date, or the 999 / 277CA rejection + PHI-free codes. */
  acceptedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  clearinghouseAcceptedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  rejectedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  rejectionStage: Type.Union([
    Type.Literal("999"),
    Type.Literal("277ca"),
    Type.Literal("clearinghouse"),
    Type.Null(),
  ]),
  rejectionCodes: Type.Array(Type.String()),
  version: Type.Integer(),
  updatedAt: IsoDateTimeSchema,
});
export type NoeView = Static<typeof NoeView>;

export const NoeListResponse = PageOf(NoeView);
export type NoeListResponse = Static<typeof NoeListResponse>;

// ── route #25: detail ───────────────────────────────────────────────────────────────────────────────────
export const NoeDetailResponse = Type.Composite([
  NoeView,
  Type.Object({
    latestSubmissionId: Type.Union([Uuid, Type.Null()]),
    latestAcknowledgmentId: Type.Union([Uuid, Type.Null()]),
    confirmationDocumentId: Type.Union([Uuid, Type.Null()]),
  }),
]);
export type NoeDetailResponse = Static<typeof NoeDetailResponse>;
