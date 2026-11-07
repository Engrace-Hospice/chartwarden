import { timingSafeEqual } from "node:crypto";

/** Deterministic identity resolution only. This module never applies acknowledgments or changes claim state. */
export type BillingModule = "M23" | "M24" | "M41";
export type ResolutionState = "pending" | "resolved" | "unmatched" | "ambiguous" | "conflict" | "needs_review";
export type ResolutionReason =
  | "NO_MATCHING_SUBMISSION"
  | "MULTIPLE_CANDIDATES"
  | "PROVIDER_IDENTITY_MISMATCH"
  | "TENANT_OWNERSHIP_CONFLICT"
  | "PAYER_MISMATCH"
  | "MISSING_STRONG_IDENTIFIERS"
  | "UNKNOWN_EXTERNAL_CLAIM"
  | "HISTORICAL_IDENTITY_UNAVAILABLE"
  | "EXTERNAL_IDENTIFIER_CONFLICT"
  | "MALFORMED_SOURCE_EVENT"
  | "CANDIDATE_LIMIT_EXCEEDED"
  | "RESOLUTION_RETRY_EXHAUSTED"
  | "OPERATOR_REQUEUED";

export interface ClaimMdIdentityEvent {
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly responseId: string | null;
  readonly claimMdClaimId: string | null;
  readonly remoteClaimId: string | null;
  readonly claimId: string | null;
  readonly fileId: string | null;
  readonly batchId: string | null;
  readonly pcn: string | null;
  readonly billingNpi: string | null;
  readonly billingTin: string | null;
  readonly payerId: string | null;
  readonly claimType: string | null;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly malformed?: boolean;
}

/** Candidate data comes only from server-owned outbound history; no external tenant/provider ids are accepted. */
export interface SubmissionCandidate {
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId?: string | null;
  readonly claimId: string;
  /** Immutable evidence row is the send-attempt identity for this integration. */
  readonly evidenceId?: string;
  readonly transportAttemptId?: string;
  readonly payloadSha256?: string;
  readonly isa13?: string;
  readonly gs06?: string;
  readonly st02?: string;
  readonly evidenceSource?: "claimmd_submission_evidence";
  readonly module: BillingModule;
  readonly submissionId: string;
  readonly submissionAttemptId: string;
  readonly receiptId: string | null;
  readonly claimMdClaimId: string | null;
  readonly vendorClaimId?: string | null;
  readonly remoteClaimId: string | null;
  readonly fileId: string | null;
  readonly batchId: string | null;
  readonly pcn: string;
  readonly billingNpiAtSend: string | null;
  /** Decrypted only in memory for exact comparison; never persisted or logged by this module. */
  readonly billingTinAtSend: string | null;
  readonly payerId: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  /** The adapter has proved this submission was sent through Claim.MD in the given account. */
  readonly verifiedClaimMdRoute: boolean;
  /** Exact vendor field provenance; namespace/value pairs are never cross-compared. */
  readonly vendorIdentifiers?: readonly { readonly field: string; readonly namespace: string; readonly value: string }[];
}

export interface ResolvedCandidate {
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId?: string | null;
  readonly claimId: string;
  readonly evidenceId?: string;
  readonly transportAttemptId?: string;
  readonly payloadSha256?: string;
  readonly module: BillingModule;
  readonly submissionId: string;
  readonly submissionAttemptId: string;
}

export interface IdentityResolution {
  readonly state: ResolutionState;
  readonly reason: ResolutionReason | null;
  readonly strategy: "external_claim_id" | "submission_receipt" | "strict_composite" | null;
  readonly candidate: ResolvedCandidate | null;
  readonly algorithmVersion: "bil1.2.v1";
}

const same = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;
const sameSensitive = (a: string | null, b: string | null): boolean => {
  if (a === null || b === null) return false;
  const left = Buffer.from(a, "utf8"); const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};
