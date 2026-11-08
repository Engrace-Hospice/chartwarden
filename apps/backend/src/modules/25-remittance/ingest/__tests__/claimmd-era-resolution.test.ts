import { describe, expect, it } from "vitest";
import { decideClaimMdEraOwnership, isVerifiedM41EraSubmissionFact } from "../claimmd-era-resolution";
import type { ClaimMdEraSubmissionFact } from "../../../23-billing-medicare/claimmd-identity/era-evidence-reader";

const ORG_A = "00000000-0000-4000-8000-000000000001";
const ORG_B = "00000000-0000-4000-8000-000000000002";
const PROVIDER_A = "00000000-0000-4000-8000-000000000011";
const PROVIDER_B = "00000000-0000-4000-8000-000000000022";
const LOCATION_1 = "00000000-0000-4000-8000-000000000031";
const ACCOUNT = "synthetic-account";

function raw835(input: { readonly npi?: string; readonly tin?: string; readonly payeeQualifier?: "XX" | "FI"; readonly payeeId?: string } = {}) {
  const body = ["BPR*I*0.00*C*NON*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
    "TRN*1*TRACE-SYNTH*1512345678", "N1*PR*SYNTHETIC PAYER*XV*99999",
    "N1*PE*SYNTHETIC HOSPICE*" + (input.payeeQualifier ?? "XX") + "*" + (input.payeeId ?? input.npi ?? "1999999999"),
    ...(input.tin ? ["REF*TJ*" + input.tin] : []),
    "CLP*PCN-0001*4*0.00*0.00*0.00*MC*ICN-SYNTH", "CAS*CO*45*0.00"];
  const isa13 = "100000001";
  const isa = ["ISA", "00", " ".repeat(10), "00", " ".repeat(10), "ZZ", "SYNTHMAC".padEnd(15),
    "ZZ", "SYNTHHOSPICE".padEnd(15), "260616", "1200", "^", "00501", isa13, "0", "T", ":"].join("*");
  const segments = ["GS*HP*SYNTHMAC*SYNTHHOSPICE*20260616*1200*77*X*005010X221A1",
    "ST*835*0001", ...body, "SE*" + (body.length + 2) + "*0001", "GE*1*77", "IEA*1*" + isa13];
  return isa + "~" + segments.map((segment) => segment + "~").join("");
}

function fact(input: Partial<ClaimMdEraSubmissionFact> & Pick<ClaimMdEraSubmissionFact, "organizationId" | "providerEntityId" | "billingNpi" | "billingTin" | "pcn">): ClaimMdEraSubmissionFact {
  return { id: input.id ?? "00000000-0000-4000-8000-000000000101", organizationId: input.organizationId,
    providerEntityId: input.providerEntityId, locationId: input.locationId ?? LOCATION_1,
    claimId: input.claimId ?? "00000000-0000-4000-8000-000000000201", billingModule: input.billingModule ?? "M23",
    billingNpi: input.billingNpi, billingTin: input.billingTin, payerId: input.payerId ?? "SYNTH-PAYER", pcn: input.pcn,
    claimType: input.claimType ?? "837I", serviceFrom: input.serviceFrom ?? "2026-01-01", serviceTo: input.serviceTo ?? "2026-01-31",
    accountReference: ACCOUNT, usage: "test", submissionId: input.submissionId ?? "00000000-0000-4000-8000-000000000099",
    attemptKey: input.attemptKey ?? "synthetic-attempt" };
}
const ownerMap = new Map([[PROVIDER_A, ORG_A], [PROVIDER_B, ORG_B]]);
const baseFacts = () => [fact({ organizationId: ORG_A, providerEntityId: PROVIDER_A,
  billingNpi: "1999999999", billingTin: "987654321", pcn: "PCN-0001" })];

describe("BIL-1.4.1A parsed ERA ownership", () => {
  it("requires M41 owner-reader facts to agree with the immutable send evidence", () => {
    const commercial = fact({ organizationId: ORG_A, providerEntityId: PROVIDER_A, billingNpi: "1999999999",
      billingTin: "987654321", pcn: "PCN-0001", billingModule: "M41" });
    const source = { id: commercial.submissionId, organizationId: ORG_A, providerEntityId: PROVIDER_A,
      locationId: commercial.locationId, claimId: commercial.claimId, controlNumber: commercial.pcn,
      payerId: commercial.payerId, vendor: "claimmd" };
    expect(isVerifiedM41EraSubmissionFact(commercial, source)).toBe(true);
    expect(isVerifiedM41EraSubmissionFact(commercial, { ...source, organizationId: ORG_B })).toBe(false);
  });

  it("verifies historical payee ownership independently from exact claim correlation", () => {
    const result = decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835({ tin: "987654321" })],
      evidenceComplete: true, evidence: baseFacts(), ownerByProvider: ownerMap });
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.organizationId).toBe(ORG_A);
    expect(result.providerEntityId).toBe(PROVIDER_A);
    expect(result.locationId).toBe(LOCATION_1);
    expect((result.decision.claims as { outcome: string }[]).map((claim) => claim.outcome)).toEqual(["verified"]);
  });

  it("returns unresolved when the bounded candidate query is capped", () => {
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835()],
      evidenceComplete: false, evidence: baseFacts(), ownerByProvider: ownerMap }))
      .toMatchObject({ status: "needs_review", reasonCode: "EVIDENCE_CANDIDATE_LIMIT" });
  });

  it("holds TIN contradiction and same-PCN evidence owned by another tenant", () => {
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835({ tin: "111111111" })],
      evidenceComplete: true, evidence: baseFacts(), ownerByProvider: ownerMap }))
      .toMatchObject({ status: "conflict", reasonCode: "PAYEE_IDENTITY_CONFLICT" });
    const evidence = [...baseFacts(), fact({ id: "00000000-0000-4000-8000-000000000102", claimId: "00000000-0000-4000-8000-000000000202",
      organizationId: ORG_B, providerEntityId: PROVIDER_B, billingNpi: "1888888888", billingTin: "111111111", pcn: "PCN-0001" })];
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835({ tin: "987654321" })],
      evidenceComplete: true, evidence, ownerByProvider: ownerMap }))
      .toMatchObject({ status: "conflict", reasonCode: "CLAIM_OWNER_CONFLICT" });
  });

  it("holds contradictory payee FI and tax-id values before historical matching", () => {
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test",
      files: [raw835({ payeeQualifier: "FI", payeeId: "123456789", tin: "987654321" })],
      evidenceComplete: true, evidence: baseFacts(), ownerByProvider: ownerMap }))
      .toMatchObject({ status: "conflict", reasonCode: "PAYEE_IDENTITY_SELF_CONFLICT" });
  });

  it("fails closed for malformed, unknown, or wrongly owned source evidence", () => {
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: ["not x12"],
      evidenceComplete: true, evidence: [], ownerByProvider: ownerMap }).status).toBe("invalid_source");
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835({ npi: "1777777777" })],
      evidenceComplete: true, evidence: baseFacts(), ownerByProvider: ownerMap }).status).toBe("unmatched");
    expect(decideClaimMdEraOwnership({ accountReference: ACCOUNT, usage: "test", files: [raw835()], evidenceComplete: true,
      evidence: baseFacts().map((row) => ({ ...row, organizationId: ORG_B })), ownerByProvider: ownerMap }).status).toBe("unmatched");
  });
});
