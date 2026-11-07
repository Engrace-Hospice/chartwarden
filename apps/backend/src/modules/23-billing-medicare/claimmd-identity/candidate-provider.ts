import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, exists, inArray, or } from "drizzle-orm";
import type { FoundationSiteReader } from "../../../bootstrap/foundation-site-reader";
import type { ClaimMdIdentityEvent, SubmissionCandidate } from "./resolve";

const E = schema.claimmdSubmissionEvidence;
const O = schema.claimmdSubmissionReceiptObservations;
const M23 = schema.claimSubmission;
const A = schema.clearinghouseSubmissionAttempts;
const MAX_CANDIDATES = 100;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type CommercialSubmissionFact = {
  readonly id: string; readonly organizationId: string; readonly providerEntityId: string;
  readonly locationId: string | null; readonly claimId: string; readonly controlNumber: string;
  readonly payerId: string; readonly vendor: string;
};
type EvidenceCipher = {
  open(input: { evidenceId: string; organizationId: string; providerEntityId: string; attemptKey: string; sealed: string }): Promise<string>;
};

export interface ClaimMdCandidateSet {
  readonly candidates: readonly SubmissionCandidate[];
  /** False means the cap was exceeded; the matcher must not infer uniqueness from a truncated result. */
  readonly complete: boolean;
}

export interface ClaimMdCandidateProvider {
  findClaimMdSubmissionCandidates(event: ClaimMdIdentityEvent): Promise<ClaimMdCandidateSet>;
}

const externalPredicates = (event: ClaimMdIdentityEvent) => [
  ...(event.claimMdClaimId ? [{ field: "claimmd_id", value: event.claimMdClaimId }] : []),
  ...(event.remoteClaimId ? [{ field: "remote_claimid", value: event.remoteClaimId }] : []),
  ...(event.claimId ? [{ field: "claimid", value: event.claimId }] : []),
  ...(event.fileId ? [{ field: "fileid", value: event.fileId }] : []),
  ...(event.batchId ? [{ field: "batchid", value: event.batchId }] : []),
];

const expectedNamespace: Readonly<Record<string, string>> = {
  fileid: "file", inboundid: "file", batchid: "batch", claimid: "claim", claimmd_id: "remote_claim",
  remote_claimid: "remote_claim", pcn: "pcn", responseid: "message", clearinghouseSubmissionId: "opaque_submission",
};

export function candidateAttemptKeyIsValid(module: "M23" | "M41", submissionId: string, attemptKey: string, attemptIndex: number | null): boolean {
  const match = /^([0-9a-f-]{36}):([0-9]{1,8})$/i.exec(attemptKey);
  if (!match || match[1] !== submissionId) return false;
  const n = Number(match[2]);
  return module === "M23" ? attemptIndex === n : Number.isSafeInteger(n) && n >= 0;
}

export function isVerifiedM23SubmissionEvidence(input: {
  readonly organizationId: string; readonly providerEntityId: string; readonly claimId: string; readonly submissionId: string;
  readonly attemptKey: string; readonly pcn: string; readonly source: {
    readonly id: string | null; readonly organizationId: string | null; readonly providerEntityId: string | null;
    readonly claimId: string | null; readonly kind: string | null; readonly controlNumber: string | null; readonly attemptIndex: number | null;
  };
  readonly transportAttempt: { readonly organizationId: string | null; readonly providerEntityId: string | null; readonly usage: string | null;
    readonly controlNumber: string | null; readonly kind: string | null; readonly status: string | null };
}): boolean {
  return input.source.id === input.submissionId && input.source.organizationId === input.organizationId &&
    input.source.providerEntityId === input.providerEntityId && input.source.claimId === input.claimId &&
    input.source.kind === "claim_837i" && input.source.controlNumber === input.pcn &&
    candidateAttemptKeyIsValid("M23", input.submissionId, input.attemptKey, input.source.attemptIndex) &&
    input.transportAttempt.organizationId === input.organizationId && input.transportAttempt.providerEntityId === input.providerEntityId &&
    input.transportAttempt.usage !== null && input.transportAttempt.controlNumber === input.pcn && input.transportAttempt.kind === "claim" &&
    (input.transportAttempt.status === "reserved" || input.transportAttempt.status === "sent");
}

