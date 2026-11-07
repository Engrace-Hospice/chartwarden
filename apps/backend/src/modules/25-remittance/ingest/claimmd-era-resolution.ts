import { createHash } from "node:crypto";
import { parseX12835AllSets, type ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";
import type { DbClient } from "@chartwarden/db";
import type { FoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import type { ClaimMdEraSubmissionFact } from "../../23-billing-medicare/claimmd-identity/era-evidence-reader";
import { resolveClaimMdEraArtifact, type EraComponentIdentity, type EraProviderIdentity } from "./claimmd-era-routing";
import { CLAIMMD_ERA_RESOLUTION_JOB_ID, type createClaimMdEraStore } from "./claimmd-era-store";

export const CLAIMMD_ERA_RESOLUTION_ALGORITHM = "BIL141A_V1";
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Store = ReturnType<typeof createClaimMdEraStore>;
export interface ClaimMdEraEvidenceReader {
  read(input: { readonly tx: DbClient; readonly accountReference: string; readonly usage: "test" | "production";
    readonly npis: readonly string[]; readonly pcns: readonly string[] }): Promise<{ readonly complete: boolean; readonly facts: readonly ClaimMdEraSubmissionFact[] }>;
}
export interface ClaimMdCommercialEvidenceReader {
  (tx: DbClient, submissionIds: readonly string[]): Promise<readonly { readonly id: string; readonly organizationId: string;
    readonly providerEntityId: string; readonly locationId: string | null; readonly claimId: string;
    readonly controlNumber: string; readonly payerId: string; readonly vendor: string }[]>;
}

export function isVerifiedM41EraSubmissionFact(fact: ClaimMdEraSubmissionFact, source:
  { readonly id: string; readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
    readonly claimId: string; readonly controlNumber: string; readonly payerId: string; readonly vendor: string } | undefined): boolean {
  return fact.billingModule === "M41" && source?.id === fact.submissionId && source.organizationId === fact.organizationId &&
    source.providerEntityId === fact.providerEntityId && source.locationId === fact.locationId && source.claimId === fact.claimId &&
    source.controlNumber === fact.pcn && source.payerId === fact.payerId && source.vendor === "claimmd";
}

export type EraOwnershipResult =
  | { readonly status: "verified"; readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
      readonly reasonCode: null; readonly decision: Readonly<Record<string, unknown>> }
  | { readonly status: "unmatched" | "ambiguous" | "conflict" | "needs_review" | "invalid_source";
      readonly organizationId: null; readonly providerEntityId: null; readonly locationId: null;
      readonly reasonCode: string; readonly decision: Readonly<Record<string, unknown>> };

const digits = (value: string | undefined): string | null => {
  if (!value) return null;
  const normalized = value.replace(/\D/g, "");
  return normalized || null;
};
const npiOf = (advice: ParsedRemittanceAdvice): string | null => {
  const payee = advice.payee;
  if (!payee) return null;
  if (payee.idQualifier === "XX") return digits(payee.id);
  if (payee.idQualifier === "FI") return null;
  return null;
};
const tinOf = (advice: ParsedRemittanceAdvice): string | null => {
  const payee = advice.payee;
  return digits(payee?.taxId ?? (payee?.idQualifier === "FI" ? payee.id : undefined));
};

function safeComponent(advice: ParsedRemittanceAdvice, fileIndex: number) {
  return { fileIndex, interchangeControlNumber: advice.interchangeControlNumber,
    functionalGroupControlNumber: advice.functionalGroupControlNumber ?? null,
    transactionSetControlNumber: advice.transactionSetControlNumber,
    payer: advice.payer ? { qualifier: advice.payer.idQualifier ?? null, id: advice.payer.id ?? null,
      additionalId: advice.payer.additionalPayerId ?? null } : null,
    payee: advice.payee ? { qualifier: advice.payee.idQualifier ?? null, id: advice.payee.id ?? null,
      taxId: advice.payee.taxId ?? null, payerAssignedId: advice.payee.payerAssignedId ?? null } : null,
    trace: advice.checkOrEftTraceNumber ?? null, paymentMethod: advice.paymentMethod,
    paymentDate: advice.productionDate, paymentAmount: advice.totalPaymentAmount,
    providerAdjustments: advice.providerAdjustments ?? [], claims: advice.claims.map((claim) => ({
      pcn: claim.patientControlNumber ?? null, payerIcn: claim.payerIcn ?? null, statusCode: claim.statusCode,
      totalCharge: claim.totalCharge, totalPayment: claim.totalPayment,
      patientResponsibility: claim.patientResponsibility, serviceFrom: claim.serviceFrom ?? null,
      serviceTo: claim.serviceTo ?? null, references: claim.references ?? [],
      adjustments: claim.adjustments, serviceLines: claim.serviceLines.map((line) => ({
        procedureCode: line.procedureCode ?? null, revenueCode: line.revenueCode ?? null,
        qualifier: line.serviceIdQualifier ?? null, submittedProcedureCode: line.submittedProcedureCode ?? null,
        charge: line.chargeAmount, paid: line.paidAmount, references: line.references ?? [], adjustments: line.adjustments,
      })),
    })), unknownSegments: advice.unknownSegments ?? [] };
}

/** Pure deterministic ownership resolution. Payee and original claim identity remain separate conclusions. */
export function decideClaimMdEraOwnership(input: {
  readonly accountReference: string; readonly usage: "test" | "production";
  readonly files: readonly string[]; readonly evidenceComplete: boolean;
  readonly evidence: readonly ClaimMdEraSubmissionFact[];
  readonly ownerByProvider: ReadonlyMap<string, string>;
}): EraOwnershipResult {
  const parsed: { fileIndex: number; advice: ParsedRemittanceAdvice }[] = [];
  for (let fileIndex = 0; fileIndex < input.files.length; fileIndex++) {
    const result = parseX12835AllSets(input.files[fileIndex]!, "commercial", { allowTestFiles: input.usage === "test" });
    if (!result.ok) return { status: "invalid_source", organizationId: null, providerEntityId: null, locationId: null,
      reasonCode: "X12_PARSE_INVALID", decision: { parseCode: result.degraded.code, files: input.files.length } };
    for (const advice of result.value) parsed.push({ fileIndex, advice });
  }
  if (!parsed.length) return { status: "invalid_source", organizationId: null, providerEntityId: null, locationId: null,
    reasonCode: "X12_EMPTY_ARTIFACT", decision: { files: input.files.length } };
  const conflictingPayeeIds = parsed.some(({ advice }) => {
    const payee = advice.payee;
    const assignedTin = digits(payee?.taxId);
    const financialInstitutionId = payee?.idQualifier === "FI" ? digits(payee.id) : null;
    return Boolean(assignedTin && financialInstitutionId && assignedTin !== financialInstitutionId);
  });
  if (conflictingPayeeIds) return { status: "conflict", organizationId: null, providerEntityId: null,
    locationId: null, reasonCode: "PAYEE_IDENTITY_SELF_CONFLICT",
    decision: { transactionSets: parsed.map(({ advice, fileIndex }) => safeComponent(advice, fileIndex)) } };
  const payeeNpis = [...new Set(parsed.map(({ advice }) => npiOf(advice)).filter((value): value is string => Boolean(value)))];
  if (!input.evidenceComplete) return { status: "needs_review", organizationId: null, providerEntityId: null, locationId: null,
    reasonCode: "EVIDENCE_CANDIDATE_LIMIT", decision: { candidateLimitReached: true } };
  const evidenceProviders = new Set(input.evidence.map((fact) => fact.providerEntityId));
  const identityMap = new Map<string, EraProviderIdentity>();
  for (const fact of input.evidence) {
    if (input.ownerByProvider.get(fact.providerEntityId) !== fact.organizationId) continue;
    const identity: EraProviderIdentity = { organizationId: fact.organizationId, providerEntityId: fact.providerEntityId,
      npi: fact.billingNpi, taxId: fact.billingTin };
    identityMap.set([identity.organizationId, identity.providerEntityId, identity.npi, identity.taxId].join("\0"), identity);
  }
  const candidates = [...identityMap.values()];
  const components: EraComponentIdentity[] = parsed.map(({ advice, fileIndex }) => ({ fileIndex,
    transactionSetControlNumber: advice.transactionSetControlNumber, payee: { npi: npiOf(advice), taxId: tinOf(advice) } }));
  const payee = resolveClaimMdEraArtifact(components, candidates);
  if (payee.kind !== "verified") {
    const conflict = payee.reason === "PAYEE_IDENTITY_CONFLICT";
    const ambiguous = payee.reason === "PAYEE_IDENTITY_AMBIGUOUS" || payee.reason === "MIXED_PROVIDER_OR_TENANT";
    return { status: conflict ? "conflict" : ambiguous ? "ambiguous" : "unmatched", organizationId: null,
      providerEntityId: null, locationId: null, reasonCode: payee.reason,
      decision: { payeeOutcome: payee.reason, transactionSets: parsed.map(({ fileIndex, advice }) => safeComponent(advice, fileIndex)) } };
  }
  if (!evidenceProviders.has(payee.providerEntityId) || payeeNpis.length === 0) return { status: "unmatched",
    organizationId: null, providerEntityId: null, locationId: null, reasonCode: "HISTORICAL_PAYEE_EVIDENCE_MISSING",
    decision: { transactionSets: parsed.map(({ fileIndex, advice }) => safeComponent(advice, fileIndex)) } };

  const correlatedClaims = parsed.flatMap(({ advice, fileIndex }) => advice.claims.map((claim) => {
    const pcn = claim.patientControlNumber;
    const matches = pcn ? input.evidence.filter((fact) => fact.pcn === pcn && fact.organizationId === payee.organizationId &&
      fact.providerEntityId === payee.providerEntityId && fact.accountReference === input.accountReference && fact.usage === input.usage &&
      fact.billingNpi === npiOf(advice) && (!tinOf(advice) || fact.billingTin.replace(/\D/g, "") === tinOf(advice))) : [];
    const matchingClaims = [...new Map(matches.map((fact) => [fact.claimId, fact])).values()];
    const conflicts = pcn ? input.evidence.filter((fact) => fact.pcn === pcn &&
      (fact.organizationId !== payee.organizationId || fact.providerEntityId !== payee.providerEntityId)) : [];
    const claimLocations = matchingClaims.length === 1 ? [...new Set(matches.filter((fact) => fact.claimId === matchingClaims[0]!.claimId)
      .flatMap((fact) => fact.locationId ? [fact.locationId] : []))] : [];
    return { fileIndex, transactionSetControlNumber: advice.transactionSetControlNumber, pcn: pcn ?? null,
      payerIcn: claim.payerIcn ?? null, outcome: conflicts.length ? "conflict" : matchingClaims.length === 1 ? "verified" :
        matchingClaims.length > 1 ? "ambiguous" : "unmatched", claimId: matchingClaims.length === 1 ? matchingClaims[0]!.claimId : null,
      submissionEvidenceIds: matchingClaims.length === 1 ? matches.filter((fact) => fact.claimId === matchingClaims[0]!.claimId).map((fact) => fact.id) : [],
      locationId: claimLocations.length === 1 ? claimLocations[0]! : null };
  }));
  if (correlatedClaims.some((claim) => claim.outcome === "conflict")) return { status: "conflict", organizationId: null,
    providerEntityId: null, locationId: null, reasonCode: "CLAIM_OWNER_CONFLICT",
    decision: { transactionSets: parsed.map(({ fileIndex, advice }) => safeComponent(advice, fileIndex)), claims: correlatedClaims } };
  const locations = [...new Set(correlatedClaims.flatMap((claim) => claim.outcome === "verified" && claim.locationId ? [claim.locationId] : []))];
  const locationId = locations.length === 1 ? locations[0]! : null;
  return { status: "verified", organizationId: payee.organizationId, providerEntityId: payee.providerEntityId,
    locationId, reasonCode: null,
    decision: { payeeOutcome: "verified", claims: correlatedClaims,
      transactionSets: parsed.map(({ fileIndex, advice }) => safeComponent(advice, fileIndex)),
      locationResolution: locations.length > 1 ? "MULTIPLE_HISTORICAL_LOCATIONS" : locationId ? "HISTORICAL_CLAIM_LOCATION" : "UNKNOWN" } };
}

/** Reads/decrypts only through the audited store, then records the protected decision. No M25 ingestion/posting calls. */
export function createClaimMdEraResolver(input: { readonly store: Store; readonly readSnapshot: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly evidenceReader: ClaimMdEraEvidenceReader;
  readonly siteReader: Pick<FoundationSiteReader, "providerEntityOwners" | "locationOwners">;
  readonly commercialSubmissionReader: ClaimMdCommercialEvidenceReader;
  readonly accountReference: string; readonly usage: "test" | "production" }) {
  return { async resolve(inboxId: string) {
    const source = await input.store.readCapturedEra({ inboxId, accountReference: input.accountReference,
      usage: input.usage, executionJobId: CLAIMMD_ERA_RESOLUTION_JOB_ID });
    const npis = [...new Set(source.files.flatMap((raw) => {
      const result = parseX12835AllSets(raw, "commercial", { allowTestFiles: input.usage === "test" });
      return result.ok ? result.value.map(npiOf).filter((value): value is string => Boolean(value)) : [];
    }))];
    const pcns = [...new Set(source.files.flatMap((raw) => {
      const result = parseX12835AllSets(raw, "commercial", { allowTestFiles: input.usage === "test" });
      return result.ok ? result.value.flatMap((advice) => advice.claims.flatMap((claim) => claim.patientControlNumber ? [claim.patientControlNumber] : [])) : [];
    }))];
    const facts = await input.readSnapshot(async (tx) => {
      const evidence = await input.evidenceReader.read({ tx: tx as unknown as DbClient,
        accountReference: input.accountReference, usage: input.usage, npis, pcns });
      const commercialSubmissionIds = evidence.facts.filter((fact) => fact.billingModule === "M41").map((fact) => fact.submissionId);
      const commercialFacts = await input.commercialSubmissionReader(tx as unknown as DbClient, commercialSubmissionIds);
      const commercialById = new Map(commercialFacts.map((fact) => [fact.id, fact]));
      const verifiedFacts = evidence.facts.filter((fact) => fact.billingModule !== "M41" ||
        isVerifiedM41EraSubmissionFact(fact, commercialById.get(fact.submissionId)));
      const locations = await input.siteReader.locationOwners(tx as unknown as DbClient,
        verifiedFacts.flatMap((fact) => fact.locationId ? [fact.locationId] : []));
      const locationProvider = new Map(locations.map((row) => [row.id, row.providerEntityId]));
      const locationVerifiedFacts = verifiedFacts.filter((fact) => fact.locationId === null ||
        locationProvider.get(fact.locationId) === fact.providerEntityId);
      const owners = await input.siteReader.providerEntityOwners(tx as unknown as DbClient,
        locationVerifiedFacts.map((fact) => fact.providerEntityId));
      return { complete: evidence.complete, facts: locationVerifiedFacts,
        ownerByProvider: new Map(owners.map((owner) => [owner.id, owner.organizationId])) };
    });
    const result = decideClaimMdEraOwnership({ accountReference: input.accountReference, usage: input.usage,
      files: source.files, evidenceComplete: facts.complete, evidence: facts.facts, ownerByProvider: facts.ownerByProvider });
    const decisionJson = JSON.stringify(result.decision);
    const persisted = await input.store.recordResolution({ inboxId, accountReference: source.accountReference, usage: source.usage,
      originalDigest: source.originalDigest, status: result.status, organizationId: result.organizationId,
      providerEntityId: result.providerEntityId, locationId: result.locationId, reasonCode: result.reasonCode,
      algorithmVersion: CLAIMMD_ERA_RESOLUTION_ALGORITHM, decision: result.decision,
      decisionDigest: createHash("sha256").update(decisionJson, "utf8").digest("hex") });
    return { status: persisted.status, version: persisted.version };
  } };
}
