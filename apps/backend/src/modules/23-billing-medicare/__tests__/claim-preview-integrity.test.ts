import { describe, expect, it } from "vitest";
import {
  CLAIM_PREVIEW_TOKEN_TTL_MS,
  fingerprintClaim837iBusinessInput,
  issueClaimPreviewToken,
  verifyClaimPreviewToken,
  reviewedClaimSourceIsStale,
} from "../services/claim-preview-integrity";

const key = "unit-test-preview-integrity-key-32chars";
const binding = { organizationId: "org-a", claimId: "claim-a", providerEntityId: "provider-a", claimVersion: 7,
  accountReference: "shared-test-account", usage: "test" as const, payerId: "payer-a", routeFingerprint: "a".repeat(64) };

describe("M23 reviewed claim preview integrity", () => {
  it("canonicalizes object key order and excludes per-send envelope identifiers", () => {
    const left = { subscriber: { mbi: "SYNTHETIC", name: "TEST" }, claim: { lines: [{ chargeCents: 100, units: 1 }], controlNumber: "preview" }, envelope: { interchangeControlNumber: 1 } };
    const right = { envelope: { interchangeControlNumber: 999 }, claim: { controlNumber: "send", lines: [{ units: 1, chargeCents: 100 }] }, subscriber: { name: "TEST", mbi: "SYNTHETIC" } };
    expect(fingerprintClaim837iBusinessInput(left, key, binding)).toBe(fingerprintClaim837iBusinessInput(right, key, binding));
  });

  it("changes for material business, payer-route, account or environment changes without exposing MBI", () => {
    const input = { subscriber: { mbi: "SYNTHETIC-MBI-ONLY" }, claim: { total: 10 } };
    const fingerprint = fingerprintClaim837iBusinessInput(input, key, binding);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("SYNTHETIC");
    expect(fingerprintClaim837iBusinessInput({ ...input, claim: { total: 11 } }, key, binding)).not.toBe(fingerprint);
    expect(fingerprintClaim837iBusinessInput(input, key, { ...binding, usage: "production" })).not.toBe(fingerprint);
  });

  it("covers rendered coverage, beneficiary, provider, diagnosis, service and route facts", () => {
    const input = {
      subscriber: { mbi: "SYNTHETIC-MBI-ONLY", payerId: "MEDICARE" },
      billingProvider: { npi: "1999999991", tin: "999999999", legalName: "SYNTHETIC HOSPICE" },
      claim: { serviceFrom: "2026-10-01", serviceTo: "2026-10-31", diagnoses: ["Z51.5"], lines: [{ revenueCode: "0651", chargeCents: 10000 }] },
    };
    const fingerprint = fingerprintClaim837iBusinessInput(input, key, binding);
    const changed = [
      { ...input, subscriber: { ...input.subscriber, mbi: "SYNTHETIC-MBI-CHANGED" } },
      { ...input, subscriber: { ...input.subscriber, payerId: "OTHER-PAYER" } },
      { ...input, billingProvider: { ...input.billingProvider, npi: "1888888888" } },
      { ...input, billingProvider: { ...input.billingProvider, tin: "888888888" } },
      { ...input, claim: { ...input.claim, diagnoses: ["R69"] } },
      { ...input, claim: { ...input.claim, serviceTo: "2026-11-01" } },
      { ...input, claim: { ...input.claim, lines: [{ revenueCode: "0651", chargeCents: 10001 }] } },
    ];
    for (const variant of changed) expect(fingerprintClaim837iBusinessInput(variant, key, binding)).not.toBe(fingerprint);
    expect(fingerprintClaim837iBusinessInput(input, key, { ...binding, routeFingerprint: "c".repeat(64) })).not.toBe(fingerprint);
    expect(fingerprintClaim837iBusinessInput(input, key, { ...binding, accountReference: "another-test-account" })).not.toBe(fingerprint);
  });

  it("binds a short-lived confirmation to organization, claim, provider and actor", () => {
    const issuedAt = 1_000_000;
    const token = issueClaimPreviewToken({ ...binding, actorUserId: "actor-a", sourceFingerprint: "b".repeat(64),
      issuedAt, expiresAt: issuedAt + CLAIM_PREVIEW_TOKEN_TTL_MS }, key);
    expect(token).not.toContain("SYNTHETIC");
    expect(token).not.toContain("org-a");
    expect(token).not.toContain("actor-a");
    expect(verifyClaimPreviewToken(token, key, { organizationId: "org-a", claimId: "claim-a", providerEntityId: "provider-a", actorUserId: "actor-a" }, issuedAt + 1)).not.toBeNull();
    expect(verifyClaimPreviewToken(token, key, { organizationId: "org-b", claimId: "claim-a", providerEntityId: "provider-a", actorUserId: "actor-a" }, issuedAt + 1)).toBeNull();
    expect(verifyClaimPreviewToken(token, key, { organizationId: "org-a", claimId: "claim-a", providerEntityId: "provider-a", actorUserId: "actor-b" }, issuedAt + 1)).toBeNull();
    const tokenParts = token.split(".");
    tokenParts[2] = `${tokenParts[2]![0] === "A" ? "B" : "A"}${tokenParts[2]!.slice(1)}`;
    expect(verifyClaimPreviewToken(tokenParts.join("."), key, { organizationId: "org-a", claimId: "claim-a", providerEntityId: "provider-a", actorUserId: "actor-a" }, issuedAt + 1)).toBeNull();
    expect(verifyClaimPreviewToken(token, key, { organizationId: "org-a", claimId: "claim-a", providerEntityId: "provider-a", actorUserId: "actor-a" }, issuedAt + CLAIM_PREVIEW_TOKEN_TTL_MS)).toBeNull();
  });

  it("holds mismatched, uncomputable, or missing Claim.MD review identities", () => {
    expect(reviewedClaimSourceIsStale("a".repeat(64), "a".repeat(64), true)).toBe(false);
    expect(reviewedClaimSourceIsStale("a".repeat(64), "b".repeat(64), true)).toBe(true);
    expect(reviewedClaimSourceIsStale("a".repeat(64), null, false)).toBe(true);
    expect(reviewedClaimSourceIsStale(null, "a".repeat(64), true)).toBe(true);
    expect(reviewedClaimSourceIsStale(null, null, false)).toBe(false);
  });
});
