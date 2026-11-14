import { createHash } from "node:crypto";
import { tokenizeInterchange } from "@chartwarden/x12-837-client";
import type {
  MedicareNoticeDispatchIdentity,
  MedicareNoticeDispatchStateMachine,
} from "../services/medicare-notice-dispatch";
import type {
  MedicareNoticeArtifactStore,
  MedicareNoticeKind,
} from "../services/medicare-notice-renderer";

/** Proposed WardenX ↔ Direct-MAC gateway notice protocol. No deployed server is qualified for it. */
export const DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION = "m23-direct-mac-notice.v1" as const;
export const DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE = "m23-direct-mac-notice-conformance.v1" as const;

export const DIRECT_MAC_NOTICE_GATEWAY_PATHS = {
  capabilities: "/v1/medicare-notice/capabilities",
  operations: "/v1/medicare-notice/operations",
  lookupByDispatch: "/v1/medicare-notice/operations/lookup",
} as const;

export type DirectMacNoticeTransaction = "81A" | "81B" | "8XC" | "8XD";
export type DirectMacGatewayOperationState =
  | "durably_accepted"
  | "queued"
  | "mac_delivery_started"
  | "mac_transport_received"
  | "mac_transport_rejected"
  | "downstream_outcome_unknown"
  | "reconciliation_required";

export type DirectMacGatewayReceiptStage =
  | "gateway_durable_acceptance"
  | "mac_delivery_started"
  | "mac_transport_received"
  | "mac_transport_rejected"
  | "downstream_outcome_unknown";

export interface DirectMacNoticeGatewayRequestV1 {
  readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
  readonly clientDispatchId: string;
  readonly organizationReference: string;
  readonly providerReference: string;
  readonly submissionReference: string;
  readonly renderReference: string;
  readonly artifactReference: string;
  readonly artifactSha256: string;
  readonly noticeTransaction: DirectMacNoticeTransaction;
  readonly jurisdiction: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly control: {
    readonly interchangeControlNumber: string;
    readonly functionalGroupControlNumber: string;
    readonly transactionSetControlNumber: string;
    readonly businessControlNumber: string;
  };
  readonly payload: { readonly format: "x12"; readonly content: string };
}

export interface DirectMacGatewayReceiptV1 {
  readonly receiptId: string;
  readonly gatewayOperationId: string;
  readonly clientDispatchId: string;
  readonly artifactSha256: string;
  readonly accountReference: string;
  readonly jurisdiction: string;
  readonly stage: DirectMacGatewayReceiptStage;
  readonly recordedAt: string;
  readonly evidenceReference?: string;
}

export type DirectMacNoticeGatewayResponseV1 =
  | {
      readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
      readonly state: "rejected_before_acceptance";
      readonly clientDispatchId: string;
      readonly reasonCode: string;
    }
  | {
      readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
      readonly state: DirectMacGatewayOperationState;
      readonly replayed: boolean;
      readonly receipt: DirectMacGatewayReceiptV1;
    };

export interface DirectMacNoticeGatewayLookupV1 {
  readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
  readonly clientDispatchId: string;
  readonly artifactSha256: string;
  readonly accountReference: string;
  readonly jurisdiction: string;
  readonly organizationReference: string;
  readonly providerReference: string;
  readonly submissionReference: string;
  readonly renderReference: string;
  readonly artifactReference: string;
  readonly usage: "test" | "production";
  readonly control: DirectMacNoticeGatewayRequestV1["control"];
  readonly state: DirectMacGatewayOperationState;
  readonly receipt: DirectMacGatewayReceiptV1;
  readonly lastVerifiedAt: string;
  readonly downstreamEvidence?: {
    readonly kind: "known_not_transmitted" | "transport_receipt" | "transport_rejection" | "outcome_unknown";
    readonly evidenceReference: string;
    readonly verifiedAt: string;
  };
}

export interface DirectMacNoticeAcknowledgmentProvenanceV1 {
  readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
  readonly acknowledgmentId: string;
  readonly gatewayOperationId: string;
  readonly clientDispatchId: string;
  readonly artifactSha256: string;
  readonly accountReference: string;
  readonly providerReference: string;
  readonly interchangeControlNumber: string;
  readonly acknowledgmentType: "999" | "277CA";
  readonly stage: "x12_processing" | "payer_processing";
  readonly disposition: "accepted" | "rejected" | "partial";
  readonly receivedAt: string;
  readonly evidenceReference: string;
}

