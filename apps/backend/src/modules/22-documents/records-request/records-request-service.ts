// apps/backend/src/modules/22-documents/records-request/records-request-service.ts — F-238 step 4: asking a
// prospect's PCP / hospital for older records, and recognising the records when they come back.
//
// A request belongs to an M6 referral (the route validated the caller can see it, through the M6
// ReferralReader seam) and carries a short code (`RR-` + 6 + a check character; @chartwarden/intake-extraction
// `generateRecordsRequestCode`) printed on the cover sheet. The intake job finds that code on the returned
// fax pages / e-mail subject and files the batch under the request's referral (./inbound-match.ts).
//
// This file holds the vocabulary, the service contract the routes compose over, and an in-memory slice for
// route tests. Production binds the Drizzle service (./records-request-db.ts) under `withOrgContext`, so RLS
// scopes every read and write by `app.org_id`.
import { randomBytes, randomUUID } from "node:crypto";
import { generateRecordsRequestCode } from "@chartwarden/intake-extraction";
import { NotFoundError, ValidationError, ChartWardenError } from "@chartwarden/types";

export const RECORDS_REQUEST_KINDS = [
  "history_and_physical",
  "discharge_summary",
  "progress_notes",
  "consult_notes",
  "labs",
  "imaging",
  "medication_list",
  "problem_list",
] as const;
export type RecordsRequestKind = (typeof RECORDS_REQUEST_KINDS)[number];

export const RECORDS_REQUEST_STATUSES = [
  "requested",
  "received",
  "partially_received",
  "cancelled",
  "expired",
] as const;
export type RecordsRequestStatus = (typeof RECORDS_REQUEST_STATUSES)[number];

/**
 * Statuses under which returned records may still be FILED against the request (by code or by hand).
 * Everything but `cancelled`: records that arrive after the due date (`expired`) or as a second fax after
 * the first (`received`, `partially_received`) are still this prospect's records.
 */
export const RECORDS_REQUEST_FILEABLE: ReadonlySet<RecordsRequestStatus> = new Set([
  "requested",
  "partially_received",
  "received",
  "expired",
]);
/** Statuses an arriving batch moves to `received` (a partial receipt stays partial until staff say so). */
export const RECORDS_REQUEST_AWAITING: ReadonlySet<RecordsRequestStatus> = new Set([
  "requested",
  "expired",
]);
/**
 * Expiry (F-238, 0314). An unanswered request (`requested`) whose `expiresOn` day has passed is moved to
 * `expired` by the hourly M22 sweep (`expireRecordsRequestsForOrg`). Default expiry: this many days after
 * the due date (or after the request day when no due date was set); staff may extend it.
 *
 * Only `requested` expires. A `partially_received` request already has records in hand — expiring it would
 * hide that; staff close it (mark received / cancel).
 *
 * Records that arrive AFTER expiry are never refused: the code still files the batch (an expired request is
 * FILEABLE, below) and the request moves to `received`, keeping `expiredAt` so the view says
 * `receivedAfterExpiry`. For a hospice, a late PCP record is still the prospect's record — losing or
 * mis-routing it would be worse than a late flag.
 */
export const RECORDS_REQUEST_DEFAULT_EXPIRY_DAYS = 30;
/** Statuses an extension may apply to (an expired one re-opens as `requested`). */
export const RECORDS_REQUEST_EXTENDABLE: ReadonlySet<RecordsRequestStatus> = new Set([
  "requested",
  "expired",
]);

/** yyyy-mm-dd + n days (UTC calendar arithmetic on a plain date). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The expiry day a new request gets when the caller did not choose one. */
export function defaultExpiresOn(dueDate: string | null | undefined, today: string): string {
  return addDays(dueDate && dueDate > today ? dueDate : today, RECORDS_REQUEST_DEFAULT_EXPIRY_DAYS);
}

/** Statuses that may still be cancelled. */
const CANCELLABLE: ReadonlySet<RecordsRequestStatus> = new Set([
  "requested",
  "partially_received",
  "expired",
]);

export interface RecordsRequestActor {
  readonly userId: string;
  readonly membershipId: string;
}

export interface CreateRecordsRequestInput {
  readonly recipientName: string;
  readonly recipientOrganization?: string;
  readonly recipientFax?: string;
  readonly recipientEmail?: string;
  readonly recordsRequested: readonly RecordsRequestKind[];
  readonly recordsRequestedNote?: string;
  readonly dateRangeStart?: string;
  readonly dateRangeEnd?: string;
  readonly dueDate?: string;
  /** Default: RECORDS_REQUEST_DEFAULT_EXPIRY_DAYS after the due date (or today). Must be after today. */
  readonly expiresOn?: string;
}

/** Staff push the expiry out (re-opening an expired request), optionally with a new due date. */
export interface ExtendRecordsRequestInput {
  readonly expiresOn: string;
  readonly dueDate?: string;
}

