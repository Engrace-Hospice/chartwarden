// apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts — the Drizzle-backed WX-PR-012
// implementation of {@link M25IngestService} (see ./service.ts for the full design rationale).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { parseX12EnvelopeHeader } from "@wardenx/x12-835-client";
import type { ParsedClaim835 } from "@wardenx/x12-835-client";
import { and, eq, sql } from "drizzle-orm";
import { autoMatch, classifyPostingOutcome, effectiveCategory, routeAdjustment } from "../domain";
import type { DenialCategory } from "../domain";
import type { WriteOutboxPort } from "../routes/write-service";
import type {
  ClaimMatchCandidateProvider,
  M25IngestActor,
  M25IngestService,
  PostAdviceResult,
  ReceiveAdviceInput,
  ReceiveAdviceResult,
  TerminologyLookupPort,
  X12835WorkerClient,
} from "./service";
import { DENY_TERMINOLOGY, NO_CLAIM_MATCH_CANDIDATES } from "./service";

const NOOP_OUTBOX: WriteOutboxPort = { async publish() {} };
const DENIAL_CATEGORIES: ReadonlySet<string> = new Set([
  "denial",
  "reduction",
  "informational",
  "recoupment",
  "unmapped",
]);

/** The real Drizzle transaction handle (has .select/.update/.insert), inferred from the db client. */
type M25Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface M25IngestDrizzleDeps {
  readonly client: X12835WorkerClient;
  readonly outbox?: WriteOutboxPort;
  readonly terminology?: TerminologyLookupPort;
  readonly claims?: ClaimMatchCandidateProvider;
}

function money(n: number): string {
  return n.toFixed(2);
}

