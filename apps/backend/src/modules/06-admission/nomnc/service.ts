// apps/backend/src/modules/06-admission/nomnc/service.ts — milestone 10a: NOMNC delivery records, BFCC-QIO expedited
// reviews and typed deadlines. RECORD-KEEPING ONLY: it stores what staff typed (local date AND time as printed on the
// notice or told by the QIO, plus a source note), derives status on read, publishes outbox facts in the same
// transaction as the write, and never blocks or sends anything. Every route hangs off the ADMISSION path; a notice,
// review or deadline of another admission reads as absent.
import { type DbClient, organizationTimezone } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { AdmissionEvidenceDocumentValidator } from "../admission-evidence-service";
import type {
  AddDeadlineInput,
  OpenReviewInput,
  PatchDeadlineInput,
  PatchNoticeInput,
  PatchReviewInput,
  RecordNoticeInput,
} from "./types";
import { ResourceNotFoundError } from "../routes/service";
import { mapUniqueViolation } from "../unique-violation";
import {
  type DocumentVerifier,
  type NomncLog,
  blankToNull,
  createDocumentVerifier,
  defaultNomncLog,
  insertDeadline,
  typedMoment,
} from "./deadlines";
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
  /** Where a refused document link is reported (ids and error class only, never PHI). Defaults to stderr. */
  readonly log?: NomncLog;
}

export type {
  AddDeadlineInput,
  OpenReviewInput,
  PatchDeadlineInput,
  PatchNoticeInput,
  PatchReviewInput,
  RecordNoticeInput,
  TypedMoment,
} from "./types";

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

  async function noticeOf(
    tx: DbClient,
    admissionId: string,
    id: string,
    opts: { readonly forUpdate?: boolean } = {},
  ): Promise<NoticeRow> {
    const row = await loadNotice(tx, id, opts);
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

  const zoneOf = (tx: DbClient, organizationId: string) => organizationTimezone(tx, organizationId);

  const moment = typedMoment;
  const verifyDocument: DocumentVerifier = createDocumentVerifier(
    deps.documentValidator,
    deps.log ?? defaultNomncLog,
  );

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
        // The review that matters is the ACTIVE notice's (none yet = none shown, so it can be opened). With no active
        // notice (all withdrawn) the newest review is shown as history.
        const review = active
          ? (reviews.find((r) => r.nomncNoticeId === active.id) ?? null)
          : (reviews[0] ?? null);
        const deadlineRows = await listDeadlinesOf(
          tx,
          active ? [active.id] : [],
          review ? [review.id] : [],
        );
        const deadlines = deadlineRows.map((d) =>
          deadlineView(d, at, d.nomncNoticeId ? active?.id === d.nomncNoticeId : review?.state === "open"),
        );
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

        const active = await loadActiveNotice(tx, admissionId, { forUpdate: true });
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
            documentVersionId: input.documentId ? (input.documentVersionId ?? null) : null,
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
        const row = await noticeOf(tx, admissionId, noticeId, { forUpdate: true });
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
            ...(input.documentId !== undefined
              ? {
                  documentId: input.documentId,
                  documentVersionId: input.documentId ? (input.documentVersionId ?? null) : null,
                }
              : {}),
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
        const row = await noticeOf(tx, admissionId, noticeId, { forUpdate: true });
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
        // Locked: openReview and withdrawNotice / supersede serialise on the notice row.
        const notice = await noticeOf(tx, admissionId, noticeId, { forUpdate: true });
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
        if (input.dencDocumentId !== undefined) {
          set.dencDocumentId = input.dencDocumentId;
          set.dencDocumentVersionId = input.dencDocumentId ? (input.dencDocumentVersionId ?? null) : null;
        }
        if (input.recordsSent !== undefined) {
          set.recordsSentAt = moment(input.recordsSent, zone).instant;
        }
        if (input.recordsSentNote !== undefined) {
          set.recordsSentNote = blankToNull(input.recordsSentNote);
        }
        if (input.decisionDocumentId !== undefined) {
          set.decisionDocumentId = input.decisionDocumentId;
          set.decisionDocumentVersionId = input.decisionDocumentId
            ? (input.decisionDocumentVersionId ?? null)
            : null;
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
          { tx, organizationId, actorUserId, now: now(), verify: verifyDocument },
          notice,
          { nomncNoticeId: noticeId },
          NOTICE_DEADLINE_KINDS,
          input,
        );
      });
    },

    async addReviewDeadline(organizationId, admissionId, reviewId, input, actorUserId) {
      return withOrgContext(db, { organizationId, userId: actorUserId }, async (txRaw) => {
        const tx = asTx(txRaw);
        const review = await reviewOf(tx, admissionId, reviewId);
        requireOpen(review);
        return insertDeadline(
          { tx, organizationId, actorUserId, now: now(), verify: verifyDocument },
          review,
          { expeditedReviewId: reviewId },
          REVIEW_DEADLINE_KINDS,
          input,
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
        if (input.noticeDocumentId !== undefined) {
          set.noticeDocumentId = input.noticeDocumentId;
          set.noticeDocumentVersionId = input.noticeDocumentId
            ? (input.noticeDocumentVersionId ?? null)
            : null;
        }
        if (input.sourceNote !== undefined) set.sourceNote = requireSourceNote(input.sourceNote);
        if (input.due !== undefined) {
          const zone = await zoneOf(tx, organizationId);
          const typed = moment(input.due, zone);
          set.dueAt = typed.instant;
          set.dueLocal = typed.dueLocal;
          set.zone = zone;
          // A moved deadline starts its alert history over.
          // (a time typed already in the past is recorded as alerted: the editor is looking at it).
          set.lastAlertedBoundaryHours = null;
          set.overdueAlertedAt = typed.instant.getTime() <= at.getTime() ? at : null;
        }
        if (input.satisfy) set.satisfiedAt = at;
        const [updated] = await tx
          .update(D)
          .set({ ...set, version: sql`${D.version} + 1`, updatedAt: SQL_NOW })
          .where(and(eq(D.id, deadlineId), eq(D.version, input.ifVersion)))
          .returning();
        if (!updated) throw versionConflict("deadline", deadlineId, row.version, input.ifVersion);
        return deadlineView(updated, at, true);
      });
    },
  };
}
