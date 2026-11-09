import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { decodeKeysetCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  DegradedError,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import type { ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import type { ClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";
import type { M25ReadActor, M25WriteActor } from "../routes/actor";

/** A page of review items plus the next signed cursor (null at the end). */
interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly searchWindowLimited: boolean;
}
import { projectEraFinancialReview } from "../domain/era-financial-review";
import {
  checkEraPaymentBalance,
  classifyEraClaimIdentity,
  isIdempotentMatchDecisionRetry,
} from "../domain/era-match-review";
import { providerEntityScopeCondition } from "../routes/scope";
import type { M25IngestService } from "./service";
import { getM25TransactionPostingPort, m25ContentDigestOf } from "./service-drizzle";
import type { M25Tx, M25ValidatedClaimAssociation } from "./service-drizzle";

const STAGE = schema.claimmdEraM25Stage;
const PAGE_MAX = 100;

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const serviceLineReference = (line: JsonRecord): string | null => {
  const ref = array(line.references).find(
    (value): value is JsonRecord =>
      record(value) && value.qualifier === "6R" && typeof value.value === "string",
  );
  return ref ? str(ref.value) : null;
};

export interface ClaimMdEraReviewItem {
  readonly id: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly eraId: string;
  readonly fileIndex: number;
  readonly transactionSetControlNumber: string;
  readonly state: string;
  readonly holdReason: string | null;
  readonly possibleDuplicate: boolean;
  readonly duplicateClassification: "none" | "possible" | "exact";
  readonly existingAdviceId: string | null;
  readonly createdAt: string;
  readonly detailsAvailable: boolean;
  readonly payer: { readonly name: string | null; readonly identifier: string | null };
  readonly payee: { readonly name: string | null; readonly npi: string | null };
  readonly payment: {
    readonly trace: string | null;
    readonly method: string | null;
    readonly amount: number | null;
    readonly date: string | null;
  };
  readonly claims: readonly ClaimMdEraReviewClaim[];
  readonly providerAdjustments: readonly {
    readonly reason: string | null;
    readonly reference: string | null;
    readonly amount: number | null;
  }[];
  readonly claimOutcomes: readonly ClaimMdEraClaimOutcome[];
  readonly reconciliationEligible: boolean;
}

export interface ClaimMdEraReviewClaim {
  readonly patientControlNumber: string | null;
  readonly payerIcn: string | null;
  readonly statusCode: number | null;
  readonly totalCharge: number | null;
  readonly totalPayment: number | null;
  readonly patientResponsibility: number | null;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly adjustments: readonly {
    readonly groupCode: string | null;
    readonly reasonCode: string | null;
    readonly amount: number | null;
    readonly quantity: number | null;
  }[];
  readonly serviceLines: readonly {
    readonly procedureCode: string | null;
    readonly revenueCode: string | null;
    readonly chargeAmount: number | null;
    readonly paidAmount: number | null;
    readonly paidUnits: number | null;
    readonly submittedUnits: number | null;
    readonly payerLineReference: string | null;
    readonly adjustments: readonly {
      readonly groupCode: string | null;
      readonly reasonCode: string | null;
      readonly amount: number | null;
      readonly quantity: number | null;
    }[];
    readonly remarks: readonly { readonly kind: string | null; readonly code: string | null }[];
  }[];
  readonly remarks: readonly { readonly kind: string | null; readonly code: string | null }[];
}

export interface ClaimMdEraClaimOutcome {
  readonly claimId: string | null;
  readonly patientControlNumber: string | null;
  readonly outcome: string | null;
  readonly module: string | null;
  readonly fileIndex: number | null;
  readonly transactionSetControlNumber: string | null;
}

export interface ClaimMdEraReviewSummary {
  readonly id: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly state: string;
  readonly holdReason: string | null;
  readonly possibleDuplicate: boolean;
  readonly duplicateClassification: "none" | "possible" | "exact";
  readonly existingAdviceId: string | null;
  readonly createdAt: string;
  readonly detailsAvailable: boolean;
  readonly payer: { readonly name: string | null; readonly identifier: string | null };
  readonly payee: { readonly name: string | null };
  readonly payment: {
    readonly method: string | null;
    readonly amount: number | null;
    readonly date: string | null;
  };
  readonly claimCount: number;
  readonly identityExceptionCount: number;
  readonly reconciliationEligible: boolean;
}

export type ClaimMdEraReviewHistoryOrigin =
  | "ingestion"
  | "ownership"
  | "delivery"
  | "recovery"
  | "system";

export interface ClaimMdEraReviewHistoryEvent {
  readonly eventType: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly stageId: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly reasonCode: string | null;
  readonly origin: ClaimMdEraReviewHistoryOrigin;
  readonly actorClassification: "platform_operator" | "system" | null;
  readonly attemptCount: number | null;
}

export interface ClaimMdEraReviewHistory {
  readonly availability: "available" | "partial" | "unavailable";
  readonly events: readonly ClaimMdEraReviewHistoryEvent[];
}

export interface ClaimMdEraHistoryStageReference {
  readonly id: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly sourceInboxId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly eraId: string;
  readonly original835Digest: string;
  readonly resolutionId: string | null;
  readonly resolutionVersion: number | null;
  readonly createdAt: Date | string;
  readonly state: string;
  readonly safeReasonCode: string | null;
}

export interface ClaimMdEraReviewHistoryReader {
  tenantStageHistory(stage: ClaimMdEraHistoryStageReference): Promise<ClaimMdEraReviewHistory>;
}

export interface ClaimMdEraReviewDetail extends ClaimMdEraReviewItem {
  readonly history: ClaimMdEraReviewHistory;
}

export interface ClaimMdEraMatchReview {
  readonly stageId: string;
  readonly totalClaims: number;
  readonly verifiedSourceIdentities: number;
  readonly unresolvedSourceIdentities: number;
  readonly claims: readonly {
    readonly claimIndex: number;
    readonly patientControlNumber: string | null;
    readonly payerIcn: string | null;
    readonly serviceLines: readonly {
      readonly lineIndex: number;
      readonly payerLineReference: string | null;
      readonly outcome: "original_line_evidence_unavailable" | "payer_line_reference_missing";
    }[];
    readonly outcome: "verified" | "ambiguous" | "conflict" | "unmatched" | "unsupported";
    readonly linkedClaimId: string | null;
    readonly decision:
      | "unreviewed"
      | "confirmed_identity"
      | "human_confirmed_candidate"
      | "cleared";
    readonly decisionVersion: number;
    readonly reason: string | null;
    readonly decisionAt: string | null;
  }[];
  readonly decisionHistory: readonly {
    readonly claimIndex: number;
    readonly decisionVersion: number;
    readonly decision: "confirmed_identity" | "human_confirmed_candidate" | "cleared";
    readonly reason: string;
    readonly occurredAt: string;
    readonly actorClassification: "authorized_reviewer";
  }[];
  readonly serviceLineMatching: "not_available_without_original_line_reference";
  readonly financialReview: ReturnType<typeof projectEraFinancialReview>;
  readonly financialReviewHistory: readonly {
    readonly itemType: "era" | "claim";
    readonly itemIndex: number;
    readonly decisionVersion: number;
    readonly disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed";
    readonly reason: string;
    readonly occurredAt: string;
    readonly reviewerMembershipId: string;
    readonly currentSource: boolean;
  }[];
  readonly readOnlyBalance: ReturnType<typeof checkEraPaymentBalance>;
  readonly postingAuthorized: false;
}

export interface HistoricalMatchCandidate {
  readonly module: "M23" | "M41";
  readonly evidenceId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly attemptKey: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly payerId: string;
  readonly pcn: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly chargeCents: number | null;
  readonly lineage: "original" | "correction" | "replacement" | "void" | "unknown";
  readonly attemptState: string;
  readonly submittedAt: string;
  readonly submittedLines: "unavailable";
  readonly supportingEvidence: readonly string[];
  readonly selectable: boolean;
}
export interface HistoricalMatchCandidatePage {
  readonly candidates: readonly HistoricalMatchCandidate[];
  readonly complete: boolean;
}

export type HistoricalMatchCandidateReader = (input: {
  readonly tx: DbClient;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly pcn: string;
}) => Promise<readonly Omit<HistoricalMatchCandidate, "supportingEvidence" | "selectable">[]>;

export function assessHistoricalMatchCandidate(input: {
  readonly candidate: Omit<HistoricalMatchCandidate, "supportingEvidence" | "selectable">;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly pcn: string;
  readonly payerId: string | null;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly chargeCents: number | null;
}): HistoricalMatchCandidate {
  const candidate = input.candidate;
  const sameScope =
    candidate.organizationId === input.organizationId &&
    candidate.providerEntityId === input.providerEntityId &&
    candidate.accountReference === input.accountReference &&
    candidate.usage === input.usage;
  const samePcn = candidate.pcn === input.pcn;
  const samePayer = Boolean(input.payerId && candidate.payerId === input.payerId);
  const samePeriod = Boolean(
    input.serviceFrom &&
      input.serviceTo &&
      candidate.serviceFrom === input.serviceFrom &&
      candidate.serviceTo === input.serviceTo,
  );
  const sameCharge = input.chargeCents !== null && candidate.chargeCents === input.chargeCents;
  const supportingEvidence = [
    ...(samePcn ? ["patient control number matches the immutable submitted attempt"] : []),
    ...(sameScope ? ["organization, provider, Claim.MD account and environment match"] : []),
    ...(samePayer ? ["payer identifier matches"] : []),
    ...(samePeriod ? ["service period matches"] : []),
    ...(sameCharge ? ["submitted charge matches"] : []),
  ];
  return {
    ...candidate,
    supportingEvidence,
    selectable: sameScope && samePcn && samePayer && samePeriod && sameCharge,
  };
}

function summaryOf(item: ClaimMdEraReviewItem): ClaimMdEraReviewSummary {
  return {
    id: item.id,
    providerEntityId: item.providerEntityId,
    locationId: item.locationId,
    state: item.state,
    holdReason: item.holdReason,
    possibleDuplicate: item.possibleDuplicate,
    duplicateClassification: item.duplicateClassification,
    existingAdviceId: item.existingAdviceId,
    createdAt: item.createdAt,
    detailsAvailable: item.detailsAvailable,
    payer: item.payer,
    payee: { name: item.payee.name },
    payment: {
      method: item.payment.method,
      amount: item.payment.amount,
      date: item.payment.date,
    },
    claimCount: item.claims.length,
    identityExceptionCount: item.claimOutcomes.filter((outcome) => outcome.outcome !== "verified")
      .length,
    reconciliationEligible: item.reconciliationEligible,
  };
}

export function projectClaimMdEraReviewSummary(
  row: StoredStage,
  cipher: ClaimMdProtectedPayloadCipher,
): ClaimMdEraReviewSummary {
  return summaryOf(projectClaimMdEraReviewItem(row, cipher));
}

interface StoredStage {
  id: string;
  organizationId: string;
  providerEntityId: string;
  locationId: string | null;
  sourceInboxId: string;
  idempotencyKey: string | null;
  accountReference: string;
  usage: "test" | "production";
  original835Digest: string;
  sourceFileDigest?: string | null;
  contentDigest?: string | null;
  paymentTraceDigest?: string | null;
  sourceEvidence?: unknown;
  resolutionId: string | null;
  resolutionVersion: number | null;
  protectedDetailsCipher: string | null;
  state: string;
  safeReasonCode: string | null;
  possibleDuplicateAdviceId: string | null;
  eraId: string;
  fileIndex: number;
  transactionSetControlNumber: string;
  createdAt: Date | string;
}

export function projectClaimMdEraReviewItem(
  row: StoredStage,
  cipher: ClaimMdProtectedPayloadCipher,
): ClaimMdEraReviewItem {
  let details: JsonRecord | null = null;
  if (row.protectedDetailsCipher && row.idempotencyKey) {
    try {
      const plaintext = cipher.open(
        row.sourceInboxId,
        row.idempotencyKey,
        Buffer.from(row.protectedDetailsCipher, "base64"),
      );
      const parsed: unknown = JSON.parse(plaintext);
      if (record(parsed)) details = parsed;
    } catch {
      throw new DegradedError(
        "M25 Claim.MD ERA review",
        "protected remittance details are unavailable",
      );
    }
  }
  const advice = record(details?.transactionSet) ? details.transactionSet : {};
  const payer = record(advice.payer) ? advice.payer : {};
  const payee = record(advice.payee) ? advice.payee : {};
  const claims: ClaimMdEraReviewClaim[] = array(advice.claims)
    .filter(record)
    .map((claim) => ({
      patientControlNumber: str(claim.patientControlNumber),
      payerIcn: str(claim.payerIcn),
      statusCode: num(claim.statusCode),
      totalCharge: num(claim.totalCharge),
      totalPayment: num(claim.totalPayment),
      patientResponsibility: num(claim.patientResponsibility),
      serviceFrom: str(claim.serviceFrom),
      serviceTo: str(claim.serviceTo),
      adjustments: array(claim.adjustments)
        .filter(record)
        .map(({ groupCode, reasonCode, amount, quantity }) => ({
          groupCode: str(groupCode),
          reasonCode: str(reasonCode),
          amount: num(amount),
          quantity: num(quantity),
        })),
      serviceLines: array(claim.serviceLines)
        .filter(record)
        .map((line) => ({
          procedureCode: str(line.procedureCode),
          revenueCode: str(line.revenueCode),
          chargeAmount: num(line.chargeAmount),
          paidAmount: num(line.paidAmount),
          paidUnits: num(line.paidUnits),
          submittedUnits: num(line.submittedUnits),
          payerLineReference: serviceLineReference(line),
          adjustments: array(line.adjustments)
            .filter(record)
            .map(({ groupCode, reasonCode, amount, quantity }) => ({
              groupCode: str(groupCode),
              reasonCode: str(reasonCode),
              amount: num(amount),
              quantity: num(quantity),
            })),
          remarks: array(line.remarks)
            .filter(record)
            .map((remark) => ({ kind: str(remark.kind), code: str(remark.code) })),
        })),
      remarks: array(claim.remarks)
        .filter(record)
        .map((remark) => ({ kind: str(remark.kind), code: str(remark.code) })),
    }));
  const outcomes: ClaimMdEraClaimOutcome[] = array(details?.claimOutcomes)
    .filter(record)
    .map((outcome) => ({
      claimId: str(outcome.claimId),
      patientControlNumber: str(outcome.pcn) ?? str(outcome.patientControlNumber),
      outcome: str(outcome.outcome),
      module: str(outcome.billingModule) ?? str(outcome.module),
      fileIndex: num(outcome.fileIndex),
      transactionSetControlNumber: str(outcome.transactionSetControlNumber),
    }));
  const date =
    row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date(row.createdAt).toISOString();
  const duplicateClassification =
    row.safeReasonCode === "EXACT_DUPLICATE_FROM_M25"
      ? "exact"
      : row.state === "possible_duplicate" ||
          row.safeReasonCode === "POSSIBLE_CROSS_SOURCE_DUPLICATE"
        ? "possible"
        : "none";
  return {
    id: row.id,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    eraId: row.eraId,
    fileIndex: row.fileIndex,
    transactionSetControlNumber: row.transactionSetControlNumber,
    state: row.state,
    holdReason: row.safeReasonCode,
    possibleDuplicate:
      row.state === "possible_duplicate" ||
      row.safeReasonCode === "POSSIBLE_CROSS_SOURCE_DUPLICATE",
    duplicateClassification,
    existingAdviceId: row.possibleDuplicateAdviceId,
    createdAt: date,
    detailsAvailable: details !== null,
    payer: { name: str(payer.name), identifier: str(payer.id) },
    payee: { name: str(payee.name), npi: payee.idQualifier === "XX" ? str(payee.id) : null },
    payment: {
      trace: str(advice.checkOrEftTraceNumber),
      method: str(advice.paymentMethod),
      amount: num(advice.totalPaymentAmount),
      date: str(advice.productionDate),
    },
    claims,
    providerAdjustments: array(advice.providerAdjustments)
      .filter(record)
      .map(({ reason, reference, amount }) => ({
        reason: str(reason),
        reference: str(reference),
        amount: num(amount),
      })),
    claimOutcomes: outcomes,
    reconciliationEligible: row.state === "staged" && details !== null,
  };
}

export interface ClaimMdEraReviewService {
  list(
    actor: M25ReadActor,
    filters: {
      providerEntityId?: string;
      state?: string;
      payer?: string;
      fromDate?: string;
      toDate?: string;
    },
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<ClaimMdEraReviewSummary>>;
  get(actor: M25ReadActor, id: string): Promise<ClaimMdEraReviewDetail | null>;
  matching(actor: M25ReadActor, id: string): Promise<ClaimMdEraMatchReview | null>;
  candidates(
    actor: M25ReadActor,
    id: string,
    claimIndex: number,
  ): Promise<HistoricalMatchCandidatePage | null>;
  recordMatchDecision(
    actor: M25MatchActor,
    id: string,
    claimIndex: number,
    input: {
      readonly action: "confirm_identity" | "confirm_candidate" | "clear";
      readonly expectedVersion: number;
      readonly reason: string;
      readonly evidenceId?: string;
    },
  ): Promise<{
    readonly decisionVersion: number;
    readonly decision: "confirmed_identity" | "human_confirmed_candidate" | "cleared";
  }>;
  recordFinancialReviewDecision(
    actor: M25MatchActor,
    id: string,
    input: {
      readonly itemType: "era" | "claim";
      readonly itemIndex: number;
      readonly disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed";
      readonly expectedVersion: number;
      readonly reason: string;
      readonly idempotencyKey: string;
    },
  ): Promise<{
    readonly id: string;
    readonly itemType: "era" | "claim";
    readonly itemIndex: number;
    readonly decisionVersion: number;
    readonly disposition: "note" | "follow_up" | "reviewed" | "reopened" | "completed";
  }>;
  postingPlan(actor: M25WriteActor, id: string): Promise<ClaimMdEraPostingPlan>;
  approvePostingPlan(
    actor: M25MatchActor,
    id: string,
    input: { planId: string; planDigest: string; reason: string; idempotencyKey: string },
  ): Promise<{ planId: string; outcome: "approved" | "already_approved" }>;
  executePostingPlan(
    actor: M25MatchActor,
    id: string,
    input: { planId: string; planDigest: string; reason: string; idempotencyKey: string },
  ): Promise<{
    planId: string;
    outcome: "posted" | "already_posted";
    adviceId: string | null;
    remittanceLineId: string | null;
    paymentCents: number;
  }>;
  postingHistory(
    actor: M25ReadActor,
    id: string,
  ): Promise<readonly ClaimMdEraPostingHistoryEvent[]>;
}

export interface M25MatchActor extends M25ReadActor {
  readonly membershipId: string;
}

export interface ClaimMdEraPostingPlan {
  readonly planId: string;
  readonly planDigest: string;
  readonly stageId: string;
  readonly providerEntityId: string;
  readonly payer: string | null;
  readonly paymentCents: number | null;
  readonly claimId: string | null;
  readonly eligible: boolean;
  readonly status: "eligible" | "blocked" | "already_posted";
  readonly blockers: readonly string[];
  readonly featureEnabled: boolean;
  readonly approval: "not_approved" | "approved" | "posted";
  readonly createdAt: string;
}

export interface ClaimMdEraPostingHistoryEvent {
  readonly eventType: "approved" | "posted";
  readonly planId: string;
  readonly occurredAt: string;
  readonly reason: string;
  readonly adviceId: string | null;
  readonly remittanceLineId: string | null;
}

export interface ClaimMdEraControlledPostingDeps {
  readonly ingestService: M25IngestService;
  readonly enabled: boolean;
}

/** M25-owned tenant read. It never reads central inbox tables and has no financial write dependency. */
export function buildDrizzleClaimMdEraReviewService(
  db: DbClient,
  cipher: ClaimMdProtectedPayloadCipher,
  historyReader?: ClaimMdEraReviewHistoryReader,
  candidateReaders: readonly HistoricalMatchCandidateReader[] = [],
  controlledPosting?: ClaimMdEraControlledPostingDeps,
): ClaimMdEraReviewService {
  const loadHistoricalCandidates = async (
    tx: DbClient,
    actor: M25ReadActor,
    stage: StoredStage,
    pcn: string,
    eraClaim: ClaimMdEraReviewClaim,
  ): Promise<readonly HistoricalMatchCandidate[]> => {
    const providerEntityId = stage.providerEntityId;
    if (actor.providerEntityScope && !actor.providerEntityScope.includes(providerEntityId))
      return [];
    const rows = (
      await Promise.all(
        candidateReaders.map((reader) =>
          reader({
            tx,
            organizationId: actor.organizationId,
            providerEntityId,
            accountReference: stage.accountReference,
            usage: stage.usage as "test" | "production",
            pcn,
          }),
        ),
      )
    ).flat();
    const detail = projectClaimMdEraReviewItem(stage, cipher);
    const eraChargeCents = decimalDollarsToCents(eraClaim.totalCharge);
    const candidates = rows
      .filter(
        (row) =>
          row.organizationId === actor.organizationId &&
          row.providerEntityId === providerEntityId &&
          row.accountReference === stage.accountReference &&
          row.usage === stage.usage &&
          row.pcn === pcn,
      )
      .map((row) =>
        assessHistoricalMatchCandidate({
          candidate: row,
          organizationId: actor.organizationId,
          providerEntityId,
          accountReference: stage.accountReference,
          usage: stage.usage as "test" | "production",
          pcn,
          payerId: detail.payer.identifier,
          serviceFrom: eraClaim.serviceFrom,
          serviceTo: eraClaim.serviceTo,
          chargeCents: eraChargeCents,
        }),
      );
    return candidates.slice(0, 101);
  };
  const derivePostingFacts = async (tx: M25Tx, actor: M25ReadActor, stage: StoredStage) => {
    const detail = projectClaimMdEraReviewItem(stage, cipher);
    const blockers: string[] = [];
    const factsValue = (stage.sourceEvidence as JsonRecord | null)?.evidenceCodes;
    const evidenceCodes = Array.isArray(factsValue)
      ? factsValue.filter((value): value is string => typeof value === "string")
      : [];
    if (stage.state !== "staged") blockers.push("STAGE_NOT_DELIVERED");
    if (detail.duplicateClassification !== "none") blockers.push("POSSIBLE_DUPLICATE");
    if (
      !evidenceCodes.includes("EXACT_PAYEE_NPI") ||
      !evidenceCodes.includes("SINGLE_PROVIDER_ARTIFACT")
    )
      blockers.push("OWNERSHIP_EVIDENCE_INSUFFICIENT");
    if (
      !stage.sourceFileDigest ||
      !stage.contentDigest ||
      !stage.paymentTraceDigest ||
      !stage.resolutionId ||
      !stage.resolutionVersion
    )
      blockers.push("SOURCE_IDENTITY_INCOMPLETE");
    if (detail.claims.length !== 1) blockers.push("UNSUPPORTED_CLAIM_COUNT");
    const claim = detail.claims[0];
    const sourceIdentity = detail.claimOutcomes[0];
    const claimMatchRows = await tx
      .select({
        id: schema.claimMdEraMatchDecision.id,
        claimIndex: schema.claimMdEraMatchDecision.claimIndex,
        decisionVersion: schema.claimMdEraMatchDecision.decisionVersion,
        sourceDigest: schema.claimMdEraMatchDecision.sourceDigest,
        outcome: schema.claimMdEraMatchDecision.outcome,
        claimId: schema.claimMdEraMatchDecision.claimId,
        evidence: schema.claimMdEraMatchDecision.evidence,
        transactionSetControlNumber: schema.claimMdEraMatchDecision.transactionSetControlNumber,
      })
      .from(schema.claimMdEraMatchDecision)
      .where(
        and(
          eq(schema.claimMdEraMatchDecision.stageId, stage.id),
          eq(schema.claimMdEraMatchDecision.organizationId, actor.organizationId),
        ),
      )
      .orderBy(
        desc(schema.claimMdEraMatchDecision.createdAt),
        desc(schema.claimMdEraMatchDecision.id),
      );
    const identityOutcome =
      claim && sourceIdentity
        ? classifyEraClaimIdentity({
            outcome: sourceIdentity.outcome,
            claimId: sourceIdentity.claimId,
            patientControlNumber: sourceIdentity.patientControlNumber,
            expectedPatientControlNumber: claim.patientControlNumber,
            transactionSetControlNumber: sourceIdentity.transactionSetControlNumber,
            expectedTransactionSetControlNumber: detail.transactionSetControlNumber,
          })
        : "unsupported";
    const identityDigest = claim
      ? matchSourceDigest(
          stage.original835Digest,
          stage.resolutionVersion,
          0,
          claim,
          sourceIdentity,
        )
      : "";
    const latestIdentity = claimMatchRows.find(
      (row) =>
        row.claimIndex === 0 &&
        row.transactionSetControlNumber === detail.transactionSetControlNumber,
    );
    const humanConfirmed =
      !!latestIdentity &&
      latestIdentity.sourceDigest === identityDigest &&
      latestIdentity.outcome === "confirmed" &&
      record(latestIdentity.evidence) &&
      latestIdentity.evidence.humanSelected === true;
    const claimId = humanConfirmed
      ? (latestIdentity?.claimId ?? null)
      : identityOutcome === "verified"
        ? (sourceIdentity?.claimId ?? null)
        : null;
    if (!claimId || (identityOutcome !== "verified" && !humanConfirmed))
      blockers.push(
        identityOutcome === "conflict" ? "MATCH_IDENTITY_CONFLICT" : "MATCH_NOT_VERIFIED",
      );
    if (claim && (!claim.patientControlNumber || !claim.serviceFrom || !claim.serviceTo))
      blockers.push("MATCH_REFERENCES_INCOMPLETE");

    const candidates = claim?.patientControlNumber
      ? await loadHistoricalCandidates(
          tx as unknown as DbClient,
          actor,
          stage,
          claim.patientControlNumber,
          claim,
        )
      : [];
    const candidate = candidates.find(
      (item) => item.selectable && item.claimId === claimId && item.module === "M41",
    );
    if (
      !candidate ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.payerId,
      )
    )
      blockers.push("PAYER_ROUTE_UNVERIFIED");

    const financialRows = await tx
      .select({
        id: schema.claimMdEraFinancialReviewDecision.id,
        itemType: schema.claimMdEraFinancialReviewDecision.itemType,
        itemIndex: schema.claimMdEraFinancialReviewDecision.itemIndex,
        decisionVersion: schema.claimMdEraFinancialReviewDecision.decisionVersion,
        disposition: schema.claimMdEraFinancialReviewDecision.disposition,
        sourceDigest: schema.claimMdEraFinancialReviewDecision.sourceDigest,
        createdAt: schema.claimMdEraFinancialReviewDecision.createdAt,
        actorMembershipId: schema.claimMdEraFinancialReviewDecision.actorMembershipId,
        reason: schema.claimMdEraFinancialReviewDecision.reason,
      })
      .from(schema.claimMdEraFinancialReviewDecision)
      .where(
        and(
          eq(schema.claimMdEraFinancialReviewDecision.stageId, stage.id),
          eq(schema.claimMdEraFinancialReviewDecision.organizationId, actor.organizationId),
        ),
      )
      .orderBy(
        desc(schema.claimMdEraFinancialReviewDecision.createdAt),
        desc(schema.claimMdEraFinancialReviewDecision.id),
      );
    const latestFinancial = new Map<string, (typeof financialRows)[number]>();
    for (const row of financialRows) {
      const key = `${row.itemType}:${row.itemIndex}`;
      if (!latestFinancial.has(key)) latestFinancial.set(key, row);
    }
    const matchRevision = matchDecisionRevisionDigest(claimMatchRows);
    // BIL-3.3's explicit completion transition is ERA-scoped; claim notes remain audit context,
    // and are still included in the source revision digest where present.
    const requiredReviews = [latestFinancial.get("era:-1")];
    if (
      requiredReviews.some(
        (row) =>
          !row ||
          row.disposition !== "completed" ||
          row.sourceDigest !==
            financialReviewSourceDigest(
              stage.original835Digest,
              stage.resolutionVersion,
              row.itemType,
              row.itemIndex,
              detail,
              matchRevision,
            ),
      )
    )
      blockers.push("FINANCIAL_REVIEW_INCOMPLETE_OR_STALE");

    let parsed: ParsedRemittanceAdvice | null = null;
    try {
      if (!stage.protectedDetailsCipher || !stage.idempotencyKey) throw new Error("SOURCE_MISSING");
      const plaintext = cipher.open(
        stage.sourceInboxId,
        stage.idempotencyKey,
        Buffer.from(stage.protectedDetailsCipher, "base64"),
      );
      const protectedDetails: unknown = JSON.parse(plaintext);
      const transactionSet = record(protectedDetails) ? protectedDetails.transactionSet : null;
      if (!record(transactionSet)) throw new Error("PARSED_SOURCE_MISSING");
      parsed = transactionSet as unknown as ParsedRemittanceAdvice;
      if (m25ContentDigestOf(parsed) !== stage.contentDigest)
        throw new Error("CONTENT_DIGEST_MISMATCH");
      if (
        !parsed.checkOrEftTraceNumber ||
        createHash("sha256").update(parsed.checkOrEftTraceNumber, "utf8").digest("hex") !==
          stage.paymentTraceDigest
      )
        throw new Error("TRACE_MISMATCH");
    } catch {
      blockers.push("PROTECTED_SOURCE_INVALID");
    }
    if (
      !parsed ||
      parsed.payerProgram !== "commercial" ||
      !parsed.payer ||
      !parsed.payee ||
      !parsed.interchangeControlNumber ||
      !parsed.transactionSetControlNumber ||
      !parsed.checkOrEftTraceNumber ||
      !["check", "eft"].includes(parsed.paymentMethod) ||
      !Number.isFinite(Date.parse(parsed.productionDate))
    )
      blockers.push("UNSUPPORTED_OR_INCOMPLETE_835");
    const parsedClaim = parsed?.claims?.[0];
    if (
      !parsed ||
      parsed.claims.length !== 1 ||
      !parsedClaim ||
      parsedClaim.statusCode !== 1 ||
      parsedClaim.totalPayment <= 0 ||
      decimalDollarsToCents(parsedClaim.totalCharge) !==
        decimalDollarsToCents(parsedClaim.totalPayment) ||
      parsedClaim.patientResponsibility !== 0 ||
      parsedClaim.adjustments.length ||
      parsedClaim.remarks.length ||
      parsedClaim.serviceLines.length ||
      (parsed.providerAdjustments?.length ?? 0) ||
      (parsed.providerAdjustmentTotal ?? 0) !== 0 ||
      (parsed.unknownSegments?.length ?? 0)
    )
      blockers.push("UNSUPPORTED_FINANCIAL_FACTS");
    if (
      claim &&
      parsedClaim &&
      (claim.patientControlNumber !== parsedClaim.patientControlNumber ||
        claim.payerIcn !== parsedClaim.payerIcn ||
        decimalDollarsToCents(claim.totalCharge) !==
          decimalDollarsToCents(parsedClaim.totalCharge) ||
        decimalDollarsToCents(claim.totalPayment) !==
          decimalDollarsToCents(parsedClaim.totalPayment))
    )
      blockers.push("PARSED_CLAIM_PROJECTION_MISMATCH");
    if (
      parsed &&
      parsedClaim &&
      decimalDollarsToCents(parsed.totalPaymentAmount) !==
        decimalDollarsToCents(parsedClaim.totalPayment)
    )
      blockers.push("PAYMENT_BALANCE_UNSUPPORTED");
    if (parsed && candidate) {
      const prior = await tx
        .select({ id: schema.remittanceAdvice.id })
        .from(schema.remittanceAdvice)
        .where(
          and(
            eq(schema.remittanceAdvice.organizationId, actor.organizationId),
            eq(schema.remittanceAdvice.providerEntityId, stage.providerEntityId),
            eq(schema.remittanceAdvice.payerId, candidate.payerId),
            eq(schema.remittanceAdvice.checkOrEftTraceNumber, parsed.checkOrEftTraceNumber ?? ""),
            eq(
              schema.remittanceAdvice.totalPaymentAmount,
              (parsed.totalPaymentAmount ?? 0).toFixed(2),
            ),
          ),
        )
        .limit(2);
      if (prior.length) blockers.push("POTENTIAL_CROSS_SOURCE_DUPLICATE");
    }
    const evidence =
      latestIdentity?.id && humanConfirmed ? latestIdentity.id : (stage.resolutionId ?? "");
    const evidenceVersion = humanConfirmed
      ? latestIdentity!.decisionVersion
      : (stage.resolutionVersion ?? 0);
    const paymentCents = parsed ? decimalDollarsToCents(parsed.totalPaymentAmount) : null;
    return {
      stage,
      detail,
      parsed,
      claimId,
      candidate,
      evidence,
      evidenceVersion,
      paymentCents,
      blockers: [...new Set(blockers)],
      sourceRevisions: {
        stageDigest: stage.original835Digest,
        fileDigest: stage.sourceFileDigest,
        contentDigest: stage.contentDigest,
        paymentTraceDigest: stage.paymentTraceDigest,
        accountReference: stage.accountReference,
        usage: stage.usage,
        ownershipEvidenceDigest: createHash("sha256")
          .update(JSON.stringify([...evidenceCodes].sort()), "utf8")
          .digest("hex"),
        claimIdentityEvidenceDigest: createHash("sha256")
          .update(JSON.stringify(detail.claimOutcomes), "utf8")
          .digest("hex"),
        resolutionId: stage.resolutionId,
        resolutionVersion: stage.resolutionVersion,
        matchDecisionId: latestIdentity?.id ?? null,
        matchDecisionVersion: latestIdentity?.decisionVersion ?? 0,
        financialReview: [...latestFinancial.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([item, row]) => ({
            item,
            id: row.id,
            version: row.decisionVersion,
            disposition: row.disposition,
            sourceDigest: row.sourceDigest,
          })),
      },
    };
  };
  const controlledPort = controlledPosting
    ? getM25TransactionPostingPort(controlledPosting.ingestService)
    : null;
  const service: ClaimMdEraReviewService = {
    async list(actor, filters, rawCursor, requestedLimit) {
      const decodedCursor = decodeKeysetCursor(actor.organizationId, rawCursor, "instant");
      const cursor = decodedCursor ? { createdAt: decodedCursor.a, id: decodedCursor.id } : null;
      if (
        rawCursor &&
        (!cursor ||
          !Number.isFinite(new Date(cursor.createdAt).getTime()) ||
          !/^[0-9a-f-]{36}$/i.test(cursor.id))
      )
        throw new ValidationError(
          "The ERA review cursor is invalid; restart the filtered search.",
          [],
        );
      const payer = filters.payer?.trim().toLocaleLowerCase("en-US") ?? "";
      if (
        payer.length > 100 ||
        [...payer].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new ValidationError("Payer search must be 100 characters or fewer.", []);
      const from = filters.fromDate ? reviewDateStart(filters.fromDate) : null;
      const to = filters.toDate ? reviewDateStart(filters.toDate) : null;
      if ((filters.fromDate && !from) || (filters.toDate && !to) || (from && to && from > to))
        throw new ValidationError("The ERA review date range is invalid.", []);
      const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(requestedLimit)));
      const filterConditions = [
        eq(STAGE.organizationId, actor.organizationId),
        providerEntityScopeCondition(
          STAGE.providerEntityId,
          actor.providerEntityScope,
          filters.providerEntityId,
        ),
        filters.state ? eq(STAGE.state, filters.state) : undefined,
        from ? gte(STAGE.createdAt, from) : undefined,
        to ? lt(STAGE.createdAt, new Date(to.getTime() + 86_400_000)) : undefined,
      ];
      const keysetCondition = (key: { createdAt: string; id: string } | null) =>
        key
          ? or(
              lt(STAGE.createdAt, new Date(key.createdAt)),
              and(eq(STAGE.createdAt, new Date(key.createdAt)), lt(STAGE.id, key.id)),
            )
          : undefined;
      const matched: { item: ClaimMdEraReviewSummary; key: { createdAt: string; id: string } }[] =
        [];
      let scanKey = cursor;
      let nextCursor: string | null = null;
      let remainingExists = false;
      let searchWindowLimited = false;
      const scanBudget = payer ? 500 : limit + 1;
      let scanned = 0;
      while (matched.length <= limit && scanned < scanBudget) {
        const batchLimit = Math.min(payer ? 100 : limit + 1, scanBudget - scanned);
        const rows = (await withOrgContext(db, actor, (tx) =>
          tx
            .select()
            .from(STAGE)
            .where(and(...filterConditions, keysetCondition(scanKey)))
            .orderBy(desc(STAGE.createdAt), desc(STAGE.id))
            .limit(batchLimit),
        )) as StoredStage[];
        if (!rows.length) break;
        scanned += rows.length;
        for (const row of rows) {
          const summary = projectClaimMdEraReviewSummary(row, cipher);
          if (
            !payer ||
            `${summary.payer.name ?? ""} ${summary.payer.identifier ?? ""}`
              .toLocaleLowerCase("en-US")
              .includes(payer)
          )
            matched.push({ item: summary, key: { createdAt: asIso(row.createdAt), id: row.id } });
          scanKey = { createdAt: asIso(row.createdAt), id: row.id };
          if (matched.length > limit) break;
        }
        if (matched.length > limit) {
          const lastReturned = matched[limit - 1];
          if (lastReturned) scanKey = lastReturned.key;
          remainingExists = true;
          break;
        }
        if (rows.length < batchLimit) break;
        if (scanned >= scanBudget) {
          const [next] = await withOrgContext(db, actor, (tx) =>
            tx
              .select({ id: STAGE.id })
              .from(STAGE)
              .where(and(...filterConditions, keysetCondition(scanKey)))
              .limit(1),
          );
          remainingExists = Boolean(next);
          searchWindowLimited = Boolean(payer && remainingExists);
          break;
        }
        if (!payer) break;
      }
      if (remainingExists && scanKey)
        nextCursor = encodeCursor(actor.organizationId, {
          a: scanKey.createdAt,
          id: scanKey.id,
        });
      return {
        items: matched.slice(0, limit).map(({ item }) => item),
        nextCursor,
        searchWindowLimited,
      };
    },
    async get(actor, id) {
      const [row] = await withOrgContext(db, actor, (tx) =>
        tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.organizationId, actor.organizationId),
              eq(STAGE.id, id),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1),
      );
      if (!row) return null;
      const stored = row as StoredStage;
      const item = projectClaimMdEraReviewItem(stored, cipher);
      let history: ClaimMdEraReviewHistory = { availability: "unavailable", events: [] };
      if (historyReader) {
        try {
          history = await historyReader.tenantStageHistory(historyReference(stored));
        } catch {
          // History is an optional projection. A central-store outage must not make an already
          // authorized tenant stage unreadable, and safe history failures reveal no source data.
          history = { availability: "unavailable", events: [] };
        }
      }
      return { ...item, history };
    },
    async matching(actor, id) {
      const detail = await this.get(actor, id);
      if (!detail) return null;
      const [stage] = await withOrgContext(db, actor, (tx) =>
        tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1),
      );
      if (!stage) return null;
      const outcomes = detail.claimOutcomes;
      const claims = detail.claims.map((claim, claimIndex) => {
        const source = outcomes[claimIndex];
        const outcome = classifyEraClaimIdentity({
          outcome: source?.outcome,
          claimId: source?.claimId,
          patientControlNumber: source?.patientControlNumber,
          expectedPatientControlNumber: claim.patientControlNumber,
          transactionSetControlNumber: source?.transactionSetControlNumber,
          expectedTransactionSetControlNumber: detail.transactionSetControlNumber,
        });
        const fingerprint = matchSourceDigest(
          stage.original835Digest,
          stage.resolutionVersion,
          claimIndex,
          claim,
          source,
        );
        return {
          claimIndex,
          patientControlNumber: claim.patientControlNumber,
          payerIcn: claim.payerIcn,
          outcome,
          linkedClaimId:
            outcome === "verified" && typeof source?.claimId === "string" ? source.claimId : null,
          sourceModule: source?.module ?? null,
          serviceLines: claim.serviceLines.map((line, lineIndex) => ({
            lineIndex,
            payerLineReference: line.payerLineReference,
            outcome: line.payerLineReference
              ? ("original_line_evidence_unavailable" as const)
              : ("payer_line_reference_missing" as const),
          })),
          fingerprint,
        };
      });
      const decisions = await withOrgContext(db, actor, (tx) =>
        tx
          .select()
          .from(schema.claimMdEraMatchDecision)
          .where(
            and(
              eq(schema.claimMdEraMatchDecision.stageId, id),
              eq(schema.claimMdEraMatchDecision.organizationId, actor.organizationId),
            ),
          )
          .orderBy(
            desc(schema.claimMdEraMatchDecision.createdAt),
            desc(schema.claimMdEraMatchDecision.id),
          ),
      );
      const latest = new Map<string, (typeof decisions)[number]>();
      for (const decision of decisions) {
        const key = `${decision.transactionSetControlNumber}:${decision.claimIndex}`;
        if (!latest.has(key)) latest.set(key, decision);
      }
      const projected = claims.map(({ fingerprint, sourceModule, ...claim }) => {
        const decision = latest.get(`${detail.transactionSetControlNumber}:${claim.claimIndex}`);
        const current = decision?.sourceDigest === fingerprint ? decision : undefined;
        return {
          ...claim,
          linkedClaimId:
            current?.outcome === "confirmed" &&
            record(current.evidence) &&
            current.evidence.humanSelected === true
              ? current.claimId
              : claim.linkedClaimId,
          linkedModule:
            current?.outcome === "confirmed" &&
            record(current.evidence) &&
            current.evidence.humanSelected === true &&
            (current.evidence.billingModule === "M23" || current.evidence.billingModule === "M41")
              ? current.evidence.billingModule
              : sourceModule,
          decision:
            current?.outcome === "confirmed"
              ? record(current.evidence) && current.evidence.humanSelected === true
                ? ("human_confirmed_candidate" as const)
                : ("confirmed_identity" as const)
              : current?.outcome === "cleared"
                ? ("cleared" as const)
                : ("unreviewed" as const),
          decisionVersion: current?.decisionVersion ?? 0,
          reason: current?.reason ?? null,
          decisionAt: current?.createdAt.toISOString() ?? null,
        };
      });
      const financialReview = projectEraFinancialReview({
        stageState: detail.state,
        duplicateClassification: detail.duplicateClassification,
        reportedPayment: detail.payment.amount,
        claims: detail.claims,
        providerAdjustments: detail.providerAdjustments,
        identityOutcomes: projected.map((claim) =>
          claim.outcome === "verified" || claim.decision === "human_confirmed_candidate"
            ? "verified"
            : claim.outcome,
        ),
      });
      const financialRows = await withOrgContext(db, actor, (tx) =>
        tx
          .select()
          .from(schema.claimMdEraFinancialReviewDecision)
          .where(
            and(
              eq(schema.claimMdEraFinancialReviewDecision.stageId, id),
              eq(schema.claimMdEraFinancialReviewDecision.organizationId, actor.organizationId),
            ),
          )
          .orderBy(
            desc(schema.claimMdEraFinancialReviewDecision.createdAt),
            desc(schema.claimMdEraFinancialReviewDecision.id),
          )
          .limit(200),
      );
      const financialReviewHistory = financialRows.map((row) => ({
        itemType: row.itemType,
        itemIndex: row.itemIndex,
        decisionVersion: row.decisionVersion,
        disposition: row.disposition,
        reason: row.reason,
        occurredAt: row.createdAt.toISOString(),
        reviewerMembershipId: row.actorMembershipId,
        currentSource:
          row.sourceDigest ===
          financialReviewSourceDigest(
            stage.original835Digest,
            stage.resolutionVersion,
            row.itemType,
            row.itemIndex,
            detail,
            matchDecisionRevisionDigest(decisions),
          ),
      }));
      return {
        stageId: id,
        totalClaims: projected.length,
        verifiedSourceIdentities: projected.filter((claim) => claim.outcome === "verified").length,
        unresolvedSourceIdentities: projected.filter((claim) => claim.outcome !== "verified")
          .length,
        claims: projected,
        decisionHistory: decisions.map((decision) => ({
          claimIndex: decision.claimIndex,
          decisionVersion: decision.decisionVersion,
          decision:
            decision.outcome === "confirmed"
              ? record(decision.evidence) && decision.evidence.humanSelected === true
                ? ("human_confirmed_candidate" as const)
                : ("confirmed_identity" as const)
              : ("cleared" as const),
          reason: decision.reason,
          occurredAt: decision.createdAt.toISOString(),
          actorClassification: "authorized_reviewer" as const,
        })),
        serviceLineMatching: "not_available_without_original_line_reference",
        financialReview,
        financialReviewHistory,
        readOnlyBalance: checkEraPaymentBalance({
          claimPayments: detail.claims.map((claim) => claim.totalPayment),
          providerAdjustments: detail.providerAdjustments.map((adjustment) =>
            typeof adjustment.amount === "number" ? adjustment.amount : null,
          ),
          reportedPayment: detail.payment.amount ?? Number.NaN,
        }),
        postingAuthorized: false,
      };
    },
    async candidates(actor, id, claimIndex) {
      if (!Number.isInteger(claimIndex) || claimIndex < 0)
        throw new ValidationError("The ERA claim index is invalid.", []);
      return withOrgContext(db, actor, async (tx) => {
        const [row] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1);
        if (!row) return null;
        const stage = row as StoredStage;
        if (
          stage.state !== "staged" ||
          stage.possibleDuplicateAdviceId ||
          stage.safeReasonCode === "EXACT_DUPLICATE_FROM_M25"
        )
          return { candidates: [], complete: true };
        const detail = projectClaimMdEraReviewItem(stage, cipher);
        const claim = detail.claims[claimIndex];
        if (!claim?.patientControlNumber) return { candidates: [], complete: true };
        const results = await loadHistoricalCandidates(
          tx as unknown as DbClient,
          actor,
          stage,
          claim.patientControlNumber,
          claim,
        );
        return { candidates: results.slice(0, 50), complete: results.length <= 50 };
      });
    },
    async recordMatchDecision(actor, id, claimIndex, input) {
      const reason = input.reason.trim();
      if (
        !Number.isInteger(claimIndex) ||
        claimIndex < 0 ||
        reason.length < 3 ||
        reason.length > 500 ||
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 0
      )
        throw new ValidationError(
          "A valid claim index, decision version and review reason are required.",
          [],
        );
      return withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1)
          .for("update");
        if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
        if (
          stage.state !== "staged" ||
          stage.possibleDuplicateAdviceId ||
          stage.safeReasonCode === "EXACT_DUPLICATE_FROM_M25"
        )
          throw new ChartWardenError(
            "INVALID_STATE",
            "this staged remittance is not eligible for a matching review decision",
            409,
          );
        const detail = projectClaimMdEraReviewItem(stage as StoredStage, cipher);
        const claim = detail.claims[claimIndex];
        const source = detail.claimOutcomes[claimIndex];
        if (
          !claim ||
          !source ||
          source.patientControlNumber !== claim.patientControlNumber ||
          source.transactionSetControlNumber !== detail.transactionSetControlNumber
        )
          throw new ChartWardenError(
            "MATCH_SOURCE_INVALID",
            "the remittance claim identity evidence is unavailable",
            409,
          );
        let chosenCandidate: HistoricalMatchCandidate | undefined;
        if (input.action === "confirm_identity") {
          if (source.outcome !== "verified" || typeof source.claimId !== "string")
            throw new ChartWardenError(
              "MATCH_REQUIRES_VERIFIED_SOURCE_IDENTITY",
              "the remittance claim does not have a unique verified original submission identity",
              409,
            );
        } else if (input.action === "confirm_candidate") {
          if (!input.evidenceId)
            throw new ValidationError("Select a historical submission candidate.", []);
          const candidates = await loadHistoricalCandidates(
            tx as unknown as DbClient,
            actor,
            stage as StoredStage,
            claim.patientControlNumber ?? "",
            claim,
          );
          chosenCandidate = candidates.find(
            (candidate) => candidate.evidenceId === input.evidenceId,
          );
          if (!chosenCandidate?.selectable)
            throw new ChartWardenError(
              "MATCH_CANDIDATE_UNSUPPORTED",
              "the selected historical attempt lacks sufficient matching evidence",
              409,
            );
          if (source.outcome === "conflict")
            throw new ChartWardenError(
              "MATCH_IDENTITY_CONFLICT",
              "a known source identity conflict cannot be overridden",
              409,
            );
        }
        const sourceDigest = matchSourceDigest(
          stage.original835Digest,
          stage.resolutionVersion,
          claimIndex,
          claim,
          source,
        );
        const serializationKey = `${actor.organizationId}:${id}:${detail.transactionSetControlNumber}:${claimIndex}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${serializationKey}, 25))`,
        );
        const existing = await tx
          .select({
            version: schema.claimMdEraMatchDecision.decisionVersion,
            sourceDigest: schema.claimMdEraMatchDecision.sourceDigest,
            outcome: schema.claimMdEraMatchDecision.outcome,
            reason: schema.claimMdEraMatchDecision.reason,
            actorMembershipId: schema.claimMdEraMatchDecision.actorMembershipId,
            evidence: schema.claimMdEraMatchDecision.evidence,
          })
          .from(schema.claimMdEraMatchDecision)
          .where(
            and(
              eq(schema.claimMdEraMatchDecision.stageId, id),
              eq(
                schema.claimMdEraMatchDecision.transactionSetControlNumber,
                detail.transactionSetControlNumber,
              ),
              eq(schema.claimMdEraMatchDecision.claimIndex, claimIndex),
              eq(schema.claimMdEraMatchDecision.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.claimMdEraMatchDecision.decisionVersion))
          .limit(1);
        const current = existing[0];
        const version = current?.version ?? 0;
        if (input.action === "clear" && (!current || current.outcome !== "confirmed"))
          throw new ChartWardenError(
            "MATCH_CLEAR_NOT_ALLOWED",
            "there is no confirmed reviewer association to supersede",
            409,
          );
        if (version !== input.expectedVersion) {
          const sameRequest = isIdempotentMatchDecisionRetry({
            currentVersion: current?.version ?? null,
            expectedVersion: input.expectedVersion,
            currentOutcome:
              current?.outcome === "confirmed" || current?.outcome === "cleared"
                ? current.outcome
                : null,
            requestedOutcome: input.action === "clear" ? "cleared" : "confirmed",
            currentReason: current?.reason ?? null,
            requestedReason: reason,
            currentActorMembershipId: current?.actorMembershipId ?? null,
            actorMembershipId: actor.membershipId,
            currentSourceDigest: current?.sourceDigest ?? null,
            sourceDigest,
          });
          const sameCandidate =
            input.action !== "confirm_candidate" ||
            (record(current?.evidence) && current.evidence.evidenceId === input.evidenceId);
          if (sameRequest && sameCandidate && current)
            return {
              decisionVersion: current.version,
              decision:
                current.outcome === "cleared"
                  ? ("cleared" as const)
                  : record(current.evidence) && current.evidence.humanSelected === true
                    ? ("human_confirmed_candidate" as const)
                    : ("confirmed_identity" as const),
            };
          throw new ChartWardenError(
            "VERSION_CONFLICT",
            "the matching decision changed; reload before continuing",
            409,
          );
        }
        if (current && current.sourceDigest !== sourceDigest)
          throw new ChartWardenError(
            "MATCH_SOURCE_STALE",
            "the remittance source identity changed; review the current evidence",
            409,
          );
        await tx.insert(schema.claimMdEraMatchDecision).values({
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          stageId: stage.id,
          transactionSetControlNumber: detail.transactionSetControlNumber,
          claimIndex,
          decisionVersion: version + 1,
          outcome: input.action === "clear" ? "cleared" : "confirmed",
          claimId:
            input.action === "clear" ? null : (chosenCandidate?.claimId ?? String(source.claimId)),
          sourceDigest,
          evidence: chosenCandidate
            ? {
                sourceOutcome: source.outcome,
                humanSelected: true,
                billingModule: chosenCandidate.module,
                evidenceId: chosenCandidate.evidenceId,
                submissionId: chosenCandidate.submissionId,
                attemptKey: chosenCandidate.attemptKey,
                accountReference: chosenCandidate.accountReference,
                usage: chosenCandidate.usage,
                supportingEvidence: chosenCandidate.supportingEvidence,
              }
            : { sourceOutcome: source.outcome, billingModule: source.module },
          reason,
          actorMembershipId: actor.membershipId,
        });
        return {
          decisionVersion: version + 1,
          decision:
            input.action === "clear"
              ? "cleared"
              : chosenCandidate
                ? "human_confirmed_candidate"
                : "confirmed_identity",
        };
      });
    },
    async recordFinancialReviewDecision(actor, id, input) {
      const reason = input.reason.trim();
      const idempotencyKey = input.idempotencyKey.trim();
      if (
        reason.length < 3 ||
        reason.length > 1000 ||
        idempotencyKey.length < 8 ||
        idempotencyKey.length > 200 ||
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        !Number.isInteger(input.itemIndex) ||
        (input.itemType === "era" ? input.itemIndex !== -1 : input.itemIndex < 0)
      ) {
        throw new ValidationError(
          "A valid review item, version, idempotency key and reason are required.",
          [],
        );
      }
      return withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1)
          .for("update");
        if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
        const detail = projectClaimMdEraReviewItem(stage as StoredStage, cipher);
        if (input.itemType === "claim" && !detail.claims[input.itemIndex])
          throw new ValidationError("The selected ERA claim does not exist.", []);
        const matchingRows = await tx
          .select({
            transactionSetControlNumber: schema.claimMdEraMatchDecision.transactionSetControlNumber,
            claimIndex: schema.claimMdEraMatchDecision.claimIndex,
            decisionVersion: schema.claimMdEraMatchDecision.decisionVersion,
            sourceDigest: schema.claimMdEraMatchDecision.sourceDigest,
            outcome: schema.claimMdEraMatchDecision.outcome,
            claimId: schema.claimMdEraMatchDecision.claimId,
            evidence: schema.claimMdEraMatchDecision.evidence,
          })
          .from(schema.claimMdEraMatchDecision)
          .where(
            and(
              eq(schema.claimMdEraMatchDecision.stageId, id),
              eq(schema.claimMdEraMatchDecision.organizationId, actor.organizationId),
            ),
          )
          .orderBy(
            desc(schema.claimMdEraMatchDecision.createdAt),
            desc(schema.claimMdEraMatchDecision.id),
          );
        const source = financialReviewSourceDigest(
          stage.original835Digest,
          stage.resolutionVersion,
          input.itemType,
          input.itemIndex,
          detail,
          matchDecisionRevisionDigest(matchingRows),
        );
        const idempotencyKeyHash = createHash("sha256").update(idempotencyKey).digest("hex");
        const serializationKey = `${actor.organizationId}:financial-review-idempotency:${idempotencyKeyHash}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${serializationKey}, 33))`,
        );
        const duplicate = await tx
          .select()
          .from(schema.claimMdEraFinancialReviewDecision)
          .where(
            and(
              eq(schema.claimMdEraFinancialReviewDecision.organizationId, actor.organizationId),
              eq(schema.claimMdEraFinancialReviewDecision.idempotencyKeyHash, idempotencyKeyHash),
            ),
          )
          .limit(1);
        if (duplicate[0]) {
          const prior = duplicate[0];
          if (
            prior.stageId === id &&
            prior.itemType === input.itemType &&
            prior.itemIndex === input.itemIndex &&
            prior.disposition === input.disposition &&
            prior.reason === reason &&
            prior.actorMembershipId === actor.membershipId &&
            prior.sourceDigest === source &&
            prior.decisionVersion === input.expectedVersion + 1
          ) {
            return {
              id: prior.id,
              itemType: prior.itemType,
              itemIndex: prior.itemIndex,
              decisionVersion: prior.decisionVersion,
              disposition: prior.disposition,
            };
          }
          throw new ChartWardenError(
            "IDEMPOTENCY_CONFLICT",
            "this review action identifier was already used for a different decision",
            409,
          );
        }
        const priorRows = await tx
          .select()
          .from(schema.claimMdEraFinancialReviewDecision)
          .where(
            and(
              eq(schema.claimMdEraFinancialReviewDecision.stageId, id),
              eq(schema.claimMdEraFinancialReviewDecision.organizationId, actor.organizationId),
              eq(schema.claimMdEraFinancialReviewDecision.itemType, input.itemType),
              eq(schema.claimMdEraFinancialReviewDecision.itemIndex, input.itemIndex),
            ),
          )
          .orderBy(desc(schema.claimMdEraFinancialReviewDecision.decisionVersion))
          .limit(1);
        const current = priorRows[0];
        const version = current?.decisionVersion ?? 0;
        if (version !== input.expectedVersion)
          throw new ChartWardenError(
            "VERSION_CONFLICT",
            "the financial review changed; reload before recording a decision",
            409,
          );
        if (input.disposition === "completed") {
          if (
            input.itemType !== "era" ||
            !detail.reconciliationEligible ||
            detail.duplicateClassification !== "none"
          )
            throw new ChartWardenError(
              "FINANCIAL_REVIEW_BLOCKED",
              "this ERA cannot be marked reviewed because its staged source is held or duplicated",
              409,
            );
          const latestMatches = new Map<string, (typeof matchingRows)[number]>();
          for (const decision of matchingRows) {
            const key = `${decision.transactionSetControlNumber}:${decision.claimIndex}`;
            if (!latestMatches.has(key)) latestMatches.set(key, decision);
          }
          const financialIdentities = detail.claims.map((claim, claimIndex) => {
            const sourceIdentity = detail.claimOutcomes[claimIndex];
            const classified = classifyEraClaimIdentity({
              outcome: sourceIdentity?.outcome,
              claimId: sourceIdentity?.claimId,
              patientControlNumber: sourceIdentity?.patientControlNumber,
              expectedPatientControlNumber: claim.patientControlNumber,
              transactionSetControlNumber: sourceIdentity?.transactionSetControlNumber,
              expectedTransactionSetControlNumber: detail.transactionSetControlNumber,
            });
            const decision = latestMatches.get(
              `${detail.transactionSetControlNumber}:${claimIndex}`,
            );
            const digest = matchSourceDigest(
              stage.original835Digest,
              stage.resolutionVersion,
              claimIndex,
              claim,
              sourceIdentity,
            );
            const manuallyConfirmed =
              decision?.outcome === "confirmed" &&
              decision.sourceDigest === digest &&
              record(decision.evidence) &&
              decision.evidence.humanSelected === true;
            return classified === "conflict"
              ? "conflict"
              : manuallyConfirmed
                ? "verified"
                : classified;
          });
          const review = projectEraFinancialReview({
            stageState: detail.state,
            duplicateClassification: detail.duplicateClassification,
            reportedPayment: detail.payment.amount,
            claims: detail.claims,
            providerAdjustments: detail.providerAdjustments,
            identityOutcomes: financialIdentities,
          });
          if (!review.canCompleteNonpostingReview)
            throw new ChartWardenError(
              "FINANCIAL_REVIEW_BLOCKED",
              "resolve blocking financial review exceptions before completing this nonposting review",
              409,
            );
        }
        if (
          input.disposition === "reopened" &&
          current?.disposition !== "completed" &&
          current?.disposition !== "reviewed"
        )
          throw new ChartWardenError(
            "FINANCIAL_REVIEW_TRANSITION_INVALID",
            "only a completed or reviewed item can be reopened",
            409,
          );
        const [inserted] = await tx
          .insert(schema.claimMdEraFinancialReviewDecision)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: stage.providerEntityId,
            stageId: id,
            itemType: input.itemType,
            itemIndex: input.itemIndex,
            decisionVersion: version + 1,
            disposition: input.disposition,
            sourceDigest: source,
            idempotencyKeyHash,
            reason,
            actorMembershipId: actor.membershipId,
          })
          .returning({ id: schema.claimMdEraFinancialReviewDecision.id });
        return {
          id: inserted!.id,
          itemType: input.itemType,
          itemIndex: input.itemIndex,
          decisionVersion: version + 1,
          disposition: input.disposition,
        };
      });
    },
    async postingPlan(actor, id) {
      return withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1);
        if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
        const facts = await derivePostingFacts(tx as unknown as M25Tx, actor, stage as StoredStage);
        const planDocument = {
          schema: "claimmd-controlled-posting-plan-v1",
          stageId: id,
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          sourceRevisions: facts.sourceRevisions,
          payerId: facts.candidate?.payerId ?? null,
          claimId: facts.claimId,
          paymentCents: facts.paymentCents,
          effect:
            facts.paymentCents === null
              ? null
              : {
                  kind: "claim_payment",
                  amountCents: facts.paymentCents,
                  allocation: "claim_level",
                },
          blockers: facts.blockers,
          accountingRule: "m25-claimmd-single-fully-paid-claim-v1",
        };
        const planDigest = createHash("sha256")
          .update(JSON.stringify(planDocument), "utf8")
          .digest("hex");
        await tx
          .insert(schema.claimMdEraPostingPlan)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: stage.providerEntityId,
            stageId: id,
            planDigest,
            plan: planDocument,
            createdByMembershipId: actor.membershipId,
          })
          .onConflictDoNothing();
        const [stored] = await tx
          .select()
          .from(schema.claimMdEraPostingPlan)
          .where(
            and(
              eq(schema.claimMdEraPostingPlan.stageId, id),
              eq(schema.claimMdEraPostingPlan.planDigest, planDigest),
              eq(schema.claimMdEraPostingPlan.organizationId, actor.organizationId),
            ),
          )
          .limit(1);
        if (!stored)
          throw new ChartWardenError(
            "POSTING_PLAN_PERSISTENCE_FAILED",
            "the posting plan could not be saved",
            500,
          );
        const events = await tx
          .select()
          .from(schema.claimMdEraPostingEvent)
          .where(
            and(
              eq(schema.claimMdEraPostingEvent.planId, stored.id),
              eq(schema.claimMdEraPostingEvent.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.claimMdEraPostingEvent.createdAt));
        const posted = events.find((event) => event.eventType === "posted");
        const approved = events.some((event) => event.eventType === "approved");
        return {
          planId: stored.id,
          planDigest,
          stageId: id,
          providerEntityId: stage.providerEntityId,
          payer: facts.detail.payer.name,
          paymentCents: facts.paymentCents,
          claimId: facts.claimId,
          eligible: facts.blockers.length === 0,
          status: posted
            ? ("already_posted" as const)
            : facts.blockers.length
              ? ("blocked" as const)
              : ("eligible" as const),
          blockers: facts.blockers,
          featureEnabled: controlledPosting?.enabled === true,
          approval: posted
            ? ("posted" as const)
            : approved
              ? ("approved" as const)
              : ("not_approved" as const),
          createdAt: stored.createdAt.toISOString(),
        };
      });
    },
    async approvePostingPlan(actor, id, input) {
      const reason = input.reason.trim();
      if (
        reason.length < 3 ||
        reason.length > 500 ||
        input.idempotencyKey.length < 8 ||
        input.idempotencyKey.length > 128
      )
        throw new ValidationError("A reason and valid idempotency key are required.", []);
      const current = await service.postingPlan(actor as M25WriteActor, id);
      if (
        current.planId !== input.planId ||
        current.planDigest !== input.planDigest ||
        !current.eligible
      )
        throw new ChartWardenError(
          "POSTING_PLAN_STALE_OR_BLOCKED",
          "refresh the plan and resolve its blockers before approval",
          409,
        );
      return withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1)
          .for("update");
        if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
        const facts = await derivePostingFacts(tx as unknown as M25Tx, actor, stage as StoredStage);
        const digest = createHash("sha256")
          .update(
            JSON.stringify({
              schema: "claimmd-controlled-posting-plan-v1",
              stageId: id,
              organizationId: actor.organizationId,
              providerEntityId: stage.providerEntityId,
              sourceRevisions: facts.sourceRevisions,
              payerId: facts.candidate?.payerId ?? null,
              claimId: facts.claimId,
              paymentCents: facts.paymentCents,
              effect:
                facts.paymentCents === null
                  ? null
                  : {
                      kind: "claim_payment",
                      amountCents: facts.paymentCents,
                      allocation: "claim_level",
                    },
              blockers: facts.blockers,
              accountingRule: "m25-claimmd-single-fully-paid-claim-v1",
            }),
            "utf8",
          )
          .digest("hex");
        if (digest !== input.planDigest || facts.blockers.length)
          throw new ChartWardenError(
            "POSTING_PLAN_STALE_OR_BLOCKED",
            "the source or review changed; refresh and review the plan again",
            409,
          );
        const [plan] = await tx
          .select()
          .from(schema.claimMdEraPostingPlan)
          .where(
            and(
              eq(schema.claimMdEraPostingPlan.id, input.planId),
              eq(schema.claimMdEraPostingPlan.stageId, id),
              eq(schema.claimMdEraPostingPlan.organizationId, actor.organizationId),
              eq(schema.claimMdEraPostingPlan.planDigest, digest),
            ),
          )
          .limit(1);
        if (!plan) throw new NotFoundError("Claim.MD posting plan", input.planId);
        if (plan.createdByMembershipId === actor.membershipId)
          throw new ChartWardenError(
            "POSTING_SEPARATION_OF_DUTIES",
            "the plan creator cannot approve the same posting plan",
            403,
          );
        const idemHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:posting-approval:${idemHash}`}, 44))`,
        );
        const prior = await tx
          .select()
          .from(schema.claimMdEraPostingEvent)
          .where(
            and(
              eq(schema.claimMdEraPostingEvent.organizationId, actor.organizationId),
              eq(schema.claimMdEraPostingEvent.idempotencyKeyHash, idemHash),
            ),
          )
          .limit(1);
        if (prior[0]) {
          if (
            prior[0].planId === plan.id &&
            prior[0].eventType === "approved" &&
            prior[0].actorMembershipId === actor.membershipId &&
            prior[0].planDigest === digest
          )
            return { planId: plan.id, outcome: "already_approved" as const };
          throw new ChartWardenError(
            "IDEMPOTENCY_CONFLICT",
            "this idempotency key was used for another action",
            409,
          );
        }
        const existing = await tx
          .select()
          .from(schema.claimMdEraPostingEvent)
          .where(
            and(
              eq(schema.claimMdEraPostingEvent.planId, plan.id),
              eq(schema.claimMdEraPostingEvent.eventType, "approved"),
            ),
          )
          .limit(1);
        if (existing[0])
          throw new ChartWardenError(
            "POSTING_PLAN_ALREADY_APPROVED",
            "this exact plan already has approval",
            409,
          );
        await tx.insert(schema.claimMdEraPostingEvent).values({
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          stageId: id,
          planId: plan.id,
          eventType: "approved",
          planDigest: digest,
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: idemHash,
          reason,
        });
        return { planId: plan.id, outcome: "approved" as const };
      });
    },
    async executePostingPlan(actor, id, input) {
      if (!controlledPosting?.enabled || !controlledPort)
        throw new ChartWardenError(
          "CLAIMMD_POSTING_DISABLED",
          "controlled Claim.MD ERA posting is disabled",
          409,
        );
      const reason = input.reason.trim();
      if (
        reason.length < 3 ||
        reason.length > 500 ||
        input.idempotencyKey.length < 8 ||
        input.idempotencyKey.length > 128
      )
        throw new ValidationError("A reason and valid idempotency key are required.", []);
      const result = await withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select()
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, id),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1)
          .for("update");
        if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
        const [plan] = await tx
          .select()
          .from(schema.claimMdEraPostingPlan)
          .where(
            and(
              eq(schema.claimMdEraPostingPlan.id, input.planId),
              eq(schema.claimMdEraPostingPlan.stageId, id),
              eq(schema.claimMdEraPostingPlan.organizationId, actor.organizationId),
            ),
          )
          .limit(1);
        if (!plan || plan.planDigest !== input.planDigest)
          throw new NotFoundError("Claim.MD posting plan", input.planId);
        const events = await tx
          .select()
          .from(schema.claimMdEraPostingEvent)
          .where(
            and(
              eq(schema.claimMdEraPostingEvent.planId, plan.id),
              eq(schema.claimMdEraPostingEvent.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.claimMdEraPostingEvent.createdAt));
        const posted = events.find((event) => event.eventType === "posted");
        const paymentCents = (plan.plan as JsonRecord).paymentCents;
        if (typeof paymentCents !== "number" || !Number.isSafeInteger(paymentCents))
          throw new ChartWardenError(
            "POSTING_PLAN_INVALID",
            "the stored posting plan is invalid",
            409,
          );
        if (posted)
          return {
            planId: plan.id,
            outcome: "already_posted" as const,
            adviceId: posted.adviceId,
            remittanceLineId: posted.remittanceLineId,
            paymentCents,
          };
        const approval = events.find(
          (event) => event.eventType === "approved" && event.planDigest === plan.planDigest,
        );
        if (!approval)
          throw new ChartWardenError(
            "POSTING_APPROVAL_REQUIRED",
            "this exact posting plan requires separate approval",
            403,
          );
        if (approval.actorMembershipId === actor.membershipId)
          throw new ChartWardenError(
            "POSTING_SEPARATION_OF_DUTIES",
            "the approver cannot execute the same posting plan",
            403,
          );
        const facts = await derivePostingFacts(tx as unknown as M25Tx, actor, stage as StoredStage);
        const currentDocument = {
          schema: "claimmd-controlled-posting-plan-v1",
          stageId: id,
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          sourceRevisions: facts.sourceRevisions,
          payerId: facts.candidate?.payerId ?? null,
          claimId: facts.claimId,
          paymentCents: facts.paymentCents,
          effect:
            facts.paymentCents === null
              ? null
              : {
                  kind: "claim_payment",
                  amountCents: facts.paymentCents,
                  allocation: "claim_level",
                },
          blockers: facts.blockers,
          accountingRule: "m25-claimmd-single-fully-paid-claim-v1",
        };
        const currentDigest = createHash("sha256")
          .update(JSON.stringify(currentDocument), "utf8")
          .digest("hex");
        if (currentDigest !== plan.planDigest || facts.blockers.length)
          throw new ChartWardenError(
            "POSTING_PLAN_STALE_OR_BLOCKED",
            "source, matching or financial review changed after approval",
            409,
          );
        if (
          !facts.parsed ||
          !facts.candidate ||
          !facts.claimId ||
          !facts.stage.sourceFileDigest ||
          !facts.evidence ||
          facts.evidenceVersion < 1
        )
          throw new ChartWardenError(
            "POSTING_SOURCE_INVALID",
            "the verified staged source is incomplete",
            409,
          );
        const parsed = facts.parsed;
        const sourceFileSha256 = facts.stage.sourceFileDigest;
        if (
          !parsed.interchangeControlNumber ||
          !parsed.transactionSetControlNumber ||
          !parsed.checkOrEftTraceNumber ||
          !sourceFileSha256 ||
          !stage.contentDigest
        )
          throw new ChartWardenError(
            "POSTING_SOURCE_INVALID",
            "the staged source lacks required payment identity",
            409,
          );
        const [advice] = await tx
          .insert(schema.remittanceAdvice)
          .values({
            organizationId: actor.organizationId,
            providerEntityId: stage.providerEntityId,
            payerId: facts.candidate.payerId,
            payerKind: "commercial",
            interchangeControlNumber: parsed.interchangeControlNumber,
            transactionSetControlNumber: parsed.transactionSetControlNumber,
            checkOrEftTraceNumber: parsed.checkOrEftTraceNumber,
            paymentMethod: parsed.paymentMethod as "eft" | "check",
            totalPaymentAmount: (paymentCents / 100).toFixed(2),
            plbTotalAmount: "0.00",
            contentDigest: stage.contentDigest,
            productionDate: new Date(parsed.productionDate),
            receivedAt: new Date(),
            minioObjectKey: `claimmd-stage/${stage.id}/${sourceFileSha256}`,
            fileSha256: sourceFileSha256,
            parseStatus: "queued",
            parseSummary: {
              source: "claimmd_stage",
              stageId: stage.id,
              sourceDigest: stage.original835Digest,
              planId: plan.id,
            },
          })
          .returning({
            id: schema.remittanceAdvice.id,
            receivedAt: schema.remittanceAdvice.receivedAt,
          });
        if (!advice)
          throw new ChartWardenError(
            "M25_ADVICE_ENVELOPE_FAILED",
            "the M25 source envelope could not be created",
            500,
          );
        const postedResult = await controlledPort.postValidatedClaimInTransaction(
          tx as unknown as M25Tx,
          { organizationId: actor.organizationId },
          {
            adviceId: advice.id,
            sourceFileSha256,
            parsed,
            association: {
              organizationId: actor.organizationId,
              providerEntityId: stage.providerEntityId,
              claimId: facts.claimId,
              evidenceId: facts.evidence,
              evidenceVersion: facts.evidenceVersion,
            } satisfies M25ValidatedClaimAssociation,
          },
        );
        if (postedResult.outcome !== "posted" || !postedResult.remittanceLineId)
          throw new ChartWardenError(
            "M25_POSTING_NOT_COMMITTED",
            "the M25 posting core did not return a committed remittance line",
            409,
          );
        const idemHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:posting-execution:${idemHash}`}, 45))`,
        );
        await tx.insert(schema.claimMdEraPostingEvent).values({
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          stageId: id,
          planId: plan.id,
          eventType: "posted",
          planDigest: plan.planDigest,
          actorMembershipId: actor.membershipId,
          idempotencyKeyHash: idemHash,
          adviceId: advice.id,
          remittanceLineId: postedResult.remittanceLineId,
          reason,
        });
        return {
          planId: plan.id,
          outcome: "posted" as const,
          adviceId: advice.id,
          remittanceLineId: postedResult.remittanceLineId,
          paymentCents,
        };
      });
      return result;
    },
    async postingHistory(actor, id) {
      const stage = await service.get(actor, id);
      if (!stage) throw new NotFoundError("Claim.MD staged remittance", id);
      return withOrgContext(db, actor, async (tx) => {
        const rows = await tx
          .select({
            eventType: schema.claimMdEraPostingEvent.eventType,
            planId: schema.claimMdEraPostingEvent.planId,
            createdAt: schema.claimMdEraPostingEvent.createdAt,
            reason: schema.claimMdEraPostingEvent.reason,
            adviceId: schema.claimMdEraPostingEvent.adviceId,
            remittanceLineId: schema.claimMdEraPostingEvent.remittanceLineId,
          })
          .from(schema.claimMdEraPostingEvent)
          .where(
            and(
              eq(schema.claimMdEraPostingEvent.stageId, id),
              eq(schema.claimMdEraPostingEvent.organizationId, actor.organizationId),
            ),
          )
          .orderBy(desc(schema.claimMdEraPostingEvent.createdAt));
        return rows.map((row) => ({
          eventType: row.eventType,
          planId: row.planId,
          occurredAt: row.createdAt.toISOString(),
          reason: row.reason,
          adviceId: row.adviceId,
          remittanceLineId: row.remittanceLineId,
        }));
      });
    },
  };
  return service;
}

