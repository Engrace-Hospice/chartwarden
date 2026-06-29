// apps/backend/src/modules/24-billing-medicaid/routes/read-service.ts — the M24 READ service interface (the
// §4.1 GET surface). The Drizzle implementation lives in read-service-drizzle.ts; a route test may bind an
// in-memory stand-in. Money crosses as integer cents; the seam read-views (seam-impls.ts) convert to
// cents-as-string. No Recipient ID is ever returned (only the masked last-4 fact; D12 / §3.6).
import type { M24ReadActor } from "./actor";
import type { CursorPage } from "./concurrency";

export interface ClaimView {
  id: string;
  providerEntityId: string;
  patientId: string;
  admissionId: string;
  serviceState: string;
  kind: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  mcoId: string | null;
  medicareClaimId: string | null;
  rbArrangementId: string | null;
  medicaidClaimControlNumber: string;
  state: string;
  version: number;
  validationRunIdLatest: string | null;
  eligibilityOutcomeSnapshot: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimLineView {
  id: string;
  medicaidClaimId: string;
  lineNumber: number;
  serviceDate: string;
  revenueCode: string;
  qCode: string;
  levelOfCare: string;
  units: number;
  rateAtAssemblyCents: number;
  chargesCents: number;
  cobPaidCents: number | null;
  isRb: boolean;
  rbDayId: string | null;
}

export interface SubmissionView {
  id: string;
  medicaidClaimId: string;
  serviceState: string;
  channel: string;
  medicaidClaimControlNumber: string;
  attemptIndex: number;
  adapterVendor: string;
  adapterVersion: string;
  result: string;
  errorCode: string | null;
  nextPollAt: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface AcknowledgmentView {
  id: string;
  medicaidClaimId: string;
  medicaidSubmissionId: string;
  kind: string;
  outcome: string;
  payerClaimControlNumber: string | null;
  acceptedLineNumbers: unknown;
  rejectedLineNumbers: unknown;
  errorCodes: unknown;
  receivedAt: string;
}

export interface ValidationRunView {
  id: string;
  medicaidClaimId: string;
  ruleRegistryVersion: string;
  triggeredBy: string;
  claimStateAtTrigger: string;
  at: string;
  completedAt: string | null;
  totalResults: number;
  failedResults: number;
  warnedResults: number;
  results?: ValidationResultView[];
}

export interface ValidationResultView {
  id: string;
  medicaidValidationRunId: string;
  ruleKey: string;
  ruleVersion: number;
  outcome: string;
  remediationSummary: string | null;
  remediationFixAction: string | null;
  at: string;
}

export interface ValidationOverrideView {
  id: string;
  medicaidValidationResultId: string;
  medicaidClaimId: string;
  ruleKey: string;
  overrideRoleApplied: string;
  reason: string;
  actorMembershipId: string;
  at: string;
}

export interface RuleConfigView {
  ruleKey: string;
  enabled: boolean;
  isCustom: boolean;
  customSeverity: string | null;
  customOverrideRole: string | null;
  regulatoryRequired: boolean;
  parametersOverlay: unknown;
  version: number | null;
  /** Present only for platform-floor rules (the §4.6 registry projection). */
  platformDefault?: {
    title: string;
    category: string;
    severity: string;
    regulatoryRequired: boolean;
    applicableStates: readonly string[];
  };
}

export interface EligibilityCheckView {
  id: string;
  patientId: string;
  patientPayerId: string;
  serviceState: string;
  asOfServiceDate: string;
  outcome: string;
  mcoId: string | null;
  recipientIdMaskedAtCheck: string | null;
  checkedAt: string;
  staleAt: string;
  errorMessage: string | null;
}

export interface RbArrangementView {
  id: string;
  patientId: string;
  providerEntityId: string;
  nfFacilityMdmId: string;
  nfFacilityNameSnapshot: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  nfPerDiemRoutineCents: number;
  nfPerDiemRespCents: number;
  nfPerDiemGipCents: number;
  passThroughPct: number;
  retentionPct: number;
  state: string;
  version: number;
  createdAt: string;
  days?: RbDayView[];
}

export interface RbDayView {
  id: string;
  rbArrangementId: string;
  patientId: string;
  serviceDate: string;
  locOfDay: string;
  perDiemCentsSnapshot: number;
  status: string;
  exclusionReason: string | null;
  medicaidClaimLineId: string | null;
  version: number;
}

export interface TradingPartnerCredentialView {
  id: string;
  providerEntityId: string;
  serviceState: string;
  channel: string;
  mcoId: string | null;
  tradingPartnerId: string;
  clientId: string | null;
  sftpHost: string | null;
  portalUrl: string | null;
  activeFrom: string;
  activeTo: string | null;
  lastSandboxTestAt: string | null;
  lastSandboxTestResult: string | null;
  version: number;
  /** Secrets are NEVER returned — only the presence flags. */
  hasClientSecret: boolean;
  hasSftpKey: boolean;
}

export interface ArAgingBucket {
  bucket: string;
  count: number;
  chargesCents: number;
}

export interface ArDashboardView {
  totalOpen: number;
  buckets: ArAgingBucket[];
  byState: Array<{ state: string; count: number; chargesCents: number }>;
}

export interface ArMetricsView {
  denialRate: number;
  openCount: number;
  byMco: Array<{ mcoId: string | null; count: number }>;
  aging: ArAgingBucket[];
}

export interface ClaimFilters {
  state?: string;
  kind?: string;
  mcoId?: string;
  serviceState?: string;
  patientId?: string;
  providerEntityId?: string;
}

export interface RbArrangementFilters {
  patientId?: string;
  nfFacilityMdmId?: string;
  serviceState?: string;
  state?: string;
}

export interface RbDayFilters {
  patientId?: string;
  rbArrangementId?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface EligibilityFilters {
  patientId?: string;
}

export interface M24ReadService {
  listClaims(actor: M24ReadActor, filters: ClaimFilters, cursor: string | undefined, limit: number): Promise<CursorPage<ClaimView>>;
  getClaim(actor: M24ReadActor, claimId: string): Promise<ClaimView | null>;
  listClaimLines(actor: M24ReadActor, claimId: string): Promise<ClaimLineView[]>;
  listSubmissions(actor: M24ReadActor, claimId: string): Promise<SubmissionView[]>;
  listAcknowledgments(actor: M24ReadActor, claimId: string): Promise<AcknowledgmentView[]>;
  getValidationRun(actor: M24ReadActor, runId: string): Promise<ValidationRunView | null>;
  listValidationRuns(actor: M24ReadActor, claimId: string): Promise<ValidationRunView[]>;
  listOverrides(actor: M24ReadActor): Promise<ValidationOverrideView[]>;
  listRuleConfig(actor: M24ReadActor): Promise<RuleConfigView[]>;
  listEligibilityChecks(actor: M24ReadActor, filters: EligibilityFilters): Promise<EligibilityCheckView[]>;
  listRbArrangements(actor: M24ReadActor, filters: RbArrangementFilters): Promise<RbArrangementView[]>;
  getRbArrangement(actor: M24ReadActor, arrangementId: string): Promise<RbArrangementView | null>;
  listRbDays(actor: M24ReadActor, filters: RbDayFilters): Promise<RbDayView[]>;
  listTradingPartnerCredentials(actor: M24ReadActor, providerEntityId?: string): Promise<TradingPartnerCredentialView[]>;
  arDashboard(actor: M24ReadActor, providerEntityId?: string): Promise<ArDashboardView>;
  arMetrics(actor: M24ReadActor, providerEntityId?: string): Promise<ArMetricsView>;
}
