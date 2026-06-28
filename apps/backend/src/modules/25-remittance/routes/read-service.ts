// apps/backend/src/modules/25-remittance/routes/read-service.ts — the M25 READ route-service CONTRACT
// (§4.1 GET surface) + the narrowed read DTOs the route plugins return. The Drizzle backend
// (./read-service-drizzle) implements this. DTO discipline: audit-denylisted / free-text columns
// (remark.free_text, denial.override_payload, appeal.appeal_narrative, assignment.reason) are NEVER
// projected onto a list/detail view; the taxonomy plain-language is the M38-catalog-fallback merge.
import type { AgingBucketLabel } from "../domain";
import type { M25ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

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
}

export interface AppealSummary {
  readonly id: string;
  readonly denialCaseId: string;
  readonly claimId: string;
  readonly tier: string;
  readonly state: string;
  readonly decisionOutcome: string | null;
  readonly tierDeadlineAt: string;
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

export interface DenialWorklistFilters {
  readonly providerEntityId?: string;
  readonly assigneeMembershipId?: string;
  readonly state?: string;
  readonly carcCode?: string;
  readonly minDollar?: number;
}

/** The READ surface every M25 GET route composes over. All reads are RLS-scoped to the actor's org. */
export interface M25ReadService {
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
