// apps/backend/src/modules/25-remittance/routes/write-service-drizzle.ts — the Drizzle-backed M25 WRITE
// service. Each command runs under `withOrgContext` (RLS), validates the §2.2 transition via the pure
// domain machines, version-checks the PATCH surfaces (§2.5 — `WHERE id = ? AND version = ?` with a
// distinguishing re-read), stamps the acting membership, and emits the §4.5 outbox event through the
// injected {@link WriteOutboxPort}. A failed transition → INVALID_TRANSITION; a stale version →
// VERSION_CONFLICT; a missing row → NOT_FOUND. Free-text reason/narrative is stored in the audit-denylisted
// columns (override_payload / appeal_narrative / assignment.reason), NEVER in an outbox payload.
import { repositories } from "@wardenx/billing";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, eq, sql } from "drizzle-orm";
import {
  type DenialState,
  canTransitionAppeal,
  canTransitionDenial,
  computeTierDeadline,
  nextTier,
} from "../domain";
import type { M25WriteActor } from "./actor";
import { VersionConflictError } from "./concurrency";
import { type RemittanceCommandDeps, buildRemittanceCommands } from "./remittance-commands-drizzle";
import type {
  AppealCreateInput,
  AppealDecideInput,
  AppealSubmitInput,
  DenialAssignInput,
  M25WriteService,
  ReasonInput,
  TaxonomyOverlayInput,
  VersionedResult,
  WriteOutboxPort,
} from "./write-service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };

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
  ports: Pick<RemittanceCommandDeps, "claims" | "audit"> = {},
): M25WriteService {
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const DC = schema.denialCase;
  const AC = schema.appealCase;
  const AE = schema.appealCaseEvent;
  const TO = schema.denialTaxonomyOverlay;

  /** Read a denial's current (state, version) or throw NOT_FOUND. */
  async function denialState(tx: M25Tx, id: string) {
    const rows = await tx
      .select({
        state: DC.state,
        version: DC.version,
        providerEntityId: DC.providerEntityId,
        claimId: DC.claimId,
      })
      .from(DC)
      .where(eq(DC.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundError("denial case not found");
    return rows[0];
  }

  /**
   * Versioned denial transition: validate the edge, `UPDATE … WHERE id AND version`, then run the optional
   * `emit` IN THE SAME TX (so the §4.5 outbox row commits with the mutation — the D2 posture).
   */
  async function transitionDenial(
    actor: M25WriteActor,
    id: string,
    to: DenialState,
    ifMatch: number,
    extra: Record<string, unknown>,
    emit?: (tx: M25Tx, cur: Awaited<ReturnType<typeof denialState>>) => Promise<void>,
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
      if (emit) await emit(tx, cur);
      return { id: updated[0].id, version: updated[0].version };
    });
  }

  return {
    async replayAdvice(actor, adviceId) {
      await withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select({ status: RA.parseStatus })
          .from(RA)
          .where(eq(RA.id, adviceId))
          .limit(1);
        if (!rows[0]) throw new NotFoundError("remittance advice not found");
        if (rows[0].status !== "failed") {
          throw new WardenXError("INVALID_STATE", "only a failed advice can be replayed", 409);
        }
        await tx.update(RA).set({ parseStatus: "queued" }).where(eq(RA.id, adviceId));
        await outbox.publish(tx, {
          eventName: "m25.edi.835_received",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_advice",
          aggregateId: adviceId,
          payload: { remittanceAdviceId: adviceId, replay: true },
        });
      });
    },

    ...buildRemittanceCommands({ db, outbox, ...ports }),

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
      return transitionDenial(
        actor,
        id,
        "resolved",
        ifMatch,
        {
          resolvedAt: sql`now()`,
          closureOutcome: "resolved_no_appeal",
        },
        async (tx, cur) => {
          // F-144 (#248) — `m25.denial_resolution_letter.render_requested` is catalogued
          // (events-by-m25.ts) with a real M22 template descriptor and REQUEST_SHAPES adapter, and
          // nothing ever emitted it: a manually-resolved denial produced no resolution letter for any
          // tenant. The chart-target patient is resolved from M23's `claim` row (`patientId`, NOT
          // NULL) — M25's manifest `dependsOn` includes 23, so a direct `repositories.ClaimRepository`
          // read on this SAME tx crosses no boundary `arch:boundaries` polices, the identical legality
          // `outbox-consumers/m23-claim-rejected.ts` already relies on for `providerEntityId`.
          // `denial_case.claim_id` is nullable (277CA-pre-835 / EVV-sourced cases may have no claim
          // yet); a denial resolved with no claim on it gets an honest `patientId: null` render rather
          // than a fabricated one — the F-099 rule.
          const claim = cur.claimId
            ? await new repositories.ClaimRepository(tx).findById(cur.claimId)
            : null;
          await outbox.publish(tx, {
            eventName: "m25.denial_resolution_letter.render_requested",
            organizationId: actor.organizationId,
            aggregateKind: "denial_case",
            aggregateId: id,
            payload: {
              denialCaseId: id,
              payload: {
                patientId: claim?.patientId ?? null,
                claimId: cur.claimId ?? null,
                resolvedAt: new Date().toISOString(),
                closureOutcome: "resolved_no_appeal",
              },
            },
          });
        },
      );
    },

    async closeDenial(actor, id, ifMatch) {
      return transitionDenial(actor, id, "closed", ifMatch, { closedAt: sql`now()` });
    },

    async closeWriteOffDenial(actor, id, input: ReasonInput, ifMatch) {
      return transitionDenial(
        actor,
        id,
        "closed",
        ifMatch,
        {
          closedAt: sql`now()`,
          closureOutcome: "written_off",
          overridePayload: { reason: input.reason, by: actor.membershipId },
        },
        (tx) =>
          outbox.publish(tx, {
            eventName: "m25.patient_responsibility.recorded",
            organizationId: actor.organizationId,
            aggregateKind: "denial_case",
            aggregateId: id,
            payload: { ledgerId: id, patientId: id, prAmount: "0.00" },
          }),
      );
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
          const lr = await tx
            .select({ receivedAt: RL.receivedAt })
            .from(RL)
            .where(eq(RL.id, lineId))
            .limit(1);
          if (lr[0]?.receivedAt) anchor = lr[0].receivedAt;
        }
        const deadline = computeTierDeadline(
          tier,
          anchor instanceof Date ? anchor : new Date(anchor),
        );
        if (!cur.claimId)
          throw new WardenXError("INVALID_STATE", "the denial has no claim to appeal", 409);
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
          await tx
            .update(DC)
            .set({ state: "appealed", version: cur.version + 1 })
            .where(eq(DC.id, denialCaseId));
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
      return transitionAppeal(
        actor,
        id,
        "submitted",
        ifMatch,
        {
          submittedAt: sql`now()`,
          appealNarrative: {
            narrative: input.appealNarrative,
            documents: input.attachedDocumentIds,
          },
        },
        async (tx, cur) => {
          await outbox.publish(tx, {
            eventName: "m25.appeal.submitted",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: {
              appealCaseId: id,
              denialCaseId: cur.denialCaseId,
              tier: cur.tier,
              submittedAt: new Date(0).toISOString(),
            },
          });
          await outbox.publish(tx, {
            eventName: "m25.appeal_packet.render_requested",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: { appealCaseId: id, tier: cur.tier, payload: {} },
          });
        },
      );
    },

    async ackAppeal(actor, id, ifMatch) {
      return transitionAppeal(actor, id, "under_review", ifMatch, {});
    },

    async decideAppeal(actor, id, input: AppealDecideInput, ifMatch) {
      const result = await withOrgContext(db, actor, async (tx) => {
        const cur = await appealRow(tx, id);
        if (!canTransitionAppeal(cur.state, "decided"))
          throw new InvalidTransitionError(cur.state, "decided");
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
        if (input.outcome === "favorable") {
          await outbox.publish(tx, {
            eventName: "m25.denial.resolved_favorable_via_appeal",
            organizationId: actor.organizationId,
            aggregateKind: "appeal_case",
            aggregateId: id,
            payload: {
              denialCaseId: cur.denialCaseId,
              appealCaseId: id,
              claimId: cur.claimId,
              tier: cur.tier,
            },
          });
        }
        return { id: updated[0].id, version: updated[0].version };
      });
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
        const rows = await tx
          .select({ id: TO.id, version: TO.version })
          .from(TO)
          .where(eq(TO.carcCode, carcCode))
          .limit(1);
        if (rows[0]) {
          const updated = await tx
            .update(TO)
            .set({
              rarcCode: input.rarcCode ?? null,
              plainLanguageOverride: input.plainLanguageOverride ?? null,
              suggestedAction: input.suggestedAction,
              ownerRole: input.ownerRole as (typeof TO.ownerRole.enumValues)[number],
              severity: input.severity as (typeof TO.severity.enumValues)[number],
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
            ownerRole: input.ownerRole as (typeof TO.ownerRole.enumValues)[number],
            severity: input.severity as (typeof TO.severity.enumValues)[number],
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

  /**
   * Versioned appeal transition: validate the edge, `UPDATE … WHERE id AND version`, then run the optional
   * `emit` IN THE SAME TX (the §4.5 outbox row commits with the mutation — the D2 posture).
   */
  async function transitionAppeal(
    actor: M25WriteActor,
    id: string,
    to: "submitted" | "under_review" | "withdrawn" | "closed",
    ifMatch: number,
    extra: Record<string, unknown>,
    emit?: (tx: M25Tx, cur: Awaited<ReturnType<typeof appealRow>>) => Promise<void>,
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
      if (emit) await emit(tx, cur);
      return { id: updated[0].id, version: updated[0].version };
    });
  }
}
