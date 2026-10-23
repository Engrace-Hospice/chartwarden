// apps/backend/src/modules/25-remittance/routes/later-tier-service.ts - M25 milestone 7a-1: record-keeping for the
// later appeal tiers (ALJ / Council / federal court) and the RECORDED DEADLINE primitive. Facts are recorded, not
// ruled: the amount in controversy is stored and never compared to a threshold, a remand / dismissal is a label that
// spawns nothing, and a due date is always typed by a person from a notice with a mandatory source note (it works for an
// appeal case and for an audit request alike). Federal court is record-only: counsel files, WardenX records it.
// Every command runs under `withOrgContext` (RLS) inside the actor's provider-entity scope; every change is If-Match.
// The write-audit triggers (and the audit request's own event history) are the trail.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  DEFAULT_DEADLINE_ZONE,
  type RecordedDeadlineRefusal,
  type TierDetailInput,
  type TierDetailRefusal,
  canPacketRender,
  checkRecordedDeadline,
  checkTierDetail,
  deriveRecordedDeadline,
  dispositionNeedsManualReview,
  isKnownZone,
  isLaterTier,
  isRealDay,
  noticeDayOf,
  windowUnconfirmed,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { type AppealSourcePorts, describeEnclosures } from "./appeal-packet-sources";
import { patientOfClaim } from "./claim-patient";
import { VersionConflictError } from "./concurrency";
import { isUniqueViolation } from "./denial-route-service";
import { type RecordedDeadlineView, viewRecordedDeadline } from "./recorded-deadline-view";
import { providerEntityScopeCondition } from "./scope";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type DeadlineSubject =
  | { readonly kind: "appeal"; readonly id: string }
  | { readonly kind: "audit_request"; readonly id: string };

export interface RecordedDeadlineInput {
  readonly label: string;
  /** The due date as printed on the notice (YYYY-MM-DD). */
  readonly dueOn: string;
  /** Where the date came from (the notice, page, paragraph). Required. */
  readonly sourceNote: string;
  readonly noticeDocumentId?: string | null;
}

export interface RecordedDeadlinePatch {
  readonly label?: string;
  readonly dueOn?: string;
  readonly sourceNote?: string;
  readonly noticeDocumentId?: string | null;
}

export interface TierDetailView {
  readonly id: string;
  readonly authorityReference: string | null;
  readonly amountInControversyCents: number | null;
  readonly hearingOn: string | null;
  readonly hearingFormatNote: string | null;
  readonly dispositionKind: string | null;
  readonly dispositionNote: string | null;
  readonly filedByCounselOn: string | null;
  readonly docketReference: string | null;
  readonly version: number;
}

export interface LaterTierView {
  readonly appealCaseId: string;
  readonly claimId: string;
  /** The claim's patient, so the read audit can attribute the read (null when no source port is bound). */
  readonly patientId: string | null;
  readonly tier: string;
  readonly state: string;
  readonly filedByEscalation: boolean;
  /** True while the shipped 60-day window for this tier is not SME-confirmed (the badge). */
  readonly windowUnconfirmed: boolean;
  /** False for federal court: counsel files, WardenX renders and sends nothing. */
  readonly canPacketRender: boolean;
  /** A remand / dismissal / other disposition: a person must look; nothing spawns. */
  readonly needsManualReview: boolean;
  readonly detail: TierDetailView | null;
  readonly deadlines: RecordedDeadlineView[];
}

