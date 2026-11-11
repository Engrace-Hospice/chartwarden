// apps/backend/src/modules/25-remittance/routes/read-service.ts — the M25 READ route-service CONTRACT
// (§4.1 GET surface) + the narrowed read DTOs the route plugins return. The Drizzle backend
// (./read-service-drizzle) implements this. DTO discipline: audit-denylisted / free-text columns
// (remark.free_text, denial.override_payload, appeal.appeal_narrative, assignment.reason) are NEVER
// projected onto a list/detail view; the taxonomy plain-language is the M38-catalog-fallback merge.
import type { AgingBucketLabel, DenialPayerKind } from "../domain";
import type { M25ReadActor } from "./actor";

/** A page of results plus the next opaque cursor (null at the end). */
export interface CursorPage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface RemittanceAdviceSummary {
  readonly id: string;
  readonly providerEntityId: string;
  readonly payerId: string;
  readonly payerKind: string;
  readonly paymentMethod: string;
  readonly totalPaymentAmount: string;
  readonly parseStatus: string;
  readonly receivedAt: string;
}

export interface RemittanceLineSummary {
  readonly id: string;
  readonly remittanceAdviceId: string;
  readonly claimId: string | null;
  readonly clp02StatusCode: number;
  readonly clp03TotalChargeAmount: string;
  readonly clp04TotalPaymentAmount: string;
  readonly clp05PatientResponsibilityAmount: string;
  readonly matchState: string;
  readonly matchStrategy: string | null;
  readonly matchConfidence: number | null;
  readonly receivedAt: string;
}

export interface DenialWorklistItem {
  /** Payer of the denied remittance (`unknown` when no advice is linked: 277CA / EVV-sourced). */
  readonly payerKind: DenialPayerKind;
  readonly id: string;
  readonly providerEntityId: string;
  readonly claimId: string | null;
  readonly carcCode: string;
  readonly rarcCode: string | null;
  readonly category: string;
  readonly source: string;
  readonly state: string;
  readonly assigneeMembershipId: string | null;
  readonly openedAt: string;
  readonly agingBucketDays: number;
  readonly agingBucketLabel: AgingBucketLabel;
  readonly dollarValue: string;
  readonly taxonomyStatus: string;
  /** Row version — the `If-Match` value the denial PATCH/close/reopen transitions require (§2.5). */
  readonly version: number;
}

export interface AppealSummary {
  readonly id: string;
  readonly denialCaseId: string;
  readonly claimId: string;
  readonly tier: string;
  readonly state: string;
  readonly decisionOutcome: string | null;
  readonly tierDeadlineAt: string;
  /** How the deadline was reached; all null on rows created before CMS-correct deadlines. */
  readonly noticeDatedOn: string | null;
  readonly presumedReceiptOn: string | null;
  readonly windowDays: number | null;
  readonly lastFilingDay: string | null;
  /** True on the ALJ case an escalation opened: filed by the QIC's forwarding, so it has no filing deadline. */
  readonly filedByEscalation: boolean;
  readonly version: number;
}

export interface AppealEventView {
  readonly id: string;
  readonly eventKind: string;
  readonly occurredAt: string;
}

export interface AppealDetail extends AppealSummary {
  readonly appealPacketDocumentId: string | null;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly events: AppealEventView[];
}

/** The merged taxonomy view: the M38 platform floor (category + default plain-language) + the tenant overlay. */
export interface TaxonomyMergedView {
  readonly carcCode: string;
  readonly rarcCode: string | null;
  readonly category: string;
  readonly plainLanguage: string;
  readonly suggestedAction: string | null;
  readonly ownerRole: string | null;
  readonly severity: string | null;
  readonly hasOverlay: boolean;
  readonly overlayVersion: number | null;
}

export interface PrLedgerRow {
  readonly id: string;
  readonly patientId: string;
  readonly prAmount: string;
  readonly status: string;
  readonly recordedAt: string;
}

export interface DenialMetricsView {
  readonly agingBucketCounts: Record<AgingBucketLabel, number>;
  readonly openCount: number;
  readonly totalDollarOpen: string;
}

