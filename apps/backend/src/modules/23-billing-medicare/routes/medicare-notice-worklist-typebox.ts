import { pageQuery } from "@chartwarden/shared/route-kit";
import { Type } from "@sinclair/typebox";

const uuid = () => Type.String({ format: "uuid" });
const date = () => Type.String({ format: "date" });
const NOTICE_STATE = Type.Union(
  ["draft", "ready", "submitted", "ack_pending", "ack_accepted", "ack_rejected", "cancelled"].map(
    (value) => Type.Literal(value),
  ),
);
export const MedicareNoticeWorklistQuerySchema = Type.Object({
  ...pageQuery({ max: 100, defaultSize: 50 }),
  type: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("noe"),
        Type.Literal("notr"),
        Type.Literal("transfer"),
        Type.Literal("cancellation"),
      ]),
      { minItems: 1, uniqueItems: true },
    ),
  ),
  // A worklist is provider-scoped: requiring the target lets the route compose the canonical
  // provider_entity_billing_scope guard before any patient/admission identifiers are returned.
  providerEntityId: uuid(),
  patientId: Type.Optional(uuid()),
  admissionId: Type.Optional(uuid()),
  state: Type.Optional(NOTICE_STATE),
  eventFrom: Type.Optional(date()),
  eventTo: Type.Optional(date()),
  deadlineRisk: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
  readiness: Type.Optional(
    Type.Union([
      Type.Literal("blocked"),
      Type.Literal("verification_required"),
      Type.Literal("ready"),
    ]),
  ),
  requiresAttention: Type.Optional(Type.Boolean()),
  exceptionReviewStatus: Type.Optional(Type.String({ minLength: 1, maxLength: 48 })),
});

const Nullable = (schema: ReturnType<typeof Type.String>) => Type.Union([schema, Type.Null()]);
const ReadinessCheckSchema = Type.Object({
  key: Type.String(),
  state: Type.Union(
    ["ready", "blocked", "verification_required", "not_applicable", "unknown"].map((x) =>
      Type.Literal(x),
    ),
  ),
  reasonCode: Nullable(Type.String()),
  message: Type.String(),
  blockingStage: Type.Union([
    Type.Literal("render"),
    Type.Literal("dispatch"),
    Type.Literal("reconciliation"),
    Type.Null(),
  ]),
});
const OperationalIssueSchema = Type.Object({
  identity: Type.Object({
    type: Type.Union([
      Type.Literal("noe"),
      Type.Literal("notr"),
      Type.Literal("transfer"),
      Type.Literal("cancellation"),
    ]),
    noticeId: uuid(),
    kind: Type.Union(
      [
        "deadline_approaching",
        "deadline_due_today",
        "deadline_overdue",
        "mac_rejection",
        "transport_rejected",
        "transport_unavailable",
        "source_or_routing_blocked",
        "artifact_integrity_hold",
        "submission_in_doubt",
        "mac_evidence_pending",
        "exception_review_follow_up",
      ].map((value) => Type.Literal(value)),
    ),
  }),
  severity: Type.Union([Type.Literal("critical"), Type.Literal("warning"), Type.Literal("info")]),
  status: Type.Literal("active"),
  responsibleArea: Type.Union([
    Type.Literal("billing"),
    Type.Literal("organization_administration"),
    Type.Literal("platform_integration"),
    Type.Literal("reconciliation"),
  ]),
  summary: Type.String({ maxLength: 240 }),
  permittedAction: Type.Union([
    Type.Literal("open_notice"),
    Type.Literal("open_dde_queue"),
    Type.Literal("open_noe_exception_review"),
  ]),
});
const PersistedOperationalIssueSchema = Type.Object({
  id: uuid(),
  issueCode: Type.String(),
  status: Type.String(),
  severity: Type.String(),
  responsibleArea: Type.String(),
  assignedMembershipId: Nullable(uuid()),
  acknowledgedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  ddeWorkItemId: Nullable(uuid()),
  version: Type.Integer(),
  updatedAt: Type.String({ format: "date-time" }),
  notificationDeliveryState: Type.Union([
    Type.Literal("pending"),
    Type.Literal("retry_exhausted"),
    Type.Null(),
  ]),
});
export const MedicareNoticeWorklistResponseSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      identity: Type.Object({
        type: Type.Union(["noe", "notr", "transfer", "cancellation"].map((x) => Type.Literal(x))),
        noticeId: uuid(),
      }),
      sourceEventType: Type.String(),
      sourceEventId: Nullable(uuid()),
      patientId: uuid(),
      admissionId: uuid(),
      providerEntityId: uuid(),
      eventDate: date(),
      deadline: Type.Object({
        dueDate: Nullable(date()),
        risk: Type.String(),
        basis: Type.String(),
      }),
      lifecycle: Type.String(),
      latestAttempt: Type.Union([
        Type.Object({ submissionId: uuid(), outcome: Type.String(), dispatchState: Type.String() }),
        Type.Null(),
      ]),
      readiness: Type.Array(ReadinessCheckSchema),
      macAcceptance: Type.Union([
        Type.Literal("verified"),
        Type.Literal("not_verified"),
        Type.Literal("unknown"),
      ]),
      exceptionReview: Type.Union([
        Type.Object({
          status: Type.String(),
          decisionProvenance: Type.Union([Type.Literal("operator_attested_document"), Type.Null()]),
          updatedAt: Type.String(),
          evidenceCount: Type.Integer({ minimum: 0 }),
        }),
        Type.Null(),
      ]),
      nextActions: Type.Array(
        Type.Union([
          Type.Literal("open_notice"),
          Type.Literal("open_noe_exception_review"),
          Type.Literal("open_transfer_notice"),
        ]),
      ),
      operationalIssues: Type.Array(OperationalIssueSchema),
      persistedIssues: Type.Array(PersistedOperationalIssueSchema),
      createdAt: Type.String(),
    }),
  ),
  nextCursor: Nullable(Type.String()),
  hasMore: Type.Boolean(),
  counts: Type.Object({
    scope: Type.Literal("returned_page"),
    total: Type.Integer(),
    requiresAttention: Type.Integer(),
    deadlineApproaching: Type.Integer(),
    overdue: Type.Integer(),
    sourceValidationRequired: Type.Integer(),
    heldByTransportCapability: Type.Integer(),
    inDoubt: Type.Integer(),
    awaitingMacEvidence: Type.Integer(),
    verifiedMacAccepted: Type.Integer(),
    exceptionReviewsPending: Type.Integer(),
    dimensionsOverlap: Type.Literal(true),
  }),
});
