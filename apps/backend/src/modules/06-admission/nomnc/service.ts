// apps/backend/src/modules/06-admission/nomnc/service.ts — milestone 10a: NOMNC delivery records, BFCC-QIO expedited
// reviews and typed deadlines. RECORD-KEEPING ONLY: it stores what staff typed (local date AND time as printed on the
// notice or told by the QIO, plus a source note), derives status on read, publishes outbox facts in the same
// transaction as the write, and never blocks or sends anything. Every route hangs off the ADMISSION path; a notice,
// review or deadline of another admission reads as absent.
import { type DbClient, organizationTimezone } from "@chartwarden/db";
import { DegradedError } from "@chartwarden/types";
import { withOrgContext } from "@chartwarden/tenancy";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AdmissionEvidenceDocumentValidator } from "../admission-evidence-service";
import { ResourceNotFoundError } from "../routes/service";
import { mapUniqueViolation } from "../unique-violation";
import {
  type AcknowledgementKind,
  type DeadlineKind,
  type DecisionOutcome,
  NOTICE_DEADLINE_KINDS,
  NomncRuleError,
  type Prompt,
  type RecipientKind,
  REVIEW_DEADLINE_KINDS,
  type RequestedByKind,
  planReviewDecision,
  promptsFor,
  requireOtherLabel,
  requireSourceNote,
  resolveTypedInstant,
  validateNoticeFacts,
} from "./domain";
import {
  D,
  type DeadlineRow,
  type DeadlineView,
  N,
  type NoticeRow,
  type NoticeView,
  R,
  type ReviewRow,
  type ReviewView,
  deadlineView,
  listDeadlinesOf,
  listNotices,
  listReviews,
  loadActiveNotice,
  loadAdmissionFacts,
  loadDeadline,
  loadNotice,
  loadReview,
  loadReviewOfNotice,
  noticeView,
  reviewView,
} from "./store";

export interface NomncOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface NomncServiceDeps {
  readonly db: DbClient;
  readonly outbox: NomncOutboxPort;
  /** M22 check (same org, same patient + admission, ACTIVE version) for every document a record links to. Unbound,
   *  linking a document is refused with 503; nothing else needs it. */
  readonly documentValidator?: AdmissionEvidenceDocumentValidator;
  readonly now?: () => Date;
}

/** A typed local date + time as the person entered them (no default for either). */
export interface TypedMoment {
  readonly date?: string | null;
  readonly time?: string | null;
}

export interface RecordNoticeInput {
  readonly supersedesId?: string | null;
  readonly servicesEndOn: string;
  readonly delivered: TypedMoment;
  readonly recipientKind: RecipientKind;
  readonly representativeName?: string | null;
  readonly deliveryNote?: string | null;
  readonly acknowledgementKind?: AcknowledgementKind | null;
  readonly acknowledgementNote?: string | null;
  readonly documentId?: string | null;
  readonly documentVersionId?: string | null;
  readonly sourceNote: string;
}

export interface PatchNoticeInput {
  readonly ifVersion: number;
  readonly deliveryNote?: string | null;
  readonly acknowledgementKind?: AcknowledgementKind | null;
  readonly acknowledgementNote?: string | null;
  readonly documentId?: string | null;
  readonly documentVersionId?: string | null;
}

export interface OpenReviewInput {
  readonly qioName: string;
  readonly qioReference?: string | null;
  readonly qioNotified: TypedMoment;
  readonly requestedByKind: RequestedByKind;
}

export interface PatchReviewInput {
  readonly ifVersion: number;
  readonly qioReference?: string | null;
  readonly dencDelivered?: TypedMoment;
  readonly dencDocumentId?: string | null;
  readonly dencDocumentVersionId?: string | null;
  readonly recordsSent?: TypedMoment;
  readonly recordsSentNote?: string | null;
  readonly decision?: {
    readonly outcome: DecisionOutcome;
    readonly received: TypedMoment;
    readonly note?: string | null;
  };
  readonly decisionDocumentId?: string | null;
  readonly decisionDocumentVersionId?: string | null;
}

