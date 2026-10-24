// apps/backend/src/modules/06-admission/routes/nomnc-typebox.ts — milestone 10a TypeBox schemas for the NOMNC /
// expedited-review record-keeping routes. Named `*-typebox` (not `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox import for a Drizzle one. Every typed time is a SEPARATE date and time of day with no
// default for either; closed sets are labels that imply no CMS rule.
import { type Static, type TSchema, Type } from "@sinclair/typebox";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Version = () => Type.Integer({ minimum: 1 });
const Uuid = () => Type.String({ format: "uuid" });
const NullableString = Type.Union([Type.String(), Type.Null()]);

/** A local date and time of day as printed on the notice / told by the QIO. Both optional here so the SERVER can
 *  refuse a missing time with the reason-coded TIME_REQUIRED instead of a generic validation error. */
export const TypedMomentSchema = Type.Object({
  date: Type.Optional(Nullable(Type.String({ maxLength: 10 }))),
  time: Type.Optional(Nullable(Type.String({ maxLength: 5 }))),
});

const RecipientKind = Type.Union([Type.Literal("beneficiary"), Type.Literal("representative")]);
const AcknowledgementKind = Type.Union([
  Type.Literal("signed"),
  Type.Literal("refused"),
  Type.Literal("other"),
]);
const DeadlineKind = Type.Union([
  Type.Literal("appeal_request"),
  Type.Literal("denc_delivery"),
  Type.Literal("records_to_qio"),
  Type.Literal("qio_decision"),
  Type.Literal("other"),
]);
const DecisionOutcome = Type.Union([
  Type.Literal("discharge_upheld"),
  Type.Literal("discharge_reversed"),
  Type.Literal("other"),
]);

export const NomncOverviewQuerySchema = Type.Object({
  dischargeReason: Type.Optional(Type.String({ maxLength: 64 })),
});

export const NoticeParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  noticeId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const ReviewParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  reviewId: Type.String({ minLength: 1, maxLength: 64 }),
});
export const DeadlineParamsSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  deadlineId: Type.String({ minLength: 1, maxLength: 64 }),
});

export const RecordNoticeSchema = Type.Object({
  supersedesId: Type.Optional(Nullable(Uuid())),
  servicesEndOn: Type.String({ format: "date" }),
  delivered: TypedMomentSchema,
  recipientKind: RecipientKind,
  representativeName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  deliveryNote: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  acknowledgementKind: Type.Optional(Nullable(AcknowledgementKind)),
  acknowledgementNote: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  documentId: Type.Optional(Nullable(Uuid())),
  documentVersionId: Type.Optional(Nullable(Uuid())),
  sourceNote: Type.String({ maxLength: 2000 }),
});

export const PatchNoticeSchema = Type.Object({
  ifVersion: Version(),
  deliveryNote: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  acknowledgementKind: Type.Optional(Nullable(AcknowledgementKind)),
  acknowledgementNote: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  documentId: Type.Optional(Nullable(Uuid())),
  documentVersionId: Type.Optional(Nullable(Uuid())),
});

export const WithdrawNoticeSchema = Type.Object({
  ifVersion: Version(),
  reason: Type.String({ maxLength: 2000 }),
});

export const OpenReviewSchema = Type.Object({
  qioName: Type.String({ minLength: 1, maxLength: 300 }),
  qioReference: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  qioNotified: TypedMomentSchema,
  requestedByKind: Type.Union([
    Type.Literal("beneficiary"),
    Type.Literal("representative"),
    Type.Literal("unknown"),
  ]),
});

export const PatchReviewSchema = Type.Object({
  ifVersion: Version(),
  qioReference: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  dencDelivered: Type.Optional(TypedMomentSchema),
  dencDocumentId: Type.Optional(Nullable(Uuid())),
  dencDocumentVersionId: Type.Optional(Nullable(Uuid())),
  recordsSent: Type.Optional(TypedMomentSchema),
  recordsSentNote: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  decision: Type.Optional(
    Type.Object({
      outcome: DecisionOutcome,
      received: TypedMomentSchema,
      note: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
    }),
  ),
  decisionDocumentId: Type.Optional(Nullable(Uuid())),
  decisionDocumentVersionId: Type.Optional(Nullable(Uuid())),
});

