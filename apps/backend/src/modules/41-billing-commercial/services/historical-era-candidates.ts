/** M41-owned, tenant-scoped historical attempt projection for M25 matching. */
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray } from "drizzle-orm";

export interface M41HistoricalEraAttemptCandidate {
  readonly module: "M41";
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
  readonly submittedLines: "available" | "unavailable";
}

/** Safe M23-owned evidence projection supplied by the composition root. */
export interface M41EraCandidateEvidence {
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

/** M41 validates only its own attempt and correction lineage; it never reads M23-owned evidence tables. */
export async function readM41HistoricalEraCandidates(input: {
  tx: DbClient;
  organizationId: string;
  providerEntityId: string;
  accountReference: string;
  usage: "test" | "production";
  pcn: string;
  evidenceRows: readonly M41EraCandidateEvidence[];
}): Promise<readonly M41HistoricalEraAttemptCandidate[]> {
  const S = schema.commercialSubmissions;
  const C = schema.commercialClaims;
  const evidenceRows = input.evidenceRows.filter(
    (r) =>
      r.organizationId === input.organizationId &&
      r.providerEntityId === input.providerEntityId &&
      r.accountReference === input.accountReference &&
      r.usage === input.usage &&
      r.pcn === input.pcn,
  );
  if (!evidenceRows.length) return [];
  const submissionIds = [...new Set(evidenceRows.map((r) => r.submissionId))];
  const rows = await input.tx
    .select({
      sourceId: S.id,
      sourceClaimId: S.claimId,
      sourceOrg: S.organizationId,
      sourceProvider: S.providerEntityId,
      sourcePayer: S.clearinghousePayerId,
      sourceVendor: S.clearinghouseKey,
      sourceControl: S.controlNumber,
      sourceState: S.status,
      correctionOf: C.correctionOfClaimId,
      frequency: C.frequencyCode,
      claimCharge: C.totalChargeCents,
      sourceTime: S.sentAt,
    })
    .from(S)
    .innerJoin(C, eq(C.id, S.claimId))
    .where(
      and(
        inArray(S.id, submissionIds),
        eq(S.organizationId, input.organizationId),
        eq(S.providerEntityId, input.providerEntityId),
        eq(S.clearinghouseKey, "claimmd"),
        eq(S.controlNumber, input.pcn),
      ),
    )
    .limit(101);
  const bySubmission = new Map(rows.map((r) => [r.sourceId, r]));
  return evidenceRows.flatMap((e) => {
    const r = bySubmission.get(e.submissionId);
    const attemptPrefix = `${e.submissionId}:`;
    const attemptOrdinal = e.attemptKey.startsWith(attemptPrefix)
      ? e.attemptKey.slice(attemptPrefix.length)
      : "";
    if (
      !r ||
      r.sourceId !== e.submissionId ||
      r.sourceClaimId !== e.claimId ||
      r.sourceOrg !== input.organizationId ||
      r.sourceProvider !== input.providerEntityId ||
      r.sourcePayer !== e.payerId ||
      r.sourceVendor !== "claimmd" ||
      r.sourceControl !== e.pcn ||
      !/^[0-9a-f-]{36}$/i.test(e.submissionId) ||
      !/^\d{1,8}$/.test(attemptOrdinal) ||
      !r.sourceTime
    )
      return [];
    return [
      {
        module: "M41" as const,
        evidenceId: e.evidenceId,
        claimId: e.claimId,
        submissionId: e.submissionId,
        attemptKey: e.attemptKey,
        organizationId: e.organizationId,
        providerEntityId: e.providerEntityId,
        accountReference: e.accountReference,
        usage: e.usage,
        payerId: e.payerId,
        pcn: e.pcn,
        claimType: e.claimType,
        serviceFrom: e.serviceFrom,
        serviceTo: e.serviceTo,
        chargeCents: r.claimCharge,
        lineage:
          r.frequency === "8"
            ? ("void" as const)
            : r.correctionOf
              ? ("correction" as const)
              : ("original" as const),
        attemptState: r.sourceState,
        submittedAt: r.sourceTime.toISOString(),
        submittedLines: "unavailable" as const,
      },
    ];
  });
}