export interface DirectMacNoticeGatewayCapabilitiesV1 {
  readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
  readonly gatewayInstanceId: string;
  readonly capabilities: {
    readonly inlineX12: boolean;
    readonly artifactDigestBinding: boolean;
    readonly historicalRouteBinding: boolean;
    readonly serverEnforcedIdempotency: boolean;
    readonly durableReceipt: boolean;
    readonly operationLookup: boolean;
    readonly acknowledgmentCorrelation: boolean;
  };
  readonly conformance: {
    readonly recordId: string;
    readonly suiteVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE;
    readonly verifiedAt: string;
    readonly expiresAt: string;
  };
}

/** Locally approved evidence. A server's self-reported capability document is not qualification. */
export interface DirectMacNoticeGatewayConformanceAttestation {
  readonly gatewayInstanceId: string;
  readonly contractVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION;
  readonly conformanceRecordId: string;
  readonly suiteVersion: typeof DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE;
  readonly suiteResultSha256: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly approvedBy: string;
}

export interface QualifiedDirectMacNoticeGateway {
  readonly capabilities: DirectMacNoticeGatewayCapabilitiesV1;
  readonly attestation: DirectMacNoticeGatewayConformanceAttestation;
}

export interface DirectMacNoticeReadinessEvidence {
  readonly evidenceReference: string;
  readonly verifiedAt: string;
  readonly expiresAt?: string;
}

export interface DirectMacNoticeGatewayReadiness {
  readonly gatewayClientImplemented: true;
  readonly gatewayServerIdentified: boolean;
  readonly contractVersionCompatible: boolean;
  readonly remoteIdempotencyVerified: boolean;
  readonly durableReceiptVerified: boolean;
  readonly outcomeLookupVerified: boolean;
  readonly acknowledgmentCorrelationVerified: boolean;
  readonly macConnectorConfigured: boolean;
  readonly ediEnrollmentConfirmed: boolean;
  readonly appRoleRlsValidated: boolean;
  readonly transportEnabled: boolean;
}

export type DirectMacNoticeGatewayCapabilityClass =
  | "gateway_unavailable"
  | "legacy_only"
  | "versioned_unverified"
  | "versioned_qualified"
  | "capability_unverified";

export type DirectMacNoticeGatewayErrorCode =
  | "NOTICE_GATEWAY_INVALID_REQUEST"
  | "NOTICE_GATEWAY_UNAVAILABLE"
  | "NOTICE_GATEWAY_UNSUPPORTED_VERSION"
  | "NOTICE_GATEWAY_LEGACY_RESPONSE"
  | "NOTICE_GATEWAY_INVALID_RESPONSE"
  | "NOTICE_GATEWAY_CORRELATION_MISMATCH"
  | "NOTICE_GATEWAY_NOT_QUALIFIED";

/** PHI-safe contract failure. Never attach the request, response body, credential, or X12 as cause text. */
export class DirectMacNoticeGatewayError extends Error {
  public override readonly name = "DirectMacNoticeGatewayError";
  constructor(readonly code: DirectMacNoticeGatewayErrorCode) {
    super(code);
  }
}

export interface DirectMacNoticeGatewayHttpRequest {
  readonly method: "GET" | "POST";
  readonly baseUrl: string;
  readonly path: string;
  readonly bearerToken: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly body?: unknown;
}

