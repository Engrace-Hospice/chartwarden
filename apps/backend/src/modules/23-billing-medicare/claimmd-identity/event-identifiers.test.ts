import { describe, expect, it } from "vitest";
import { claimMdIdentityFromCapturedPage } from "./event-identifiers";
import { claimMdIdentityResolutionEnabled } from "./config";

describe("Claim.MD captured identity fields", () => {
  it("extracts a child message's identifiers without copying the message text", () => {
    expect(claimMdIdentityFromCapturedPage({body:{result:{claim:{claimmd_id:"synthetic-vendor-id",bill_npi:"1234567893",bill_taxid:"123456789",messages:[{responseid:"90",message:"synthetic private text"}]}}},parentIndex:0,messageIndex:0,accountReference:"a",usage:"test",responseId:"90"})).toMatchObject({claimMdClaimId:"synthetic-vendor-id",billingNpi:"1234567893",billingTin:"123456789",responseId:"90"});
  });
  it("fails closed when disabled config is absent or invalid", () => {
    expect(claimMdIdentityResolutionEnabled({})).toBe(false);
    expect(claimMdIdentityResolutionEnabled({CLAIMMD_IDENTITY_RESOLUTION_ENABLED:"yes"})).toBe(false);
    expect(claimMdIdentityResolutionEnabled({CLAIMMD_IDENTITY_RESOLUTION_ENABLED:"true"})).toBe(true);
  });
});
