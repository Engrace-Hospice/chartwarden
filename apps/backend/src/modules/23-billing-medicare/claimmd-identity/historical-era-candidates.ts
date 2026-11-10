/**
 * M23-owned, tenant-scoped historical attempt projection for the M25 ERA matching reviewer.
 * This reads immutable Claim.MD send evidence, never current mutable claim lines.
 */
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

const E = schema.claimmdSubmissionEvidence;
const C = schema.claimSubmission;
const A = schema.clearinghouseSubmissionAttempts;
const L = schema.claimmdSubmissionLineEvidence;

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
      payloadSha256: E.payloadSha256,
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
  readonly submittedLines: "available" | "unavailable";
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
      payloadSha256: E.payloadSha256,
      transportOrg: A.organizationId,
      transportProvider: A.providerEntityId,
      transportUsage: A.usage,
      transportControl: A.controlNumber,
      transportKind: A.kind,
      transportStatus: A.status,
    })
    .from(E)
    .innerJoin(C, and(eq(C.id, E.submissionId), eq(E.billingModule, "M23")))
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

  const scopedRows = rows.filter(
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
  );
  if (!scopedRows.length) return [];

  // Charge comes from immutable line facts bound to this exact submitted payload. Current
  // M23 claim totals can change after correction and are not historical send evidence.
  const lineRows = await input.tx
    .select({
      evidenceId: L.evidenceId,
      organizationId: L.organizationId,
      providerEntityId: L.providerEntityId,
      claimId: L.claimId,
      submissionId: L.submissionId,
      attemptKey: L.attemptKey,
      linePosition: L.linePosition,
      chargeCents: L.chargeCents,
      payloadSha256: L.payloadSha256,
      accountReference: L.accountReference,
      usage: L.usage,
    })
    .from(L)
    .where(
      inArray(
        L.evidenceId,
        scopedRows.map((r) => r.evidenceId),
      ),
    )
    .orderBy(L.linePosition);
  const linesByEvidence = new Map<string, typeof lineRows>();
  for (const line of lineRows) {
    const current = linesByEvidence.get(line.evidenceId) ?? [];
    current.push(line);
    linesByEvidence.set(line.evidenceId, current);
  }

  return scopedRows.map((r) => {
    const lines = linesByEvidence.get(r.evidenceId) ?? [];
    const completeLineScope =
      lines.length > 0 &&
      lines.every(
        (line) =>
          line.organizationId === r.organizationId &&
          line.providerEntityId === r.providerEntityId &&
          line.claimId === r.claimId &&
          line.submissionId === r.submissionId &&
          line.attemptKey === r.attemptKey &&
          line.payloadSha256 === r.payloadSha256 &&
          line.accountReference === r.accountReference &&
          line.usage === r.usage &&
          Number.isSafeInteger(line.chargeCents),
      );
    const total = completeLineScope
      ? lines.reduce((sum, line) => sum + BigInt(line.chargeCents!), 0n)
      : null;
    const chargeCents =
      total !== null &&
      total <= BigInt(Number.MAX_SAFE_INTEGER) &&
      total >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(total)
        : null;
    const frequency = r.claimType.split(":").at(-1);
    return {
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
      chargeCents,
      lineage:
        frequency === "8"
          ? ("void" as const)
          : frequency === "7"
            ? ("replacement" as const)
            : frequency
              ? ("original" as const)
              : ("unknown" as const),
      attemptState: r.state,
      submittedAt: (r.submittedAt ?? new Date(0)).toISOString(),
      submittedLines: completeLineScope ? ("available" as const) : ("unavailable" as const),
    };
  });
}
