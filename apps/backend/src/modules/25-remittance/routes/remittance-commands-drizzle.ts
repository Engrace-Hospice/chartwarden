// apps/backend/src/modules/25-remittance/routes/remittance-commands-drizzle.ts — GAP-073: the Drizzle
// manual-match and adjustment-override commands (§4.1 #6/#7, §7.2).
//
// Manual match: the proposed claim is looked up server-side ({@link ClaimFactsPort}); a missing claim and a
// claim on another provider entity are the SAME 404 (no existence oracle). The line is then bound AND posted
// in one tx — `manual`/100, state `posted` (`reversed` for a CLP02=22) — and the posting outcome event
// (`claim_paid` / `claim_partial_paid` / `claim_denied` / `claim_recouped`) that M23's claim state machine
// consumes is emitted beside `manual_match_recorded`. The operator's rationale goes to the audit trail only.
// `UPDATE … WHERE match_state IN (…)` is the race guard; a replay of a completed match to the same claim is a
// no-op that emits nothing. `advice_posted` is NOT re-emitted (ingest already announced the advice with its
// unmatched count and M26's cap accrual consumes it); the advice only flips `partial_posted → posted`.
//
// Adjustment override: only a `flagged_review` adjustment can be reclassified; the effect follows the new
// action — `auto_posted` (write-off) records the decision, `ledger_recorded` seeds the PR ledger for the
// claim's patient (fail closed with no resolvable patient), `denial_seeded` opens a denial case — all under
// an `UPDATE … WHERE post_action = 'flagged_review'` guard so a concurrent override cannot double-apply.
// Both commands are org-scoped by RLS and provider-entity-scoped through `actor.providerEntityScope`
// (out-of-scope = 404).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type PostingOutcome,
  classifyPostingOutcome,
  decideAdjustmentOverride,
  decideManualMatch,
} from "../domain";
import type { M25WriteActor } from "./actor";
import {
  type ClaimFacts,
  type ClaimFactsPort,
  type RemittanceAuditPort,
  m4RemittanceAuditPort,
  m23ClaimFactsPort,
} from "./remittance-ports";
import type {
  AdjustmentOverrideInput,
  AdjustmentOverrideResult,
  ManualMatchInput,
  ManualMatchResult,
  OutboxEmission,
  WriteOutboxPort,
} from "./write-service";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface RemittanceCommandDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly claims?: ClaimFactsPort;
  readonly audit?: RemittanceAuditPort;
}

const money = (n: number): string => n.toFixed(2);
const inScope = (actor: M25WriteActor, providerEntityId: string): boolean =>
  actor.providerEntityScope === undefined || actor.providerEntityScope.includes(providerEntityId);

const MATCHABLE_STATES = ["unmatched", "manual_matched"] as const;

