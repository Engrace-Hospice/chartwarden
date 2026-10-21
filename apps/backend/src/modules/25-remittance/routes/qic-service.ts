// apps/backend/src/modules/25-remittance/routes/qic-service.ts - M25 milestone 4: the QIC reconsideration. The tier
// itself is an ordinary appeal_case (the redetermination decision opens it); this service adds what only that tier
// needs: the documentation the redetermination notice named (draft only), the QIC's own 60-day decision clock
// (computed on read from the receipt date the person records and the late-evidence extensions), and the escalation
// to OMHA when the QIC is late (a recorded request, then a confirmation that opens the ALJ case). Every command runs
// under `withOrgContext` (RLS) inside the actor's provider-entity scope and is If-Match. Nothing is sent from here:
// the escalation request records a filing made outside WardenX (electronic submission is milestone 6). No outbox
// events (nothing consumes them); the appeal_case audit trigger and appeal_case_event rows are the trail, and
// the overdue signal is a nightly alert (jobs/qic-overdue.ts).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  DEFAULT_DEADLINE_ZONE,
  MS_PER_DAY,
  type QicClock,
  type QicEvidenceItem,
  type QicExtension,
  type SubmissionChannel,
  canRequestEscalation,
  canTransitionAppeal,
  checkEscalationFiling,
  checkQicExtension,
  containsMbi,
  deriveQicDecisionClock,
  isKnownZone,
  isQicOverdue,
  parseNoticeDay,
  qicDaysOverdue,
} from "../domain";
import type { M25ReadActor, M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import {
  QIC_ESCALATION_FILING_MESSAGES,
  QIC_ESCALATION_MESSAGES,
  QIC_EXTENSION_MESSAGES,
} from "./qic-messages";
import { providerEntityScopeCondition } from "./scope";
import { recordFilingAttempt } from "./submission-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type AppealRow = typeof schema.appealCase.$inferSelect;

/** The most items one reconsideration may cite (a QIC packet has a hard ceiling too). */
export const MAX_CITED_EVIDENCE_ITEMS = 50;

export interface CitedEvidenceInput {
  readonly items: readonly QicEvidenceItem[];
  /** The attestation that the redetermination notice named no missing documentation. */
  readonly none: boolean;
}

export type QicClockInput = { readonly receivedOn: string } | { readonly extensionDays: number };

export interface EscalationRequestInput {
  readonly channel: string;
  readonly confirmationRef: string;
  /** When the request was actually sent (ISO date-time). */
  readonly requestedAt: string;
}

export interface QicClockView {
  readonly receivedOn: string;
  readonly baseDays: number;
  readonly extensionDays: number;
  readonly extensions: readonly QicExtension[];
  readonly decisionDueOn: string;
  readonly decisionDueAt: string;
  readonly zone: string;
  readonly overdue: boolean;
  readonly daysOverdue: number;
}

export interface QicEscalationView {
  readonly requestedAt: string;
  readonly channel: string;
  readonly confirmationRef: string;
  /** null until the date the QIC forwarded the case is confirmed. */
  readonly confirmedOn: string | null;
}

/**
 * `reconsideration`: the QIC tier. `escalated_alj`: the ALJ case an escalation opened (it has no filing deadline).
 * `none`: any other appeal (the QIC surface does not apply).
 */
export interface QicView {
  readonly id: string;
  readonly kind: "reconsideration" | "escalated_alj" | "none";
  readonly tier: string;
  readonly state: string;
  readonly version: number;
  /** The date printed on the redetermination notice (the clock the 180-day filing deadline runs from). */
  readonly redeterminationNoticeDate: string | null;
  readonly citedEvidence: readonly QicEvidenceItem[];
  readonly citedEvidenceNone: boolean;
  /** The list is editable only while the case is a draft. */
  readonly evidenceEditable: boolean;
  /** null = no receipt date recorded: no clock is computed and escalation is not offered. */
  readonly clock: QicClockView | null;
  readonly escalation: QicEscalationView | null;
  readonly escalationEligible: boolean;
  /** Why escalation is not offered right now (a message), or null when it is, or does not apply. */
  readonly escalationBlockedReason: string | null;
  /** The ALJ case an escalation opened, once confirmed. */
  readonly nextAppealCaseId: string | null;
  /** For an `escalated_alj` case: the reconsideration it was escalated from. */
  readonly escalatedFromAppealCaseId: string | null;
}

export interface QicService {
  getQic(actor: M25ReadActor, id: string): Promise<QicView | null>;
  setCitedEvidence(
    actor: M25WriteActor,
    id: string,
    input: CitedEvidenceInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  recordQicClock(
    actor: M25WriteActor,
    id: string,
    input: QicClockInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  requestEscalation(
    actor: M25WriteActor,
    id: string,
    input: EscalationRequestInput,
    ifMatch: number,
  ): Promise<{ id: string; version: number }>;
  confirmEscalation(
    actor: M25WriteActor,
    id: string,
    input: { forwardedOn: string },
    ifMatch: number,
  ): Promise<{ id: string; version: number; nextAppealCaseId: string }>;
}

export interface QicServiceDeps {
  /** The timezones of a provider entity's locations (M1's published reader); absent -> the default zone. */
  readonly providerZones?: (tx: DbClient, providerEntityId: string) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

const iso = (d: Date | string | null): string | null =>
  d === null ? null : d instanceof Date ? d.toISOString() : String(d);

/** Parse a stored `[{days, recordedAt}]` defensively (the column is jsonb); anything malformed is dropped. */
function asExtensions(value: unknown): QicExtension[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): QicExtension[] =>
    e && typeof e === "object" && typeof (e as QicExtension).days === "number"
      ? [
          {
            days: (e as QicExtension).days,
            recordedAt: String((e as QicExtension).recordedAt ?? ""),
          },
        ]
      : [],
  );
}

/** Parse the stored cited-evidence list defensively (the column is jsonb). */
export function asEvidence(value: unknown): QicEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((e): QicEvidenceItem[] =>
    e && typeof e === "object"
      ? [
          {
            label: String((e as QicEvidenceItem).label ?? ""),
            documentId: (e as QicEvidenceItem).documentId ?? null,
            notAvailableReason: (e as QicEvidenceItem).notAvailableReason ?? null,
          },
        ]
      : [],
  );
}

/** A date the person typed: a real calendar day, not further ahead than a time-zone difference can explain. */
function checkedDay(day: string, what: string, now: Date): string {
  let ms: number;
  try {
    ms = parseNoticeDay(day);
  } catch {
    throw new ChartWardenError("INVALID_DATE", `${what} is not a real calendar date (YYYY-MM-DD)`, 422);
  }
  if (ms > now.getTime() + MS_PER_DAY) {
    throw new ChartWardenError("DATE_IN_FUTURE", `${what} cannot be in the future`, 422);
  }
  return day;
}

/** M25 holds no Medicare number by design: free text that carries one is refused, not stored. */
function assertNoMbi(value: string | null, what: string): void {
  if (value !== null && containsMbi(value)) {
    throw new ChartWardenError(
      "MBI_NOT_ALLOWED",
      `${what} looks like a Medicare number. Do not enter the Medicare number here; the request is completed and signed by hand.`,
      422,
    );
  }
}

export function buildDrizzleQicService(db: DbClient, deps: QicServiceDeps = {}): QicService {
  const AC = schema.appealCase;
  const AE = schema.appealCaseEvent;
  const nowOf = (): Date => (deps.now ?? (() => new Date()))();

  async function zonesOf(tx: Tx, providerEntityId: string): Promise<readonly string[]> {
    const zones = (
      deps.providerZones
        ? await deps.providerZones(tx as unknown as DbClient, providerEntityId)
        : []
    ).filter(isKnownZone);
    return zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE];
  }

  async function load(tx: Tx, actor: M25ReadActor, id: string): Promise<AppealRow> {
    const scope = providerEntityScopeCondition(AC.providerEntityId, actor.providerEntityScope);
    const rows = await tx
      .select()
      .from(AC)
      .where(scope ? and(eq(AC.id, id), scope) : eq(AC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("appeal case not found");
    return rows[0];
  }

  function requireReconsideration(row: AppealRow): void {
    if (row.tier !== "reconsideration") {
      throw new ChartWardenError(
        "NOT_RECONSIDERATION",
        "this applies only to a QIC reconsideration appeal",
        409,
      );
    }
  }

  async function clockOf(tx: Tx, row: AppealRow): Promise<QicClock | null> {
    if (row.qicReceivedOn === null) return null;
    return deriveQicDecisionClock({
      receivedOn: row.qicReceivedOn,
      extensions: asExtensions(row.qicClockExtensions),
      zones: await zonesOf(tx, row.providerEntityId),
    });
  }

  /** One guarded progress update: version + state pinned, an event row, all in the caller's transaction. */
  async function update(
    tx: Tx,
    actor: M25WriteActor,
    cur: AppealRow,
    ifMatch: number,
    set: Partial<typeof AC.$inferInsert>,
    event: { kind: (typeof AE.$inferInsert)["eventKind"]; payload?: Record<string, unknown> },
  ): Promise<{ id: string; version: number }> {
    const updated = await tx
      .update(AC)
      .set({ ...set, version: sql`${AC.version} + 1` })
      .where(and(eq(AC.id, cur.id), eq(AC.version, ifMatch), eq(AC.state, cur.state)))
      .returning({ id: AC.id, version: AC.version });
    if (!updated[0]) throw new VersionConflictError(cur.version);
    await tx.insert(AE).values({
      organizationId: actor.organizationId,
      appealCaseId: cur.id,
      eventKind: event.kind,
      eventPayload: event.payload ?? null,
      actorMembershipId: actor.membershipId,
    });
    return updated[0];
  }

  async function viewOf(tx: Tx, row: AppealRow): Promise<QicView> {
    const base = {
      id: row.id,
      tier: row.tier,
      state: row.state,
      version: row.version,
      redeterminationNoticeDate: row.noticeDatedOn,
      citedEvidence: asEvidence(row.citedEvidence),
      citedEvidenceNone: row.citedEvidenceNone,
      evidenceEditable: row.tier === "reconsideration" && row.state === "draft",
      clock: null,
      escalation: null,
      escalationEligible: false,
      escalationBlockedReason: null,
      nextAppealCaseId: null,
      escalatedFromAppealCaseId: null,
    } as const;
    if (row.tier === "alj" && row.filedByEscalation) {
      return {
        ...base,
        kind: "escalated_alj",
        escalatedFromAppealCaseId: row.priorTierAppealCaseId,
      };
    }
    if (row.tier !== "reconsideration") return { ...base, kind: "none" };

    const now = nowOf();
    const clock = await clockOf(tx, row);
    const refusal = canRequestEscalation({
      tier: row.tier,
      state: row.state,
      clock,
      alreadyRequested: row.escalationRequestedAt !== null,
      now,
    });
    const next =
      row.state === "escalated"
        ? await tx
            .select({ id: AC.id })
            .from(AC)
            .where(and(eq(AC.priorTierAppealCaseId, row.id), eq(AC.tier, "alj")))
            .orderBy(asc(AC.createdAt))
            .limit(1)
        : [];
    return {
      ...base,
      kind: "reconsideration",
      clock: clock
        ? {
            receivedOn: clock.receivedOn,
            baseDays: clock.baseDays,
            extensionDays: clock.extensionDays,
            extensions: asExtensions(row.qicClockExtensions),
            decisionDueOn: clock.decisionDueOn,
            decisionDueAt: clock.decisionDueAt.toISOString(),
            zone: clock.zone,
            overdue: isQicOverdue(clock, now),
            daysOverdue: qicDaysOverdue(clock, now),
          }
        : null,
      escalation:
        row.escalationRequestedAt && row.escalationChannel && row.escalationConfirmationRef
          ? {
              requestedAt: row.escalationRequestedAt.toISOString(),
              channel: row.escalationChannel,
              confirmationRef: row.escalationConfirmationRef,
              confirmedOn: row.escalationConfirmedOn,
            }
          : null,
      escalationEligible: refusal === null,
      // Only the states where the QIC is still working the case explain why escalation is off.
      escalationBlockedReason:
        refusal === null ||
        row.state === "draft" ||
        row.state === "escalated" ||
        row.state === "closed"
          ? null
          : QIC_ESCALATION_MESSAGES[refusal],
      nextAppealCaseId: next[0]?.id ?? null,
    };
  }

  return {
    async getQic(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const scope = providerEntityScopeCondition(AC.providerEntityId, actor.providerEntityScope);
        const rows = await tx
          .select()
          .from(AC)
          .where(scope ? and(eq(AC.id, id), scope) : eq(AC.id, id))
          .limit(1);
        return rows[0] ? viewOf(tx, rows[0]) : null;
      });
    },

    async setCitedEvidence(actor, id, input, ifMatch) {
      if (input.items.length > MAX_CITED_EVIDENCE_ITEMS) {
        throw new ChartWardenError(
          "TOO_MANY_EVIDENCE_ITEMS",
          `a reconsideration may cite at most ${MAX_CITED_EVIDENCE_ITEMS} items`,
          422,
        );
      }
      if (input.none && input.items.length > 0) {
        throw new ChartWardenError(
          "EVIDENCE_LIST_CONFLICT",
          "the list names documentation but also says the notice named none; keep one or the other",
          422,
        );
      }
      for (const i of input.items) {
        assertNoMbi(i.label, "an item label");
        assertNoMbi(i.notAvailableReason, "an item reason");
      }
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        requireReconsideration(cur);
        if (cur.state !== "draft") {
          throw new ChartWardenError(
            "EVIDENCE_FROZEN",
            "the cited evidence is part of the filed request and cannot change after it is submitted",
            409,
          );
        }
        return update(
          tx,
          actor,
          cur,
          ifMatch,
          {
            citedEvidence: input.items.map((i) => ({
              label: i.label.trim(),
              documentId: i.documentId,
              notAvailableReason:
                i.documentId === null ? (i.notAvailableReason ?? "").trim() : null,
            })),
            citedEvidenceNone: input.none,
          },
          { kind: "evidence_updated", payload: { items: input.items.length, none: input.none } },
        );
      });
    },

    async recordQicClock(actor, id, input, ifMatch) {
      const now = nowOf();
      if ("extensionDays" in input) {
        const refusal = checkQicExtension(input.extensionDays);
        if (refusal) throw new ChartWardenError(refusal, QIC_EXTENSION_MESSAGES[refusal], 422);
      }
      const receivedOn =
        "receivedOn" in input ? checkedDay(input.receivedOn, "the receipt date", now) : null;
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        requireReconsideration(cur);
        // The QIC acknowledges after the request is filed; a draft has no clock to record against.
        if (cur.state !== "submitted" && cur.state !== "under_review") {
          throw new ChartWardenError(
            "INVALID_STATE",
            "the QIC clock is recorded after the request is submitted and while the QIC is reviewing it",
            409,
          );
        }
        if (receivedOn === null && cur.state !== "under_review") {
          throw new ChartWardenError(
            "INVALID_STATE",
            "a late-evidence extension is recorded while the QIC is reviewing the request",
            409,
          );
        }
        if (cur.escalationRequestedAt !== null) {
          throw new ChartWardenError(
            "CLOCK_FROZEN",
            "an escalation request is recorded, so the QIC clock it was measured against cannot change",
            409,
          );
        }
        if (receivedOn !== null) {
          // The QIC cannot have received the request before it was filed. One day of slack: the filing instant
          // is stored in UTC and the printed receipt date is in the provider's zone.
          if (
            cur.submittedAt &&
            parseNoticeDay(receivedOn) <
              parseNoticeDay(cur.submittedAt.toISOString().slice(0, 10)) - MS_PER_DAY
          ) {
            throw new ChartWardenError(
              "RECEIPT_BEFORE_FILING",
              "the QIC cannot have received the request before it was filed in ChartWarden; check the date on the acknowledgement",
              422,
            );
          }
          return update(
            tx,
            actor,
            cur,
            ifMatch,
            { qicReceivedOn: receivedOn },
            {
              kind: "qic_clock_recorded",
              payload: { receivedOn, previousReceivedOn: cur.qicReceivedOn },
            },
          );
        }
        if (cur.qicReceivedOn === null) {
          throw new ChartWardenError(
            "QIC_RECEIPT_NOT_RECORDED",
            "record the date the QIC received the request before adding a late-evidence extension",
            409,
          );
        }
        const days = (input as { extensionDays: number }).extensionDays;
        const extension: QicExtension = { days, recordedAt: now.toISOString() };
        return update(
          tx,
          actor,
          cur,
          ifMatch,
          { qicClockExtensions: [...asExtensions(cur.qicClockExtensions), extension] },
          { kind: "qic_clock_recorded", payload: { extensionDays: days } },
        );
      });
    },

    async requestEscalation(actor, id, input, ifMatch) {
      const now = nowOf();
      const requestedAt = new Date(input.requestedAt);
      if (Number.isNaN(requestedAt.getTime())) {
        throw new ChartWardenError(
          "INVALID_REQUESTED_AT",
          "the request time is not a real date and time",
          422,
        );
      }
      const fileWith = (notBefore?: Date) =>
        checkEscalationFiling({
          channel: input.channel,
          confirmationRef: input.confirmationRef,
          requestedAt,
          now,
          ...(notBefore ? { notBefore } : {}),
        });
      const early = fileWith();
      if (early) throw new ChartWardenError(early, QIC_ESCALATION_FILING_MESSAGES[early], 422);
      assertNoMbi(input.confirmationRef, "the confirmation reference");
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        const clock = cur.tier === "reconsideration" ? await clockOf(tx, cur) : null;
        const refusal = canRequestEscalation({
          tier: cur.tier,
          state: cur.state,
          clock,
          alreadyRequested: cur.escalationRequestedAt !== null,
          now,
        });
        if (refusal) throw new ChartWardenError(refusal, QIC_ESCALATION_MESSAGES[refusal], 409);
        // The request was made after the QIC's decision date (and so after the receipt and the filing): this also
        // bounds the forwarding date and the ALJ case's stored instant.
        const late = fileWith(clock?.decisionDueAt);
        if (late) throw new ChartWardenError(late, QIC_ESCALATION_FILING_MESSAGES[late], 422);
        // The state stays `under_review`: the QIC may still decide until it forwards the case.
        const result = await update(
          tx,
          actor,
          cur,
          ifMatch,
          {
            escalationRequestedAt: requestedAt,
            escalationChannel: input.channel,
            escalationConfirmationRef: input.confirmationRef.trim(),
          },
          { kind: "escalation_requested", payload: { channel: input.channel } },
        );
        // Milestone 6a: the request's attempt record (already acknowledged: the case carried channel, reference, time).
        await recordFilingAttempt(tx, {
          organizationId: actor.organizationId,
          providerEntityId: cur.providerEntityId,
          purpose: "qic_escalation_request",
          subjectId: id,
          channel: input.channel as SubmissionChannel,
          confirmationRef: input.confirmationRef.trim(),
          receiptAt: requestedAt,
          actorMembershipId: actor.membershipId,
        });
        return result;
      });
    },

    async confirmEscalation(actor, id, input, ifMatch) {
      const now = nowOf();
      const forwardedOn = checkedDay(input.forwardedOn, "the forwarding date", now);
      return withOrgContext(db, actor, async (tx) => {
        const cur = await load(tx, actor, id);
        requireReconsideration(cur);
        if (!canTransitionAppeal(cur.state, "escalated")) {
          throw new ChartWardenError(
            "INVALID_TRANSITION",
            `cannot transition from '${cur.state}' to 'escalated'`,
            409,
          );
        }
        if (cur.escalationRequestedAt === null) {
          throw new ChartWardenError(
            "ESCALATION_NOT_REQUESTED",
            "record the escalation request before confirming that the QIC forwarded the case",
            409,
          );
        }
        // One day of slack: the request instant and the printed forwarding date can sit in different time zones.
        if (
          parseNoticeDay(forwardedOn) <
          parseNoticeDay(cur.escalationRequestedAt.toISOString().slice(0, 10)) - MS_PER_DAY
        ) {
          throw new ChartWardenError(
            "FORWARDED_BEFORE_REQUEST",
            "the case cannot have been forwarded before the escalation was requested",
            422,
          );
        }
        const moved = await update(
          tx,
          actor,
          cur,
          ifMatch,
          { state: "escalated", escalationConfirmedOn: forwardedOn },
          { kind: "escalated_to_next_tier", payload: { forwardedOn } },
        );
        // The ALJ case opens already filed (the QIC forwarded it). It has no filing deadline of its own: the NOT NULL
        // `tier_deadline_at` is the escalation request instant, which is in the past, so no deadline alert fires.
        const alj = await tx
          .insert(AC)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: cur.providerEntityId,
            denialCaseId: cur.denialCaseId,
            claimId: cur.claimId,
            priorTierAppealCaseId: cur.id,
            tier: "alj",
            state: "submitted",
            tierDeadlineAt: cur.escalationRequestedAt,
            submittedAt: now,
            filedByEscalation: true,
          })
          .returning({ id: AC.id });
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: alj[0]!.id,
          eventKind: "created",
          eventPayload: { escalatedFromAppealCaseId: cur.id },
          actorMembershipId: actor.membershipId,
        });
        return { ...moved, nextAppealCaseId: alj[0]!.id };
      });
    },
  };
}