function financialReviewSourceDigest(
  originalDigest: string,
  resolutionVersion: number | null,
  itemType: "era" | "claim",
  itemIndex: number,
  detail: ClaimMdEraReviewItem,
  matchingRevision: string,
): string {
  const projection = itemType === "era" ? detail : (detail.claims[itemIndex] ?? null);
  const canonical = JSON.stringify({
    schema: "claimmd-era-fin-review-v1",
    originalDigest,
    resolutionVersion,
    itemType,
    itemIndex,
    projection,
    matchingRevision,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function matchDecisionRevisionDigest(
  decisions: readonly {
    readonly transactionSetControlNumber: string;
    readonly claimIndex: number;
    readonly decisionVersion: number;
    readonly sourceDigest: string;
    readonly outcome: string;
    readonly claimId: string | null;
    readonly evidence: unknown;
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        decisions.map((decision) => ({
          transactionSetControlNumber: decision.transactionSetControlNumber,
          claimIndex: decision.claimIndex,
          decisionVersion: decision.decisionVersion,
          sourceDigest: decision.sourceDigest,
          outcome: decision.outcome,
          claimId: decision.claimId,
          evidence: decision.evidence,
        })),
      ),
    )
    .digest("hex");
}

function decimalDollarsToCents(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(cents)) return null;
  return match[1] ? -cents : cents;
}

function matchSourceDigest(
  originalDigest: string,
  resolutionVersion: number | null,
  claimIndex: number,
  claim: {
    readonly patientControlNumber: string | null;
    readonly payerIcn: string | null;
    readonly totalCharge: number | null;
    readonly totalPayment: number | null;
  },
  source: ClaimMdEraClaimOutcome | undefined,
): string {
  const canonical = JSON.stringify({
    schema: "claimmd-era-match-source-v1",
    originalDigest,
    resolutionVersion,
    claimIndex,
    patientControlNumber: claim.patientControlNumber ?? null,
    payerIcn: claim.payerIcn ?? null,
    totalCharge: claim.totalCharge ?? null,
    totalPayment: claim.totalPayment ?? null,
    outcome: source?.outcome ?? null,
    claimId: source?.claimId ?? null,
    module: source?.module ?? null,
    transactionSetControlNumber: source?.transactionSetControlNumber ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function reviewDateStart(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function historyReference(row: StoredStage): ClaimMdEraHistoryStageReference {
  return {
    id: row.id,
    organizationId: row.organizationId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    sourceInboxId: row.sourceInboxId,
    accountReference: row.accountReference,
    usage: row.usage,
    eraId: row.eraId,
    original835Digest: row.original835Digest,
    resolutionId: row.resolutionId,
    resolutionVersion: row.resolutionVersion,
    createdAt: row.createdAt,
    state: row.state,
    safeReasonCode: row.safeReasonCode,
  };
}