const scoped = (event: ClaimMdIdentityEvent, candidates: readonly SubmissionCandidate[]) =>
  candidates.filter((c) => c.accountReference === event.accountReference && c.usage === event.usage && c.verifiedClaimMdRoute);
const unique = <T>(values: readonly T[]): T | null => values.length === 1 ? values[0]! : null;
const vendorMatch = (candidate: SubmissionCandidate, field: string, value: string | null): boolean => {
  if (value === null) return false;
  const exact = candidate.vendorIdentifiers?.some((entry) => entry.field === field && entry.value === value) ?? false;
  if (exact) return true;
  // Legacy injected candidate sources remain source-compatible, with field-specific aliases only.
  if (field === "claimmd_id") return candidate.claimMdClaimId === value;
  if (field === "remote_claimid") return candidate.remoteClaimId === value;
  if (field === "claimid") return candidate.vendorClaimId === value;
  return false;
};
const idKey = (candidate: SubmissionCandidate, event: ClaimMdIdentityEvent): boolean =>
  vendorMatch(candidate, "claimmd_id", event.claimMdClaimId) ||
  vendorMatch(candidate, "remote_claimid", event.remoteClaimId) ||
  vendorMatch(candidate, "claimid", event.claimId);

const receiptMatch = (candidate: SubmissionCandidate, event: ClaimMdIdentityEvent): boolean => {
  if (event.pcn === null || candidate.pcn !== event.pcn) return false;
  const exact = (field: string, value: string | null) => value !== null &&
    (candidate.vendorIdentifiers?.some((entry) => entry.field === field && entry.value === value) ?? false);
  return exact("fileid", event.fileId) || exact("batchid", event.batchId) ||
    (!candidate.vendorIdentifiers && ((event.fileId !== null && candidate.fileId === event.fileId) ||
      (event.batchId !== null && candidate.batchId === event.batchId)));
};

function contradiction(event: ClaimMdIdentityEvent, candidate: SubmissionCandidate): ResolutionReason | null {
  if (event.pcn !== null && event.pcn !== candidate.pcn) return "EXTERNAL_IDENTIFIER_CONFLICT";
  if (event.billingNpi !== null && candidate.billingNpiAtSend === null) return "HISTORICAL_IDENTITY_UNAVAILABLE";
  if (!same(event.billingNpi, candidate.billingNpiAtSend) && event.billingNpi !== null) return "PROVIDER_IDENTITY_MISMATCH";
  if (event.billingTin !== null && candidate.billingTinAtSend === null) return "HISTORICAL_IDENTITY_UNAVAILABLE";
  if (!sameSensitive(event.billingTin, candidate.billingTinAtSend) && event.billingTin !== null) return "PROVIDER_IDENTITY_MISMATCH";
  if (event.payerId !== null && !same(event.payerId, candidate.payerId)) return "PAYER_MISMATCH";
  if (event.claimType !== null && !same(event.claimType, candidate.claimType)) return "EXTERNAL_IDENTIFIER_CONFLICT";
  if (event.serviceFrom !== null && candidate.serviceFrom !== null && !same(event.serviceFrom, candidate.serviceFrom)) return "EXTERNAL_IDENTIFIER_CONFLICT";
  if (event.serviceTo !== null && candidate.serviceTo !== null && !same(event.serviceTo, candidate.serviceTo)) return "EXTERNAL_IDENTIFIER_CONFLICT";
  return null;
}

function target(candidate: SubmissionCandidate | null): ResolvedCandidate | null {
  if (!candidate) return null;
  return { accountReference: candidate.accountReference, usage: candidate.usage, organizationId: candidate.organizationId,
    providerEntityId: candidate.providerEntityId, locationId: candidate.locationId ?? null, claimId: candidate.claimId,
    evidenceId: candidate.evidenceId, transportAttemptId: candidate.transportAttemptId,
    payloadSha256: candidate.payloadSha256, module: candidate.module,
    submissionId: candidate.submissionId, submissionAttemptId: candidate.submissionAttemptId };
}
function outcome(state: ResolutionState, reason: ResolutionReason | null, strategy: IdentityResolution["strategy"] = null, candidate: SubmissionCandidate | null = null): IdentityResolution {
  return { state, reason, strategy, candidate: target(candidate), algorithmVersion: "bil1.2.v1" };
}

