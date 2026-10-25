// @chartwarden/x12-837-client — M23-owned TypeScript client to the Python `x12-worker` sidecar (pyx12).
//
// PACKAGE NAMING: the M23 spec calls this `packages/x12-worker-client`; the locked manifest + scaffold
// use `packages/x12-837-client` (architecture wins). ALL of M23's X12 sidecar client code lives here;
// map every spec reference of "x12-worker-client" to this package.
//
// This is the ONLY place outside the Python `x12-worker` sidecar where X12 wire-format work is reached
// and the ONLY place where MAC portal URLs / endpoints / credentials are named (architecture §25.14
// adapter mandate, spec §8.5). dependency-cruiser (task 20) will forbid `@anthropic-ai/sdk` here and
// forbid one `mac-portal/<juris>` module importing another — the jurisdiction modules are independent.
//
// Barrel discipline: the shared CONTRACT comes from ./types (the extracted leaf). Concrete values are
// re-exported from ./client and ./mac-portal/*, all of which import ONLY from ./types — never from this
// index — so the no-circular fitness rule (the M27 index↔client cycle gotcha) holds.

// ─── Shared adapter CONTRACT (from ./types) ─────────────────────────────────────────────────────
export {
  degraded,
  LAUNCH_JURISDICTION,
  MAC_PORTAL_NOT_WIRED,
  NotImplementedError,
  X12_WORKER_NOT_WIRED,
} from "./types";
export type {
  AckError,
  AckOutcome,
  ClaimAckStatus,
  DegradedError,
  Eligibility270Request,
  Eligibility271Result,
  EligibilityOutcome,
  Generate837iNoeRequest,
  Generate837iNotrRequest,
  Generate837iRequest,
  Generated837i,
  MacJurisdiction,
  MacPortalClient,
  MacPortalReceipt,
  MacPortalStatus,
  MacPortalStatusRequest,
  MacPortalStatusState,
  MacPortalSubmitRequest,
  Parse277caRequest,
  Parse999Request,
  Parsed277ca,
  Parsed999,
  SubmitterContext,
  X12WorkerClient,
  X12WorkerResult,
} from "./types";

// ─── The X12 worker client shape + fail-closed factory (from ./client) ──────────────────────────
export {
  createX12WorkerClient,
  LiveX12WorkerClient,
  NO_X12_WORKER_PORT,
  x12WorkerClient,
} from "./client";
export type {
  X12WorkerClientDeps,
  X12WorkerClientFactory,
  X12WorkerHttpPort,
  X12WorkerHttpRequest,
  X12WorkerHttpResponse,
} from "./client";

// ─── MAC portal clients — launch case + six deny-stubs (from ./mac-portal/*) ─────────────────────
export { createNgsJ6PortalClient, NgsJ6PortalClient } from "./mac-portal/ngs-j6";
export type {
  NgsJ6PortalHttpPort,
  NgsJ6PortalHttpRequest,
  NgsJ6PortalHttpResponse,
} from "./mac-portal/ngs-j6";
export { createNgsJkPortalClient, NgsJkPortalClient } from "./mac-portal/ngs-jk";
export { createCgsJ15PortalClient, CgsJ15PortalClient } from "./mac-portal/cgs-j15";
export { createPalmettoJjPortalClient, PalmettoJjPortalClient } from "./mac-portal/palmetto-jj";
export { createPalmettoJmPortalClient, PalmettoJmPortalClient } from "./mac-portal/palmetto-jm";
export { createNoridianJfPortalClient, NoridianJfPortalClient } from "./mac-portal/noridian-jf";
export { createNoridianJePortalClient, NoridianJePortalClient } from "./mac-portal/noridian-je";

// ─── HETS 270/271 eligibility codec + transport (ADR-0037: TypeScript, not the sidecar) ─────────────
// Pure 270 builder / 271 parser / hospice-history derivation, the CORE MIME transport port, and the
// fixture-backed sandbox transport (dev/test only). Each module imports only its eligibility siblings.
export {
  build270,
  Hets270BuildError,
  HETS_DEFAULT_SERVICE_TYPES,
  MBI_PATTERN,
} from "./eligibility/build-270";
export type { Hets270Request } from "./eligibility/build-270";
export {
  assertNoMbi,
  HETS_271_MAX_CHARS,
  HETS_271_MAX_HOSPICE_RECORDS,
  MbiLeakError,
  parse271,
} from "./eligibility/parse-271";
export type {
  Hets271Outcome,
  Hets271Rejection,
  HospiceRecord,
  HospiceRevocationCode,
  PartAEntitlement,
  Parsed271,
} from "./eligibility/parse-271";
export {
  deriveHospiceHistory,
  HETS_HOSPICE_PERIOD_RETURN_CAP,
} from "./eligibility/hospice-history";
export type {
  HospiceHistory,
  HospicePeriod,
  NextPeriodBasis,
} from "./eligibility/hospice-history";
export {
  buildCoreMimeForm,
  coreSenderId,
  createCoreMimeHetsTransport,
  HetsTransportError,
} from "./eligibility/transport";
export type {
  CoreMimeHetsTransportConfig,
  HetsFetch,
  HetsTransport,
  HetsTransportRequest,
  HetsTransportResponse,
} from "./eligibility/transport";
export { createSandboxHetsTransport } from "./eligibility/sandbox-transport";
export type { SandboxHetsTransportOptions } from "./eligibility/sandbox-transport";
export { HETS_271_SCENARIOS, synthetic271 } from "./eligibility/fixtures";
export type {
  Hets271Scenario,
  Synthetic271Context,
  SyntheticHospicePeriod,
} from "./eligibility/fixtures";
export { X12FormatError } from "./eligibility/x12-envelope";