export function isVerifiedM41SubmissionEvidence(input: {
  readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
  readonly claimId: string; readonly submissionId: string; readonly attemptKey: string; readonly pcn: string;
  readonly payerId: string; readonly source: { readonly id: string | null; readonly organizationId: string | null;
    readonly providerEntityId: string | null; readonly locationId: string | null; readonly claimId: string | null;
    readonly controlNumber: string | null; readonly payerId: string | null; readonly vendor: string | null };
  readonly transportAttempt: { readonly organizationId: string | null; readonly providerEntityId: string | null; readonly usage: string | null;
    readonly controlNumber: string | null; readonly kind: string | null; readonly status: string | null };
}): boolean {
  return input.source.id === input.submissionId && input.source.organizationId === input.organizationId &&
    input.source.providerEntityId === input.providerEntityId && input.source.locationId === input.locationId &&
    input.source.claimId === input.claimId && input.source.controlNumber === input.pcn &&
    input.source.payerId === input.payerId && input.source.vendor === "claimmd" &&
    candidateAttemptKeyIsValid("M41", input.submissionId, input.attemptKey, null) &&
    input.transportAttempt.organizationId === input.organizationId && input.transportAttempt.providerEntityId === input.providerEntityId &&
    input.transportAttempt.usage !== null && input.transportAttempt.controlNumber === input.pcn && input.transportAttempt.kind === "claim" &&
    (input.transportAttempt.status === "reserved" || input.transportAttempt.status === "sent");
}

export function isVerifiedReceiptObservation(field: string, namespace: string): boolean {
  return expectedNamespace[field] === namespace && field !== "responseid" && field !== "clearinghouseSubmissionId";
}

/**
 * Account-wide privileged query over immutable send evidence. Every lookup is restricted by the configured
 * Claim.MD account/environment and at least one exact external identifier or PCN; no mutable provider identity
 * participates in matching. The composition root supplies an allowlisted, audited repeatable-read snapshot.
 */