/** Exact associations first; weak or contradictory identity evidence never authorizes a tenant assignment. */
export function resolveClaimMdIdentity(event: ClaimMdIdentityEvent, allCandidates: readonly SubmissionCandidate[], complete = true): IdentityResolution {
  if (event.malformed) return outcome("needs_review", "MALFORMED_SOURCE_EVENT");
  if (!complete) return outcome("ambiguous", "CANDIDATE_LIMIT_EXCEEDED");
  const candidates = scoped(event, allCandidates);
  const external = candidates.filter((candidate) => idKey(candidate, event));
  const receipt = candidates.filter((candidate) => receiptMatch(candidate, event));
  const externalTargets = new Set(external.map((c) => c.evidenceId ?? c.submissionAttemptId));
  const receiptTargets = new Set(receipt.map((c) => c.evidenceId ?? c.submissionAttemptId));
  if (externalTargets.size && receiptTargets.size && [...externalTargets].some((id) => !receiptTargets.has(id)))
    return outcome("conflict", "EXTERNAL_IDENTIFIER_CONFLICT", "external_claim_id");
  if (external.length > 1) return outcome("ambiguous", "MULTIPLE_CANDIDATES", "external_claim_id");
  const exactExternal = unique(external);
  if (exactExternal) {
    const issue = contradiction(event, exactExternal);
    return issue ? outcome(issue === "HISTORICAL_IDENTITY_UNAVAILABLE" ? "needs_review" : "conflict", issue, "external_claim_id")
      : outcome("resolved", null, "external_claim_id", exactExternal);
  }

  const scopedReceipt = receipt.filter((candidate) => event.pcn === null || candidate.pcn === event.pcn);
  if (scopedReceipt.length > 1) return outcome("ambiguous", "MULTIPLE_CANDIDATES", "submission_receipt");
  const exactReceipt = unique(scopedReceipt);
  if (exactReceipt) {
    const issue = contradiction(event, exactReceipt);
    return issue ? outcome(issue === "HISTORICAL_IDENTITY_UNAVAILABLE" ? "needs_review" : "conflict", issue, "submission_receipt")
      : outcome("resolved", null, "submission_receipt", exactReceipt);
  }

  // Fallback is intentionally strict. PCN, NPI, or TIN alone can never select a candidate.
  if (!event.pcn || !event.billingNpi || !event.billingTin || !event.payerId || !event.claimType || !event.serviceFrom || !event.serviceTo) {
    return outcome("needs_review", "MISSING_STRONG_IDENTIFIERS");
  }
  const composite = candidates.filter((candidate) => candidate.pcn === event.pcn && candidate.billingNpiAtSend !== null &&
    candidate.billingTinAtSend !== null && candidate.billingNpiAtSend === event.billingNpi && sameSensitive(candidate.billingTinAtSend, event.billingTin) &&
    candidate.payerId === event.payerId && candidate.claimType === event.claimType && candidate.serviceFrom === event.serviceFrom &&
    candidate.serviceTo === event.serviceTo);
  if (composite.length > 1) return outcome("ambiguous", "MULTIPLE_CANDIDATES", "strict_composite");
  const strict = unique(composite);
  if (strict) return outcome("resolved", null, "strict_composite", strict);
  if (candidates.some((candidate) => candidate.pcn === event.pcn)) return outcome("conflict", "EXTERNAL_IDENTIFIER_CONFLICT", "strict_composite");
  return outcome("unmatched", candidates.length === 0 ? "NO_MATCHING_SUBMISSION" : "UNKNOWN_EXTERNAL_CLAIM");
}