// ─── Medicare hospice transfer notice 837I (TOB 81C/82C, correction, 8xD void) — ADR-0037 TypeScript ─────────
export {
  build837iTransferNotice,
  TransferNotice837iBuildError,
} from "./notices/build-837i-transfer-notice";
export type {
  TransferNotice837iInput,
  TransferNoticeDocumentInput,
  X12Address,
  X12PersonName,
  X12Physician,
} from "./notices/build-837i-transfer-notice";

// ─── 999 / 277CA payer dates (STC02, GS04, ISA09) — the NOE/NOTR payer status date, ADR-0037 TypeScript ──────
export { read277caStatusDates, read999EnvelopeDates } from "./acks/ack-dates";
export type { Ack999EnvelopeDates, ClaimStatusDate } from "./acks/ack-dates";
export { parse999 } from "./acks/parse-999";
export { routeAckEvent } from "./acks/route-ack-event";
export type { RoutedAckEvent } from "./acks/route-ack-event";
export type { Ack999TransactionSet, Parsed999Detail } from "./acks/parse-999";

// ─── ClearinghouseTransport port and conformance cases (ADR-0053; the in-memory reference is in ./testing) ─────────
export { CH, CLEARINGHOUSE_EVENT_KINDS, RETRYABLE_CODES } from "./clearinghouse/types";
export { checkStediEdits } from "./clearinghouse/stedi-edit-rules";
export type { StediEditFinding, StediEditRule } from "./clearinghouse/stedi-edit-rules";
export type {
  AckDisposition,
  AckEvent,
  AckStage,
  ClaimAdjustment,
  ClaimStatus,
  ClearinghouseContext,
  ClearinghouseEligibilityRequest,
  ClearinghouseEligibilityResult,
  ClearinghouseErrorCode,
  ClearinghouseScope,
  ClearinghouseEvent,
  ClearinghouseEventKind,
  ClearinghouseSubmission,
  ClearinghouseTransport,
  ClearinghouseVendor,
  Page,
  RawWebhook,
  RemittanceFile,
  SubmissionKind,
  SubmissionPayload,
  SubmissionReceipt,
  SubmissionState,
  ValidationIssue,
  ValidationReport,
} from "./clearinghouse/types";
export {
  CLEARINGHOUSE_CONFORMANCE_CASES,
  ALL_CONFORMANCE_CAPABILITIES,
  DEFAULT_SCOPE,
  runClearinghouseConformance,
  runConformance,
  SYNTHETIC_MBI,
} from "./clearinghouse/conformance";
export type {
  ClearinghouseHarness,
  ConformanceCapability,
  ConformanceCase,
  ConformanceOutcome,
  ConformancePayloads,
  ConformanceScript,
  HarnessFactory,
} from "./clearinghouse/conformance";
export {
  Notice837iBuildError,
  build837iNotice,
  type Notice837iInput,
  type NoticeDocument,
  type NoticeKind,
} from "./notices/build-837i-notice";
export { X12BuildError } from "./x12/writer";
export {
  Claim837iBuildError,
  build837iClaim,
  type Claim837iInput,
  type ClaimDocument,
  type ClaimLine,
  type ClaimOccurrenceSpan,
} from "./claims/build-837i-claim";
export {
  buildStediClaimJson,
  type StediAddress,
  type StediClaimJson,
} from "./clearinghouse/stedi-claim-json";
export { compareStediClaimJsonToX12 } from "./clearinghouse/stedi-claim-agreement";
export {
  CLEARINGHOUSE_VENDOR_ENV,
  NOT_WIRED_TRANSPORT,
  PRODUCTION_CLEARINGHOUSE_VENDORS,
  bindClearinghouseTransport,
  parseClearinghouseVendor,
} from "./clearinghouse/transport-registry";
export type {
  ClearinghouseBinding,
  ClearinghouseTransportFactories,
  ClearinghouseTransportFactory,
} from "./clearinghouse/transport-registry";
export { InMemoryAttemptStore, PlatformControlNumberTaken } from "./clearinghouse/attempt-store";
export type {
  AttemptResolution,
  SettleGuard,
  AttemptStatus,
  AttemptUsage,
  ReserveResult,
  SubmissionAttempt,
  SubmissionAttemptStore,
} from "./clearinghouse/attempt-store";
export {
  ATTEMPT_STORE_CONTRACT,
  CONTRACT_OPERATOR_ID,
  IN_MEMORY_CONTRACT_IDS,
  reservation as attemptReservationFixture,
} from "./clearinghouse/attempt-store-contract";
export type {
  AttemptStoreContractCase,
  AttemptStoreContractIds,
} from "./clearinghouse/attempt-store-contract";
export {
  pastKeyWindow,
  settleGuard,
  STEDI_API_KEY_ENV,
  StediTransport,
  createStediTransportFromEnv,
} from "./clearinghouse/stedi-transport";
export type { StediAnomaly, StediTransportOptions } from "./clearinghouse/stedi-transport";
export { scopeKey } from "./clearinghouse/submission-identity";
export { DirectMacTransport } from "./clearinghouse/direct-mac-transport";
export type {
  DirectMacAnomaly,
  DirectMacGateway,
  DirectMacTransportOptions,
} from "./clearinghouse/direct-mac-transport";
