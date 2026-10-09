// apps/backend/src/modules/23-billing-medicare/routes/dde-queue-typebox.ts — request / response TypeBox shapes of
// the DDE work-queue routes (ADR-0052). Named `*-typebox` for the same table-ownership-heuristic reason as
// `billing-typebox.ts`. The route handlers `parse(...)` the request schemas below; the OpenAPI enrichment reuses
// the SAME exports. Notes are capped (and screened for MBI-shaped text by the service); NO MBI is ever stored.
import { Type } from "@sinclair/typebox";

const uuid = () => Type.String({ format: "uuid" });
const isoDate = (description?: string) =>
  Type.String({ format: "date", ...(description ? { description } : {}) });
const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const DDE_NOTES_SCHEMA_MAX = 500;

const ITEM_TYPE = Type.Union([
  Type.Literal("noe"),
  Type.Literal("notr"),
  Type.Literal("claim_entry"),
  Type.Literal("rtp_correction"),
  Type.Literal("adjustment"),
  Type.Literal("cancel"),
  Type.Literal("adr_response"),
]);
const STATE = Type.Union([
  Type.Literal("queued"),
  Type.Literal("assigned"),
  Type.Literal("in_progress"),
  Type.Literal("submitted"),
  Type.Literal("accepted"),
  Type.Literal("returned"),
  Type.Literal("closed"),
  Type.Literal("cancelled"),
]);
const DEADLINE_STATUS = Type.Union([
  Type.Literal("none"),
  Type.Literal("on_track"),
  Type.Literal("at_risk"),
  Type.Literal("overdue"),
  Type.Literal("met"),
  Type.Literal("missed"),
]);
const ACTION = Type.Union([
  Type.Literal("claim"),
  Type.Literal("assign"),
  Type.Literal("start"),
  Type.Literal("record_submission"),
  Type.Literal("record_outcome"),
  Type.Literal("record_acceptance"),
  Type.Literal("retry"),
  Type.Literal("cancel"),
  Type.Literal("close"),
]);
const Notes = Type.String({
  maxLength: DDE_NOTES_SCHEMA_MAX,
  description:
    "Free text, capped. Never put an MBI here (MBI-shaped text is refused). Not copied into events or logs.",
});
const ExpectedVersion = Type.Integer({
  minimum: 0,
  description: "The item `version` the change is applied against (a stale value → 412).",
});
const OutcomeCode = Type.Union(
  [
    Type.Literal("accepted"),
    Type.Literal("accepted_with_edits"),
    Type.Literal("rtp"),
    Type.Literal("rejected"),
    Type.Literal("adr_requested"),
    Type.Literal("other"),
  ],
  { description: "What came back, from a closed set." },
);
const Dcn = Type.String({
  pattern: "^[A-Za-z0-9]{13,23}$",
  description: "The DCN / ICN / receipt number FISS showed (13 to 23 characters).",
});

export const DdeItemIdParamsSchema = Type.Object({ id: uuid() });

export const DdeItemListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  state: Type.Optional(STATE),
  itemType: Type.Optional(ITEM_TYPE),
  assigneeMembershipId: Type.Optional(uuid()),
  providerEntityId: Type.Optional(uuid()),
  patientId: Type.Optional(uuid()),
  overdue: Type.Optional(Type.Boolean()),
  atRisk: Type.Optional(Type.Boolean()),
});

export const CreateDdeItemBodySchema = Type.Object({
  itemType: ITEM_TYPE,
  subjectId: uuid(),
  priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  deadlineAt: Type.Optional(
    isoDate(
      "Operator-set deadline for non-notice items; an NOE/NOTR item takes the notice's window.",
    ),
  ),
  notes: Type.Optional(Notes),
});

export const DdeVersionBodySchema = Type.Object({ expectedVersion: ExpectedVersion });

export const AssignDdeItemBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  assigneeMembershipId: uuid(),
});

export const RecordDdeSubmissionBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  dcn: Type.Optional(Dcn),
  notes: Type.Optional(Notes),
});

/** Returned / rejected outcome (an accepted outcome is `record-acceptance`: it acts on the notice and needs step-up). */
export const RecordDdeOutcomeBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  outcome: Type.Literal("returned"),
  rtpReasonCode: Type.String({
    pattern: "^[A-Z0-9]{1,8}$",
    description: "The RTP / reject reason code.",
  }),
  dcn: Type.Optional(Dcn),
  outcomeCode: Type.Optional(OutcomeCode),
  notes: Type.Optional(Notes),
});

export const RecordDdeAcceptanceBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  macAcceptedOn: Type.Optional(
    isoDate(
      "The date FISS/the MAC accepted it (operator-entered). Required for an NOE/NOTR, where it is stored as the notice's payer_status_date with source dde_manual; not before the election/termination date, not in the future.",
    ),
  ),
  dcn: Type.Optional(Dcn),
  outcomeCode: Type.Optional(OutcomeCode),
  notes: Type.Optional(Notes),
});

export const DdeEventViewSchema = Type.Object({
  eventId: uuid(),
  event: Type.String(),
  fromState: nullable(Type.String()),
  toState: Type.String(),
  attemptNumber: Type.Integer(),
  actorMembershipId: nullable(uuid()),
  actorKind: Type.String(),
  detail: Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Null()])),
  occurredAt: Type.String({ format: "date-time" }),
});

export const DdeItemViewSchema = Type.Object({
  ddeWorkItemId: uuid(),
  organizationId: uuid(),
  providerEntityId: uuid(),
  patientId: uuid(),
  itemType: ITEM_TYPE,
  subjectKind: Type.Union([
    Type.Literal("claim"),
    Type.Literal("noe_record"),
    Type.Literal("notr_record"),
  ]),
  subjectId: uuid(),
  state: STATE,
  attemptNumber: Type.Integer(),
  assigneeMembershipId: nullable(uuid()),
  priority: Type.Integer(),
  source: Type.Union([Type.Literal("manual"), Type.Literal("watchdog")]),
  deadlineAt: nullable(isoDate()),
  deadlineStatus: DEADLINE_STATUS,
  submittedAt: nullable(Type.String({ format: "date-time" })),
  macAcceptedOn: nullable(isoDate()),
  dcn: nullable(Type.String()),
  rtpReasonCode: nullable(Type.String()),
  outcomeCode: nullable(Type.String()),
  notes: nullable(Type.String()),
  allowedActions: Type.Array(ACTION),
  version: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
});

export const DdeItemDetailViewSchema = Type.Composite([
  DdeItemViewSchema,
  Type.Object({ events: Type.Array(DdeEventViewSchema) }),
]);

export const DdeItemListViewSchema = Type.Object({
  items: Type.Array(DdeItemViewSchema),
  nextCursor: nullable(Type.String()),
  hasMore: Type.Boolean(),
});