export function createClaimMdCandidateProvider(input: {
  readonly readSnapshot: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  readonly siteReader: Pick<FoundationSiteReader, "providerEntityOwners" | "locationOwners">;
  readonly commercialSubmissionReader: (tx: DbClient, ids: readonly string[]) => Promise<readonly CommercialSubmissionFact[]>;
  readonly cipher: EvidenceCipher;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly maxCandidates?: number;
}): ClaimMdCandidateProvider {
  const cap = Math.min(MAX_CANDIDATES, Math.max(1, input.maxCandidates ?? MAX_CANDIDATES));
  return {
    async findClaimMdSubmissionCandidates(event) {
      if (event.accountReference !== input.accountReference || event.usage !== input.usage)
        return { candidates: [], complete: true };
      const hints = externalPredicates(event);
      if (!event.pcn && !hints.length) return { candidates: [], complete: true };
      const captured = await input.readSnapshot(async (tx) => {
        const matchesReceipt = hints.length ? tx.select({ one: O.id }).from(O).where(and(
          eq(O.evidenceId, E.id), eq(O.accountReference, input.accountReference), eq(O.usage, input.usage),
          or(...hints.map(({ field, value }) => and(eq(O.sourceField, field), eq(O.externalValue, value)))),
        )) : null;
        const matchPredicates = [
          ...(event.pcn ? [eq(E.pcn, event.pcn)] : []),
          ...(matchesReceipt ? [exists(matchesReceipt)] : []),
        ];
        const rows = await tx.select({
          id: E.id, organizationId: E.organizationId, providerEntityId: E.providerEntityId, locationId: E.locationId,
          claimId: E.claimId, billingModule: E.billingModule, submissionId: E.submissionId, attemptKey: E.attemptKey,
          accountReference: E.accountReference, usage: E.usage, billingNpi: E.billingNpi,
          billingTinCiphertext: E.billingTinCiphertext, payerId: E.payerId, claimType: E.claimType, pcn: E.pcn,
          serviceFrom: E.serviceFrom, serviceTo: E.serviceTo, payloadSha256: E.payloadSha256,
          isa13: E.isa13, gs06: E.gs06, st02: E.st02,
          m23Id: M23.id, m23OrgId: M23.organizationId, m23ProviderId: M23.providerEntityId,
          m23ClaimId: M23.claimId, m23Kind: M23.kind, m23Control: M23.claimControlNumber, m23AttemptIndex: M23.attemptIndex,
          attemptId: A.id, attemptOrgId: A.organizationId, attemptProviderId: A.providerEntityId, attemptUsage: A.usage,
          attemptControl: A.controlNumber, attemptKind: A.kind, attemptStatus: A.status,
        }).from(E)
          .leftJoin(M23, and(eq(M23.id, E.submissionId), eq(E.billingModule, "M23")))
          .leftJoin(A, and(eq(A.organizationId, E.organizationId), eq(A.providerEntityId, E.providerEntityId),
            eq(A.usage, E.usage), eq(A.controlNumber, E.pcn), inArray(A.status, ["reserved", "sent"])))
          .where(and(eq(E.vendor, "claimmd"), eq(E.accountReference, input.accountReference), eq(E.usage, input.usage),
            or(...matchPredicates)))
          .orderBy(E.createdAt).limit(cap + 1);
        const complete = rows.length <= cap;
        const selected = rows.slice(0, cap);
        if (!selected.length) return { selected, complete, byEvidence: new Map<string, { field: string; namespace: string; value: string }[]>(),
          providerOwners: new Map<string, string>(), locationOwners: new Map<string, string>(),
          commercialFacts: new Map<string, CommercialSubmissionFact>() };
        const observations = await tx.select({ evidenceId: O.evidenceId, field: O.sourceField,
          namespace: O.identifierNamespace, value: O.externalValue }).from(O)
          .where(and(inArray(O.evidenceId, selected.map((row) => row.id)), eq(O.accountReference, input.accountReference),
            eq(O.usage, input.usage), eq(O.vendor, "claimmd"),
            inArray(O.sourceField, ["fileid", "inboundid", "batchid", "claimid", "claimmd_id", "remote_claimid", "pcn"])));
        const byEvidence = new Map<string, { field: string; namespace: string; value: string }[]>();
        for (const observation of observations) {
          if (!isVerifiedReceiptObservation(observation.field, observation.namespace)) continue;
          const values = byEvidence.get(observation.evidenceId) ?? [];
          values.push({ field: observation.field, namespace: observation.namespace, value: observation.value });
          byEvidence.set(observation.evidenceId, values);
        }
        // All owner readers use this same audited repeatable-read transaction. Batch IDs stay bounded by cap.
        const siteTx = tx as unknown as DbClient;
        const providerOwners = new Map((await input.siteReader.providerEntityOwners(siteTx, selected.map((row) => row.providerEntityId)))
          .map((row) => [row.id, row.organizationId]));
        const locationOwners = new Map((await input.siteReader.locationOwners(siteTx,
          selected.flatMap((row) => row.locationId === null ? [] : [row.locationId])))
          .map((row) => [row.id, row.providerEntityId]));
        const commercialIds = selected.filter((row) => row.billingModule === "M41").map((row) => row.submissionId);
        const commercialFacts = new Map((commercialIds.length === 0 ? [] : await input.commercialSubmissionReader(siteTx, commercialIds))
          .map((row) => [row.id, row]));
        return { selected, complete, byEvidence, providerOwners, locationOwners, commercialFacts };
      });
      if (!captured.complete) return { candidates: [], complete: false };
      const candidates: SubmissionCandidate[] = [];
      for (const row of captured.selected) {
          if (captured.providerOwners.get(row.providerEntityId) !== row.organizationId) continue;
          const commercial = captured.commercialFacts.get(row.submissionId);
          const attemptValid = row.billingModule === "M23"
            ? isVerifiedM23SubmissionEvidence({ organizationId: row.organizationId, providerEntityId: row.providerEntityId,
              claimId: row.claimId, submissionId: row.submissionId, attemptKey: row.attemptKey, pcn: row.pcn,
              source: { id: row.m23Id, organizationId: row.m23OrgId, providerEntityId: row.m23ProviderId,
                claimId: row.m23ClaimId, kind: row.m23Kind, controlNumber: row.m23Control, attemptIndex: row.m23AttemptIndex },
              transportAttempt: { organizationId: row.attemptOrgId, providerEntityId: row.attemptProviderId, usage: row.attemptUsage,
                controlNumber: row.attemptControl, kind: row.attemptKind, status: row.attemptStatus } })
            : isVerifiedM41SubmissionEvidence({ organizationId: row.organizationId, providerEntityId: row.providerEntityId,
              locationId: row.locationId, claimId: row.claimId, submissionId: row.submissionId, attemptKey: row.attemptKey,
              pcn: row.pcn, payerId: row.payerId, source: { id: commercial?.id ?? null, organizationId: commercial?.organizationId ?? null,
                providerEntityId: commercial?.providerEntityId ?? null, locationId: commercial?.locationId ?? null,
                claimId: commercial?.claimId ?? null, controlNumber: commercial?.controlNumber ?? null,
                payerId: commercial?.payerId ?? null, vendor: commercial?.vendor ?? null },
              transportAttempt: { organizationId: row.attemptOrgId, providerEntityId: row.attemptProviderId, usage: row.attemptUsage,
                controlNumber: row.attemptControl, kind: row.attemptKind, status: row.attemptStatus } });
          if (!attemptValid || !row.attemptId || (row.locationId !== null && captured.locationOwners.get(row.locationId) !== row.providerEntityId) ||
            !/^[0-9a-f]{64}$/.test(row.payloadSha256)) continue;
          let tinAtSend: string;
          try { tinAtSend = await input.cipher.open({ evidenceId: row.id, organizationId: row.organizationId,
            providerEntityId: row.providerEntityId, attemptKey: row.attemptKey, sealed: row.billingTinCiphertext }); }
          catch { throw new Error("CLAIMMD_CANDIDATE_KEY_UNAVAILABLE"); }
          const identifiers = captured.byEvidence.get(row.id) ?? [];
          const valueFor = (field: string) => identifiers.find((item) => item.field === field)?.value ?? null;
          candidates.push({ accountReference: row.accountReference, usage: row.usage, organizationId: row.organizationId,
            providerEntityId: row.providerEntityId, locationId: row.locationId, claimId: row.claimId, evidenceId: row.id,
            transportAttemptId: row.attemptId, isa13: row.isa13, gs06: row.gs06, st02: row.st02,
            payloadSha256: row.payloadSha256, evidenceSource: "claimmd_submission_evidence",
            module: row.billingModule, submissionId: row.submissionId, submissionAttemptId: row.id, receiptId: null,
            claimMdClaimId: valueFor("claimmd_id"), remoteClaimId: valueFor("remote_claimid"), vendorClaimId: valueFor("claimid"),
            fileId: valueFor("fileid"), batchId: valueFor("batchid"), pcn: row.pcn, billingNpiAtSend: row.billingNpi,
            billingTinAtSend: tinAtSend, payerId: row.payerId, claimType: row.claimType,
            serviceFrom: row.serviceFrom, serviceTo: row.serviceTo, verifiedClaimMdRoute: true, vendorIdentifiers: identifiers });
      }
      return { candidates, complete: captured.complete };
    },
  };
}
