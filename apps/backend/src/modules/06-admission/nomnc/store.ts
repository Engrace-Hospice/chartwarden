// apps/backend/src/modules/06-admission/nomnc/store.ts — milestone 10a in-transaction reads and the shared row/view
// shapes for NOMNC delivery records, BFCC-QIO expedited reviews and typed deadlines. Every function takes the CALLER's
// org-context tx; nothing here opens a transaction. RLS scopes every query to the org, so an id from another tenant
// reads as absent.
import { type DbClient, schema } from "@chartwarden/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  type AcknowledgementKind,
  type DeadlineKind,
  type DecisionOutcome,
  type DeadlineStatus,
  type NoticeStatus,
  type RecipientKind,
  type RequestedByKind,
  type ReviewState,
  deadlineStatus,
} from "./domain";

export const N = schema.nomncNotices;
export const R = schema.expeditedReviews;
export const D = schema.expeditedDeadlines;
const ADM = schema.admissions;

export type NoticeRow = typeof N.$inferSelect;
export type ReviewRow = typeof R.$inferSelect;
export type DeadlineRow = typeof D.$inferSelect;

export interface NomncAdmissionFacts {
  readonly id: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

export async function loadAdmissionFacts(
  tx: DbClient,
  admissionId: string,
): Promise<NomncAdmissionFacts | null> {
  const [adm] = await tx
    .select({
      id: ADM.id,
      patientId: ADM.patientId,
      providerEntityId: ADM.providerEntityId,
      locationId: ADM.locationId,
    })
    .from(ADM)
    .where(eq(ADM.id, admissionId))
    .limit(1);
  return adm ?? null;
}

/** `forUpdate` locks the row for the rest of the transaction (openReview / withdraw / supersede serialise on it). */
export async function loadNotice(
  tx: DbClient,
  id: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<NoticeRow | null> {
  const q = tx.select().from(N).where(eq(N.id, id)).limit(1);
  const [row] = await (opts.forUpdate ? q.for("update") : q);
  return row ?? null;
}

export async function loadReview(tx: DbClient, id: string): Promise<ReviewRow | null> {
  const [row] = await tx.select().from(R).where(eq(R.id, id)).limit(1);
  return row ?? null;
}

export async function loadDeadline(tx: DbClient, id: string): Promise<DeadlineRow | null> {
  const [row] = await tx.select().from(D).where(eq(D.id, id)).limit(1);
  return row ?? null;
}

export async function loadActiveNotice(
  tx: DbClient,
  admissionId: string,
  opts: { readonly forUpdate?: boolean } = {},
): Promise<NoticeRow | null> {
  const q = tx
    .select()
    .from(N)
    .where(and(eq(N.admissionId, admissionId), eq(N.status, "active")))
    .limit(1);
  const [row] = await (opts.forUpdate ? q.for("update") : q);
  return row ?? null;
}

export async function loadReviewOfNotice(tx: DbClient, noticeId: string): Promise<ReviewRow | null> {
  const [row] = await tx.select().from(R).where(eq(R.nomncNoticeId, noticeId)).limit(1);
  return row ?? null;
}

export async function listNotices(tx: DbClient, admissionId: string): Promise<NoticeRow[]> {
  return tx.select().from(N).where(eq(N.admissionId, admissionId)).orderBy(desc(N.createdAt));
}

export async function listReviews(tx: DbClient, admissionId: string): Promise<ReviewRow[]> {
  return tx.select().from(R).where(eq(R.admissionId, admissionId)).orderBy(desc(R.createdAt));
}

export async function listDeadlines(tx: DbClient, admissionId: string): Promise<DeadlineRow[]> {
  return tx.select().from(D).where(eq(D.admissionId, admissionId)).orderBy(asc(D.dueAt));
}

export async function listDeadlinesOf(
  tx: DbClient,
  noticeIds: readonly string[],
  reviewIds: readonly string[],
): Promise<DeadlineRow[]> {
  const rows: DeadlineRow[] = [];
  if (noticeIds.length > 0) {
    rows.push(...(await tx.select().from(D).where(inArray(D.nomncNoticeId, [...noticeIds]))));
  }
  if (reviewIds.length > 0) {
    rows.push(...(await tx.select().from(D).where(inArray(D.expeditedReviewId, [...reviewIds]))));
  }
  return rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

// ── views (what the API returns) ─────────────────────────────────────────────────────────────────────────

export interface NoticeView {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly status: NoticeStatus;
  readonly servicesEndOn: string;
  readonly deliveredAt: string;
  readonly deliveredByUserId: string | null;
  readonly recipientKind: RecipientKind;
  readonly representativeName: string | null;
  readonly deliveryNote: string | null;
  readonly acknowledgementKind: AcknowledgementKind | null;
  readonly acknowledgementNote: string | null;
  readonly documentId: string | null;
  readonly sourceNote: string;
  readonly supersededById: string | null;
  readonly withdrawnReason: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface ReviewView {
  readonly id: string;
  readonly admissionId: string;
  readonly nomncNoticeId: string;
  readonly state: ReviewState;
  readonly qioName: string;
  readonly qioReference: string | null;
  readonly qioNotifiedAt: string;
  readonly requestedByKind: RequestedByKind;
  readonly dencDeliveredAt: string | null;
  readonly dencDocumentId: string | null;
  readonly recordsSentAt: string | null;
  readonly recordsSentNote: string | null;
  readonly decisionOutcome: DecisionOutcome | null;
  readonly decisionReceivedAt: string | null;
  readonly decisionNote: string | null;
  readonly decisionDocumentId: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface DeadlineView {
  readonly id: string;
  readonly subject: "notice" | "review";
  readonly subjectId: string;
  readonly kind: DeadlineKind;
  readonly label: string | null;
  readonly dueAt: string;
  /** What the person typed (`YYYY-MM-DDTHH:MM` in `zone`), shown back verbatim. */
  readonly dueLocal: string;
  readonly zone: string;
  readonly sourceNote: string;
  readonly noticeDocumentId: string | null;
  readonly satisfiedAt: string | null;
  /** Derived on read, never stored. */
  readonly status: DeadlineStatus;
  readonly version: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function noticeView(r: NoticeRow): NoticeView {
  return {
    id: r.id,
    admissionId: r.admissionId,
    patientId: r.patientId,
    status: r.status as NoticeStatus,
    servicesEndOn: r.servicesEndOn,
    deliveredAt: r.deliveredAt.toISOString(),
    deliveredByUserId: r.deliveredByUserId,
    recipientKind: r.recipientKind as RecipientKind,
    representativeName: r.representativeName,
    deliveryNote: r.deliveryNote,
    acknowledgementKind: r.acknowledgementKind as AcknowledgementKind | null,
    acknowledgementNote: r.acknowledgementNote,
    documentId: r.documentId,
    sourceNote: r.sourceNote,
    supersededById: r.supersededById,
    withdrawnReason: r.withdrawnReason,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

export function reviewView(r: ReviewRow): ReviewView {
  return {
    id: r.id,
    admissionId: r.admissionId,
    nomncNoticeId: r.nomncNoticeId,
    state: r.state as ReviewState,
    qioName: r.qioName,
    qioReference: r.qioReference,
    qioNotifiedAt: r.qioNotifiedAt.toISOString(),
    requestedByKind: r.requestedByKind as RequestedByKind,
    dencDeliveredAt: iso(r.dencDeliveredAt),
    dencDocumentId: r.dencDocumentId,
    recordsSentAt: iso(r.recordsSentAt),
    recordsSentNote: r.recordsSentNote,
    decisionOutcome: r.decisionOutcome as DecisionOutcome | null,
    decisionReceivedAt: iso(r.decisionReceivedAt),
    decisionNote: r.decisionNote,
    decisionDocumentId: r.decisionDocumentId,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

/** `live` = the deadline's notice is active / its review open; a closed parent makes an unmet deadline `closed`. */
export function deadlineView(r: DeadlineRow, now: Date, live: boolean): DeadlineView {
  return {
    id: r.id,
    subject: r.nomncNoticeId ? "notice" : "review",
    subjectId: (r.nomncNoticeId ?? r.expeditedReviewId) as string,
    kind: r.kind as DeadlineKind,
    label: r.label,
    dueAt: r.dueAt.toISOString(),
    dueLocal: r.dueLocal,
    zone: r.zone,
    sourceNote: r.sourceNote,
    noticeDocumentId: r.noticeDocumentId,
    satisfiedAt: iso(r.satisfiedAt),
    status: deadlineStatus({ dueAt: r.dueAt, satisfiedAt: r.satisfiedAt }, now, live),
    version: r.version,
  };
}
