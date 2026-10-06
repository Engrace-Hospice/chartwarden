// apps/backend/src/modules/23-billing-medicare/routes/transfer-notice-typebox.ts — request / response TypeBox
// shapes of the Medicare transfer-notice routes (TOB 8xC / corrected 8xC / 8xD; CMS Pub. 100-04 ch. 11 §20.1.3
// / §20.1.4). Named `*-typebox` for the same table-ownership-heuristic reason as `billing-typebox.ts`. The route
// handlers `parse(...)` the request schemas below; the OpenAPI enrichment reuses the SAME exports.
import { Type } from "@sinclair/typebox";

const uuid = () => Type.String({ format: "uuid" });
const isoDate = (description?: string) =>
  Type.String({ format: "date", ...(description ? { description } : {}) });
const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

const NOTICE_STATE = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
  Type.Literal("submitted"),
  Type.Literal("ack_pending"),
  Type.Literal("ack_accepted"),
  Type.Literal("ack_rejected"),
  Type.Literal("cancelled"),
]);
const ACTION = Type.Union([
  Type.Literal("original"),
  Type.Literal("correction"),
  Type.Literal("void"),
]);
const PATIENT_STATUS = Type.Union([Type.Literal("50"), Type.Literal("51")]);

export const TransferNoticeIdParamsSchema = Type.Object({ id: uuid() });

export const TransferNoticeListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  patientId: Type.Optional(uuid()),
  admissionId: Type.Optional(uuid()),
  state: Type.Optional(NOTICE_STATE),
});

const ExpectedVersion = Type.Integer({
  minimum: 0,
  description: "The notice `version` the change is applied against (a stale value → 412).",
});

export const ConfirmPriorBillingBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  priorHospiceThroughDate: isoDate(
    "The Through date on the transferring hospice's final claim. It must equal the transfer date, or Medicare " +
      "rejects the transfer as a gap in care (§20.1.3).",
  ),
  priorHospicePatientStatus: Type.Union([Type.Literal("50"), Type.Literal("51")], {
    description:
      "The patient status on that final claim: 50 discharged to hospice (home), 51 to hospice (medical facility).",
  }),
  priorHospiceCcn: Type.Optional(
    Type.String({
      pattern: "^[0-9A-Z]{6}$",
      description: "The transferring hospice's CCN, when the transfer-in recorded none.",
    }),
  ),
  priorHospiceNpi: Type.Optional(
    Type.String({
      pattern: "^[0-9]{10}$",
      description: "The transferring hospice's NPI, when the transfer-in recorded none.",
    }),
  ),
});

export const SubmitTransferNoticeBodySchema = Type.Object({ expectedVersion: ExpectedVersion });

export const CancelTransferNoticeBodySchema = Type.Object({
  expectedVersion: ExpectedVersion,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

export const CorrectTransferDateBodySchema = Type.Object({
  correctedTransferDate: isoDate(
    "The correct effective date of the transfer — the corrected notice's From date; the date on file is " +
      "reported with occurrence code 56 and condition code D0 (§20.1.3).",
  ),
});

const Finding = Type.Object({
  code: Type.String(),
  message: Type.String(),
  citation: Type.String(),
});

export const TransferNoticeViewSchema = Type.Object({
  transferNoticeId: uuid(),
  organizationId: uuid(),
  providerEntityId: uuid(),
  patientId: uuid(),
  admissionId: uuid(),
  transferEventId: uuid(),
  action: ACTION,
  supersedesNoticeId: nullable(Type.String()),
  state: NOTICE_STATE,
  tob: Type.String({ description: "81C / 82C (transfer notice) or 81D / 82D (void)." }),
  statementFromDate: Type.String(),
  originalTransferDate: nullable(Type.String()),
  admissionDate: nullable(Type.String()),
  benefitPeriodSequence: Type.Integer(),
  benefitPeriodStartDate: nullable(Type.String()),
  priorHospiceName: Type.String(),
  priorHospiceCcn: nullable(Type.String()),
  priorHospiceNpi: nullable(Type.String()),
  providerCcn: Type.String(),
  priorBillingConfirmedAt: nullable(Type.String()),
  priorHospiceThroughDate: nullable(Type.String()),
  priorHospicePatientStatus: Type.Union([PATIENT_STATUS, Type.Null()]),
  controlNumber: Type.String(),
  payerControlNumber: nullable(Type.String()),
  latestSubmissionId: nullable(Type.String()),
  latestSubmissionOutcome: nullable(Type.String()),
  cancelReason: nullable(Type.String()),
  blockers: Type.Array(Finding),
  warnings: Type.Array(Finding),
  conditionCodes: Type.Array(Type.String()),
  occurrenceCodes: Type.Array(Type.Object({ code: Type.String(), date: Type.String() })),
  allowedActions: Type.Array(
    Type.Union(
      ["confirm_prior_billing", "submit", "cancel", "correct_date", "void", "redraft"].map((a) =>
        Type.Literal(a),
      ),
    ),
  ),
  followUp: Type.Union([
    Type.Object({ transferNoticeId: uuid(), action: ACTION, state: NOTICE_STATE }),
    Type.Null(),
  ]),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

export const TransferNoticeListResponseSchema = Type.Object({
  items: Type.Array(TransferNoticeViewSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

export const TransferNoticeSubmissionResponseSchema = Type.Object({
  transferNoticeId: uuid(),
  submissionId: uuid(),
  jobId: Type.String(),
  kind: Type.Literal("transfer_notice"),
});
