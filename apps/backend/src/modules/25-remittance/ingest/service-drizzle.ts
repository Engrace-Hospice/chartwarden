// apps/backend/src/modules/25-remittance/ingest/service-drizzle.ts — the Drizzle-backed WX-PR-012
// implementation of {@link M25IngestService} (see ./service.ts for the full design rationale).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  parseX12EnvelopeHeader,
  parseX12TransactionSetControlNumbers,
} from "@chartwarden/x12-835-client";
import type { ParsedClaim835, ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { autoMatch, classifyPostingOutcome, effectiveCategory, routeAdjustment } from "../domain";
import type { DenialCategory } from "../domain";
import type { WriteOutboxPort } from "../routes/write-service";
import type {
  ClaimMatchCandidateProvider,
  ClaimMatchCandidateProviderByPayer,
  M25IngestActor,
  RawAdviceStore,
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

/** F-172 — widened to carry `payerKind` so `postClaim`/`postAdjustments` can route the candidate lookup. */
type AdviceContext = {
  id: string;
  providerEntityId: string;
  receivedAt: Date;
  payerKind: ReceiveAdviceInput["payerKind"];
};

export type PayeeNpiLookup = (
  organizationId: string,
  providerEntityId: string,
) => Promise<string | null>;
/** Explicit opt-out of the payee check, for tests that are not about it. */
export const PAYEE_UNCHECKED = "unchecked" as const;

export interface M25IngestDrizzleDeps {
  readonly client: X12835WorkerClient;
  readonly outbox?: WriteOutboxPort;
  readonly terminology?: TerminologyLookupPort;
  /**
   * #658 — stages the raw 835 at receive and reads it back at post. Absent = nothing is staged and `postAdvice`
   * falls back to the client's own `readRaw` (fail closed, retryable, when that is not wired either).
   */
  readonly rawStore?: RawAdviceStore;
  /**
   * F-172 (#248, m24 group) — keyed by the advice's OWN `payerKind` (already on `RA.payer_kind`, read at
   * `postAdvice` time below). A payer with no entry degrades to {@link NO_CLAIM_MATCH_CANDIDATES} — never
   * routes a Medicaid 835 against M23's claim table, or vice versa.
   */
  readonly claims?: ClaimMatchCandidateProviderByPayer;
  /**
   * #659 — the tenant's own NPI for a provider entity (null when unknown). When bound, an 835 whose payee
   * (N1*PE, N103=XX) is not that NPI is refused before anything is stored or posted, so a file addressed to
   * another provider can never post into this tenant. Required so a composition root cannot drop the guard
   * silently; tests that do not exercise it pass {@link PAYEE_UNCHECKED}. The TIN is sealed per tenant (M2) and the
   * PTAN has no tenant column, so neither is compared. A payee identified only by tax id (FI) is refused.
   */
  readonly payeeNpi: PayeeNpiLookup | typeof PAYEE_UNCHECKED;
  /**
   * Ops-visibility hook: called when `postAdvice` fails on a RETRYABLE degraded parse (e.g. no staged-object
   * reader wired, X12_835_RAW_UNAVAILABLE) so a dead pipeline is not silent. PHI-free by contract: ids and
   * the degraded code only. The composition root points this at a warn log.
   */
  readonly onStagedReadFailed?: (event: {
    readonly organizationId: string;
    readonly adviceId: string;
    readonly errorName: string;
  }) => void;
  readonly onStagedDeleteFailed?: (event: {
    readonly organizationId: string;
    readonly adviceId: string;
    readonly errorName: string;
  }) => void;
  readonly onRetryableParseDegraded?: (event: {
    readonly organizationId: string;
    readonly adviceId: string;
    readonly code: string;
  }) => void;
}

function money(n: number): string {
  return n.toFixed(2);
}

/**
 * The 835 production date is a calendar day printed on the remittance. Store it as that day at UTC midnight
 * (the appeal clock reads the UTC date back), ignoring any time or offset the clearinghouse appended; a
 * value that is not date-led is parsed as an instant.
 */
export function productionDay(raw: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? new Date(`${m[1]}T00:00:00Z`) : new Date(raw);
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
  const claimsByPayer = deps.claims ?? {};
  const client = deps.client;

  /** F-172 — the per-payer candidate provider, defaulting to the honest "no candidates" degrade. */
  function claimCandidatesFor(
    payerKind: ReceiveAdviceInput["payerKind"],
  ): ClaimMatchCandidateProvider {
    return claimsByPayer[payerKind] ?? NO_CLAIM_MATCH_CANDIDATES;
  }

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

  /** #659 — null when the payee is this tenant's, else a PHI-free refusal reason (fail closed). */
  async function payeeMismatch(
    organizationId: string,
    providerEntityId: string,
    payee: ParsedRemittanceAdvice["payee"],
  ): Promise<string | null> {
    if (deps.payeeNpi === PAYEE_UNCHECKED) return null;
    const expected = (await deps.payeeNpi(organizationId, providerEntityId))?.trim();
    if (!expected) return "payee check: the provider entity has no NPI on file";
    if (payee?.idQualifier !== "XX" || !payee.id)
      return "payee check: the 835 payee carries no NPI (N103 XX)";
    return payee.id === expected
      ? null
      : "payee check: the 835 payee NPI is not this provider entity's";
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
    advice: AdviceContext,
    claim: ParsedClaim835,
  ): Promise<{ matched: boolean }> {
    const claimCandidates = claimCandidatesFor(advice.payerKind);
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
        // GAP-037 — the advice id M23 stamps onto `claim_state_history.remittance_advice_id` and onto its
        // own `m23.claim.paid` / `.denied` / `.adjudicated` payloads (all three REQUIRE it). Without it
        // the consumer could only reach it by reading M25's own tables across the module boundary.
        remittanceAdviceId: advice.id,
        // Was `new Date(0).toISOString()` — a literal 1970-01-01 on every posting event. Nothing consumed
        // it before, so nothing noticed; M23 now maps it to `paidAt` / `adjudicatedAt`, which feed M30's
        // and M33's date-bucketed measures. The 835's receipt instant is the posting instant.
        postedAt: advice.receivedAt.toISOString(),
      };
      // GAP-075 — the per-claim accrual facts M26 records (see `capAccrualFacts` in events-by-m25.ts).
      // Resolved only for the two outcomes that carry paid money; the patient comes from the payer-routed
      // claim-match seam, honestly `null` when it cannot be sited.
      const capFacts = async () => ({
        patientId:
          (await claimCandidates.patientIdForClaim(
            actor.organizationId,
            match.claimId as string,
          )) ?? null,
        paidAmountCents: Math.round(claim.totalPayment * 100),
        serviceFrom: claim.serviceFrom ?? null,
        serviceTo: claim.serviceTo ?? null,
      });
      if (outcome === "paid") {
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_paid",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: { ...eventBase, paidAmount: money(claim.totalPayment), ...(await capFacts()) },
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
            ...(await capFacts()),
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
        // F-163 (#248) — M26's `handleClaimReversed` needs `patientId` + a cents amount that neither this
        // payload nor `m23.claim.replaced`/`.voided` ever carried (M26's own standing finding). Resolved
        // the same way `postAdjustments`' PR-ledger seed already resolves it two functions up in this same
        // file: the real M23 seam (`claimCandidates`, already in scope), honestly `null` when the claim
        // cannot be sited to a patient (the deny-stub default, or a genuinely orphaned match) — never
        // fabricated. `recoupedAmountCents` is a NEW, correctly-unit-named field computed directly from the
        // same float dollars `recoupedAmount`'s own `money()` string already carries, rather than asking
        // `handleClaimReversed` to parse a decimal string through its `cents()` helper (which does not
        // convert dollars → cents at all — a real, separate defect this pass declined to touch, since
        // every other `cents()` caller already passes it a pre-converted integer).
        const patientId = await claimCandidates.patientIdForClaim(
          actor.organizationId,
          match.claimId as string,
        );
        await outbox.publish(tx, {
          eventName: "m25.remittance.claim_recouped",
          organizationId: actor.organizationId,
          aggregateKind: "remittance_line",
          aggregateId: line.id,
          payload: {
            ...eventBase,
            patientId,
            recoupedAmount: money(claim.totalPayment),
            recoupedAmountCents: Math.round(claim.totalPayment * 100),
            serviceFrom: claim.serviceFrom ?? null,
            serviceTo: claim.serviceTo ?? null,
          },
        });
      }
    }

    return { matched: bound };
  }

  /** Route + insert every CAS adjustment at one CLP/SVC granularity; seeds denial_case / PR-ledger rows. */
  async function postAdjustments(
    tx: M25Tx,
    actor: M25IngestActor,
    advice: AdviceContext,
    args: {
      claimId: string | null;
      remittanceLineId: string;
      remittanceServiceLineId: string | null;
      adjustments: ParsedClaim835["adjustments"];
    },
  ): Promise<void> {
    const claimCandidates = claimCandidatesFor(advice.payerKind);
    for (const adj of args.adjustments) {
      const catalogCategory = await resolveCategory(adj.reasonCode);
      const { category, taxonomyStatus } = effectiveCategory(catalogCategory);
      const routing = routeAdjustment(adj.groupCode, category, taxonomyStatus);
      // The PR ledger requires a real patient id (NOT NULL) — resolvable only for a matched claim, and
      // only once the M23/M24 cross-module seam (routed by payer, F-172) is bound. Absent that, the
      // adjustment honestly degrades to `flagged_review` rather than claiming a ledger entry was
      // recorded when it was not.
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

  /**
   * Insert one transaction set's envelope row + its `m25.edi.835_received` event (tx-bound). The DB's
   * `ux_remittance_envelope_dedupe` unique index is the real dedup enforcement (§2.6) — a conflicting insert is
   * caught here (never thrown, so the tx never poisons) and resolved by looking up the winner, whether that was
   * an earlier call or a concurrent one racing this one.
   */
  async function queueEnvelope(
    tx: M25Tx,
    actor: M25IngestActor,
    input: ReceiveAdviceInput,
    parsed: ParsedRemittanceAdvice,
  ): Promise<ReceiveAdviceResult> {
    const [row] = await tx
      .insert(RA)
      .values({
        organizationId: actor.organizationId,
        providerEntityId: input.providerEntityId,
        payerId: input.payerId,
        payerKind: input.payerKind,
        interchangeControlNumber: parsed.interchangeControlNumber,
        transactionSetControlNumber: parsed.transactionSetControlNumber,
        checkOrEftTraceNumber: parsed.checkOrEftTraceNumber ?? null,
        paymentMethod: parsed.paymentMethod,
        totalPaymentAmount: money(parsed.totalPaymentAmount),
        productionDate: productionDay(parsed.productionDate),
        minioObjectKey: input.minioObjectKey,
        fileSha256: input.fileSha256,
        parseStatus: "queued",
      })
      .onConflictDoNothing({
        target: [RA.interchangeControlNumber, RA.transactionSetControlNumber, RA.providerEntityId],
      })
      .returning({ id: RA.id });
    if (!row) {
      const [dup] = await tx
        .select({ id: RA.id })
        .from(RA)
        .where(
          and(
            eq(RA.interchangeControlNumber, parsed.interchangeControlNumber),
            eq(RA.transactionSetControlNumber, parsed.transactionSetControlNumber),
            eq(RA.providerEntityId, input.providerEntityId),
          ),
        )
        .limit(1);
      if (!dup) throw new Error("m25-ingest: envelope insert conflicted but no row found");
      return { outcome: "duplicate", existingAdviceId: dup.id };
    }
    // Staged inside the transaction under the new row's id: a store failure rolls the receive back, so
    // nothing is queued whose raw text cannot be read at post time (every set of a file stages the whole file).
    await deps.rawStore?.put(actor.organizationId, row.id, input.rawEdi);
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
  }

  /**
   * #669 — once an advice is posted the staged raw text (PHI) has no reader left. Best effort: a failure must
   * never un-post the advice; it is reported, and the next redelivery (or a bucket lifecycle rule) retries.
   */
  async function dropStagedRaw(organizationId: string, adviceId: string): Promise<void> {
    await deps.rawStore?.delete(organizationId, adviceId).catch((err: unknown) => {
      try {
        deps.onStagedDeleteFailed?.({
          organizationId,
          adviceId,
          errorName: err instanceof Error ? err.name : "unknown",
        });
      } catch {
        // Ops-only hook.
      }
    });
  }

  return {
    async receiveAdvice(
      actor: M25IngestActor,
      input: ReceiveAdviceInput,
    ): Promise<ReceiveAdviceResult> {
      // Cheap, real, local pre-flight — a genuinely malformed file (not X12, no
      // ISA/ST segment) is rejected with NOTHING persisted before we ever call the parser.
      const header = parseX12EnvelopeHeader(input.rawEdi);
      if (!header) {
        return {
          outcome: "malformed",
          reason: "not a valid X12 envelope (missing ISA/ST segment)",
        };
      }
      // #668 — the staged text is what gets posted, so the declared hash must describe it.
      if (
        createHash("sha256").update(input.rawEdi, "utf8").digest("hex") !==
        input.fileSha256.toLowerCase()
      ) {
        return { outcome: "malformed", reason: "fileSha256 does not match the submitted 835 text" };
      }
      // One file may hold several ST/SE sets; each is its own advice (its own dedup key and event). Every set is
      // parsed and payee-checked BEFORE anything is stored, so one bad set refuses the whole file.
      const parsedSets: ParsedRemittanceAdvice[] = [];
      for (const st02 of parseX12TransactionSetControlNumbers(input.rawEdi)) {
        const parsed = await client.parse835({
          minioObjectKey: input.minioObjectKey,
          payerProgram: input.payerKind,
          rawEdi: input.rawEdi,
          transactionSetControlNumber: st02,
        });
        if (!parsed.ok) {
          return { outcome: "malformed", reason: parsed.degraded.reason };
        }
        if (
          parsed.value.interchangeControlNumber !== header.interchangeControlNumber ||
          parsed.value.transactionSetControlNumber !== st02
        ) {
          return {
            outcome: "malformed",
            reason: "parsed envelope control numbers disagree with the local ISA/ST header",
          };
        }
        const mismatch = await payeeMismatch(
          actor.organizationId,
          input.providerEntityId,
          parsed.value.payee,
        );
        if (mismatch) return { outcome: "malformed", reason: mismatch };
        parsedSets.push(parsed.value);
      }

      // The response carries the first set's advice (queued if any set is new, else the existing duplicate);
      // every queued set emits its own `m25.edi.835_received`, so the pipeline never depends on the response.
      const results = await withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: "" },
        async (tx) => {
          const out: ReceiveAdviceResult[] = [];
          for (const parsed of parsedSets) out.push(await queueEnvelope(tx, actor, input, parsed));
          return out;
        },
      );
      return results.find((r) => r.outcome === "queued") ?? (results[0] as ReceiveAdviceResult);
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
              transactionSetControlNumber: RA.transactionSetControlNumber,
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
        // A redelivery retries a delete that failed after the original post (delete is idempotent).
        if (advice.parseStatus === "posted" || advice.parseStatus === "partial_posted")
          await dropStagedRaw(actor.organizationId, adviceId);
        return { outcome: "already_posted", adviceId };
      }

      // #658 — read the staged object here (this layer knows the tenant); a read failure leaves `rawEdi` unset so
      // the client degrades to its retryable X12_835_RAW_UNAVAILABLE path and the row is marked failed/replayable.
      const staged = await deps.rawStore
        ?.get(actor.organizationId, adviceId)
        .catch((err: unknown) => {
          // Reported without the message (it can carry bucket/key): a 403/5xx/oversize read must not look like "missing".
          try {
            deps.onStagedReadFailed?.({
              organizationId: actor.organizationId,
              adviceId,
              errorName: err instanceof Error ? err.name : "unknown",
            });
          } catch {
            // Ops-only hook.
          }
          return null;
        });
      const parsed = await client.parse835({
        minioObjectKey: advice.minioObjectKey,
        payerProgram: advice.payerKind,
        transactionSetControlNumber: advice.transactionSetControlNumber,
        ...(staged ? { rawEdi: staged } : {}),
      });
      if (!parsed.ok) {
        if (parsed.degraded.retryable) {
          try {
            deps.onRetryableParseDegraded?.({
              organizationId: actor.organizationId,
              adviceId,
              code: parsed.degraded.code,
            });
          } catch {
            // Ops-only hook: it must never stop the advice being marked failed.
          }
        }
        await markFailed(actor, adviceId, parsed.degraded.reason);
        return { outcome: "failed", adviceId, reason: parsed.degraded.reason };
      }

      const mismatch = await payeeMismatch(
        actor.organizationId,
        advice.providerEntityId,
        parsed.value.payee,
      );
      if (mismatch) {
        await markFailed(actor, adviceId, mismatch);
        return { outcome: "failed", adviceId, reason: mismatch };
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
                  payerKind: advice.payerKind,
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
                postedAt: advice.receivedAt.toISOString(),
              },
            });
            return { outcome: finalStatus, postedLineCount, unmatchedLineCount };
          },
        );
        if (result.outcome === "already_posted") {
          await dropStagedRaw(actor.organizationId, adviceId);
          return { outcome: "already_posted", adviceId };
        }
        await dropStagedRaw(actor.organizationId, adviceId);
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
