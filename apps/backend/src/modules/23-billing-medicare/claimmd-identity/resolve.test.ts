import { describe, expect, it } from "vitest";
import { resolveClaimMdIdentity, type ClaimMdIdentityEvent, type SubmissionCandidate } from "./resolve";

const event: ClaimMdIdentityEvent = {
  accountReference: "acct-synthetic", usage: "test", responseId: "9001", claimMdClaimId: "vendor-claim-a",
  remoteClaimId: "cw-clm-a", claimId: "cw-clm-a", fileId: "synthetic-file-a", batchId: "batch-a",
  pcn: "SYNTH-PCN-001", billingNpi: "1234567893", billingTin: "123456789", payerId: "SYN-PAYER-A",
  claimType: "837I", serviceFrom: "2026-01-01", serviceTo: "2026-01-31",
};
const candidate: SubmissionCandidate = {
  accountReference: "acct-synthetic", usage: "test", organizationId: "org-a", providerEntityId: "provider-a",
  claimId: "claim-a", module: "M23", submissionId: "submission-a", submissionAttemptId: "attempt-a",
  receiptId: "file:synthetic-file-a", claimMdClaimId: "vendor-claim-a", remoteClaimId: "cw-clm-a",
  fileId: "synthetic-file-a", batchId: "batch-a", pcn: "SYNTH-PCN-001", billingNpiAtSend: "1234567893",
  billingTinAtSend: "123456789", payerId: "SYN-PAYER-A", claimType: "837I", serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31", verifiedClaimMdRoute: true,
};

describe("Claim.MD deterministic identity resolution", () => {
  it("resolves exact vendor claim IDs only within matching account/environment and validates all supplied identity fields", () => {
    expect(resolveClaimMdIdentity(event, [candidate])).toMatchObject({ state: "resolved", strategy: "external_claim_id", candidate: {organizationId:"org-a",providerEntityId:"provider-a",claimId:"claim-a",module:"M23",submissionId:"submission-a",submissionAttemptId:"attempt-a",accountReference:"acct-synthetic",usage:"test"} });
    expect(resolveClaimMdIdentity({ ...event, usage: "production" }, [candidate])).toMatchObject({ state: "unmatched" });
    expect(resolveClaimMdIdentity({ ...event, accountReference: "other-account" }, [candidate])).toMatchObject({ state: "unmatched" });
  });
  it("uses file receipt correlation before PCN and blocks conflicting provider, payer, and historical identity", () => {
    const noVendorClaimId = { ...event, claimMdClaimId: null, remoteClaimId: null, claimId: null };
    expect(resolveClaimMdIdentity(noVendorClaimId, [candidate])).toMatchObject({ state: "resolved", strategy: "submission_receipt" });
    expect(resolveClaimMdIdentity({ ...event, billingNpi: "9999999999" }, [candidate])).toMatchObject({ state: "conflict", reason: "PROVIDER_IDENTITY_MISMATCH" });
    expect(resolveClaimMdIdentity({ ...event, payerId: "WRONG" }, [candidate])).toMatchObject({ state: "conflict", reason: "PAYER_MISMATCH" });
    expect(resolveClaimMdIdentity(event, [{ ...candidate, billingNpiAtSend: null }])).toMatchObject({ state: "needs_review", reason: "HISTORICAL_IDENTITY_UNAVAILABLE" });
  });
  it("never routes on PCN, NPI, or TIN alone; strict composite must be unique", () => {
    expect(resolveClaimMdIdentity({ ...event, claimMdClaimId: null, remoteClaimId: null, claimId: null, fileId: null, batchId: null, billingTin: null }, [candidate])).toMatchObject({ state: "needs_review", reason: "MISSING_STRONG_IDENTIFIERS" });
    const c2 = { ...candidate, organizationId: "org-b", providerEntityId: "provider-b", claimId: "claim-b", submissionId: "sub-b", submissionAttemptId: "att-b", claimMdClaimId: null, remoteClaimId: null, fileId: null, batchId: null, receiptId: null };
    const fallback = { ...event, claimMdClaimId: null, remoteClaimId: null, claimId: null, fileId: null, batchId: null };
    expect(resolveClaimMdIdentity(fallback, [{ ...candidate, claimMdClaimId: null, remoteClaimId: null, fileId: null, batchId: null, receiptId: null }, c2])).toMatchObject({ state: "ambiguous", reason: "MULTIPLE_CANDIDATES" });
  });
  it("rejects unverified vendors and detects repeated-ID contradictions instead of selecting a tenant", () => {
    expect(resolveClaimMdIdentity(event, [{ ...candidate, verifiedClaimMdRoute: false }])).toMatchObject({ state: "unmatched" });
    expect(resolveClaimMdIdentity(event, [candidate, { ...candidate, organizationId: "org-b", providerEntityId: "provider-b", claimId: "claim-b", submissionId: "sub-b", submissionAttemptId: "att-b" }])).toMatchObject({ state: "ambiguous" });
  });
  it("keeps Claim.MD fields namespace-exact, refuses file-only claim assignment, and detects cross-identifier conflicts", () => {
    const candidateWithProvenance: SubmissionCandidate = { ...candidate, claimMdClaimId: null, remoteClaimId: null,
      vendorClaimId: null, fileId: null, batchId: null,
      vendorIdentifiers: [{ field: "claimmd_id", namespace: "remote_claim", value: "vendor-A" },
        { field: "fileid", namespace: "file", value: "file-A" }] };
    const wrongNamespace = { ...event, claimMdClaimId: null, remoteClaimId: null, fileId: null, batchId: null,
      pcn: null, billingNpi: null, billingTin: null, payerId: null, claimType: null, serviceFrom: null, serviceTo: null,
      claimId: "vendor-A" };
    expect(resolveClaimMdIdentity(wrongNamespace, [candidateWithProvenance])).toMatchObject({ state: "needs_review" });
    const fileOnly = { ...wrongNamespace, claimId: null, fileId: "file-A" };
    expect(resolveClaimMdIdentity(fileOnly, [candidateWithProvenance])).toMatchObject({ state: "needs_review", reason: "MISSING_STRONG_IDENTIFIERS" });
    const fileAndPcn = { ...fileOnly, pcn: candidate.pcn };
    expect(resolveClaimMdIdentity(fileAndPcn, [candidateWithProvenance])).toMatchObject({ state: "resolved", strategy: "submission_receipt" });
    const conflictingFile = { ...candidateWithProvenance, evidenceId: "evidence-b", submissionAttemptId: "attempt-b",
      vendorIdentifiers: [{ field: "fileid", namespace: "file", value: "file-B" }] };
    const conflictEvent = { ...event, claimMdClaimId: "vendor-A", fileId: "file-B" };
    expect(resolveClaimMdIdentity(conflictEvent, [candidateWithProvenance, conflictingFile])).toMatchObject({
      state: "conflict", reason: "EXTERNAL_IDENTIFIER_CONFLICT",
    });
  });
  it("does not infer uniqueness from an incomplete capped candidate search", () => {
    expect(resolveClaimMdIdentity(event, [candidate], false)).toMatchObject({ state: "ambiguous", reason: "CANDIDATE_LIMIT_EXCEEDED", candidate: null });
  });
});
