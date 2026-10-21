// apps/backend/src/modules/22-documents/records-request/inbound-match.ts — recognise returned records
// (F-238). Called by the intake job right after Docling, BEFORE the identity check, so the check compares
// the documents against the prospect the request was for.
//
//   first pages' text + the batch's source metadata (e-mail subject) ──findRecordsRequestCodes──▶ codes
//     ──org-scoped lookup (RLS)──▶ exactly one fileable request?
//        batch unfiled                      → file it under the request's referral (+ patient), link it,
//                                             move the request to `received`
//        batch already on THAT referral     → link it (and mark received); nothing else changes
//        batch on ANOTHER referral/patient  → NOT re-filed; the conflict is PERSISTED on the batch
//                                             (records_request_conflict_id / _kind, 0314) so the review
//                                             workspace, the queue and the referral's Records tab warn
//
// An EXPIRED request still files (records are never refused for arriving late): the request moves to
// `received`, keeps `expired_at`, and the summary says `afterExpiry`.
//
// Ambiguity is never resolved by guessing: two different open requests answering (an OCR misread with two
// valid readings, or two cover sheets in one fax) leaves the batch as it is and says so.
import { type DbClient, schema } from "@chartwarden/db";
import { findRecordsRequestCodes } from "@chartwarden/intake-extraction";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  RECORDS_REQUEST_AWAITING,
  RECORDS_REQUEST_FILEABLE,
  type RecordsRequestStatus,
} from "./records-request-service";

const RR = schema.intakeRecordsRequests;
const BATCH = schema.intakeUploadBatches;
const DOC = schema.documents;

/** How many leading pages are searched for the cover sheet's code. */
export const RECORDS_REQUEST_SCAN_PAGES = 3;

export type RecordsRequestMatchSummary =
  | { readonly outcome: "already_linked" }
  | { readonly outcome: "no_code" }
  /** A well-formed code nobody in this org issued (or a misread with no fileable request behind it). */
  | { readonly outcome: "unknown_code"; readonly codes: readonly string[] }
  | { readonly outcome: "cancelled_request"; readonly code: string }
  | { readonly outcome: "ambiguous"; readonly codes: readonly string[] }
  | {
      readonly outcome: "linked";
      readonly code: string;
      readonly recordsRequestId: string;
      readonly referralId: string;
      /** True when the batch had no referral and was filed under the request's. */
      readonly filed: boolean;
      /** The request had expired before these records arrived (they were still filed). */
      readonly afterExpiry: boolean;
    }
  /** WARNING: the batch is filed under a different referral / patient than the request's. Not moved. */
  | {
      readonly outcome: "conflict";
      readonly code: string;
      readonly recordsRequestId: string;
      readonly warning: "code_names_another_referral" | "code_names_another_patient";
    };

/**
 * Look for a records-request code and file the batch accordingly. Runs inside the caller's org-scoped
 * transaction (RLS confines the lookup to the batch's own organization).
 */