export interface DirectMacNoticeGatewayHttpPort {
  request(input: DirectMacNoticeGatewayHttpRequest): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface VersionedDirectMacNoticeGatewayClient {
  declaredCapabilities(): Promise<DirectMacNoticeGatewayCapabilitiesV1>;
  submit(request: DirectMacNoticeGatewayRequestV1): Promise<DirectMacNoticeGatewayResponseV1>;
  lookupByClientDispatch(input: {
    clientDispatchId: string;
    artifactSha256: string;
    accountReference: string;
    jurisdiction: string;
    organizationReference: string;
    providerReference: string;
    submissionReference: string;
    renderReference: string;
    artifactReference: string;
    usage: "test" | "production";
    control: DirectMacNoticeGatewayRequestV1["control"];
  }): Promise<DirectMacNoticeGatewayLookupV1>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const OPAQUE = /^[A-Za-z0-9:._/-]{1,256}$/;
const ACCOUNT = /^[A-Za-z0-9:._/-]{1,512}$/;
const JURISDICTION = /^[a-z0-9_]{2,64}$/;
const SAFE_CODE = /^[A-Z0-9_]{1,64}$/;
const ISA13 = /^\d{9}$/;
const MAX_X12_BYTES = 10 * 1024 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const boolean = (value: unknown): value is boolean => typeof value === "boolean";
const isoInstant = (value: unknown): value is string =>
  text(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const opaque = (value: unknown): value is string => text(value) && OPAQUE.test(value);
const account = (value: unknown): value is string => text(value) && ACCOUNT.test(value);
const digest = (value: unknown): value is string => text(value) && SHA256.test(value);

function noticeTransaction(kind: MedicareNoticeKind): DirectMacNoticeTransaction {
  if (kind === "noe") return "81A";
  if (kind === "notr") return "81B";
  if (kind === "transfer_notice") return "8XC";
  return "8XD";
}

function controlIdentity(x12: string, expected: MedicareNoticeDispatchIdentity) {
  let segments: readonly (readonly string[])[];
  try {
    segments = tokenizeInterchange(x12).segments;
  } catch {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
  }
  const find = (tag: string) => segments.find((segment) => segment[0] === tag);
  const isa = find("ISA");
  const gs = find("GS");
  const st = find("ST");
  const bht = find("BHT");
  const clm = find("CLM");
  const numericInterchange = Number(expected.interchangeControlNumber);
  const groupControlNumber = gs?.[6];
  const transactionSetControlNumber = st?.[2];
  const businessControlNumber = bht?.[3];
  if (!isa || !gs || !st || !bht || !clm || isa[13] !== expected.interchangeControlNumber ||
      !Number.isSafeInteger(numericInterchange) || numericInterchange < 0 ||
      groupControlNumber !== String(numericInterchange) ||
      transactionSetControlNumber !== String(numericInterchange).padStart(4, "0") ||
      businessControlNumber !== expected.controlNumber || clm[1] !== expected.controlNumber ||
      bht[3] !== clm[1]) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
  }
  return {
    interchangeControlNumber: isa[13]!,
    functionalGroupControlNumber: groupControlNumber!,
    transactionSetControlNumber: transactionSetControlNumber!,
    businessControlNumber,
  };
}

export function buildDirectMacNoticeGatewayRequest(
  identity: MedicareNoticeDispatchIdentity,
  x12: string,
): DirectMacNoticeGatewayRequestV1 {
  const bytes = Buffer.from(x12, "utf8");
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  const controls = controlIdentity(x12, identity);
  if (
    identity.vendor !== "direct_mac" || !UUID.test(identity.organizationId) ||
    !UUID.test(identity.providerEntityId) || !UUID.test(identity.submissionId) ||
    !UUID.test(identity.renderIdentityId) || !UUID.test(identity.artifactId) ||
    !UUID.test(identity.dispatchToken) || !digest(identity.artifactSha256) ||
    identity.artifactSha256 !== actualDigest || !JURISDICTION.test(identity.jurisdiction) ||
    !account(identity.accountReference) || !opaque(identity.controlNumber) ||
    !ISA13.test(identity.interchangeControlNumber) || bytes.length === 0 ||
    bytes.length > MAX_X12_BYTES || !x12.startsWith("ISA")
  ) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
  }
  return {
    contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
    clientDispatchId: identity.dispatchToken,
    organizationReference: identity.organizationId,
    providerReference: identity.providerEntityId,
    submissionReference: identity.submissionId,
    renderReference: identity.renderIdentityId,
    artifactReference: identity.artifactId,
    artifactSha256: identity.artifactSha256,
    noticeTransaction: noticeTransaction(identity.kind),
    jurisdiction: identity.jurisdiction,
    accountReference: identity.accountReference,
    usage: identity.usage,
    control: controls,
    payload: { format: "x12", content: x12 },
  };
}

function parseReceipt(value: unknown): DirectMacGatewayReceiptV1 {
  if (!record(value)) throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  const allowed = ["receiptId", "gatewayOperationId", "clientDispatchId", "artifactSha256", "accountReference", "jurisdiction", "stage", "recordedAt"];
  const keys = value.evidenceReference === undefined ? allowed : [...allowed, "evidenceReference"];
  const stages: readonly DirectMacGatewayReceiptStage[] = [
    "gateway_durable_acceptance", "mac_delivery_started", "mac_transport_received",
    "mac_transport_rejected", "downstream_outcome_unknown",
  ];
  if (!exactKeys(value, keys) || !opaque(value.receiptId) || !opaque(value.gatewayOperationId) ||
      !UUID.test(String(value.clientDispatchId)) || !digest(value.artifactSha256) ||
      !account(value.accountReference) || !text(value.jurisdiction) || !JURISDICTION.test(value.jurisdiction) ||
      !text(value.stage) || !stages.includes(value.stage as DirectMacGatewayReceiptStage) ||
      !isoInstant(value.recordedAt) || (value.evidenceReference !== undefined && !opaque(value.evidenceReference))) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  }
  return value as unknown as DirectMacGatewayReceiptV1;
}

