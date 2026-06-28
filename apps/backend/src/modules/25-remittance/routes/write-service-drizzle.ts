// apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts — the Drizzle-backed M25 WRITE
// service. Each command runs under `withOrgContext` (RLS), validates the §2.2 transition via the pure
// domain machines, version-checks the PATCH surfaces (§2.5 — `WHERE id = ? AND version = ?` with a
// distinguishing re-read), stamps the acting membership, and emits the §4.5 outbox event through the
// injected {@link WriteOutboxPort}. A failed transition → INVALID_TRANSITION; a stale version →
// VERSION_CONFLICT; a missing row → NOT_FOUND. Free-text reason/narrative is stored in the audit-denylisted
// columns (override_payload / appeal_narrative / assignment.reason), NEVER in an outbox payload.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import {
  canTransitionAppeal,
  canTransitionDenial,
  computeTierDeadline,
  type DenialState,
  nextTier,
} from "../domain";
import type { M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import type {
  AdjustmentOverrideInput,
  AppealCreateInput,
  AppealDecideInput,
  AppealSubmitInput,
  DenialAssignInput,
  M25WriteService,
  ManualMatchInput,
  ReasonInput,
  TaxonomyOverlayInput,
  VersionedResult,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async emit() {} };

/** The real Drizzle transaction handle (has .select/.update/.insert), inferred from the db client. */
type M25Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

class InvalidTransitionError extends WardenXError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `cannot transition from '${from}' to '${to}'`, 409);
    this.name = "InvalidTransitionError";
  }
}