export interface RecordsRequestView {
  readonly id: string;
  readonly referralId: string;
  readonly patientId: string | null;
  readonly requestCode: string;
  readonly recipientName: string;
  readonly recipientOrganization: string | null;
  readonly recipientFax: string | null;
  readonly recipientEmail: string | null;
  readonly recordsRequested: readonly RecordsRequestKind[];
  readonly recordsRequestedNote: string | null;
  readonly dateRangeStart: string | null;
  readonly dateRangeEnd: string | null;
  readonly status: RecordsRequestStatus;
  readonly dueDate: string | null;
  readonly overdue: boolean;
  /** The day after which an unanswered request expires (null = never). */
  readonly expiresOn: string | null;
  /** When the sweep expired it (kept after late records arrive). */
  readonly expiredAt: string | null;
  /** Records arrived after the request had expired (they were still filed). */
  readonly receivedAfterExpiry: boolean;
  readonly requestedByMembershipId: string;
  readonly requestedAt: string;
  readonly receivedAt: string | null;
  readonly cancelledAt: string | null;
  readonly batches: number;
}

/** What the upload route needs to validate a manual `recordsRequestId`. */
export interface RecordsRequestLinkFacts {
  readonly id: string;
  readonly referralId: string;
  readonly patientId: string | null;
  readonly status: RecordsRequestStatus;
}

export interface RecordsRequestService {
  create(
    organizationId: string,
    actor: RecordsRequestActor,
    target: { referralId: string; patientId: string | null },
    input: CreateRecordsRequestInput,
  ): Promise<RecordsRequestView>;
  listForReferral(organizationId: string, referralId: string): Promise<RecordsRequestView[]>;
  /** 404 when the request is not this referral's (or not this org's). */
  get(organizationId: string, referralId: string, requestId: string): Promise<RecordsRequestView>;
  cancel(
    organizationId: string,
    actor: RecordsRequestActor,
    referralId: string,
    requestId: string,
    reason: string | null,
  ): Promise<RecordsRequestView>;
  /** Staff say the records are in (all, or some). */
  mark(
    organizationId: string,
    actor: RecordsRequestActor,
    referralId: string,
    requestId: string,
    status: "received" | "partially_received",
  ): Promise<RecordsRequestView>;
  /** Push the expiry out; an expired request re-opens as `requested`. 409 for any other status. */
  extend(
    organizationId: string,
    actor: RecordsRequestActor,
    referralId: string,
    requestId: string,
    input: ExtendRecordsRequestInput,
  ): Promise<RecordsRequestView>;
  /** Org-scoped read for the upload route's manual link (null = not found / not this org). */
  findForLink(organizationId: string, requestId: string): Promise<RecordsRequestLinkFacts | null>;
}

/** Shared input validation (route-independent: both services enforce it). */
export function validateCreateInput(input: CreateRecordsRequestInput): void {
  const fail = (field: string, message: string): never => {
    throw new ValidationError(message, [{ field, code: "INVALID", message }]);
  };
  if (!input.recordsRequestedNote?.trim() && input.recordsRequested.length === 0) {
    fail("recordsRequested", "say what is requested: tick at least one record kind or describe it");
  }
  if (!input.recipientFax?.trim() && !input.recipientEmail?.trim()) {
    fail("recipientFax", "a fax number or an e-mail address is required");
  }
  if (input.dateRangeStart && input.dateRangeEnd && input.dateRangeStart > input.dateRangeEnd) {
    fail("dateRangeEnd", "the date range ends before it starts");
  }
  if (input.expiresOn && input.dueDate && input.expiresOn < input.dueDate) {
    fail("expiresOn", "the request cannot expire before it is due");
  }
}

/** Shared extension validation: the new expiry is in the future and not before the due date. */
export function validateExtendInput(
  input: ExtendRecordsRequestInput,
  currentDueDate: string | null,
  today: string,
): void {
  const fail = (field: string, message: string): never => {
    throw new ValidationError(message, [{ field, code: "INVALID", message }]);
  };
  if (input.expiresOn <= today) fail("expiresOn", "the new expiry date must be after today");
  const due = input.dueDate ?? currentDueDate;
  if (due && input.expiresOn < due) fail("expiresOn", "the request cannot expire before it is due");
}

/** Arrived after the sweep expired the request (an ISO timestamp comparison). */
export const receivedAfterExpiry = (receivedAt: string | null, expiredAt: string | null): boolean =>
  receivedAt !== null && expiredAt !== null && receivedAt >= expiredAt;

export function isOverdue(
  status: RecordsRequestStatus,
  dueDate: string | null,
  today: string,
): boolean {
  return (status === "requested" || status === "expired") && dueDate !== null && dueDate < today;
}

/** Crypto-random code source for production. */
export const newRecordsRequestCode = (): string =>
  generateRecordsRequestCode((n) => randomBytes(n));

export const notExtendable = () =>
  new ChartWardenError(
    "RECORDS_REQUEST_NOT_EXTENDABLE",
    "only an open or expired records request can be extended",
    409,
  );

export const notCancellable = () =>
  new ChartWardenError(
    "RECORDS_REQUEST_NOT_CANCELLABLE",
    "this records request can no longer be cancelled",
    409,
  );