function assertReceiptCorrelation(
  receipt: DirectMacGatewayReceiptV1,
  expected: Pick<DirectMacNoticeGatewayRequestV1, "clientDispatchId" | "artifactSha256" | "accountReference" | "jurisdiction">,
) {
  if (receipt.clientDispatchId !== expected.clientDispatchId ||
      receipt.artifactSha256 !== expected.artifactSha256 ||
      receipt.accountReference !== expected.accountReference ||
      receipt.jurisdiction !== expected.jurisdiction) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_CORRELATION_MISMATCH");
  }
}

function receiptMatchesOperationState(state: DirectMacGatewayOperationState, stage: DirectMacGatewayReceiptStage): boolean {
  if (state === "durably_accepted" || state === "queued") return stage === "gateway_durable_acceptance";
  if (state === "mac_delivery_started") return stage === "mac_delivery_started";
  if (state === "mac_transport_received") return stage === "mac_transport_received";
  if (state === "mac_transport_rejected") return stage === "mac_transport_rejected";
  return stage === "downstream_outcome_unknown";
}

export function parseDirectMacNoticeGatewayResponse(
  value: unknown,
  expected: DirectMacNoticeGatewayRequestV1,
): DirectMacNoticeGatewayResponseV1 {
  if (record(value) && exactKeys(value, ["accepted", "generatedFileUri"])) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_LEGACY_RESPONSE");
  }
  if (!record(value) || value.contractVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION) {
    throw new DirectMacNoticeGatewayError(
      record(value) && text(value.contractVersion)
        ? "NOTICE_GATEWAY_UNSUPPORTED_VERSION"
        : "NOTICE_GATEWAY_INVALID_RESPONSE",
    );
  }
  if (value.state === "rejected_before_acceptance") {
    if (!exactKeys(value, ["contractVersion", "state", "clientDispatchId", "reasonCode"]) ||
        value.clientDispatchId !== expected.clientDispatchId || !text(value.reasonCode) ||
        !SAFE_CODE.test(value.reasonCode)) {
      throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
    }
    return value as unknown as DirectMacNoticeGatewayResponseV1;
  }
  const states: readonly DirectMacGatewayOperationState[] = [
    "durably_accepted", "queued", "mac_delivery_started", "mac_transport_received",
    "mac_transport_rejected", "downstream_outcome_unknown", "reconciliation_required",
  ];
  if (!exactKeys(value, ["contractVersion", "state", "replayed", "receipt"]) ||
      !text(value.state) || !states.includes(value.state as DirectMacGatewayOperationState) ||
      !boolean(value.replayed)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  }
  const receipt = parseReceipt(value.receipt);
  if (!receiptMatchesOperationState(value.state as DirectMacGatewayOperationState, receipt.stage)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  }
  assertReceiptCorrelation(receipt, expected);
  return { ...value, receipt } as DirectMacNoticeGatewayResponseV1;
}

export function parseDirectMacNoticeGatewayCapabilities(value: unknown): DirectMacNoticeGatewayCapabilitiesV1 {
  if (!record(value) || !exactKeys(value, ["contractVersion", "gatewayInstanceId", "capabilities", "conformance"]) ||
      value.contractVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION || !opaque(value.gatewayInstanceId) ||
      !record(value.capabilities) || !exactKeys(value.capabilities, [
        "inlineX12", "artifactDigestBinding", "historicalRouteBinding", "serverEnforcedIdempotency",
        "durableReceipt", "operationLookup", "acknowledgmentCorrelation",
      ]) || !Object.values(value.capabilities).every(boolean) || !record(value.conformance) ||
      !exactKeys(value.conformance, ["recordId", "suiteVersion", "verifiedAt", "expiresAt"]) ||
      !opaque(value.conformance.recordId) || value.conformance.suiteVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE ||
      !isoInstant(value.conformance.verifiedAt) || !isoInstant(value.conformance.expiresAt) ||
      Date.parse(value.conformance.expiresAt) <= Date.parse(value.conformance.verifiedAt)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  }
  return value as unknown as DirectMacNoticeGatewayCapabilitiesV1;
}

