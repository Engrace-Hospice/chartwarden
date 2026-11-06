import { describe, expect, it } from "vitest";
import { candidateAttemptKeyIsValid, isVerifiedM23SubmissionEvidence, isVerifiedM41SubmissionEvidence, isVerifiedReceiptObservation } from "./candidate-provider";

const org = "10000000-0000-4000-8000-000000000001";
const provider = "20000000-0000-4000-8000-000000000001";
const claim = "30000000-0000-4000-8000-000000000001";
const submission = "40000000-0000-4000-8000-000000000001";
const location = "50000000-0000-4000-8000-000000000001";
const attempt = { organizationId: org, providerEntityId: provider, usage: "test", controlNumber: "SYNTH-PCN-1", kind: "claim", status: "sent" };

describe("BIL-1.2.2B M23/M41 candidate evidence verification", () => {
  it("accepts only the exact M23 claim submission, provider, PCN and attempt index", () => {
    const input = { organizationId: org, providerEntityId: provider, claimId: claim, submissionId: submission,
      attemptKey: `${submission}:2`, pcn: "SYNTH-PCN-1", source: { id: submission, organizationId: org,
        providerEntityId: provider, claimId: claim, kind: "claim_837i", controlNumber: "SYNTH-PCN-1", attemptIndex: 2 },
      transportAttempt: attempt };
    expect(isVerifiedM23SubmissionEvidence(input)).toBe(true);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, organizationId: "60000000-0000-4000-8000-000000000001" } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, attemptIndex: 1 } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, source: { ...input.source, kind: "noe" } })).toBe(false);
    expect(isVerifiedM23SubmissionEvidence({ ...input, transportAttempt: { ...attempt, status: "released" } })).toBe(false);
  });

  it("accepts M41's exact historical submission row and its provider/location/payer route", () => {
    const input = { organizationId: org, providerEntityId: provider, locationId: location, claimId: claim,
      submissionId: submission, attemptKey: `${submission}:3`, pcn: "SYNTH-PCN-2", payerId: "SYNTH-PAYER-A",
      source: { id: submission, organizationId: org, providerEntityId: provider, locationId: location,
        claimId: claim, controlNumber: "SYNTH-PCN-2", payerId: "SYNTH-PAYER-A", vendor: "claimmd" },
      transportAttempt: { ...attempt, controlNumber: "SYNTH-PCN-2" } };
    expect(isVerifiedM41SubmissionEvidence(input)).toBe(true);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, providerEntityId: org } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, payerId: "SYNTH-PAYER-B" } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, locationId: null } })).toBe(false);
    expect(isVerifiedM41SubmissionEvidence({ ...input, source: { ...input.source, vendor: "stedi" } })).toBe(false);
    // Current provider profile is deliberately not an input to this historical evidence verifier.
  });

  it("keeps vendor receipt fields in separate namespaces and validates attempt-key shape", () => {
    expect(candidateAttemptKeyIsValid("M23", submission, `${submission}:0`, 0)).toBe(true);
    expect(candidateAttemptKeyIsValid("M23", submission, `${submission}:1`, 0)).toBe(false);
    expect(candidateAttemptKeyIsValid("M41", submission, `${submission}:4`, null)).toBe(true);
    expect(candidateAttemptKeyIsValid("M41", submission, `${claim}:4`, null)).toBe(false);
    expect(isVerifiedReceiptObservation("fileid", "file")).toBe(true);
    expect(isVerifiedReceiptObservation("inboundid", "file")).toBe(true);
    expect(isVerifiedReceiptObservation("claimid", "claim")).toBe(true);
    expect(isVerifiedReceiptObservation("claimid", "remote_claim")).toBe(false);
    expect(isVerifiedReceiptObservation("responseid", "message")).toBe(false);
    expect(isVerifiedReceiptObservation("clearinghouseSubmissionId", "opaque_submission")).toBe(false);
  });
});