export interface AddDeadlineInput {
  readonly kind: DeadlineKind;
  readonly label?: string | null;
  readonly due: TypedMoment;
  readonly sourceNote: string;
  readonly noticeDocumentId?: string | null;
  readonly noticeDocumentVersionId?: string | null;
}

export interface PatchDeadlineInput {
  readonly ifVersion: number;
  readonly label?: string | null;
  readonly due?: TypedMoment;
  readonly sourceNote?: string;
  readonly noticeDocumentId?: string | null;
  readonly noticeDocumentVersionId?: string | null;
  /** Mark the deadline met (the server stamps the time). Irreversible: a satisfied deadline is frozen. */
  readonly satisfy?: boolean;
}

export interface NomncOverview {
  readonly admissionId: string;
  readonly timeZone: string;
  readonly activeNotice: NoticeView | null;
  /** Earlier / withdrawn notices, newest first. */
  readonly history: readonly NoticeView[];
  readonly review: ReviewView | null;
  readonly deadlines: readonly DeadlineView[];
  readonly prompts: readonly Prompt[];
}

export interface NomncService {
  overview(
    organizationId: string,
    admissionId: string,
    dischargeReason?: string,
  ): Promise<NomncOverview | null>;
  recordNotice(
    organizationId: string,
    admissionId: string,
    input: RecordNoticeInput,
    actorUserId: string,
  ): Promise<NoticeView>;
  patchNotice(
    organizationId: string,
    admissionId: string,
    noticeId: string,
    input: PatchNoticeInput,
    actorUserId: string,
  ): Promise<NoticeView>;
  withdrawNotice(
    organizationId: string,
    admissionId: string,
    noticeId: string,
    input: { readonly ifVersion: number; readonly reason: string },
    actorUserId: string,
  ): Promise<NoticeView>;
  openReview(
    organizationId: string,
    admissionId: string,
    noticeId: string,
    input: OpenReviewInput,
    actorUserId: string,
  ): Promise<ReviewView>;
  patchReview(
    organizationId: string,
    admissionId: string,
    reviewId: string,
    input: PatchReviewInput,
    actorUserId: string,
  ): Promise<ReviewView>;
  withdrawReview(
    organizationId: string,
    admissionId: string,
    reviewId: string,
    input: { readonly ifVersion: number },
    actorUserId: string,
  ): Promise<ReviewView>;
  addNoticeDeadline(
    organizationId: string,
    admissionId: string,
    noticeId: string,
    input: AddDeadlineInput,
    actorUserId: string,
  ): Promise<DeadlineView>;
  addReviewDeadline(
    organizationId: string,
    admissionId: string,
    reviewId: string,
    input: AddDeadlineInput,
    actorUserId: string,
  ): Promise<DeadlineView>;
  patchDeadline(
    organizationId: string,
    admissionId: string,
    deadlineId: string,
    input: PatchDeadlineInput,
    actorUserId: string,
  ): Promise<DeadlineView>;
}

const versionConflict = (what: string, id: string, have: number, want: number) =>
  new NomncRuleError(
    "VERSION_CONFLICT",
    `${what} ${id} changed since it was read (version ${have}, expected ${want})`,
  );

/** A blank string from a form is "not recorded", never an empty fact. */
const blankToNull = (s: string | null | undefined): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

const SQL_NOW = sql`now()`;