export const WithdrawReviewSchema = Type.Object({ ifVersion: Version() });

export const AddDeadlineSchema = Type.Object({
  kind: DeadlineKind,
  label: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  due: TypedMomentSchema,
  sourceNote: Type.String({ maxLength: 2000 }),
  noticeDocumentId: Type.Optional(Nullable(Uuid())),
  noticeDocumentVersionId: Type.Optional(Nullable(Uuid())),
});

export const PatchDeadlineSchema = Type.Object({
  ifVersion: Version(),
  label: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
  due: Type.Optional(TypedMomentSchema),
  sourceNote: Type.Optional(Type.String({ maxLength: 2000 })),
  noticeDocumentId: Type.Optional(Nullable(Uuid())),
  noticeDocumentVersionId: Type.Optional(Nullable(Uuid())),
  satisfy: Type.Optional(Type.Boolean()),
});

// ── responses ────────────────────────────────────────────────────────────────────────────────────────────

export const NoticeViewSchema = Type.Object({
  id: Type.String(),
  admissionId: Type.String(),
  patientId: Type.String(),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("superseded"),
    Type.Literal("withdrawn"),
  ]),
  servicesEndOn: Type.String(),
  deliveredAt: Type.String(),
  deliveredByUserId: NullableString,
  recipientKind: RecipientKind,
  representativeName: NullableString,
  deliveryNote: NullableString,
  acknowledgementKind: Type.Union([AcknowledgementKind, Type.Null()]),
  acknowledgementNote: NullableString,
  documentId: NullableString,
  sourceNote: Type.String(),
  supersededById: NullableString,
  withdrawnReason: NullableString,
  version: Type.Integer(),
  createdAt: Type.String(),
});

export const ReviewViewSchema = Type.Object({
  id: Type.String(),
  admissionId: Type.String(),
  nomncNoticeId: Type.String(),
  state: Type.Union([Type.Literal("open"), Type.Literal("decided"), Type.Literal("withdrawn")]),
  qioName: Type.String(),
  qioReference: NullableString,
  qioNotifiedAt: Type.String(),
  requestedByKind: Type.Union([
    Type.Literal("beneficiary"),
    Type.Literal("representative"),
    Type.Literal("unknown"),
  ]),
  dencDeliveredAt: NullableString,
  dencDocumentId: NullableString,
  recordsSentAt: NullableString,
  recordsSentNote: NullableString,
  decisionOutcome: Type.Union([DecisionOutcome, Type.Null()]),
  decisionReceivedAt: NullableString,
  decisionNote: NullableString,
  decisionDocumentId: NullableString,
  version: Type.Integer(),
  createdAt: Type.String(),
});

export const DeadlineViewSchema = Type.Object({
  id: Type.String(),
  subject: Type.Union([Type.Literal("notice"), Type.Literal("review")]),
  subjectId: Type.String(),
  kind: DeadlineKind,
  label: NullableString,
  dueAt: Type.String(),
  dueLocal: Type.String(),
  zone: Type.String(),
  sourceNote: Type.String(),
  noticeDocumentId: NullableString,
  satisfiedAt: NullableString,
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("due_soon"),
    Type.Literal("past"),
    Type.Literal("satisfied"),
  ]),
  version: Type.Integer(),
});

export const PromptSchema = Type.Object({
  code: Type.String(),
  severity: Type.Union([Type.Literal("warn"), Type.Literal("info")]),
  message: Type.String(),
});

export const NomncOverviewSchema = Type.Object({
  admissionId: Type.String(),
  timeZone: Type.String(),
  activeNotice: Type.Union([NoticeViewSchema, Type.Null()]),
  history: Type.Array(NoticeViewSchema),
  review: Type.Union([ReviewViewSchema, Type.Null()]),
  deadlines: Type.Array(DeadlineViewSchema),
  prompts: Type.Array(PromptSchema),
});

export type RecordNoticeBody = Static<typeof RecordNoticeSchema>;