export function buildRemittanceCommands(deps: RemittanceCommandDeps): {
  manualMatch(
    actor: M25WriteActor,
    lineId: string,
    input: ManualMatchInput,
  ): Promise<ManualMatchResult>;
  overrideAdjustment(
    actor: M25WriteActor,
    adjustmentId: string,
    input: AdjustmentOverrideInput,
  ): Promise<AdjustmentOverrideResult>;
} {
  const { db, outbox } = deps;
  const claims = deps.claims ?? m23ClaimFactsPort;
  const auditPort = deps.audit ?? m4RemittanceAuditPort;
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const RSL = schema.remittanceServiceLine;
  const ADJ = schema.remittanceAdjustment;
  const DC = schema.denialCase;
  const PR = schema.patientResponsibilityLedger;

  const emit = (tx: Tx, actor: M25WriteActor, e: Omit<OutboxEmission, "organizationId">) =>
    outbox.publish(tx, { ...e, organizationId: actor.organizationId });

  /** The line's distinct CARC codes (claim-level + service-level CAS), for a `claim_denied` payload. */
  async function carcCodesOf(tx: Tx, lineId: string): Promise<string[]> {
    const rows = await tx
      .select({ code: ADJ.casReasonCode })
      .from(ADJ)
      .where(
        sql`${ADJ.remittanceLineId} = ${lineId} OR ${ADJ.remittanceServiceLineId} IN (SELECT ${RSL.id} FROM ${RSL} WHERE ${RSL.remittanceLineId} = ${lineId})`,
      );
    return [...new Set(rows.map((r) => r.code))];
  }

  /** The §2.4 M23-consumer event for a posting outcome. */
  async function emitOutcome(
    tx: Tx,
    actor: M25WriteActor,
    line: { id: string; adviceId: string; charge: number; paid: number },
    claim: ClaimFacts,
    outcome: PostingOutcome,
  ): Promise<void> {
    const base = {
      claimId: claim.id,
      remittanceLineId: line.id,
      remittanceAdviceId: line.adviceId,
      postedAt: new Date().toISOString(),
    };
    const shape = { aggregateKind: "remittance_line", aggregateId: line.id };
    // GAP-075 — the per-claim cap facts the catalog now REQUIRES on both paid outcomes. A manual match has no
    // 835 service dates in hand, so they are honestly null (M26 skips a dateless line rather than invent one).
    const capFacts = {
      patientId: claim.patientId ?? null,
      paidAmountCents: Math.round(line.paid * 100),
      serviceFrom: null,
      serviceTo: null,
    };
    if (outcome === "paid") {
      await emit(tx, actor, {
        ...shape,
        eventName: "m25.remittance.claim_paid",
        payload: { ...base, ...capFacts, paidAmount: money(line.paid) },
      });
    } else if (outcome === "partial_paid") {
      await emit(tx, actor, {
        ...shape,
        eventName: "m25.remittance.claim_partial_paid",
        payload: {
          ...base,
          ...capFacts,
          paidAmount: money(line.paid),
          adjustedAmount: money(line.charge - line.paid),
        },
      });
    } else if (outcome === "denied") {
      await emit(tx, actor, {
        ...shape,
        eventName: "m25.remittance.claim_denied",
        payload: { ...base, carcCodes: await carcCodesOf(tx, line.id) },
      });
    } else {
      await emit(tx, actor, {
        ...shape,
        eventName: "m25.remittance.claim_recouped",
        payload: {
          ...base,
          patientId: claim.patientId,
          recoupedAmount: money(line.paid),
          recoupedAmountCents: Math.round(line.paid * 100),
          serviceFrom: null,
          serviceTo: null,
        },
      });
    }
  }

  /** `partial_posted → posted` once the last unmatched line of the advice is resolved. */
  async function settleAdvice(tx: Tx, adviceId: string, status: string): Promise<void> {
    if (status !== "partial_posted") return;
    const left = await tx
      .select({ id: RL.id })
      .from(RL)
      .where(and(eq(RL.remittanceAdviceId, adviceId), eq(RL.matchState, "unmatched")))
      .limit(1);
    if (left.length === 0) {
      await tx.update(RA).set({ parseStatus: "posted" }).where(eq(RA.id, adviceId));
    }
  }

  return {
    async manualMatch(actor, lineId, input) {
      return withOrgContext(db, actor, async (tx) => {
        const [line] = await tx
          .select({
            id: RL.id,
            matchState: RL.matchState,
            matchStrategy: RL.matchStrategy,
            claimId: RL.claimId,
            remittanceAdviceId: RL.remittanceAdviceId,
            clp02StatusCode: RL.clp02StatusCode,
            clp03TotalChargeAmount: RL.clp03TotalChargeAmount,
            clp04TotalPaymentAmount: RL.clp04TotalPaymentAmount,
            receivedAt: RL.receivedAt,
          })
          .from(RL)
          .where(eq(RL.id, lineId))
          .for("update")
          .limit(1);
        if (!line) throw new NotFoundError("remittance line not found");
        const [advice] = await tx
          .select({ providerEntityId: RA.providerEntityId, parseStatus: RA.parseStatus })
          .from(RA)
          .where(eq(RA.id, line.remittanceAdviceId))
          .limit(1);
        if (!advice || !inScope(actor, advice.providerEntityId)) {
          throw new NotFoundError("remittance line not found");
        }
        const claim = await claims.byId(tx, input.proposedClaimId);
        if (!claim || claim.providerEntityId !== advice.providerEntityId) {
          throw new NotFoundError("claim not found");
        }
        const charge = Number(line.clp03TotalChargeAmount);
        const paid = Number(line.clp04TotalPaymentAmount);
        const outcome = classifyPostingOutcome(line.clp02StatusCode, charge, paid);
        const decision = decideManualMatch(line, claim.id, outcome);
        if (decision.kind === "noop") return { matchState: decision.matchState };
        if (decision.kind === "conflict") {
          throw new ChartWardenError("INVALID_STATE", decision.reason, 409);
        }
        const updated = await tx
          .update(RL)
          .set({
            claimId: claim.id,
            matchState: decision.nextState,
            matchStrategy: "manual",
            matchConfidence: 100,
            matchedAt: sql`now()`,
            matchedByMembershipId: actor.membershipId,
          })
          .where(
            and(
              eq(RL.id, lineId),
              eq(RL.receivedAt, line.receivedAt),
              inArray(RL.matchState, [...MATCHABLE_STATES]),
            ),
          )
          .returning({ id: RL.id });
        if (!updated[0]) {
          throw new ChartWardenError("INVALID_STATE", "the line was matched concurrently", 409);
        }
        await auditPort.record(tx, actor, {
          eventType: "m25.remittance.manual_match",
          resourceKind: "remittance_line",
          resourceId: lineId,
          context: {
            claimId: claim.id,
            matchState: decision.nextState,
            outcome,
            reason: input.reason,
          },
        });
        await emitOutcome(
          tx,
          actor,
          { id: lineId, adviceId: line.remittanceAdviceId, charge, paid },
          claim,
          outcome,
        );
        await emit(tx, actor, {
          eventName: "m25.remittance.manual_match_recorded",
          aggregateKind: "remittance_line",
          aggregateId: lineId,
          payload: {
            remittanceLineId: lineId,
            claimId: claim.id,
            matchedByMembershipId: actor.membershipId,
          },
        });
        await settleAdvice(tx, line.remittanceAdviceId, advice.parseStatus);
        return { matchState: decision.nextState };
      });
    },

    async overrideAdjustment(actor, adjustmentId, input) {
      return withOrgContext(db, actor, async (tx) => {
        const [adj] = await tx
          .select({
            id: ADJ.id,
            remittanceLineId: ADJ.remittanceLineId,
            remittanceServiceLineId: ADJ.remittanceServiceLineId,
            postAction: ADJ.postAction,
            taxonomyStatus: ADJ.taxonomyStatus,
            casReasonCode: ADJ.casReasonCode,
            adjustmentAmount: ADJ.adjustmentAmount,
            denialCaseId: ADJ.denialCaseId,
            receivedAt: ADJ.receivedAt,
          })
          .from(ADJ)
          .where(eq(ADJ.id, adjustmentId))
          .limit(1);
        if (!adj) throw new NotFoundError("remittance adjustment not found");
        const lineId = await lineIdOf(tx, adj);
        const [line] = lineId
          ? await tx
              .select({ id: RL.id, claimId: RL.claimId, remittanceAdviceId: RL.remittanceAdviceId })
              .from(RL)
              .where(eq(RL.id, lineId))
              .limit(1)
          : [];
        const [advice] = line
          ? await tx
              .select({ providerEntityId: RA.providerEntityId })
              .from(RA)
              .where(eq(RA.id, line.remittanceAdviceId))
              .limit(1)
          : [];
        if (!line || !advice || !inScope(actor, advice.providerEntityId)) {
          throw new NotFoundError("remittance adjustment not found");
        }
        const claim = line.claimId ? await claims.byId(tx, line.claimId) : null;
        const patientId =
          claim && claim.providerEntityId === advice.providerEntityId ? claim.patientId : null;
        const amount = Number(adj.adjustmentAmount);
        const decision = decideAdjustmentOverride(
          { postAction: adj.postAction, amount, denialCaseId: adj.denialCaseId },
          input.newPostAction,
          patientId,
        );
        if (decision.kind === "noop") return { postAction: input.newPostAction }; // noop ⇒ already that action
        if (decision.kind === "conflict") {
          throw new ChartWardenError("INVALID_STATE", decision.reason, 409);
        }
        const updated = await tx
          .update(ADJ)
          .set({ postAction: input.newPostAction })
          .where(
            and(
              eq(ADJ.id, adjustmentId),
              eq(ADJ.receivedAt, adj.receivedAt),
              eq(ADJ.postAction, "flagged_review"),
            ),
          )
          .returning({ id: ADJ.id });
        if (!updated[0]) {
          throw new ChartWardenError(
            "INVALID_STATE",
            "the adjustment was overridden concurrently",
            409,
          );
        }
        await auditPort.record(tx, actor, {
          eventType: "m25.remittance.adjustment_override",
          resourceKind: "remittance_adjustment",
          resourceId: adjustmentId,
          context: { from: adj.postAction, to: input.newPostAction, reason: input.reason },
        });
        if (decision.effect === "ledger" && patientId) {
          const [pr] = await tx
            .insert(PR)
            .values({
              organizationId: actor.organizationId,
              patientId,
              remittanceLineId: line.id,
              remittanceAdjustmentId: adjustmentId,
              prAmount: money(amount),
            })
            .returning({ id: PR.id });
          if (!pr)
            throw new Error("m25-override: patient_responsibility_ledger insert returned no row");
          await emit(tx, actor, {
            eventName: "m25.patient_responsibility.recorded",
            aggregateKind: "patient_responsibility_ledger",
            aggregateId: pr.id,
            payload: { ledgerId: pr.id, patientId, prAmount: money(amount) },
          });
        } else if (decision.effect === "denial") {
          await seedDenial(tx, actor, {
            adj,
            amount,
            lineId: line.id,
            claimId: line.claimId,
            providerEntityId: advice.providerEntityId,
            reason: input.reason,
          });
        }
        return { postAction: input.newPostAction };
      });
    },
  };

  /** The line an adjustment hangs off (claim-level direct, or via its service line). */
  async function lineIdOf(
    tx: Tx,
    adj: { remittanceLineId: string | null; remittanceServiceLineId: string | null },
  ): Promise<string | null> {
    if (adj.remittanceLineId) return adj.remittanceLineId;
    if (!adj.remittanceServiceLineId) return null;
    const [svc] = await tx
      .select({ remittanceLineId: RSL.remittanceLineId })
      .from(RSL)
      .where(eq(RSL.id, adj.remittanceServiceLineId))
      .limit(1);
    return svc?.remittanceLineId ?? null;
  }

  /** Open the denial case an operator override asked for, link it, and announce it. */
  async function seedDenial(
    tx: Tx,
    actor: M25WriteActor,
    a: {
      adj: {
        id: string;
        casReasonCode: string;
        taxonomyStatus: "mapped" | "unmapped";
        remittanceServiceLineId: string | null;
      };
      amount: number;
      lineId: string;
      claimId: string | null;
      providerEntityId: string;
      reason: string;
    },
  ): Promise<void> {
    const unmapped = a.adj.taxonomyStatus === "unmapped";
    const category = unmapped ? "unmapped" : "denial";
    const [denial] = await tx
      .insert(DC)
      .values({
        organizationId: actor.organizationId,
        providerEntityId: a.providerEntityId,
        claimId: a.claimId,
        remittanceLineId: a.lineId,
        remittanceServiceLineId: a.adj.remittanceServiceLineId,
        remittanceAdjustmentId: a.adj.id,
        carcCode: a.adj.casReasonCode,
        category,
        source: "remittance_adjustment",
        dollarValue: money(a.amount),
        taxonomyStatus: a.adj.taxonomyStatus,
        overridePayload: { overriddenByMembershipId: actor.membershipId, reason: a.reason },
      })
      .returning({ id: DC.id });
    if (!denial) throw new Error("m25-override: denial_case insert returned no row");
    await tx.update(ADJ).set({ denialCaseId: denial.id }).where(eq(ADJ.id, a.adj.id));
    await emit(tx, actor, {
      eventName: "m25.denial.opened",
      aggregateKind: "denial_case",
      aggregateId: denial.id,
      payload: {
        denialCaseId: denial.id,
        providerEntityId: a.providerEntityId,
        claimId: a.claimId,
        carcCode: a.adj.casReasonCode,
        category,
        source: "remittance_adjustment",
        dollarValue: money(a.amount),
      },
    });
    if (unmapped) {
      await emit(tx, actor, {
        eventName: "m25.taxonomy.unmapped_code_observed",
        aggregateKind: "denial_case",
        aggregateId: denial.id,
        payload: {
          carcCode: a.adj.casReasonCode,
          rarcCode: null,
          providerEntityId: a.providerEntityId,
          denialCaseId: denial.id,
        },
      });
    }
  }
}
