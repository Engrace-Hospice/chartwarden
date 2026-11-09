/**
 * M23-owned, tenant-scoped historical attempt projection for the M25 ERA matching reviewer.
 * This reads immutable Claim.MD send evidence, never current mutable claim lines.
 */
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

const E = schema.claimmdSubmissionEvidence;
const C = schema.claimSubmission;
const A = schema.clearinghouseSubmissionAttempts;
const CLAIM = schema.claim;

export interface ClaimMdEraCandidateEvidence {
  readonly evidenceId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly attemptKey: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly payerId: string;
  readonly pcn: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
}

/** M23-owned shared evidence projection. No ciphertext, member identifier or raw X12 is returned. */
export async function readClaimMdEraCandidateEvidence(input: {
  tx: DbClient;
  organizationId: string;
  providerEntityId: string;
  accountReference: string;
  usage: "test" | "production";
  pcn: string;
}): Promise<readonly ClaimMdEraCandidateEvidence[]> {
  return input.tx
    .select({
      evidenceId: E.id,
      claimId: E.claimId,
      submissionId: E.submissionId,
      attemptKey: E.attemptKey,
      organizationId: E.organizationId,
      providerEntityId: E.providerEntityId,
      accountReference: E.accountReference,
      usage: E.usage,
      payerId: E.payerId,
      pcn: E.pcn,
      claimType: E.claimType,
      serviceFrom: E.serviceFrom,
      serviceTo: E.serviceTo,
    })
    .from(E)
    .where(
      and(
        eq(E.vendor, "claimmd"),
        eq(E.organizationId, input.organizationId),
        eq(E.providerEntityId, input.providerEntityId),
        eq(E.accountReference, input.accountReference),
        eq(E.usage, input.usage),
        eq(E.pcn, input.pcn),
      ),
    )
    .limit(101);
}

export interface HistoricalEraAttemptCandidate {
  readonly module: "M23" | "M41";
  readonly evidenceId: string;
  readonly claimId: string;
  readonly submissionId: string;
  readonly attemptKey: string;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly payerId: string;
  readonly pcn: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly chargeCents: number | null;
  readonly lineage: "original" | "correction" | "replacement" | "void" | "unknown";
  readonly attemptState: string;
  readonly submittedAt: string;
  /** No original line snapshot currently exists in the immutable evidence contract. */
  readonly submittedLines: "unavailable";
}

/** Owner-exported exact-scope reader. PCN narrows candidates; it is never treated as unique proof. */
export async function readM23HistoricalEraCandidates(input: {
  tx: DbClient;
  organizationId: string;
  providerEntityId: string;
  accountReference: string;
  usage: "test" | "production";
  pcn: string;
}): Promise<readonly HistoricalEraAttemptCandidate[]> {
  const rows = await input.tx
    .select({
      evidenceId: E.id,
      claimId: E.claimId,
      submissionId: E.submissionId,
      attemptKey: E.attemptKey,
      organizationId: E.organizationId,
      providerEntityId: E.providerEntityId,
      accountReference: E.accountReference,
      usage: E.usage,
      payerId: E.payerId,
      pcn: E.pcn,
      claimType: E.claimType,
      serviceFrom: E.serviceFrom,
      serviceTo: E.serviceTo,
      claimSubmissionId: C.id,
      sourceClaimId: C.claimId,
      sourceKind: C.kind,
      sourceControl: C.claimControlNumber,
      attemptIndex: C.attemptIndex,
      state: C.outcome,
      submittedAt: C.submittedAt,
      replacementOf: CLAIM.replacesClaimId,
      tob: CLAIM.tob,
      totalCents: CLAIM.totalChargeCents,
      transportOrg: A.organizationId,
      transportProvider: A.providerEntityId,
      transportUsage: A.usage,
      transportControl: A.controlNumber,
      transportKind: A.kind,
      transportStatus: A.status,
    })
    .from(E)
    .innerJoin(C, and(eq(C.id, E.submissionId), eq(E.billingModule, "M23")))
    .innerJoin(CLAIM, eq(CLAIM.id, E.claimId))
    .innerJoin(
      A,
      and(
        eq(A.organizationId, E.organizationId),
        eq(A.providerEntityId, E.providerEntityId),
        eq(A.usage, E.usage),
        eq(A.controlNumber, E.pcn),
        inArray(A.status, ["reserved", "sent"]),
      ),
    )
    .where(
      and(
        eq(E.vendor, "claimmd"),
        eq(E.organizationId, input.organizationId),
        eq(E.providerEntityId, input.providerEntityId),
        eq(E.accountReference, input.accountReference),
        eq(E.usage, input.usage),
        eq(E.pcn, input.pcn),
        eq(C.kind, "claim_837i"),
      ),
    )
    .limit(101);

  return rows
    .filter(
      (r) =>
        r.organizationId === r.transportOrg &&
        r.providerEntityId === r.transportProvider &&
        r.usage === r.transportUsage &&
        r.pcn === r.transportControl &&
        r.transportKind === "claim" &&
        (r.transportStatus === "reserved" || r.transportStatus === "sent") &&
        r.claimSubmissionId === r.submissionId &&
        r.sourceClaimId === r.claimId &&
        r.sourceKind === "claim_837i" &&
        r.sourceControl === r.pcn &&
        r.attemptKey === `${r.submissionId}:${r.attemptIndex}` &&
        r.submittedAt !== null,
    )
    .map((r) => ({
      module: "M23",
      evidenceId: r.evidenceId,
      claimId: r.claimId,
      submissionId: r.submissionId,
      attemptKey: r.attemptKey,
      organizationId: r.organizationId,
      providerEntityId: r.providerEntityId,
      accountReference: r.accountReference,
      usage: r.usage,
      payerId: r.payerId,
      pcn: r.pcn,
      claimType: r.claimType,
      serviceFrom: r.serviceFrom,
      serviceTo: r.serviceTo,
      chargeCents: r.totalCents,
      lineage: r.tob === "818" ? "void" : r.replacementOf ? "replacement" : "original",
      attemptState: r.state,
      submittedAt: (r.submittedAt ?? new Date(0)).toISOString(),
      submittedLines: "unavailable",
    }));
}