export function parseDirectMacNoticeAcknowledgmentProvenance(
  value: unknown,
  expected: Pick<DirectMacNoticeGatewayRequestV1,
    "clientDispatchId" | "artifactSha256" | "accountReference" | "providerReference"> &
    { readonly interchangeControlNumber: string; readonly gatewayOperationId: string },
): DirectMacNoticeAcknowledgmentProvenanceV1 {
  if (!record(value) || !exactKeys(value, [
    "contractVersion", "acknowledgmentId", "gatewayOperationId", "clientDispatchId",
    "artifactSha256", "accountReference", "providerReference", "interchangeControlNumber",
    "acknowledgmentType", "stage", "disposition", "receivedAt", "evidenceReference",
  ]) || value.contractVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION ||
      !opaque(value.acknowledgmentId) || !opaque(value.gatewayOperationId) ||
      value.gatewayOperationId !== expected.gatewayOperationId ||
      value.clientDispatchId !== expected.clientDispatchId ||
      value.artifactSha256 !== expected.artifactSha256 ||
      value.accountReference !== expected.accountReference ||
      value.providerReference !== expected.providerReference ||
      value.interchangeControlNumber !== expected.interchangeControlNumber ||
      (value.acknowledgmentType !== "999" && value.acknowledgmentType !== "277CA") ||
      (value.stage !== "x12_processing" && value.stage !== "payer_processing") ||
      (value.acknowledgmentType === "999" && value.stage !== "x12_processing") ||
      (value.acknowledgmentType === "277CA" && value.stage !== "payer_processing") ||
      (value.disposition !== "accepted" && value.disposition !== "rejected" && value.disposition !== "partial") ||
      (value.acknowledgmentType === "999" && value.disposition === "partial") ||
      !isoInstant(value.receivedAt) || !opaque(value.evidenceReference)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_CORRELATION_MISMATCH");
  }
  return value as unknown as DirectMacNoticeAcknowledgmentProvenanceV1;
}

export function qualifyDirectMacNoticeGateway(input: {
  declared: DirectMacNoticeGatewayCapabilitiesV1;
  attestation: DirectMacNoticeGatewayConformanceAttestation;
  now?: Date;
}): QualifiedDirectMacNoticeGateway {
  const { declared, attestation } = input;
  const required = declared.capabilities;
  const attestedExpiry = Date.parse(attestation.expiresAt);
  const now = (input.now ?? new Date()).getTime();
  if (declared.gatewayInstanceId !== attestation.gatewayInstanceId ||
      attestation.contractVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION ||
      attestation.suiteVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE ||
      declared.conformance.recordId !== attestation.conformanceRecordId ||
      declared.conformance.verifiedAt !== attestation.verifiedAt ||
      declared.conformance.expiresAt !== attestation.expiresAt || !digest(attestation.suiteResultSha256) ||
      !opaque(attestation.approvedBy) || !isoInstant(attestation.verifiedAt) ||
      !isoInstant(attestation.expiresAt) || attestedExpiry <= now || Date.parse(attestation.verifiedAt) > now ||
      !required.inlineX12 || !required.artifactDigestBinding || !required.historicalRouteBinding ||
      !required.serverEnforcedIdempotency || !required.durableReceipt || !required.operationLookup ||
      !required.acknowledgmentCorrelation) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_NOT_QUALIFIED");
  }
  return { capabilities: declared, attestation };
}

const currentEvidence = (evidence: DirectMacNoticeReadinessEvidence | undefined, now: Date) =>
  evidence !== undefined && opaque(evidence.evidenceReference) && isoInstant(evidence.verifiedAt) &&
  (evidence.expiresAt === undefined || (isoInstant(evidence.expiresAt) && Date.parse(evidence.expiresAt) > now.getTime()));

