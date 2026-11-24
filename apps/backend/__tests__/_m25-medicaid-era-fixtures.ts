// Synthetic fixtures (NO PHI) shared by the production-account Medicaid ERA review suites. Control numbers, payer ids
// and NPIs are invented; the account is `usage: "production"` so the evaluator cannot short-circuit on the test guard.
import { createHash } from "node:crypto";
import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import { wrap835, wrap835Sets } from "../../../packages/x12-835-client/__tests__/fixtures-835";
import { observeParsedMedicaidEra } from "../src/modules/25-remittance/domain/medicaid-era-observation";
import {
  type AuthenticatedMedicaidEraSource,
  type MedicaidEraAccountEvidence,
  type MedicaidEraAttribution,
  type MedicaidEraClaimCandidate,
  resolveMedicaidEraAttribution,
} from "../src/modules/25-remittance/domain/medicaid-era-trusted-review";
import type { M25ReadActor } from "../src/modules/25-remittance/routes/actor";

export const header = (trace = "EFT0001"): readonly string[] => [
  `TRN*1*${trace}*1512345678`,
  "REF*EV*RECV01",
  "DTM*405*20260616",
  "N1*PR*SYNTHETIC MAC*XV*99999",
  "N3*1 TEST WAY",
  "N4*TESTVILLE*ZZ*00000",
  "N1*PE*SYNTH HOSPICE*XX*1999999999",
  "LX*1",
];

export const bpr = (amount: string): string =>
  `BPR*C*${amount}*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`;

/** A fully paid claim PCN-0001 / ICN-A1 for 2026-05-01..2026-05-31 (CLP03 = CLP04). */
export const paidClaim = (
  pcn = "PCN-0001",
  icn = "ICN-A1",
  amount = "1000.00",
): readonly string[] => [
  `CLP*${pcn}*1*${amount}*${amount}*0.00*MC*${icn}`,
  "DTM*232*20260501",
  "DTM*233*20260531",
];

/** One transaction set body: BPR + header + the given claim/PLB segments. */
export const setBody = (
  payment: string,
  segments: readonly string[],
  trace = "EFT0001",
): readonly string[] => [bpr(payment), ...header(trace), ...segments];

export const parseProduction = (raw: string) => {
  const parsed = parseX12835AllSets(raw, "medicaid", { allowTestFiles: false });
  if (!parsed.ok) throw new Error(parsed.degraded.code);
  return parsed.value.map(observeParsedMedicaidEra);
};

export const singleSet = (body: readonly string[] = setBody("1000.00", paidClaim())) => {
  const raw = wrap835(body);
  return { raw, observation: parseProduction(raw)[0]! };
};

export const multiSet = (sets: readonly (readonly [string, readonly string[]])[]) => {
  const raw = wrap835Sets(sets);
  return { raw, observations: parseProduction(raw) };
};

export const sourceFor = (raw: string): AuthenticatedMedicaidEraSource => ({
  vendor: "claimmd",
  accountReference: "synthetic:account-1",
  usage: "production",
  artifactReference: "synthetic:artifact-prod-1",
  artifactDigest: createHash("sha256").update(raw, "utf8").digest("hex"),
  receivedAt: "2026-11-22T12:00:00.000Z",
});

export const productionAccount: MedicaidEraAccountEvidence = {
  organizationId: "org-synthetic-1",
  providerEntityId: "provider-synthetic-1",
  vendor: "claimmd",
  accountReference: "synthetic:account-1",
  usage: "production",
  canonicalPayerId: "payer-synthetic-oregon",
  programId: "program-synthetic-oregon-ccp",
  acceptedPayerIdentifiers: [{ qualifier: "XV", identifier: "99999" }],
  billingNpi: "1999999999",
  billingTin: null,
  enrollment: "verified_active",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceReference: "synthetic:evidence-1",
  verifiedAt: "2026-11-20T00:00:00.000Z",
  evidenceFreshUntil: "2026-12-20T00:00:00.000Z",
  sourceEvidenceFingerprint: "a".repeat(64),
};

export const productionActor: M25ReadActor = {
  organizationId: "org-synthetic-1",
  userId: "synthetic-user-1",
  roles: ["billing_staff"],
  providerEntityScope: ["provider-synthetic-1"],
};

export const verifiedAttribution = (
  raw: string,
  observation = singleSet().observation,
  account: MedicaidEraAccountEvidence = productionAccount,
): Extract<MedicaidEraAttribution, { status: "verified" }> => {
  const attribution = resolveMedicaidEraAttribution({
    source: sourceFor(raw),
    observation,
    accounts: [account],
  });
  if (attribution.status !== "verified") throw new Error(`fixture held: ${attribution.reason}`);
  return attribution;
};

export const submittedCandidate = (
  overrides: Partial<MedicaidEraClaimCandidate> = {},
): MedicaidEraClaimCandidate => ({
  organizationId: "org-synthetic-1",
  providerEntityId: "provider-synthetic-1",
  claimId: "claim-synthetic-1",
  canonicalPayerId: "payer-synthetic-oregon",
  programId: "program-synthetic-oregon-ccp",
  claimControlNumber: "PCN-0001",
  serviceFrom: "2026-05-01",
  serviceTo: "2026-05-31",
  claimVersion: 1,
  claimState: "ACK_ACCEPTED",
  replacementLineage: "original",
  submission: {
    status: "verified_submitted",
    submissionId: "submission-synthetic-1",
    claimId: "claim-synthetic-1",
    claimVersion: 1,
    claimControlNumber: "PCN-0001",
    payerClaimControlNumber: "ICN-A1",
    vendor: "claimmd",
    accountReference: "synthetic:account-1",
    transactionReference: "vendor-tx-synthetic-1",
  },
  sourceEvidenceFingerprint: "b".repeat(64),
  ...overrides,
});