/** Read-only M25 activity totals. Amounts are integer-cent strings to retain NUMERIC precision. */
export interface RevenueCycleM25Summary {
  readonly dateBasis: "era_received_at_utc";
  readonly fromDate: string | null;
  readonly toDate: string | null;
  readonly providerEntityId: string | null;
  readonly completeness: "exact_for_m25_remittance_advice";
  readonly receivedAdviceCount: number;
  readonly reportedAdviceCount: number;
  /** BPR02 from parse-complete M25 advice envelopes; includes envelope-level PLB effect. */
  readonly reportedEraPaymentCents: string;
  readonly reportedClaimPaymentCents: string;
  /** Sum of CLP04 from fully posted M25 advice only. Partial-post envelopes are excluded. */
  readonly fullyPostedClaimPaymentCents: string;
  /** Actual positive claim-level M25 effects on posted lines, including posted lines in partial_posted advice. */
  readonly postedClaimPaymentCents: string;
  readonly fullyPostedAdviceCount: number;
  readonly partialPostedAdviceCount: number;
  readonly reportedAdjustmentsByGroup: Readonly<Record<string, string>>;
  /** Provider-level PLB reported by source, not allocated to claims. */
  readonly reportedPlbCents: string;
  readonly unmatchedLineCount: number;
  readonly latestReceivedAt: string | null;
  readonly claimMdStagesIncluded: false;
  readonly authoritativeAr: {
    readonly status: "unavailable";
    readonly reasonCode: "NO_CANONICAL_RECEIVABLE_LEDGER";
  };
}

/** Tenant-safe Claim.MD staging health. It intentionally contains no account cursor or inbox facts. */
export interface ClaimMdTenantOperationalHealth {
  readonly scope: "tenant_attributed_m25_stages";
  readonly providerEntityId: string;
  readonly completeness: "exact_for_authorized_provider_stages";
  readonly stageCount: number;
  readonly states: Readonly<Record<string, number>>;
  readonly exceptionCount: number;
  readonly oldestExceptionAt: string | null;
  readonly latestStageAt: string | null;
  readonly centralCapture: {
    readonly status: "restricted";
    readonly reasonCode: "CENTRAL_ACCOUNT_METADATA_NOT_TENANT_VISIBLE";
  };
  readonly requestBudget: {
    readonly status: "unavailable";
    readonly reasonCode: "NO_DURABLE_REQUEST_BUDGET_OBSERVATION";
  };
  readonly sampledAt: string;
}

/** M25-owned payment facts for one exact, source-authorized commercial claim identity. */
export interface M25CommercialClaimPaymentFacts {
  readonly items: readonly {
    readonly remittanceAdviceId: string;
    readonly remittanceLineId: string;
    readonly payerReportedPaymentCents: string;
    readonly m25PostedPaymentCents: string | null;
    readonly adviceStatus: "parsed" | "posted" | "partial_posted";
    readonly lineMatchState: string;
    readonly receivedAt: string;
  }[];
  readonly payerReportedPaymentCents: string;
  readonly m25PostedPaymentCents: string;
  readonly completeness: "exact_for_matched_m25_remittance_lines";
  readonly historyRecordCount: number;
  readonly detailTruncated: boolean;
}

export interface DenialWorklistFilters {
  readonly providerEntityId?: string;
  readonly assigneeMembershipId?: string;
  readonly state?: string;
  readonly carcCode?: string;
  readonly minDollar?: number;
}

/** The READ surface every M25 GET route composes over. All reads are RLS-scoped to the actor's org. */
export interface M25ReadService {
  claimMdTenantOperationalHealth(
    actor: M25ReadActor,
    providerEntityId: string,
  ): Promise<ClaimMdTenantOperationalHealth>;
  revenueCycleSummary(
    actor: M25ReadActor,
    filters: { providerEntityId?: string; fromDate: string; toDate: string },
  ): Promise<RevenueCycleM25Summary>;
  /** Internal owner seam: caller must first authorize the commercial claim with M41. */
  commercialClaimPaymentFacts(
    actor: M25ReadActor,
    query: { claimId: string; providerEntityId: string; payerId: string },
  ): Promise<M25CommercialClaimPaymentFacts>;
  listAdvices(
    actor: M25ReadActor,
    filters: { providerEntityId?: string; parseStatus?: string },
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<RemittanceAdviceSummary>>;
  getAdvice(actor: M25ReadActor, id: string): Promise<RemittanceAdviceSummary | null>;
  listLines(
    actor: M25ReadActor,
    filters: { remittanceAdviceId?: string; matchState?: string },
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<RemittanceLineSummary>>;
  getLine(actor: M25ReadActor, id: string): Promise<RemittanceLineSummary | null>;
  listUnmatched(
    actor: M25ReadActor,
    providerEntityId: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<RemittanceLineSummary>>;
  denialWorklist(
    actor: M25ReadActor,
    filters: DenialWorklistFilters,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<DenialWorklistItem>>;
  getDenial(actor: M25ReadActor, id: string): Promise<DenialWorklistItem | null>;
  listAppeals(
    actor: M25ReadActor,
    filters: { state?: string; tier?: string },
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPage<AppealSummary>>;
  getAppeal(actor: M25ReadActor, id: string): Promise<AppealDetail | null>;
  taxonomyView(actor: M25ReadActor, carcCode: string): Promise<TaxonomyMergedView>;
  denialMetrics(actor: M25ReadActor): Promise<DenialMetricsView>;
  prLedger(actor: M25ReadActor, patientId: string | undefined): Promise<PrLedgerRow[]>;
}