/** PHI-free operational report. Every `verified` field is backed by qualification/evidence, not URL or health. */
export function directMacNoticeGatewayReadiness(input: {
  readonly serverIdentity?: DirectMacNoticeReadinessEvidence;
  readonly qualification?: QualifiedDirectMacNoticeGateway;
  readonly macConnector?: DirectMacNoticeReadinessEvidence;
  readonly ediEnrollment?: DirectMacNoticeReadinessEvidence;
  readonly appRoleRls?: DirectMacNoticeReadinessEvidence;
  readonly transmissionAuthorization?: DirectMacNoticeReadinessEvidence;
  readonly now?: Date;
}): DirectMacNoticeGatewayReadiness {
  const now = input.now ?? new Date();
  const server = currentEvidence(input.serverIdentity, now);
  const qualified = server && input.qualification !== undefined &&
    Date.parse(input.qualification.attestation.expiresAt) > now.getTime();
  const capabilities = input.qualification?.capabilities.capabilities;
  const connector = currentEvidence(input.macConnector, now);
  const enrollment = currentEvidence(input.ediEnrollment, now);
  const rls = currentEvidence(input.appRoleRls, now);
  const authorized = currentEvidence(input.transmissionAuthorization, now);
  const result = {
    gatewayClientImplemented: true as const,
    gatewayServerIdentified: server,
    contractVersionCompatible: qualified,
    remoteIdempotencyVerified: qualified && capabilities?.serverEnforcedIdempotency === true,
    durableReceiptVerified: qualified && capabilities?.durableReceipt === true,
    outcomeLookupVerified: qualified && capabilities?.operationLookup === true,
    acknowledgmentCorrelationVerified: qualified && capabilities?.acknowledgmentCorrelation === true,
    macConnectorConfigured: connector,
    ediEnrollmentConfirmed: enrollment,
    appRoleRlsValidated: rls,
    transportEnabled: false,
  };
  return {
    ...result,
    transportEnabled: authorized && Object.entries(result)
      .filter(([key]) => key !== "gatewayClientImplemented" && key !== "transportEnabled")
      .every(([, value]) => value === true),
  };
}

export function classifyDirectMacNoticeGatewayCapability(input: {
  readonly declared?: DirectMacNoticeGatewayCapabilitiesV1;
  readonly attestation?: DirectMacNoticeGatewayConformanceAttestation;
  readonly errorCode?: DirectMacNoticeGatewayErrorCode;
  readonly now?: Date;
}): DirectMacNoticeGatewayCapabilityClass {
  if (input.errorCode === "NOTICE_GATEWAY_UNAVAILABLE") return "gateway_unavailable";
  if (input.errorCode === "NOTICE_GATEWAY_LEGACY_RESPONSE") return "legacy_only";
  if (!input.declared) return "capability_unverified";
  if (!input.attestation) return "versioned_unverified";
  try {
    qualifyDirectMacNoticeGateway({
      declared: input.declared,
      attestation: input.attestation,
      now: input.now,
    });
    return "versioned_qualified";
  } catch {
    return "versioned_unverified";
  }
}

function parseLookup(
  value: unknown,
  expected: Parameters<VersionedDirectMacNoticeGatewayClient["lookupByClientDispatch"]>[0],
): DirectMacNoticeGatewayLookupV1 {
  if (!record(value)) throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  const baseKeys = ["contractVersion", "clientDispatchId", "artifactSha256", "accountReference", "jurisdiction", "organizationReference", "providerReference", "submissionReference", "renderReference", "artifactReference", "usage", "control", "state", "receipt", "lastVerifiedAt"];
  const keys = value.downstreamEvidence === undefined ? baseKeys : [...baseKeys, "downstreamEvidence"];
  const states: readonly DirectMacGatewayOperationState[] = [
    "durably_accepted", "queued", "mac_delivery_started", "mac_transport_received",
    "mac_transport_rejected", "downstream_outcome_unknown", "reconciliation_required",
  ];
  if (!exactKeys(value, keys) || value.contractVersion !== DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION ||
      value.clientDispatchId !== expected.clientDispatchId || value.artifactSha256 !== expected.artifactSha256 ||
      value.accountReference !== expected.accountReference || value.jurisdiction !== expected.jurisdiction ||
      value.organizationReference !== expected.organizationReference || value.providerReference !== expected.providerReference ||
      value.submissionReference !== expected.submissionReference || value.renderReference !== expected.renderReference ||
      value.artifactReference !== expected.artifactReference || value.usage !== expected.usage ||
      !record(value.control) || !exactKeys(value.control, ["interchangeControlNumber", "functionalGroupControlNumber", "transactionSetControlNumber", "businessControlNumber"]) ||
      value.control.interchangeControlNumber !== expected.control.interchangeControlNumber ||
      value.control.functionalGroupControlNumber !== expected.control.functionalGroupControlNumber ||
      value.control.transactionSetControlNumber !== expected.control.transactionSetControlNumber ||
      value.control.businessControlNumber !== expected.control.businessControlNumber ||
      !text(value.state) || !states.includes(value.state as DirectMacGatewayOperationState) ||
      !isoInstant(value.lastVerifiedAt)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_CORRELATION_MISMATCH");
  }
  const receipt = parseReceipt(value.receipt);
  if (!receiptMatchesOperationState(value.state as DirectMacGatewayOperationState, receipt.stage)) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
  }
  assertReceiptCorrelation(receipt, expected);
  if (value.downstreamEvidence !== undefined) {
    const evidence = value.downstreamEvidence;
    const kinds = ["known_not_transmitted", "transport_receipt", "transport_rejection", "outcome_unknown"];
    if (!record(evidence) || !exactKeys(evidence, ["kind", "evidenceReference", "verifiedAt"]) ||
        !text(evidence.kind) || !kinds.includes(evidence.kind) || !opaque(evidence.evidenceReference) ||
        !isoInstant(evidence.verifiedAt)) {
      throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
    }
  }
  return { ...value, receipt } as DirectMacNoticeGatewayLookupV1;
}