export function buildDrizzleM25IngestService(
  db: DbClient,
  deps: M25IngestDrizzleDeps,
): M25IngestService {
  const RA = schema.remittanceAdvice;
  const RL = schema.remittanceLine;
  const RSL = schema.remittanceServiceLine;
  const ADJ = schema.remittanceAdjustment;
  const REM = schema.remittanceRemark;
  const DC = schema.denialCase;
  const PR = schema.patientResponsibilityLedger;
  const outbox = deps.outbox ?? NOOP_OUTBOX;
  const terminology = deps.terminology ?? DENY_TERMINOLOGY;
  const claimCandidates = deps.claims ?? NO_CLAIM_MATCH_CANDIDATES;
  const client = deps.client;

  /** Mark an advice row failed (a fresh short tx) — always operator-actionable via `remittance.replay`. */
  async function markFailed(
    actor: M25IngestActor,
    adviceId: string,
    reason: string,
  ): Promise<void> {
    await withOrgContext(db, { organizationId: actor.organizationId, userId: "" }, async (tx) => {
      await tx
        .update(RA)
        .set({ parseStatus: "failed", parseSummary: { reason } })
        .where(and(eq(RA.id, adviceId), sql`${RA.parseStatus} IN ('queued','failed')`));
    });
  }

  async function resolveCategory(carcCode: string): Promise<DenialCategory | null> {
    const looked = await terminology.lookup(carcCode, null);
    if (looked && DENIAL_CATEGORIES.has(looked.category)) {
      return looked.category as DenialCategory;
    }
    return null;
  }

  /** Post one CLP claim's line + service lines + adjustments + remarks. Returns the match/posting facts. */
  async function postClaim(
    tx: M25Tx,
    actor: M25IngestActor,
    advice: { id: string; providerEntityId: string; receivedAt: Date },
    claim: ParsedClaim835,
  ): Promise<{ matched: boolean }> {
    const candidates = await claimCandidates.candidatesForLine({
      organizationId: actor.organizationId,
      providerEntityId: advice.providerEntityId,
      payerIcn: claim.payerIcn,
      patientControlNumber: claim.patientControlNumber,
      patientMemberId: claim.patientMemberId,
    });
    const match = autoMatch(
      {
        clp01PatientControlNumber: claim.patientControlNumber,
        clp07PayerIcn: claim.payerIcn,
        patientMemberId: claim.patientMemberId,
        serviceFrom: claim.serviceFrom,
        serviceTo: claim.serviceTo,
        totalCharge: claim.totalCharge,
      },
      candidates,
    );
    // D3: only a confidence-100 exact strategy auto-binds. A heuristic proposal (requiresManual=true even
    // though matched=true) stays unmatched here — it surfaces on the manual-match worklist, never silently
    // auto-bound on a guess.
    const bound = match.matched && !match.requiresManual;
    const outcome = classifyPostingOutcome(claim.statusCode, claim.totalCharge, claim.totalPayment);
    const matchState = !bound ? "unmatched" : outcome === "recouped" ? "reversed" : "posted";

    const [line] = await tx
      .insert(RL)
      .values({
        organizationId: actor.organizationId,
        remittanceAdviceId: advice.id,
        claimId: bound ? (match.claimId ?? null) : null,
        clp01PatientControlNumber: claim.patientControlNumber ?? null,
        clp07PayerIcn: claim.payerIcn ?? null,
        clp02StatusCode: claim.statusCode,
        clp03TotalChargeAmount: money(claim.totalCharge),
        clp04TotalPaymentAmount: money(claim.totalPayment),
        clp05PatientResponsibilityAmount: money(claim.patientResponsibility),
        matchState,
        matchStrategy: bound ? (match.strategy ?? null) : null,
        matchConfidence: bound ? (match.confidence ?? null) : null,
        matchedAt: bound ? sql`now()` : null,
        receivedAt: advice.receivedAt,
      })
      .returning({ id: RL.id });
    if (!line) throw new Error("m25-ingest: remittance_line insert returned no row");

    for (const svc of claim.serviceLines) {
      const [svcRow] = await tx
        .insert(RSL)
        .values({
          organizationId: actor.organizationId,
          remittanceLineId: line.id,
          svc01ProcedureCode: svc.procedureCode ?? null,
          svc01RevenueCode: svc.revenueCode ?? null,
          svc02ChargeAmount: money(svc.chargeAmount),
          svc03PaidAmount: money(svc.paidAmount),
          svc05PaidUnits: svc.paidUnits ?? null,
          svc07SubmittedUnits: svc.submittedUnits ?? null,
          receivedAt: advice.receivedAt,
        })
        .returning({ id: RSL.id });
      if (!svcRow) throw new Error("m25-ingest: remittance_service_line insert returned no row");
      await postAdjustments(tx, actor, advice, {
        claimId: bound ? (match.claimId ?? null) : null,
        remittanceLineId: line.id,
        remittanceServiceLineId: svcRow.id,
        adjustments: svc.adjustments,
      });
      await postRemarks(tx, actor, advice, {
        remittanceLineId: null,
        remittanceServiceLineId: svcRow.id,
        remarks: svc.remarks,
      });
    }

    await postAdjustments(tx, actor, advice, {
      claimId: bound ? (match.claimId ?? null) : null,
      remittanceLineId: line.id,
      remittanceServiceLineId: null,
      adjustments: claim.adjustments,
    });
    await postRemarks(tx, actor, advice, {
      remittanceLineId: line.id,
      remittanceServiceLineId: null,
      remarks: claim.remarks,
    });

    if (bound) {
      const eventBase = {
        claimId: match.claimId as string,
        remittanceLineId: line.id,
        postedAt: new Date(0).toISOString(),
      };
      if (outcome === "paid") {
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_paid",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: { ...eventBase, paidAmount: money(claim.totalPayment) },
        });
      } else if (outcome === "partial_paid") {
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_partial_paid",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: {
            ...eventBase,
            paidAmount: money(claim.totalPayment),
            adjustedAmount: money(claim.totalCharge - claim.totalPayment),
          },
        });
      } else if (outcome === "denied") {
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_denied",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: {
            ...eventBase,
            carcCodes: claim.adjustments.map((a) => a.reasonCode),
          },
        });
      } else {
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_recouped",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: { ...eventBase, recoupedAmount: money(claim.totalPayment) },
        });
      }
    }

    return { matched: bound };
  }

  /** Route + insert every CAS adjustment at one CLP/SVC granularity; seeds denial_case / PR-ledger rows. */
  async function postAdjustments(
    tx: M25Tx,
    actor: M25IngestActor,
    advice: { id: string; providerEntityId: string; receivedAt: Date },
    args: {
      claimId: string | null;
      remittanceLineId: string;
      remittanceServiceLineId: string | null;
      adjustments: ParsedClaim835["adjustments"];
    },
  ): Promise<void> {
    for (const adj of args.adjustments) {
      const catalogCategory = await resolveCategory(adj.reasonCode);
      const { category, taxonomyStatus } = effectiveCategory(catalogCategory);
      const routing = routeAdjustment(adj.groupCode, category, taxonomyStatus);
      // The PR ledger requires a real patient id (NOT NULL) — resolvable only for a matched claim, and
      // only once the M23 cross-module seam is bound (same posture as the auto-match candidate lookup).
      // Absent that, the adjustment honestly degrades to `flagged_review` rather than claiming a ledger
      // entry was recorded when it was not.
      let postAction = routing.postAction;
      let prLedgerPatientId: string | null = null;
      if (routing.seedPrLedger) {
        prLedgerPatientId = args.claimId
          ? await claimCandidates.patientIdForClaim(actor.organizationId, args.claimId)
          : null;
        if (!prLedgerPatientId) postAction = "flagged_review";
      }

      const [adjRow] = await tx
        .insert(ADJ)
        .values({
          organizationId: actor.organizationId,
          remittanceLineId: args.remittanceServiceLineId ? null : args.remittanceLineId,
          remittanceServiceLineId: args.remittanceServiceLineId,
          casGroupCode: adj.groupCode,
          casReasonCode: adj.reasonCode,
          adjustmentAmount: money(adj.amount),
          adjustmentQuantity: adj.quantity ?? null,
          postAction,
          taxonomyStatus,
          receivedAt: advice.receivedAt,
        })
        .returning({ id: ADJ.id });
      if (!adjRow) throw new Error("m25-ingest: remittance_adjustment insert returned no row");

      if (routing.seedDenial) {
        const [denial] = await tx
          .insert(DC)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: advice.providerEntityId,
            claimId: args.claimId,
            remittanceLineId: args.remittanceLineId,
            remittanceServiceLineId: args.remittanceServiceLineId,
            remittanceAdjustmentId: adjRow.id,
            carcCode: adj.reasonCode,
            source: "remittance_adjustment",
            category,
            taxonomyStatus,
            dollarValue: money(adj.amount),
          })
          .returning({ id: DC.id });
        if (!denial) throw new Error("m25-ingest: denial_case insert returned no row");
        await tx.update(ADJ).set({ denialCaseId: denial.id }).where(eq(ADJ.id, adjRow.id));
        await outbox.publish(tx, {
          eventName: "m25.denial.opened",
          organizationId: actor.organizationId,
          aggregateKind: "denial_case",
          aggregateId: denial.id,
          payload: {
            denialCaseId: denial.id,
            providerEntityId: advice.providerEntityId,
            claimId: args.claimId,
            carcCode: adj.reasonCode,
            category,
            source: "remittance_adjustment",
            dollarValue: money(adj.amount),
          },
        });
        if (taxonomyStatus === "unmapped") {
          await outbox.publish(tx, {
            eventName: "m25.taxonomy.unmapped_code_observed",
            organizationId: actor.organizationId,
            aggregateKind: "denial_case",
            aggregateId: denial.id,
            payload: {
              carcCode: adj.reasonCode,
              rarcCode: null,
              providerEntityId: advice.providerEntityId,
              denialCaseId: denial.id,
            },
          });
        }
      } else if (routing.seedPrLedger && prLedgerPatientId) {
        const [pr] = await tx
          .insert(PR)
          .values({
            organizationId: actor.organizationId,
            patientId: prLedgerPatientId,
            remittanceLineId: args.remittanceLineId,
            remittanceAdjustmentId: adjRow.id,
            prAmount: money(adj.amount),
          })
          .returning({ id: PR.id });
        if (!pr)
          throw new Error("m25-ingest: patient_responsibility_ledger insert returned no row");
        await outbox.publish(tx, {
          eventName: "m25.patient_responsibility.recorded",
          organizationId: actor.organizationId,
          aggregateKind: "patient_responsibility_ledger",
          aggregateId: pr.id,
          payload: { ledgerId: pr.id, patientId: prLedgerPatientId, prAmount: money(adj.amount) },
        });
      }
    }
  }

  async function postRemarks(
    tx: M25Tx,
    actor: M25IngestActor,
    _advice: { id: string; providerEntityId: string; receivedAt: Date },
    args: {
      remittanceLineId: string | null;
      remittanceServiceLineId: string | null;
      remarks: ParsedClaim835["remarks"];
    },
  ): Promise<void> {
    for (const remark of args.remarks) {
      await tx.insert(REM).values({
        organizationId: actor.organizationId,
        remittanceLineId: args.remittanceLineId,
        remittanceServiceLineId: args.remittanceServiceLineId,
        remarkKind: remark.kind,
        remarkCode: remark.code,
        freeText: remark.text ?? null,
        receivedAt: _advice.receivedAt,
      });
    }
  }

  return {
    async receiveAdvice(
      actor: M25IngestActor,
      input: ReceiveAdviceInput,
    ): Promise<ReceiveAdviceResult> {
      // Cheap, real, local pre-flight (no sidecar round-trip) — a genuinely malformed file (not X12, no
      // ISA/ST segment) is rejected with NOTHING persisted before we ever call the parser.
      const header = parseX12EnvelopeHeader(input.rawEdi);
      if (!header) {
        return {
          outcome: "malformed",
          reason: "not a valid X12 envelope (missing ISA/ST segment)",
        };
      }
      const parsed = await client.parse835({
        minioObjectKey: input.minioObjectKey,
        payerProgram: input.payerKind,
      });
      if (!parsed.ok) {
        return { outcome: "malformed", reason: parsed.degraded.reason };
      }
      if (
        parsed.value.interchangeControlNumber !== header.interchangeControlNumber ||
        parsed.value.transactionSetControlNumber !== header.transactionSetControlNumber
      ) {
        return {
          outcome: "malformed",
          reason: "sidecar envelope control numbers disagree with the local ISA/ST header",
        };
      }

      return withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: "" },
        async (tx) => {
          // The DB's `ux_remittance_envelope_dedupe` unique index is the real dedup enforcement (§2.6) — a
          // conflicting insert is caught here (never thrown, so the tx never poisons) and resolved by
          // looking up the winner, whether that was an earlier call or a concurrent one racing this one.
          const [row] = await tx
            .insert(RA)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              payerId: input.payerId,
              payerKind: input.payerKind,
              interchangeControlNumber: header.interchangeControlNumber,
              transactionSetControlNumber: header.transactionSetControlNumber,
              checkOrEftTraceNumber: parsed.value.checkOrEftTraceNumber ?? null,
              paymentMethod: parsed.value.paymentMethod,
              totalPaymentAmount: money(parsed.value.totalPaymentAmount),
              productionDate: new Date(parsed.value.productionDate),
              minioObjectKey: input.minioObjectKey,
              fileSha256: input.fileSha256,
              parseStatus: "queued",
            })
            .onConflictDoNothing({
              target: [
                RA.interchangeControlNumber,
                RA.transactionSetControlNumber,
                RA.providerEntityId,
              ],
            })
            .returning({ id: RA.id });
          if (!row) {
            const [dup] = await tx
              .select({ id: RA.id })
              .from(RA)
              .where(
                and(
                  eq(RA.interchangeControlNumber, header.interchangeControlNumber),
                  eq(RA.transactionSetControlNumber, header.transactionSetControlNumber),
                  eq(RA.providerEntityId, input.providerEntityId),
                ),
              )
              .limit(1);
            if (!dup) throw new Error("m25-ingest: envelope insert conflicted but no row found");
            return { outcome: "duplicate", existingAdviceId: dup.id };
          }
          await outbox.publish(tx, {
            eventName: "m25.edi.835_received",
            organizationId: actor.organizationId,
            aggregateKind: "remittance_advice",
            aggregateId: row.id,
            payload: {
              remittanceAdviceId: row.id,
              providerEntityId: input.providerEntityId,
              payerId: input.payerId,
              payerProgram: input.payerKind,
              minioObjectKey: input.minioObjectKey,
              fileSha256: input.fileSha256,
            },
          });
          return { outcome: "queued", adviceId: row.id };
        },
      );
    },

    async postAdvice(actor: M25IngestActor, adviceId: string): Promise<PostAdviceResult> {
      const current = await withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: "" },
        (tx) =>
          tx
            .select({
              id: RA.id,
              providerEntityId: RA.providerEntityId,
              payerKind: RA.payerKind,
              minioObjectKey: RA.minioObjectKey,
              parseStatus: RA.parseStatus,
              receivedAt: RA.receivedAt,
              totalPaymentAmount: RA.totalPaymentAmount,
            })
            .from(RA)
            .where(eq(RA.id, adviceId))
            .limit(1),
      );
      const advice = current[0];
      if (!advice) return { outcome: "not_found", adviceId };
      if (advice.parseStatus !== "queued" && advice.parseStatus !== "failed") {
        return { outcome: "already_posted", adviceId };
      }

      const parsed = await client.parse835({
        minioObjectKey: advice.minioObjectKey,
        payerProgram: advice.payerKind,
      });
      if (!parsed.ok) {
        await markFailed(actor, adviceId, parsed.degraded.reason);
        return { outcome: "failed", adviceId, reason: parsed.degraded.reason };
      }

      try {
        const result = await withOrgContext(
          db,
          { organizationId: actor.organizationId, userId: "" },
          async (tx) => {
            const guard = await tx
              .select({ parseStatus: RA.parseStatus })
              .from(RA)
              .where(eq(RA.id, adviceId))
              .for("update")
              .limit(1);
            if (guard[0]?.parseStatus !== "queued" && guard[0]?.parseStatus !== "failed") {
              return { outcome: "already_posted" as const };
            }
            let postedLineCount = 0;
            let unmatchedLineCount = 0;
            for (const claim of parsed.value.claims) {
              const { matched } = await postClaim(
                tx,
                actor,
                {
                  id: adviceId,
                  providerEntityId: advice.providerEntityId,
                  receivedAt: advice.receivedAt,
                },
                claim,
              );
              if (matched) postedLineCount += 1;
              else unmatchedLineCount += 1;
            }
            const finalStatus: "posted" | "partial_posted" =
              unmatchedLineCount === 0 ? "posted" : "partial_posted";
            await tx
              .update(RA)
              .set({
                parseStatus: finalStatus,
                parseSummary: {
                  lineCount: parsed.value.claims.length,
                  postedLineCount,
                  unmatchedLineCount,
                },
              })
              .where(eq(RA.id, adviceId));
            await outbox.publish(tx, {
              eventName: "m25.remittance.advice_posted",
              organizationId: actor.organizationId,
              aggregateKind: "remittance_advice",
              aggregateId: adviceId,
              payload: {
                remittanceAdviceId: adviceId,
                providerEntityId: advice.providerEntityId,
                totalPaymentAmount: advice.totalPaymentAmount,
                postedLineCount,
                unmatchedLineCount,
                postedAt: new Date(0).toISOString(),
              },
            });
            return { outcome: finalStatus, postedLineCount, unmatchedLineCount };
          },
        );
        if (result.outcome === "already_posted") return { outcome: "already_posted", adviceId };
        return {
          outcome: result.outcome,
          adviceId,
          postedLineCount: result.postedLineCount,
          unmatchedLineCount: result.unmatchedLineCount,
        };
      } catch (err) {
        // The whole batch rolled back — no half-posted lines survive. A fresh short tx marks the advice
        // `failed` so it stays visible + replayable rather than stuck silently at `queued`/`failed`-forever.
        const reason = err instanceof Error ? err.message : "posting failed";
        await markFailed(actor, adviceId, reason);
        return { outcome: "failed", adviceId, reason };
      }
    },
  };
}