export function createNomncService(deps: NomncServiceDeps): NomncService {
  const { db, outbox } = deps;
  const now = deps.now ?? (() => new Date());

  const asTx = (tx: unknown): DbClient => tx as DbClient;

  async function admissionOrThrow(tx: DbClient, admissionId: string) {
    const facts = await loadAdmissionFacts(tx, admissionId);
    if (!facts) throw new ResourceNotFoundError(admissionId);
    return facts;
  }

  async function noticeOf(tx: DbClient, admissionId: string, id: string): Promise<NoticeRow> {
    const row = await loadNotice(tx, id);
    if (!row || row.admissionId !== admissionId) throw new ResourceNotFoundError(id);
    return row;
  }

  async function reviewOf(tx: DbClient, admissionId: string, id: string): Promise<ReviewRow> {
    const row = await loadReview(tx, id);
    if (!row || row.admissionId !== admissionId) throw new ResourceNotFoundError(id);
    return row;
  }

  const requireActive = (notice: NoticeRow): void => {
    if (notice.status !== "active") {
      throw new NomncRuleError("NOTICE_NOT_ACTIVE", `NOMNC record ${notice.id} is ${notice.status}`);
    }
  };

  const requireOpen = (review: ReviewRow): void => {
    if (review.state !== "open") {
      throw new NomncRuleError("REVIEW_NOT_OPEN", `the review is ${review.state}`);
    }
  };

  /**
   * A document a record links to must be an ACTIVE M22 version of THIS organization's patient and admission. Run
   * before any write, inside the caller's org-context transaction; a foreign, cross-patient or cross-tenant id reads
   * as absent (404, no existence oracle) and nothing is written.
   */
  async function verifyDocument(
    organizationId: string,
    scope: { readonly admissionId: string; readonly patientId: string },
    documentId: string | null | undefined,
    documentVersionId: string | null | undefined,
  ): Promise<void> {
    if (!documentId) return;
    if (!deps.documentValidator) {
      throw new DegradedError("m6.nomnc-documents", "document linking is not bound");
    }
    if (!documentVersionId) {
      throw new NomncRuleError("DOCUMENT_VERSION_REQUIRED", "name the document version to link");
    }
    try {
      await deps.documentValidator.validateAdmissionEvidenceDocumentVersion({
        organizationId,
        admissionId: scope.admissionId,
        patientId: scope.patientId,
        documentId,
        documentVersionId,
      });
    } catch {
      throw new ResourceNotFoundError(documentId);
    }
  }

  const zoneOf = (tx: DbClient, organizationId: string) => organizationTimezone(tx, organizationId);

  const moment = (m: TypedMoment | undefined, zone: string) =>
    resolveTypedInstant(m?.date, m?.time, zone);

  return {
    async overview(organizationId, admissionId, dischargeReason) {
      return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = asTx(txRaw);
        const facts = await loadAdmissionFacts(tx, admissionId);
        if (!facts) return null;
        const at = now();
        const timeZone = await zoneOf(tx, organizationId);
        const notices = await listNotices(tx, admissionId);
        const active = notices.find((n) => n.status === "active") ?? null;
        const reviews = await listReviews(tx, admissionId);
        // The review that matters is the active notice's; failing that, the newest (e.g. after a withdrawal).
        const review = reviews.find((r) => r.nomncNoticeId === active?.id) ?? reviews[0] ?? null;
        const deadlineRows = await listDeadlinesOf(
          tx,
          active ? [active.id] : [],
          review ? [review.id] : [],
        );
        const deadlines = deadlineRows.map((d) => deadlineView(d, at));
        const prompts = promptsFor({
          notice: active
            ? {
                acknowledgementKind: active.acknowledgementKind as AcknowledgementKind | null,
                documentId: active.documentId,
              }
            : null,
          review: review
            ? {
                state: review.state as ReviewView["state"],
                decisionOutcome: review.decisionOutcome as DecisionOutcome | null,
              }
            : null,
          // Every recorded deadline counts as recorded, met or not: a met one is not a missing one.
          deadlines: deadlines.map((d) => ({ subject: d.subject, kind: d.kind })),
          dischargeReason,
        });
        return {
          admissionId,
          timeZone,
          activeNotice: active ? noticeView(active) : null,
          history: notices.filter((n) => n.status !== "active").map(noticeView),
          review: review ? reviewView(review) : null,
          deadlines,
          prompts,
        };
      });
    },

    async recordNotice(organizationId, admissionId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const facts = await admissionOrThrow(tx, admissionId);
        const zone = await zoneOf(tx, organizationId);
        const at = now();
        const delivered = moment(input.delivered, zone);
        const sourceNote = requireSourceNote(input.sourceNote);
        await verifyDocument(organizationId, { admissionId, patientId: facts.patientId }, input.documentId, input.documentVersionId);
        const rep = blankToNull(input.representativeName);
        const ackNote = blankToNull(input.acknowledgementNote);
        validateNoticeFacts({
          deliveredAt: delivered.instant,
          now: at,
          recipientKind: input.recipientKind,
          representativeName: rep,
          acknowledgementKind: input.acknowledgementKind ?? null,
          acknowledgementNote: ackNote,
        });

        const active = await loadActiveNotice(tx, admissionId);
        if (active && active.id !== input.supersedesId) {
          throw new NomncRuleError(
            "ACTIVE_NOTICE_EXISTS",
            "a NOMNC record is already active on this admission; supersede it to record a new one",
          );
        }
        if (!active && input.supersedesId) {
          throw new NomncRuleError("NOTICE_NOT_ACTIVE", "the record to supersede is not active");
        }
        const newId = randomUUID();
        if (active) {
          const priorReview = await loadReviewOfNotice(tx, active.id);
          if (priorReview?.state === "open") {
            throw new NomncRuleError(
              "REVIEW_STILL_OPEN",
              "withdraw or decide the open QIO review before superseding its notice",
            );
          }
          await tx
            .update(N)
            .set({
              status: "superseded",
              supersededById: newId,
              version: sql`${N.version} + 1`,
              updatedAt: SQL_NOW,
            })
            .where(eq(N.id, active.id));
        }
        const [row] = await tx
          .insert(N)
          .values({
            id: newId,
            organizationId,
            providerEntityId: facts.providerEntityId,
            locationId: facts.locationId,
            patientId: facts.patientId,
            admissionId,
            servicesEndOn: input.servicesEndOn,
            deliveredAt: delivered.instant,
            deliveredByUserId: actorUserId || null,
            recipientKind: input.recipientKind,
            representativeName: rep,
            deliveryNote: blankToNull(input.deliveryNote),
            acknowledgementKind: input.acknowledgementKind ?? null,
            acknowledgementNote: ackNote,
            documentId: input.documentId ?? null,
            sourceNote,
            createdByUserId: actorUserId || null,
          })
          .returning()
          .catch((err: unknown) => {
            throw mapUniqueViolation(err, {
              nomnc_notice_one_active_uq: () =>
                new NomncRuleError("ACTIVE_NOTICE_EXISTS", "a NOMNC record is already active"),
            });
          });
        if (!row) throw new Error("nomnc_notice insert returned no row");
        await outbox.publish(tx, {
          eventName: "m6.nomnc.recorded",
          payload: {
            nomncNoticeId: row.id,
            admissionId,
            patientId: facts.patientId,
            supersededNoticeId: active?.id ?? null,
          },
          organizationId,
          aggregateKind: "nomnc_notice",
          aggregateId: row.id,
        });
        return noticeView(row);
      });
    },

    async patchNotice(organizationId, admissionId, noticeId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const row = await noticeOf(tx, admissionId, noticeId);
        requireActive(row);
        await verifyDocument(organizationId, row, input.documentId, input.documentVersionId);
        const ackKind =
          input.acknowledgementKind !== undefined
            ? input.acknowledgementKind
            : (row.acknowledgementKind as AcknowledgementKind | null);
        const ackNote =
          input.acknowledgementNote !== undefined
            ? blankToNull(input.acknowledgementNote)
            : row.acknowledgementNote;
        validateNoticeFacts({
          deliveredAt: row.deliveredAt,
          now: now(),
          recipientKind: row.recipientKind as RecipientKind,
          representativeName: row.representativeName,
          acknowledgementKind: ackKind,
          acknowledgementNote: ackNote,
        });
        const [updated] = await tx
          .update(N)
          .set({
            acknowledgementKind: ackKind,
            acknowledgementNote: ackNote,
            ...(input.deliveryNote !== undefined
              ? { deliveryNote: blankToNull(input.deliveryNote) }
              : {}),
            ...(input.documentId !== undefined ? { documentId: input.documentId } : {}),
            version: sql`${N.version} + 1`,
            updatedAt: SQL_NOW,
          })
          .where(and(eq(N.id, noticeId), eq(N.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("NOMNC record", noticeId, row.version, input.ifVersion);
        return noticeView(updated);
      });
    },

    async withdrawNotice(organizationId, admissionId, noticeId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const row = await noticeOf(tx, admissionId, noticeId);
        requireActive(row);
        const reason = blankToNull(input.reason);
        if (!reason) {
          throw new NomncRuleError("WITHDRAW_REASON_REQUIRED", "a reason is required to withdraw");
        }
        const review = await loadReviewOfNotice(tx, noticeId);
        if (review?.state === "open") {
          throw new NomncRuleError(
            "REVIEW_STILL_OPEN",
            "withdraw or decide the open QIO review before withdrawing its notice",
          );
        }
        const [updated] = await tx
          .update(N)
          .set({
            status: "withdrawn",
            withdrawnReason: reason,
            version: sql`${N.version} + 1`,
            updatedAt: SQL_NOW,
          })
          .where(and(eq(N.id, noticeId), eq(N.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("NOMNC record", noticeId, row.version, input.ifVersion);
        return noticeView(updated);
      });
    },

    async openReview(organizationId, admissionId, noticeId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const notice = await noticeOf(tx, admissionId, noticeId);
        requireActive(notice);
        if (await loadReviewOfNotice(tx, noticeId)) {
          throw new NomncRuleError("REVIEW_ALREADY_OPEN", "this notice already has a QIO review");
        }
        const zone = await zoneOf(tx, organizationId);
        const notified = moment(input.qioNotified, zone);
        const qioName = input.qioName.trim();
        if (!qioName) throw new NomncRuleError("QIO_NAME_REQUIRED", "name the QIO that called");
        const [row] = await tx
          .insert(R)
          .values({
            organizationId,
            providerEntityId: notice.providerEntityId,
            locationId: notice.locationId,
            patientId: notice.patientId,
            admissionId,
            nomncNoticeId: noticeId,
            qioName,
            qioReference: blankToNull(input.qioReference),
            qioNotifiedAt: notified.instant,
            requestedByKind: input.requestedByKind,
            createdByUserId: actorUserId || null,
          })
          .returning()
          .catch((err: unknown) => {
            throw mapUniqueViolation(err, {
              expedited_review_one_per_notice: () =>
                new NomncRuleError("REVIEW_ALREADY_OPEN", "this notice already has a QIO review"),
            });
          });
        if (!row) throw new Error("expedited_review insert returned no row");
        await outbox.publish(tx, {
          eventName: "m6.expedited_review.opened",
          payload: {
            expeditedReviewId: row.id,
            nomncNoticeId: noticeId,
            admissionId,
            patientId: notice.patientId,
            qioNotifiedAt: row.qioNotifiedAt.toISOString(),
          },
          organizationId,
          aggregateKind: "expedited_review",
          aggregateId: row.id,
        });
        return reviewView(row);
      });
    },

    async patchReview(organizationId, admissionId, reviewId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const row = await reviewOf(tx, admissionId, reviewId);
        const touchesFacts =
          input.qioReference !== undefined ||
          input.dencDelivered !== undefined ||
          input.recordsSent !== undefined ||
          input.recordsSentNote !== undefined ||
          input.decision !== undefined;
        // A decided / withdrawn review is frozen except for its document links (the DB guard repeats this).
        if (touchesFacts) requireOpen(row);
        await verifyDocument(organizationId, row, input.dencDocumentId, input.dencDocumentVersionId);
        await verifyDocument(organizationId, row, input.decisionDocumentId, input.decisionDocumentVersionId);
        const zone = await zoneOf(tx, organizationId);
        const set: Partial<typeof R.$inferInsert> = {};
        if (input.qioReference !== undefined) set.qioReference = blankToNull(input.qioReference);
        if (input.dencDelivered !== undefined) {
          set.dencDeliveredAt = moment(input.dencDelivered, zone).instant;
        }
        if (input.dencDocumentId !== undefined) set.dencDocumentId = input.dencDocumentId;
        if (input.recordsSent !== undefined) {
          set.recordsSentAt = moment(input.recordsSent, zone).instant;
        }
        if (input.recordsSentNote !== undefined) {
          set.recordsSentNote = blankToNull(input.recordsSentNote);
        }
        if (input.decisionDocumentId !== undefined) {
          set.decisionDocumentId = input.decisionDocumentId;
        }
        let decidedOutcome: DecisionOutcome | null = null;
        if (input.decision) {
          const received = moment(input.decision.received, zone);
          const note = blankToNull(input.decision.note);
          set.state = planReviewDecision(row.state as ReviewView["state"], {
            kind: "decide",
            outcome: input.decision.outcome,
            receivedAt: received.instant,
            note,
          });
          set.decisionOutcome = input.decision.outcome;
          set.decisionReceivedAt = received.instant;
          set.decisionNote = note;
          decidedOutcome = input.decision.outcome;
        }
        const [updated] = await tx
          .update(R)
          .set({ ...set, version: sql`${R.version} + 1`, updatedAt: SQL_NOW })
          .where(and(eq(R.id, reviewId), eq(R.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("QIO review", reviewId, row.version, input.ifVersion);
        if (decidedOutcome) {
          await outbox.publish(tx, {
            eventName: "m6.expedited_review.decided",
            payload: {
              expeditedReviewId: reviewId,
              nomncNoticeId: row.nomncNoticeId,
              admissionId,
              patientId: row.patientId,
              outcome: decidedOutcome,
            },
            organizationId,
            aggregateKind: "expedited_review",
            aggregateId: reviewId,
          });
        }
        return reviewView(updated);
      });
    },

    async withdrawReview(organizationId, admissionId, reviewId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const row = await reviewOf(tx, admissionId, reviewId);
        planReviewDecision(row.state as ReviewView["state"], { kind: "withdraw" });
        const [updated] = await tx
          .update(R)
          .set({ state: "withdrawn", version: sql`${R.version} + 1`, updatedAt: SQL_NOW })
          .where(and(eq(R.id, reviewId), eq(R.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("QIO review", reviewId, row.version, input.ifVersion);
        return reviewView(updated);
      });
    },

    async addNoticeDeadline(organizationId, admissionId, noticeId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const notice = await noticeOf(tx, admissionId, noticeId);
        requireActive(notice);
        return insertDeadline(
          tx,
          organizationId,
          notice,
          { nomncNoticeId: noticeId },
          NOTICE_DEADLINE_KINDS,
          input,
          actorUserId,
        );
      });
    },

    async addReviewDeadline(organizationId, admissionId, reviewId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const review = await reviewOf(tx, admissionId, reviewId);
        requireOpen(review);
        return insertDeadline(
          tx,
          organizationId,
          review,
          { expeditedReviewId: reviewId },
          REVIEW_DEADLINE_KINDS,
          input,
          actorUserId,
        );
      });
    },

    async patchDeadline(organizationId, admissionId, deadlineId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const row: DeadlineRow | null = await loadDeadline(tx, deadlineId);
        if (!row || row.admissionId !== admissionId) throw new ResourceNotFoundError(deadlineId);
        if (row.satisfiedAt) {
          throw new NomncRuleError("DEADLINE_SATISFIED", "a satisfied deadline cannot change");
        }
        await verifyDocument(organizationId, row, input.noticeDocumentId, input.noticeDocumentVersionId);
        const at = now();
        const set: Partial<typeof D.$inferInsert> = {};
        if (input.label !== undefined && row.kind === "other") {
          set.label = requireOtherLabel("other", input.label);
        }
        if (input.noticeDocumentId !== undefined) set.noticeDocumentId = input.noticeDocumentId;
        if (input.sourceNote !== undefined) set.sourceNote = requireSourceNote(input.sourceNote);
        if (input.due !== undefined) {
          const zone = await zoneOf(tx, organizationId);
          const typed = moment(input.due, zone);
          set.dueAt = typed.instant;
          set.dueLocal = typed.dueLocal;
          set.zone = zone;
          // A moved deadline starts its alert history over.
          set.lastAlertedBoundaryHours = null;
          set.overdueAlertedAt = null;
        }
        if (input.satisfy) set.satisfiedAt = at;
        const [updated] = await tx
          .update(D)
          .set({ ...set, version: sql`${D.version} + 1`, updatedAt: SQL_NOW })
          .where(and(eq(D.id, deadlineId), eq(D.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("deadline", deadlineId, row.version, input.ifVersion);
        return deadlineView(updated, at);
      });
    },
  };

  async function insertDeadline(
    tx: DbClient,
    organizationId: string,
    parent: NoticeRow | ReviewRow,
    subject: { nomncNoticeId: string } | { expeditedReviewId: string },
    allowedKinds: readonly DeadlineKind[],
    input: AddDeadlineInput,
    actorUserId: string,
  ): Promise<DeadlineView> {
    if (!allowedKinds.includes(input.kind)) {
      throw new NomncRuleError(
        "DEADLINE_KIND_NOT_ALLOWED",
        `a deadline of kind "${input.kind}" does not belong here`,
      );
    }
    await verifyDocument(organizationId, parent, input.noticeDocumentId, input.noticeDocumentVersionId);
    const label = requireOtherLabel(input.kind, input.label);
    const sourceNote = requireSourceNote(input.sourceNote);
    const zone = await zoneOf(tx, organizationId);
    const typed = moment(input.due, zone);
    const subjectColumn =
      "nomncNoticeId" in subject
        ? eq(D.nomncNoticeId, subject.nomncNoticeId)
        : eq(D.expeditedReviewId, subject.expeditedReviewId);
    if (input.kind !== "other") {
      const [dup] = await tx
        .select({ id: D.id })
        .from(D)
        .where(and(subjectColumn, eq(D.kind, input.kind), sql`${D.satisfiedAt} IS NULL`))
        .limit(1);
      if (dup) {
        throw new NomncRuleError(
          "DEADLINE_ALREADY_RECORDED",
          `an unsatisfied "${input.kind}" deadline is already recorded; edit it instead`,
        );
      }
    }
    const [row] = await tx
      .insert(D)
      .values({
        organizationId,
        providerEntityId: parent.providerEntityId,
        locationId: parent.locationId,
        patientId: parent.patientId,
        admissionId: parent.admissionId,
        ...subject,
        kind: input.kind,
        label,
        dueAt: typed.instant,
        dueLocal: typed.dueLocal,
        zone,
        sourceNote,
        noticeDocumentId: input.noticeDocumentId ?? null,
        createdByUserId: actorUserId || null,
      })
      .returning()
      .catch((err: unknown) => {
        throw mapUniqueViolation(err, {
          expedited_deadline_notice_kind_uq: () =>
            new NomncRuleError("DEADLINE_ALREADY_RECORDED", "that deadline is already recorded"),
          expedited_deadline_review_kind_uq: () =>
            new NomncRuleError("DEADLINE_ALREADY_RECORDED", "that deadline is already recorded"),
        });
      });
    if (!row) throw new Error("expedited_deadline insert returned no row");
    return deadlineView(row, now());
  }
}