const safeFetch: DirectMacNoticeGatewayHttpPort = {
  async request(input) {
    const response = await fetch(new URL(input.path, `${input.baseUrl.replace(/\/$/, "")}/`), {
      method: input.method,
      redirect: "error",
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
        accept: "application/json",
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > input.maxResponseBytes) throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > input.maxResponseBytes) throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_RESPONSE");
    let body: unknown = null;
    try { body = raw.length ? JSON.parse(raw) : null; } catch { /* validated below without echoing content */ }
    return { status: response.status, body };
  },
};

export function createVersionedDirectMacNoticeGatewayClient(
  config: { baseUrl: string; bearerToken: string; timeoutMs: number; maxResponseBytes?: number },
  http: DirectMacNoticeGatewayHttpPort = safeFetch,
): VersionedDirectMacNoticeGatewayClient {
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST"); }
  if (url.protocol !== "https:" || url.username || url.password || !config.bearerToken ||
      config.timeoutMs < 1000 || config.timeoutMs > 120_000) {
    throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
  }
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    let response: { readonly status: number; readonly body: unknown };
    try {
      response = await http.request({
        method, path, body, baseUrl: url.toString(), bearerToken: config.bearerToken,
        timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes ?? 64 * 1024,
      });
    } catch (error) {
      if (error instanceof DirectMacNoticeGatewayError) throw error;
      throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_UNAVAILABLE");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_UNAVAILABLE");
    }
    return response.body;
  };
  return {
    async declaredCapabilities() {
      return parseDirectMacNoticeGatewayCapabilities(await request("GET", DIRECT_MAC_NOTICE_GATEWAY_PATHS.capabilities));
    },
    async submit(input) {
      return parseDirectMacNoticeGatewayResponse(
        await request("POST", DIRECT_MAC_NOTICE_GATEWAY_PATHS.operations, input),
        input,
      );
    },
    async lookupByClientDispatch(input) {
      if (!UUID.test(input.clientDispatchId) || !digest(input.artifactSha256) ||
          !account(input.accountReference) || !JURISDICTION.test(input.jurisdiction) ||
          !UUID.test(input.organizationReference) || !UUID.test(input.providerReference) ||
          !UUID.test(input.submissionReference) || !UUID.test(input.renderReference) ||
          !UUID.test(input.artifactReference) || !ISA13.test(input.control.interchangeControlNumber) ||
          !opaque(input.control.functionalGroupControlNumber) ||
          !opaque(input.control.transactionSetControlNumber) ||
          !opaque(input.control.businessControlNumber)) {
        throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
      }
      // Correlation fields stay in the authenticated JSON body rather than proxy/access-log URLs.
      const body = await request("POST", DIRECT_MAC_NOTICE_GATEWAY_PATHS.lookupByDispatch, input);
      return parseLookup(body, input);
    },
  };
}

/**
 * Testable WardenX-side adapter. It is intentionally not composed into production workers until an actual gateway
 * has a matching approved conformance attestation. It never rerenders and never retries an already-started attempt.
 */