/** In-memory slice (route tests). Org-scoped: another org's request is a non-leaking 404. */
export const cancelledRequest = () =>
  new ChartWardenError("RECORDS_REQUEST_CANCELLED", "this records request was cancelled", 409);

export function createInMemoryRecordsRequestService(
  opts: { now?: () => Date; code?: () => string } = {},
): RecordsRequestService & {
  /** Test hook: a batch filed against a request (what the intake job / upload would do). */
  noteBatch(requestId: string): void;
  /** Test hook: what the hourly sweep does (expire `requested` rows past `expiresOn`). */
  expireDue(organizationId: string): number;
} {
  const now = opts.now ?? (() => new Date());
  const code = opts.code ?? newRecordsRequestCode;
  interface Row {
    organizationId: string;
    view: Omit<RecordsRequestView, "overdue" | "receivedAfterExpiry">;
  }
  const rows = new Map<string, Row>();
  const today = () => now().toISOString().slice(0, 10);
  const project = (r: Row): RecordsRequestView => ({
    ...r.view,
    overdue: isOverdue(r.view.status, r.view.dueDate, today()),
    receivedAfterExpiry: receivedAfterExpiry(r.view.receivedAt, r.view.expiredAt),
  });
  const load = (organizationId: string, referralId: string, id: string): Row => {
    const r = rows.get(id);
    if (!r || r.organizationId !== organizationId || r.view.referralId !== referralId) {
      throw new NotFoundError("records_request");
    }
    return r;
  };
  return {
    async create(organizationId, actor, target, input) {
      validateCreateInput(input);
      const uuid = randomUUID();
      const at = now().toISOString();
      const row: Row = {
        organizationId,
        view: {
          id: uuid,
          referralId: target.referralId,
          patientId: target.patientId,
          requestCode: code(),
          recipientName: input.recipientName.trim(),
          recipientOrganization: input.recipientOrganization?.trim() || null,
          recipientFax: input.recipientFax?.trim() || null,
          recipientEmail: input.recipientEmail?.trim() || null,
          recordsRequested: [...input.recordsRequested],
          recordsRequestedNote: input.recordsRequestedNote?.trim() || null,
          dateRangeStart: input.dateRangeStart ?? null,
          dateRangeEnd: input.dateRangeEnd ?? null,
          status: "requested",
          dueDate: input.dueDate ?? null,
          expiresOn: input.expiresOn ?? defaultExpiresOn(input.dueDate, today()),
          expiredAt: null,
          requestedByMembershipId: actor.membershipId,
          requestedAt: at,
          receivedAt: null,
          cancelledAt: null,
          batches: 0,
        },
      };
      rows.set(uuid, row);
      return project(row);
    },
    async listForReferral(organizationId, referralId) {
      return [...rows.values()]
        .filter((r) => r.organizationId === organizationId && r.view.referralId === referralId)
        .sort((a, b) => b.view.requestedAt.localeCompare(a.view.requestedAt))
        .map(project);
    },
    async get(organizationId, referralId, requestId) {
      return project(load(organizationId, referralId, requestId));
    },
    async cancel(organizationId, _actor, referralId, requestId) {
      const r = load(organizationId, referralId, requestId);
      if (!CANCELLABLE.has(r.view.status)) throw notCancellable();
      r.view = { ...r.view, status: "cancelled", cancelledAt: now().toISOString() };
      return project(r);
    },
    async mark(organizationId, _actor, referralId, requestId, status) {
      const r = load(organizationId, referralId, requestId);
      if (r.view.status === "cancelled") throw cancelledRequest();
      r.view = { ...r.view, status, receivedAt: r.view.receivedAt ?? now().toISOString() };
      return project(r);
    },
    async extend(organizationId, _actor, referralId, requestId, input) {
      const r = load(organizationId, referralId, requestId);
      if (!RECORDS_REQUEST_EXTENDABLE.has(r.view.status)) throw notExtendable();
      validateExtendInput(input, r.view.dueDate, today());
      r.view = {
        ...r.view,
        status: "requested",
        expiresOn: input.expiresOn,
        expiredAt: null,
        dueDate: input.dueDate ?? r.view.dueDate,
      };
      return project(r);
    },
    async findForLink(organizationId, requestId) {
      const r = rows.get(requestId);
      if (!r || r.organizationId !== organizationId) return null;
      return {
        id: r.view.id,
        referralId: r.view.referralId,
        patientId: r.view.patientId,
        status: r.view.status,
      };
    },
    noteBatch(requestId) {
      const r = rows.get(requestId);
      if (r) r.view = { ...r.view, batches: r.view.batches + 1 };
    },
    expireDue(organizationId) {
      let n = 0;
      for (const r of rows.values()) {
        if (
          r.organizationId === organizationId &&
          r.view.status === "requested" &&
          r.view.expiresOn !== null &&
          r.view.expiresOn < today()
        ) {
          r.view = { ...r.view, status: "expired", expiredAt: now().toISOString() };
          n++;
        }
      }
      return n;
    },
  };
}
