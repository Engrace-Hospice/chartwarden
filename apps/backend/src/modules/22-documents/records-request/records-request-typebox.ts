// apps/backend/src/modules/22-documents/records-request/records-request-typebox.ts — wire shapes of the
// F-238 records-request routes (request a prospect's older records; cover sheet; cancel; mark received).
// Named `*-typebox` (not `*schema*`) for the table-ownership import heuristic, like documents-typebox.ts.
import { Type } from "@sinclair/typebox";
import { RECORDS_REQUEST_FAX_STATUSES } from "./records-request-fax";
import { RECORDS_REQUEST_KINDS, RECORDS_REQUEST_STATUSES } from "./records-request-service";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const ISO_DATE = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const nullable = <T extends ReturnType<typeof Type.String>>(t: T) => Type.Union([t, Type.Null()]);

export const RecordsRequestReferralParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});
export const RecordsRequestParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  requestId: Type.String({ format: "uuid" }),
});

export const CreateRecordsRequestRequest = Type.Object({
  recipientName: Type.String({ minLength: 1, maxLength: 200 }),
  recipientOrganization: Type.Optional(Type.String({ maxLength: 200 })),
  /** At least one of fax / e-mail (422 otherwise). Digits, spaces and + ( ) - . only. */
  recipientFax: Type.Optional(
    Type.String({ minLength: 7, maxLength: 40, pattern: "^[0-9+()\\-. ]+$" }),
  ),
  recipientEmail: Type.Optional(
    Type.String({ minLength: 3, maxLength: 254, pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" }),
  ),
  recordsRequested: Type.Array(lit(RECORDS_REQUEST_KINDS), {
    minItems: 0,
    maxItems: 16,
    uniqueItems: true,
  }),
  /** Free text ("all oncology notes since the diagnosis") — required when no kind is ticked. */
  recordsRequestedNote: Type.Optional(Type.String({ maxLength: 1000 })),
  dateRangeStart: Type.Optional(ISO_DATE),
  dateRangeEnd: Type.Optional(ISO_DATE),
  dueDate: Type.Optional(ISO_DATE),
  /** Default: 30 days after the due date (or today). An unanswered request expires after this day. */
  expiresOn: Type.Optional(ISO_DATE),
});

/** Push the expiry out (an expired request re-opens as `requested`), optionally with a new due date. */
export const ExtendRecordsRequestRequest = Type.Object({
  expiresOn: ISO_DATE,
  dueDate: Type.Optional(ISO_DATE),
});

export const CancelRecordsRequestRequest = Type.Object({
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

export const MarkRecordsRequestRequest = Type.Object({
  status: lit(["received", "partially_received"] as const),
});

/** Fax the request's cover sheet + letter (F-238). E.164 ("+15035550100") or a NANP number as typed. */
export const SendRecordsRequestFaxRequest = Type.Object({
  faxNumber: Type.String({ minLength: 7, maxLength: 40, pattern: "^[0-9+()\\-. ]+$" }),
});

export const RecordsRequestFaxViewSchema = Type.Object({
  id: Type.String(),
  recordsRequestId: Type.String(),
  /** E.164. */
  faxNumber: Type.String(),
  status: lit(RECORDS_REQUEST_FAX_STATUSES),
  /** The outbound-fax adapter ("stub" in development). */
  provider: Type.String(),
  providerMessageId: nullable(Type.String()),
  pageCount: Type.Integer(),
  failureReason: nullable(Type.String()),
  attemptedAt: Type.String({ format: "date-time" }),
  sentAt: nullable(Type.String({ format: "date-time" })),
  failedAt: nullable(Type.String({ format: "date-time" })),
});

export const SendRecordsRequestFaxResponseSchema = Type.Object({
  fax: RecordsRequestFaxViewSchema,
  /** An earlier successful send to the same number was returned; nothing was dialled again. */
  replayed: Type.Boolean(),
});

export const RecordsRequestViewSchema = Type.Object({
  id: Type.String(),
  referralId: Type.String(),
  patientId: nullable(Type.String()),
  requestCode: Type.String(),
  recipientName: Type.String(),
  recipientOrganization: nullable(Type.String()),
  recipientFax: nullable(Type.String()),
  recipientEmail: nullable(Type.String()),
  recordsRequested: Type.Array(lit(RECORDS_REQUEST_KINDS)),
  recordsRequestedNote: nullable(Type.String()),
  dateRangeStart: nullable(Type.String()),
  dateRangeEnd: nullable(Type.String()),
  status: lit(RECORDS_REQUEST_STATUSES),
  dueDate: nullable(Type.String()),
  /** Still awaiting records past the due date (computed; `status` is never rewritten by a read). */
  overdue: Type.Boolean(),
  /** The day after which an unanswered request expires (null = never). */
  expiresOn: nullable(Type.String()),
  /** When the hourly sweep expired it — kept after late records arrive. */
  expiredAt: nullable(Type.String({ format: "date-time" })),
  /** Records arrived after the request had expired (they were still filed under the referral). */
  receivedAfterExpiry: Type.Boolean(),
  requestedByMembershipId: Type.String(),
  requestedAt: Type.String({ format: "date-time" }),
  receivedAt: nullable(Type.String({ format: "date-time" })),
  cancelledAt: nullable(Type.String({ format: "date-time" })),
  /** Intake batches filed against this request (matched by code or linked at upload). */
  batches: Type.Integer(),
  /** The latest fax send of this request (null = never faxed). Present on the LIST response. */
  fax: Type.Optional(Type.Union([RecordsRequestFaxViewSchema, Type.Null()])),
});

export const RecordsRequestListResponseSchema = Type.Object({
  items: Type.Array(RecordsRequestViewSchema),
});