export interface LaterTierService {
  getLaterTier(actor: M25ReadActor, appealCaseId: string): Promise<LaterTierView | null>;
  putTierDetail(
    actor: M25WriteActor,
    appealCaseId: string,
    input: TierDetailInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  listDeadlines(
    actor: M25ReadActor,
    subject: DeadlineSubject,
  ): Promise<{ items: RecordedDeadlineView[]; patientId: string | null }>;
  createDeadline(
    actor: M25WriteActor,
    subject: DeadlineSubject,
    input: RecordedDeadlineInput,
  ): Promise<{ id: string; version: number }>;
  updateDeadline(
    actor: M25WriteActor,
    subject: DeadlineSubject,
    deadlineId: string,
    patch: RecordedDeadlinePatch,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  satisfyDeadline(
    actor: M25WriteActor,
    subject: DeadlineSubject,
    deadlineId: string,
    satisfiedOn: string | undefined,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
}

export interface LaterTierPorts {
  /** The timezones of a provider entity's locations (M1's published reader); absent -> the default zone. */
  readonly providerZones?: (tx: DbClient, providerEntityId: string) => Promise<readonly string[]>;
  /** M22 / M23 seams; needed only to validate a notice document id on an appeal's recorded deadline. */
  readonly sources?: AppealSourcePorts;
}

const unprocessable = (code: string, message: string) => new ChartWardenError(code, message, 422);

const TIER_MESSAGES: Readonly<Record<TierDetailRefusal, string>> = {
  TIER_NOT_LATER: "tier detail exists only for ALJ, Council and federal-court cases",
  AMOUNT_INVALID: "the amount in controversy must be a non-negative whole number of cents",
  HEARING_ON_INVALID: "the hearing date is not a real date",
  HEARING_NOT_RECORDED: "hearing facts are not recorded for a federal-court case",
  FILED_BY_COUNSEL_INVALID: "the counsel filing date is not a real date",
  FEDERAL_ONLY_FIELD: "the counsel filing date and docket reference are for federal court only",
  DISPOSITION_INVALID: "the disposition must be decision, remand, dismissal or other",
  DISPOSITION_KIND_REQUIRED: "choose the disposition the note describes",
  DISPOSITION_NOTE_REQUIRED: "describe the disposition when it is 'other'",
  TEXT_TOO_LONG: "a text field is too long",
};

const DEADLINE_MESSAGES: Readonly<Record<RecordedDeadlineRefusal, string>> = {
  LABEL_REQUIRED: "name what this deadline is for",
  LABEL_TOO_LONG: "the label is too long",
  DUE_DATE_INVALID: "the due date is not a real date",
  SOURCE_NOTE_REQUIRED: "say where the date came from (the notice, page or paragraph)",
  SOURCE_NOTE_TOO_LONG: "the source note is too long",
};

const subjectFinished = () =>
  new ChartWardenError(
    "DEADLINE_SUBJECT_FINISHED",
    "the case is finished; its deadlines can no longer change",
    409,
  );

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

export function buildDrizzleLaterTierService(
  db: DbClient,
  ports: LaterTierPorts = {},
): LaterTierService {
  const AC = schema.appealCase;
  const AR = schema.auditRequest;
  const TD = schema.appealTierDetail;
  const RD = schema.recordedDeadline;
  const AREV = schema.auditRequestEvent;

  const detailView = (r: typeof TD.$inferSelect): TierDetailView => ({
    id: r.id,
    authorityReference: r.authorityReference,
    amountInControversyCents: r.amountInControversyCents,
    hearingOn: r.hearingOn,
    hearingFormatNote: r.hearingFormatNote,
    dispositionKind: r.dispositionKind,
    dispositionNote: r.dispositionNote,
    filedByCounselOn: r.filedByCounselOn,
    docketReference: r.docketReference,
    version: r.version,
  });

  async function loadAppeal(tx: Tx, actor: M25ReadActor, id: string) {
    const scope = providerEntityScopeCondition(AC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(AC)
      .where(scope ? and(eq(AC.id, id), scope) : eq(AC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("appeal case");
    return rows[0];
  }

  /** The subject's provider entity and whether it still takes new deadlines. Out-of-scope reads as absent (404). */
  async function loadSubject(tx: Tx, actor: M25ReadActor, subject: DeadlineSubject) {
    if (subject.kind === "appeal") {
      const a = await loadAppeal(tx, actor, subject.id);
      return {
        providerEntityId: a.providerEntityId,
        finished: a.state === "closed" || a.state === "withdrawn",
        claimId: a.claimId as string | null,
      };
    }
    const scope = providerEntityScopeCondition(AR.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(AR)
      .where(scope ? and(eq(AR.id, subject.id), scope) : eq(AR.id, subject.id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("audit request");
    // An audit request has a single patient only when it covers exactly one claim.
    const live = await tx
      .select({ claimId: schema.auditRequestClaim.claimId })
      .from(schema.auditRequestClaim)
      .where(
        and(
          eq(schema.auditRequestClaim.auditRequestId, subject.id),
          isNull(schema.auditRequestClaim.removedAt),
        ),
      )
      .limit(2);
    return {
      providerEntityId: rows[0].providerEntityId,
      finished: rows[0].state === "closed" || rows[0].state === "withdrawn",
      claimId: live.length === 1 ? (live[0]?.claimId ?? null) : null,
    };
  }

  const subjectFilter = (subject: DeadlineSubject) =>
    subject.kind === "appeal" ? eq(RD.appealCaseId, subject.id) : eq(RD.auditRequestId, subject.id);

  async function zonesFor(tx: Tx, providerEntityId: string): Promise<readonly string[]> {
    const zones = (
      ports.providerZones
        ? await ports.providerZones(tx as unknown as DbClient, providerEntityId)
        : []
    ).filter(isKnownZone);
    return zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  }

  /** A notice document is validated against the appeal's claim patient (the receipt-document rules); audits take none yet. */
  async function checkNoticeDocument(
    organizationId: string,
    subject: DeadlineSubject,
    claimId: string | null,
    documentId: string | null | undefined,
  ): Promise<void> {
    if (!documentId) return;
    if (subject.kind !== "appeal" || !claimId) {
      throw unprocessable(
        "NOTICE_DOCUMENT_UNSUPPORTED",
        "a notice document can be linked to an appeal's deadline only; describe an audit request's source in the source note",
      );
    }
    if (!ports.sources) {
      throw unprocessable("NOTICE_DOCUMENT_UNAVAILABLE", "the document source is not available");
    }
    const claim = await ports.sources.claims().claimCopyForAppeal(organizationId, claimId);
    if (!claim) {
      throw unprocessable(
        "NOTICE_DOCUMENT_UNAVAILABLE",
        "the claim cannot be read to validate the document",
      );
    }
    await describeEnclosures(
      ports.sources.documents(),
      organizationId,
      claim.patientId,
      [documentId],
      undefined,
      "recorded deadline",
    );
  }

  async function auditEvent(
    tx: Tx,
    actor: M25WriteActor,
    subject: DeadlineSubject,
    eventKind: string,
    deadlineId: string,
  ) {
    if (subject.kind !== "audit_request") return;
    await tx.insert(AREV).values({
      organizationId: actor.organizationId,
      auditRequestId: subject.id,
      eventKind,
      eventPayload: { deadlineId },
      actorMembershipId: actor.membershipId,
    });
  }

  async function loadDeadline(tx: Tx, subject: DeadlineSubject, deadlineId: string) {
    const rows = await tx
      .select()
      .from(RD)
      .where(and(eq(RD.id, deadlineId), subjectFilter(subject)))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("recorded deadline");
    return rows[0];
  }

  return {
    async getLaterTier(actor, appealCaseId) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(AC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(AC)
          .where(scope ? and(eq(AC.id, appealCaseId), scope) : eq(AC.id, appealCaseId))
          .limit(1);
        const appeal = rows[0];
        if (!appeal || !isLaterTier(appeal.tier)) return null;
        const detail = (
          await tx.select().from(TD).where(eq(TD.appealCaseId, appealCaseId)).limit(1)
        )[0];
        const deadlines = await tx
          .select()
          .from(RD)
          .where(eq(RD.appealCaseId, appealCaseId))
          .orderBy(asc(RD.dueOn), asc(RD.createdAt));
        const now = new Date();
        return {
          appealCaseId,
          claimId: appeal.claimId,
          patientId: await patientOfClaim(ports.sources, actor.organizationId, appeal.claimId),
          tier: appeal.tier,
          state: appeal.state,
          filedByEscalation: appeal.filedByEscalation,
          windowUnconfirmed: windowUnconfirmed(appeal.tier),
          canPacketRender: canPacketRender(appeal.tier),
          needsManualReview: dispositionNeedsManualReview(detail?.dispositionKind),
          detail: detail ? detailView(detail) : null,
          deadlines: deadlines.map((d) => viewRecordedDeadline(d, now)),
        };
      });
    },

    async putTierDetail(actor, appealCaseId, input, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const appeal = await loadAppeal(tx, actor, appealCaseId);
        const refusal = checkTierDetail(appeal.tier, input);
        if (refusal === "TIER_NOT_LATER") throw new NotFoundError("later-tier appeal case");
        if (refusal) throw unprocessable(`TIER_DETAIL_${refusal}`, TIER_MESSAGES[refusal]);
        if (appeal.state === "closed") {
          throw new ChartWardenError("TIER_DETAIL_FROZEN", "the appeal case is closed", 409);
        }
        const values = {
          authorityReference: clean(input.authorityReference),
          amountInControversyCents: input.amountInControversyCents ?? null,
          hearingOn: clean(input.hearingOn),
          hearingFormatNote: clean(input.hearingFormatNote),
          dispositionKind: clean(input.dispositionKind),
          dispositionNote: clean(input.dispositionNote),
          filedByCounselOn: clean(input.filedByCounselOn),
          docketReference: clean(input.docketReference),
        };
        const existing = (
          await tx.select().from(TD).where(eq(TD.appealCaseId, appealCaseId)).limit(1)
        )[0];
        if (!existing) {
          if (ifMatch !== 0) throw new VersionConflictError(null);
          try {
            const inserted = await tx
              .insert(TD)
              .values({
                organizationId: actor.organizationId,
                providerEntityId: appeal.providerEntityId,
                appealCaseId,
                tier: appeal.tier,
                ...values,
              })
              .returning({ id: TD.id, version: TD.version });
            return inserted[0]!;
          } catch (e) {
            if (isUniqueViolation(e)) throw new VersionConflictError(1);
            throw e;
          }
        }
        const updated = await tx
          .update(TD)
          .set({ ...values, version: sql`${TD.version} + 1`, updatedAt: new Date() })
          .where(and(eq(TD.id, existing.id), eq(TD.version, ifMatch)))
          .returning({ id: TD.id, version: TD.version });
        if (!updated[0]) throw new VersionConflictError(existing.version);
        return updated[0];
      });
    },

    async listDeadlines(actor, subject) {
      return withOrgContext(db, actor, async (tx) => {
        const s = await loadSubject(tx, actor, subject);
        const rows = await tx
          .select()
          .from(RD)
          .where(subjectFilter(subject))
          .orderBy(asc(RD.dueOn), asc(RD.createdAt));
        const now = new Date();
        return {
          items: rows.map((r) => viewRecordedDeadline(r, now)),
          patientId: await patientOfClaim(ports.sources, actor.organizationId, s.claimId),
        };
      });
    },

    async createDeadline(actor, subject, input) {
      const refusal = checkRecordedDeadline(input);
      if (refusal) throw unprocessable(`DEADLINE_${refusal}`, DEADLINE_MESSAGES[refusal]);
      return withOrgContext(db, actor, async (tx) => {
        const s = await loadSubject(tx, actor, subject);
        if (s.finished) throw subjectFinished();
        await checkNoticeDocument(actor.organizationId, subject, s.claimId, input.noticeDocumentId);
        const derived = deriveRecordedDeadline(input.dueOn, await zonesFor(tx, s.providerEntityId));
        const inserted = await tx
          .insert(RD)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: s.providerEntityId,
            appealCaseId: subject.kind === "appeal" ? subject.id : null,
            auditRequestId: subject.kind === "audit_request" ? subject.id : null,
            label: input.label.trim(),
            dueOn: input.dueOn,
            zone: derived.zone,
            sourceNote: input.sourceNote.trim(),
            noticeDocumentId: input.noticeDocumentId ?? null,
            createdByMembershipId: actor.membershipId,
          })
          .returning({ id: RD.id, version: RD.version });
        await auditEvent(tx, actor, subject, "deadline_recorded", inserted[0]!.id);
        return inserted[0]!;
      });
    },

    async updateDeadline(actor, subject, deadlineId, patch, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const s = await loadSubject(tx, actor, subject);
        if (s.finished) throw subjectFinished();
        const cur = await loadDeadline(tx, subject, deadlineId);
        if (cur.satisfiedOn !== null) {
          throw new ChartWardenError(
            "DEADLINE_SATISFIED",
            "a satisfied deadline cannot change",
            409,
          );
        }
        const next = {
          label: patch.label ?? cur.label,
          dueOn: patch.dueOn ?? cur.dueOn,
          sourceNote: patch.sourceNote ?? cur.sourceNote,
        };
        const refusal = checkRecordedDeadline(next);
        if (refusal) throw unprocessable(`DEADLINE_${refusal}`, DEADLINE_MESSAGES[refusal]);
        if (patch.noticeDocumentId !== undefined) {
          await checkNoticeDocument(
            actor.organizationId,
            subject,
            s.claimId,
            patch.noticeDocumentId,
          );
        }
        const dateMoved = next.dueOn !== cur.dueOn;
        const derived = deriveRecordedDeadline(next.dueOn, await zonesFor(tx, s.providerEntityId));
        const updated = await tx
          .update(RD)
          .set({
            label: next.label.trim(),
            dueOn: next.dueOn,
            sourceNote: next.sourceNote.trim(),
            zone: dateMoved ? derived.zone : cur.zone,
            ...(patch.noticeDocumentId !== undefined
              ? { noticeDocumentId: patch.noticeDocumentId }
              : {}),
            // A moved date restarts the alert ladder: the new date may be later than a boundary already alerted.
            ...(dateMoved ? { lastAlertedBoundary: null } : {}),
            version: sql`${RD.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(RD.id, deadlineId), eq(RD.version, ifMatch)))
          .returning({ id: RD.id, version: RD.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await auditEvent(tx, actor, subject, "deadline_changed", deadlineId);
        return updated[0];
      });
    },

    async satisfyDeadline(actor, subject, deadlineId, satisfiedOn, ifMatch) {
      const day = satisfiedOn ?? noticeDayOf(new Date());
      if (!isRealDay(day) || day > noticeDayOf(new Date())) {
        throw unprocessable(
          "DEADLINE_SATISFIED_DATE_INVALID",
          "the satisfied date must be a real date, not in the future",
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const s = await loadSubject(tx, actor, subject);
        if (s.finished) throw subjectFinished();
        const cur = await loadDeadline(tx, subject, deadlineId);
        if (cur.satisfiedOn !== null) {
          throw new ChartWardenError(
            "DEADLINE_SATISFIED",
            "the deadline is already satisfied",
            409,
          );
        }
        const updated = await tx
          .update(RD)
          .set({ satisfiedOn: day, version: sql`${RD.version} + 1`, updatedAt: new Date() })
          .where(and(eq(RD.id, deadlineId), eq(RD.version, ifMatch)))
          .returning({ id: RD.id, version: RD.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await auditEvent(tx, actor, subject, "deadline_satisfied", deadlineId);
        return updated[0];
      });
    },
  };
}