export function buildQualifiedDirectMacNoticeDispatchAdapter(deps: {
  artifacts: MedicareNoticeArtifactStore;
  dispatch: MedicareNoticeDispatchStateMachine;
  gateway: VersionedDirectMacNoticeGatewayClient;
  qualification: QualifiedDirectMacNoticeGateway;
}) {
  return {
    async dispatch(input: { organizationId: string; noticeId: string; submissionId: string; kind: MedicareNoticeKind }) {
      // Recheck the authenticated server declaration against the local attestation before artifact recovery,
      // sensitive payload handling, or dispatch reservation. Self-report alone never qualifies the server.
      const currentCapabilities = await deps.gateway.declaredCapabilities();
      const currentQualification = qualifyDirectMacNoticeGateway({
        declared: currentCapabilities,
        attestation: deps.qualification.attestation,
      });
      if (currentQualification.capabilities.gatewayInstanceId !== deps.qualification.capabilities.gatewayInstanceId) {
        throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_NOT_QUALIFIED");
      }
      const artifact = await deps.artifacts.recover(input);
      if (!artifact) throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
      const reservation = await deps.dispatch.reserve(artifact);
      if (reservation.kind !== "reserved") {
        throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_NOT_QUALIFIED");
      }
      let request: DirectMacNoticeGatewayRequestV1;
      try {
        request = buildDirectMacNoticeGatewayRequest(reservation.identity, artifact.x12);
      } catch {
        await deps.dispatch.finishKnownNotSent({
          organizationId: reservation.identity.organizationId,
          submissionId: reservation.identity.submissionId,
          dispatchToken: reservation.identity.dispatchToken,
          reasonCode: "GATEWAY_REQUEST_VALIDATION_FAILED",
        });
        throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_INVALID_REQUEST");
      }
      let response: DirectMacNoticeGatewayResponseV1;
      try {
        response = await deps.gateway.submit(request);
      } catch {
        await deps.dispatch.markInDoubt({
          organizationId: reservation.identity.organizationId,
          submissionId: reservation.identity.submissionId,
          dispatchToken: reservation.identity.dispatchToken,
          reasonCode: "GATEWAY_OUTCOME_UNKNOWN",
        });
        throw new DirectMacNoticeGatewayError("NOTICE_GATEWAY_UNAVAILABLE");
      }
      if (response.state === "rejected_before_acceptance") {
        await deps.dispatch.finishKnownNotSent({
          organizationId: reservation.identity.organizationId,
          submissionId: reservation.identity.submissionId,
          dispatchToken: reservation.identity.dispatchToken,
          reasonCode: response.reasonCode,
        });
        return response;
      }
      if (response.state === "downstream_outcome_unknown" || response.state === "reconciliation_required") {
        await deps.dispatch.markInDoubt({
          organizationId: reservation.identity.organizationId,
          submissionId: reservation.identity.submissionId,
          dispatchToken: reservation.identity.dispatchToken,
          reasonCode: "GATEWAY_RECONCILIATION_REQUIRED",
        });
        return response;
      }
      if (response.state === "mac_transport_rejected") {
        await deps.dispatch.finishKnownNotSent({
          organizationId: reservation.identity.organizationId,
          submissionId: reservation.identity.submissionId,
          dispatchToken: reservation.identity.dispatchToken,
          reasonCode: "GATEWAY_MAC_TRANSPORT_REJECTED",
        });
        return response;
      }
      await deps.dispatch.finishTransportReceipt({
        organizationId: reservation.identity.organizationId,
        submissionId: reservation.identity.submissionId,
        dispatchToken: reservation.identity.dispatchToken,
        receiptReference: response.receipt.receiptId,
        correlationId: response.receipt.gatewayOperationId,
        receivedAt: new Date(response.receipt.recordedAt),
      });
      return response;
    },

    /** Evidence is returned for an explicit reconciliation workflow; this method never mutates an in-doubt attempt. */
    lookup(identity: MedicareNoticeDispatchIdentity) {
      return deps.gateway.lookupByClientDispatch({
        clientDispatchId: identity.dispatchToken,
        artifactSha256: identity.artifactSha256,
        accountReference: identity.accountReference,
        jurisdiction: identity.jurisdiction,
        organizationReference: identity.organizationId,
        providerReference: identity.providerEntityId,
        submissionReference: identity.submissionId,
        renderReference: identity.renderIdentityId,
        artifactReference: identity.artifactId,
        usage: identity.usage,
        control: {
          interchangeControlNumber: identity.interchangeControlNumber,
          functionalGroupControlNumber: String(Number(identity.interchangeControlNumber)),
          transactionSetControlNumber: String(Number(identity.interchangeControlNumber)).padStart(4, "0"),
          businessControlNumber: identity.controlNumber,
        },
      });
    },
  };
}