export function buildDrizzleM25WriteService(
  db: DbClient,
  outbox: WriteOutboxPort = NOOP_OUTBOX,
): M25WriteService {
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const ADJ = schema.remittanceAdjustment;
  const DC = schema.denialCase;
  const AC = schema.appealCase;
  const AE = schema.appealCaseEvent;
  const TO = schema.denialTaxonomyOverlay;

  /** Read a denial's current (state, version) or throw NOT_FOUND. */
  async function denialState(tx: M25Tx, id: string) {
    const rows = await tx
      .select({ state: DC.state, version: DC.version, providerEntityId: DC.providerEntityId, claimId: DC.claimId })
      .from(DC)
      .where(eq(DC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("denial case not found");
    return rows[0];
  }

  /** Versioned denial transition: validate the edge, then `UPDATE … WHERE id AND version`. */
  async function transitionDenial(
    actor: M25WriteActor,
    id: string,
    to: DenialState,
    ifMatch: number,
    extra: Record<string, unknown>,
  ): Promise<VersionedResult> {
    return withOrgContext(db, actor, async (tx) => {
      const cur = await denialState(tx, id);
      if (!canTransitionDenial(cur.state, to)) throw new InvalidTransitionError(cur.state, to);
      const updated = await tx
        .update(DC)
        .set({ state: to, version: cur.version + 1, ...extra })
        .where(and(eq(DC.id, id), eq(DC.version, ifMatch)))
        .returning({ id: DC.id, version: DC.version });
      if (!updated[0]) throw new VersionConflictError(cur.version);
      return { id: updated[0].id, version: updated[0].version };
    });
  }

  return {
    async replayAdvice(actor, adviceId) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select({ status: RA.parseStatus }).from(RA).where(eq(RA.id, adviceId)).limit(1);
        if (!rows[0]) throw new NotFoundError("remittance advice not found");
        if (rows[0].status !== "failed") {
          throw new WardenXError("INVALID_STATE", "only a failed advice can be replayed", 409);
        }
        await tx.update(RA).set({ parseStatus: "queued" }).where(eq(RA.id, adviceId));
      });
      await outbox.emit(actor.organizationId, {
        eventName: "m25.edi.835_received",
        payload: { remittanceAdviceId: adviceId, replay: true },
      });
    },

    async manualMatch(actor, lineId, input: ManualMatchInput) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select({ id: RL.id, matchState: RL.matchState }).from(RL).where(eq(RL.id, lineId)).limit(1);
        if (!rows[0]) throw new NotFoundError("remittance line not found");
        if (rows[0].matchState !== "unmatched") {
          throw new WardenXError("INVALID_STATE", "only an unmatched line can be manually matched", 409);
        }
        await tx
          .update(RL)
          .set({
            claimId: input.proposedClaimId,
            matchState: "manual_matched",
            matchStrategy: "manual",
            matchConfidence: 100,
            matchedAt: sql`now()`,
            matchedByMembershipId: actor.membershipId,
          })
          .where(eq(RL.id, lineId));
      });
      await outbox.emit(actor.organizationId, {
        eventName: "m25.remittance.manual_match_recorded",
        payload: { remittanceLineId: lineId, claimId: input.proposedClaimId, matchedByMembershipId: actor.membershipId },
      });
    },

    async overrideAdjustment(actor, adjustmentId, input: AdjustmentOverrideInput) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select({ id: ADJ.id }).from(ADJ).where(eq(ADJ.id, adjustmentId)).limit(1);
        if (!rows[0]) throw new NotFoundError("remittance adjustment not found");
        await tx.update(ADJ).set({ postAction: input.newPostAction }).where(eq(ADJ.id, adjustmentId));
      });
    },

    async assignDenial(actor, id, input: DenialAssignInput, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await denialState(tx, id);
        const updated = await tx
          .update(DC)
          .set({ assigneeMembershipId: input.assigneeMembershipId, version: cur.version + 1 })
          .where(and(eq(DC.id, id), eq(DC.version, ifMatch)))
          .returning({ id: DC.id, version: DC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(schema.denialCaseAssignment).values({
          organizationId: actor.organizationId,
          denialCaseId: id,
          assignedToMembershipId: input.assigneeMembershipId,
          assignedByMembershipId: actor.membershipId,
          reason: input.reason ?? null,
        });
        return { id: updated[0].id, version: updated[0].version };
      });
    },

    async startDenial(actor, id, ifMatch) {
      return transitionDenial(actor, id, "in_progress", ifMatch, { firstActionedAt: sql`now()` });
    },

    async escalateDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(actor, id, "escalated", ifMatch, {});
    },

    async resolveDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(actor, id, "resolved", ifMatch, {
        resolvedAt: sql`now()`,
        closureOutcome: "resolved_no_appeal",
      });
    },

    async closeDenial(actor, id, ifMatch) {
      return transitionDenial(actor, id, "closed", ifMatch, { closedAt: sql`now()` });
    },

    async closeWriteOffDenial(actor, id, input: ReasonInput, ifMatch) {
      const result = await transitionDenial(actor, id, "closed", ifMatch, {
        closedAt: sql`now()`,
        closureOutcome: "written_off",
        overridePayload: { reason: input.reason, by: actor.membershipId },
      });
      await outbox.emit(actor.organizationId, {
        eventName: "m25.patient_responsibility.recorded",
        payload: { denialCaseId: id, writeOff: true },
      });
      return result;
    },

    async reopenDenial(actor, id, _input: ReasonInput, ifMatch) {
      return transitionDenial(actor, id, "open", ifMatch, { closedAt: null, resolvedAt: null });
    },

    async createAppeal(actor, denialCaseId, input: AppealCreateInput) {
      const result = await withOrgContext(db, actor, async (tx) => {
        const cur = await denialState(tx, denialCaseId);
        const tier = input.tier ?? "redetermination";
        // Anchor the redetermination clock on the linked line's received date when available (F04), else
        // the denial open date. Later tiers anchor on a prior decision (handled when that appeal decides).
        const anchorRows = await tx
          .select({ openedAt: DC.openedAt, remittanceLineId: DC.remittanceLineId })
          .from(DC)
          .where(eq(DC.id, denialCaseId))
          .limit(1);
        let anchor = anchorRows[0]?.openedAt ?? new Date();
        const lineId = anchorRows[0]?.remittanceLineId;
        if (lineId) {
          const lr = await tx.select({ receivedAt: RL.receivedAt }).from(RL).where(eq(RL.id, lineId)).limit(1);
          if (lr[0]?.receivedAt) anchor = lr[0].receivedAt;
        }
        const deadline = computeTierDeadline(tier, anchor instanceof Date ? anchor : new Date(anchor));
        if (!cur.claimId) throw new WardenXError("INVALID_STATE", "the denial has no claim to appeal", 409);
        const inserted = await tx
          .insert(AC)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: cur.providerEntityId,
            denialCaseId,
            claimId: cur.claimId,
            tier,
            state: "draft",
            tierDeadlineAt: deadline,
          })
          .returning({ id: AC.id, version: AC.version });
        const appealId = inserted[0]!.id;
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: appealId,
          eventKind: "created",
          actorMembershipId: actor.membershipId,
        });
        // Move the denial onto the appealed track when the edge is legal (escalated → appealed).
        if (canTransitionDenial(cur.state, "appealed")) {
          await tx.update(DC).set({ state: "appealed", version: cur.version + 1 }).where(eq(DC.id, denialCaseId));
        }
        return { id: appealId, version: inserted[0]!.version };
      });
      return result;
    },

    async attachAppealDocument(actor, id, documentId, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const cur = await appealRow(tx, id);
        const updated = await tx
          .update(AC)
          .set({ appealPacketDocumentId: documentId, version: cur.version + 1 })
          .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
          .returning({ id: AC.id, version: AC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: id,
          eventKind: "attached_document",
          actorMembershipId: actor.membershipId,
        });
        return { id: updated[0].id, version: updated[0].version };
      });
    },

    async submitAppeal(actor, id, input: AppealSubmitInput, ifMatch) {
      const result = await transitionAppeal(actor, id, "submitted", ifMatch, {
        submittedAt: sql`now()`,
        appealNarrative: { narrative: input.appealNarrative, documents: input.attachedDocumentIds },
      });
      await outbox.emit(actor.organizationId, {
        eventName: "m25.appeal.submitted",
        payload: { appealCaseId: id, submittedAt: new Date().toISOString() },
      });
      await outbox.emit(actor.organizationId, {
        eventName: "m25.appeal_packet.render_requested",
        payload: { appealCaseId: id, payload: {} },
      });
      return result;
    },

    async ackAppeal(actor, id, ifMatch) {
      return transitionAppeal(actor, id, "under_review", ifMatch, {});
    },

    async decideAppeal(actor, id, input: AppealDecideInput, ifMatch) {
      const result = await withOrgContext(db, actor, async (tx) => {
        const cur = await appealRow(tx, id);
        if (!canTransitionAppeal(cur.state, "decided")) throw new InvalidTransitionError(cur.state, "decided");
        const updated = await tx
          .update(AC)
          .set({
            state: "decided",
            decisionOutcome: input.outcome,
            decidedAt: new Date(input.decidedAt),
            macReferenceNumbers: input.macReferenceNumbers ?? null,
            version: cur.version + 1,
          })
          .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
          .returning({ id: AC.id, version: AC.version });
        if (!updated[0]) throw new VersionConflictError(cur.version);
        await tx.insert(AE).values({
          organizationId: actor.organizationId,
          appealCaseId: id,
          eventKind: "decided",
          actorMembershipId: actor.membershipId,
        });
        // Unfavorable → spawn the next tier (draft) when one exists, anchored on this decision (F04).
        if (input.outcome === "unfavorable") {
          const nt = nextTier(cur.tier);
          if (nt) {
            await tx.insert(AC).values({
              organizationId: actor.organizationId,
              providerEntityId: cur.providerEntityId,
              denialCaseId: cur.denialCaseId,
              claimId: cur.claimId,
              priorTierAppealCaseId: id,
              tier: nt,
              state: "draft",
              tierDeadlineAt: computeTierDeadline(nt, new Date(input.decidedAt)),
            });
          }
        }
        return { id: updated[0].id, version: updated[0].version, denialCaseId: cur.denialCaseId, claimId: cur.claimId, tier: cur.tier };
      });
      if (input.outcome === "favorable") {
        await outbox.emit(actor.organizationId, {
          eventName: "m25.denial.resolved_favorable_via_appeal",
          payload: { denialCaseId: result.denialCaseId, appealCaseId: id, claimId: result.claimId, tier: result.tier },
        });
      }
      return { id: result.id, version: result.version };
    },

    async withdrawAppeal(actor, id, _input: ReasonInput, ifMatch) {
      return transitionAppeal(actor, id, "withdrawn", ifMatch, {});
    },

    async closeAppeal(actor, id, ifMatch) {
      return transitionAppeal(actor, id, "closed", ifMatch, { closedAt: sql`now()` });
    },

    async editTaxonomyOverlay(actor, carcCode, input: TaxonomyOverlayInput, ifMatch) {
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx.select({ id: TO.id, version: TO.version }).from(TO).where(eq(TO.carcCode, carcCode)).limit(1);
        if (rows[0]) {
          const updated = await tx
            .update(TO)
            .set({
              rarcCode: input.rarcCode ?? null,
              plainLanguageOverride: input.plainLanguageOverride ?? null,
              suggestedAction: input.suggestedAction,
              ownerRole: input.ownerRole as typeof TO.ownerRole.enumValues[number],
              severity: input.severity as typeof TO.severity.enumValues[number],
              version: rows[0].version + 1,
              updatedAt: sql`now()`,
            })
            .where(and(eq(TO.id, rows[0].id), eq(TO.version, ifMatch)))
            .returning({ id: TO.id, version: TO.version });
          if (!updated[0]) throw new VersionConflictError(rows[0].version);
          return { id: updated[0].id, version: updated[0].version };
        }
        const inserted = await tx
          .insert(TO)
          .values({
            organizationId: actor.organizationId,
            carcCode,
            rarcCode: input.rarcCode ?? null,
            plainLanguageOverride: input.plainLanguageOverride ?? null,
            suggestedAction: input.suggestedAction,
            ownerRole: input.ownerRole as typeof TO.ownerRole.enumValues[number],
            severity: input.severity as typeof TO.severity.enumValues[number],
          })
          .returning({ id: TO.id, version: TO.version });
        return { id: inserted[0]!.id, version: inserted[0]!.version };
      });
    },
  };

  /** Read an appeal's current row facts or throw NOT_FOUND. */
  async function appealRow(tx: M25Tx, id: string) {
    const rows = await tx
      .select({
        state: AC.state,
        version: AC.version,
        tier: AC.tier,
        denialCaseId: AC.denialCaseId,
        claimId: AC.claimId,
        providerEntityId: AC.providerEntityId,
      })
      .from(AC)
      .where(eq(AC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("appeal case not found");
    return rows[0];
  }

  /** Versioned appeal transition: validate the edge, then `UPDATE … WHERE id AND version`. */
  async function transitionAppeal(
    actor: M25WriteActor,
    id: string,
    to: "submitted" | "under_review" | "withdrawn" | "closed",
    ifMatch: number,
    extra: Record<string, unknown>,
  ): Promise<VersionedResult> {
    return withOrgContext(db, actor, async (tx) => {
      const cur = await appealRow(tx, id);
      if (!canTransitionAppeal(cur.state, to)) throw new InvalidTransitionError(cur.state, to);
      const updated = await tx
        .update(AC)
        .set({ state: to, version: cur.version + 1, ...extra })
        .where(and(eq(AC.id, id), eq(AC.version, ifMatch)))
        .returning({ id: AC.id, version: AC.version });
      if (!updated[0]) throw new VersionConflictError(cur.version);
      return { id: updated[0].id, version: updated[0].version };
    });
  }
}