export async function matchInboundRecordsRequest(
  tx: DbClient,
  args: {
    readonly organizationId: string;
    readonly batchId: string;
    /** Page texts in page order; only the first RECORDS_REQUEST_SCAN_PAGES are read. */
    readonly pageTexts: readonly string[];
    readonly now?: Date;
  },
): Promise<RecordsRequestMatchSummary> {
  const [b] = await tx
    .select({
      referralId: BATCH.referralId,
      patientId: BATCH.patientId,
      recordsRequestId: BATCH.recordsRequestId,
      sourceMetadata: BATCH.sourceMetadata,
      documentId: BATCH.initialDocumentId,
    })
    .from(BATCH)
    .where(and(eq(BATCH.id, args.batchId), eq(BATCH.organizationId, args.organizationId)))
    .limit(1);
  if (!b) return { outcome: "no_code" };
  if (b.recordsRequestId) return { outcome: "already_linked" };

  const haystacks = [
    b.sourceMetadata ?? "",
    ...args.pageTexts.slice(0, RECORDS_REQUEST_SCAN_PAGES),
  ];
  const codes: string[] = [];
  for (const h of haystacks)
    for (const c of findRecordsRequestCodes(h)) if (!codes.includes(c)) codes.push(c);
  if (codes.length === 0) return { outcome: "no_code" };

  const rows = await tx
    .select({
      id: RR.id,
      code: RR.requestCode,
      referralId: RR.referralId,
      patientId: RR.patientId,
      status: RR.status,
    })
    .from(RR)
    .where(inArray(RR.requestCode, codes));
  if (rows.length === 0) return { outcome: "unknown_code", codes };
  const fileable = rows.filter((r) =>
    RECORDS_REQUEST_FILEABLE.has(r.status as RecordsRequestStatus),
  );
  if (fileable.length === 0)
    return { outcome: "cancelled_request", code: (rows[0] as { code: string }).code };
  if (fileable.length > 1) return { outcome: "ambiguous", codes: fileable.map((r) => r.code) };
  const req = fileable[0] as (typeof fileable)[number];

  const warning: RecordsRequestConflictKind | null =
    b.referralId && b.referralId !== req.referralId
      ? "code_names_another_referral"
      : b.patientId && req.patientId && b.patientId !== req.patientId
        ? "code_names_another_patient"
        : null;
  if (warning) {
    // Not moved — but remembered on the batch, so the screens can say so (not only the job summary).
    await tx
      .update(BATCH)
      .set({ recordsRequestConflictId: req.id, recordsRequestConflictKind: warning })
      .where(and(eq(BATCH.id, args.batchId), isNull(BATCH.recordsRequestId)));
    return { outcome: "conflict", code: req.code, recordsRequestId: req.id, warning };
  }

  const filed = !b.referralId;
  const adoptPatient = !b.patientId && req.patientId ? req.patientId : null;
  // Guarded on `records_request_id IS NULL` so a concurrent run can never link twice.
  const linked = await tx
    .update(BATCH)
    .set({
      recordsRequestId: req.id,
      referralId: req.referralId,
      recordsRequestConflictId: null,
      recordsRequestConflictKind: null,
      ...(adoptPatient ? { patientId: adoptPatient } : {}),
    })
    .where(and(eq(BATCH.id, args.batchId), isNull(BATCH.recordsRequestId)))
    .returning({ id: BATCH.id });
  if (linked.length === 0) return { outcome: "already_linked" };
  if (adoptPatient) {
    // The source document follows the batch onto the chart (as a relink does) — only when it has none.
    await tx
      .update(DOC)
      .set({ patientId: adoptPatient })
      .where(and(eq(DOC.id, b.documentId), isNull(DOC.patientId)));
  }
  await markReceivedOnArrival(tx, req.id, args.now ?? new Date());
  return {
    outcome: "linked",
    code: req.code,
    recordsRequestId: req.id,
    referralId: req.referralId,
    filed,
    afterExpiry: req.status === "expired",
  };
}

export type RecordsRequestConflictKind =
  | "code_names_another_referral"
  | "code_names_another_patient";

/** A batch arrived for this request: `requested` / `expired` → `received` (a partial receipt stays). */
export async function markReceivedOnArrival(
  tx: DbClient,
  requestId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(RR)
    .set({ status: "received", receivedAt: at, updatedAt: at })
    .where(and(eq(RR.id, requestId), inArray(RR.status, [...RECORDS_REQUEST_AWAITING])));
}

/**
 * F-238 — the fax carried a records-request code naming ANOTHER referral / patient than the one the batch
 * is filed under (persisted by the intake job; ../records-request/inbound-match.ts). Only the code and the
 * kind of conflict: the other referral's prospect is never named here.
 */
export interface RecordsRequestConflictView {
  readonly code: string;
  readonly kind: RecordsRequestConflictKind;
}

/** The conflict views of these batches (one RR read; RLS-scoped by the caller's transaction). */
export async function recordsRequestConflicts(
  tx: DbClient,
  rows: readonly {
    readonly id: string;
    readonly conflictId: string | null;
    readonly conflictKind: string | null;
  }[],
): Promise<Map<string, RecordsRequestConflictView>> {
  const ids = [...new Set(rows.flatMap((r) => (r.conflictId ? [r.conflictId] : [])))];
  if (ids.length === 0) return new Map();
  const codes = new Map(
    (await tx.select({ id: RR.id, code: RR.requestCode }).from(RR).where(inArray(RR.id, ids))).map(
      (r) => [r.id, r.code],
    ),
  );
  const out = new Map<string, RecordsRequestConflictView>();
  for (const r of rows) {
    const code = r.conflictId ? codes.get(r.conflictId) : undefined;
    if (code && r.conflictKind)
      out.set(r.id, { code, kind: r.conflictKind as RecordsRequestConflictKind });
  }
  return out;
}
