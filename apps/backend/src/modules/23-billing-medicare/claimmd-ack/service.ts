import { timingSafeEqual } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { interpretClaimMdStatus } from "./interpret";
import { applyMedicareClaimMdReceipt } from "./medicare-adapter";
import type { AckDeliveryLease, ResolvedClaimMdAck } from "./store";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type EvidenceCipher = {
  open(input: {
    evidenceId: string;
    organizationId: string;
    providerEntityId: string;
    attemptKey: string;
    sealed: string;
  }): Promise<string>;
};
/**
 * M41's Claim.MD receipt applier, injected by the composition root (apps/backend/src/index.ts). M23 cannot import M41:
 * M41 depends on M23, so a direct import is a module cycle the boundary gate rejects.
 */
export type CommercialClaimMdReceiptApplier = (
  tx: Tx,
  input: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly locationId: string | null;
    readonly claimId: string;
    readonly submissionId: string;
    readonly attemptKey: string;
    readonly payerId: string;
    readonly pcn: string;
    readonly eventId: string;
    readonly occurredAt: Date;
  },
) => Promise<{
  readonly outcome: "applied" | "held";
  readonly previousState: string | null;
  readonly newState: string | null;
  readonly reasonCode: string;
}>;
type Decision = {
  readonly outcome: "applied" | "held" | "informational" | "shadow";
  readonly previousState: string | null;
  readonly newState: string | null;
  readonly reasonCode: string;
};
const held = (reasonCode: string): Decision => ({
  outcome: "held",
  previousState: null,
  newState: null,
  reasonCode,
});
const safeCode = (value: string | null): string | null =>
  value && /^[A-Za-z0-9._:-]{1,64}$/.test(value) ? value : null;
const sourceField = (parent: unknown, key: string): string | null => {
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return null;
  const value = (parent as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const sensitiveEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Checked again inside the tenant transaction, after locking the current resolution. */
export function resolvedAckMatchesEvidence(input: {
  readonly item: ResolvedClaimMdAck;
  readonly current: typeof schema.claimmdResponseResolutions.$inferSelect;
  readonly evidence: typeof schema.claimmdSubmissionEvidence.$inferSelect;
}): boolean {
  const { item, current: r, evidence: e } = input;
  const original = item.resolution;
  return (
    r.id === original.id &&
    r.eventId === item.source.eventId &&
    r.state === "resolved" &&
    r.version === original.version &&
    r.algorithmVersion === "bil1.2.v1" &&
    r.strategy !== null &&
    r.organizationId === original.organizationId &&
    r.providerEntityId === original.providerEntityId &&
    r.locationId === original.locationId &&
    r.claimId === original.claimId &&
    r.module === original.module &&
    r.submissionId === original.submissionId &&
    r.submissionAttemptId === original.submissionAttemptId &&
    r.evidenceRef?.evidenceId === e.id &&
    r.submissionAttemptId === e.id &&
    r.evidenceRef?.payloadSha256 === e.payloadSha256 &&
    e.vendor === "claimmd" &&
    e.accountReference === item.source.accountReference &&
    e.usage === item.source.usage &&
    e.organizationId === r.organizationId &&
    e.providerEntityId === r.providerEntityId &&
    e.locationId === r.locationId &&
    e.claimId === r.claimId &&
    e.billingModule === r.module &&
    e.submissionId === r.submissionId
  );
}

/** One transaction contains the owner domain mutation, its outbox, and the final ledger row. */
export function createClaimMdAckDispatcher(input: {
  readonly db: DbClient;
  readonly source: {
    claim(limit: number): Promise<readonly AckDeliveryLease[]>;
    load(lease: AckDeliveryLease): Promise<ResolvedClaimMdAck | null>;
    complete(lease: AckDeliveryLease): Promise<boolean>;
    retry(
      lease: AckDeliveryLease,
      code: "SOURCE_UNAVAILABLE" | "APPLICATION_FAILED" | "HELD_FOR_REVIEW",
    ): Promise<void>;
  };
  readonly mode: "shadow" | "apply";
  readonly evidenceCipher: EvidenceCipher;
  readonly applyCommercialReceipt: CommercialClaimMdReceiptApplier;
}) {
  const R = schema.claimmdResponseResolutions;
  const E = schema.claimmdSubmissionEvidence;
  const A = schema.claimmdAckApplications;
  const processOne = async (
    item: ResolvedClaimMdAck,
    attemptNumber: number,
  ): Promise<{
    readonly result: "recorded" | "duplicate";
    readonly outcome: Decision["outcome"];
  }> => {
    const org = item.resolution.organizationId;
    if (!org) throw new Error("CLAIMMD_ACK_UNRESOLVED_ORG");
    const interpreted = interpretClaimMdStatus(item.source);
    return withOrgContext(input.db, systemOrgContext(org), async (tx: Tx) => {
      // The advisory lock serializes same-event dispatchers before any domain mutation.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${item.source.eventId}, 0))`,
      );
      const [existing] = await tx
        .select({ outcome: A.outcome })
        .from(A)
        .where(
          and(
            eq(A.eventId, item.source.eventId),
            eq(A.mode, input.mode),
            eq(A.attemptNumber, attemptNumber),
          ),
        )
        .limit(1);
      if (existing) return { result: "duplicate", outcome: existing.outcome };
      const [applied] = await tx
        .select({ id: A.id })
        .from(A)
        .where(
          and(eq(A.eventId, item.source.eventId), eq(A.mode, input.mode), eq(A.outcome, "applied")),
        )
        .limit(1);
      if (applied) return { result: "duplicate", outcome: "applied" };
      const [current] = await tx
        .select()
        .from(R)
        .where(and(eq(R.id, item.resolution.id), eq(R.organizationId, org)))
        .for("share")
        .limit(1);
      const evidenceId = item.resolution.evidenceRef?.evidenceId;
      const [evidence] = evidenceId
        ? await tx
            .select()
            .from(E)
            .where(
              and(
                eq(E.id, evidenceId),
                eq(E.organizationId, org),
                eq(E.accountReference, item.source.accountReference),
                eq(E.usage, item.source.usage),
              ),
            )
            .limit(1)
        : [];
      let decision: Decision = held("IDENTITY_EVIDENCE_STALE");
      if (current && evidence && resolvedAckMatchesEvidence({ item, current, evidence })) {
        const npi = sourceField(item.source.parent, "bill_npi");
        const tin = sourceField(item.source.parent, "bill_taxid");
        const payer = sourceField(item.source.parent, "payerid");
        const pcn = sourceField(item.source.parent, "pcn");
        let historicalTin: string;
        try {
          historicalTin = await input.evidenceCipher.open({
            evidenceId: evidence.id,
            organizationId: evidence.organizationId,
            providerEntityId: evidence.providerEntityId,
            attemptKey: evidence.attemptKey,
            sealed: evidence.billingTinCiphertext,
          });
        } catch {
          throw new Error("CLAIMMD_ACK_HISTORICAL_KEY_UNAVAILABLE");
        }
        if (
          npi !== evidence.billingNpi ||
          !tin ||
          !sensitiveEqual(tin, historicalTin) ||
          payer !== evidence.payerId ||
          pcn !== evidence.pcn
        )
          decision = held("HISTORICAL_IDENTITY_MISMATCH");
        else if (input.mode === "shadow")
          decision = {
            outcome: "shadow",
            previousState: null,
            newState: null,
            reasonCode: interpreted.reasonCode,
          };
        else if (!interpreted.proposedAction)
          decision = {
            outcome: "informational",
            previousState: null,
            newState: null,
            reasonCode: interpreted.reasonCode,
          };
        else if (current.module === "M23")
          decision = await applyMedicareClaimMdReceipt(tx, {
            organizationId: org,
            providerEntityId: evidence.providerEntityId,
            claimId: evidence.claimId,
            submissionId: evidence.submissionId,
            attemptKey: evidence.attemptKey,
            pcn: evidence.pcn,
            occurredAt: item.source.capturedAt,
          });
        else if (current.module === "M41")
          decision = await input.applyCommercialReceipt(tx, {
            organizationId: org,
            providerEntityId: evidence.providerEntityId,
            locationId: evidence.locationId,
            claimId: evidence.claimId,
            submissionId: evidence.submissionId,
            attemptKey: evidence.attemptKey,
            payerId: evidence.payerId,
            pcn: evidence.pcn,
            eventId: item.source.eventId,
            occurredAt: item.source.capturedAt,
          });
        else decision = held("UNSUPPORTED_BILLING_MODULE");
      }
      await tx.insert(A).values({
        eventId: item.source.eventId,
        mode: input.mode,
        attemptNumber,
        resolutionId: item.resolution.id,
        resolutionVersion: item.resolution.version,
        accountReference: item.source.accountReference,
        usage: item.source.usage,
        organizationId: org,
        providerEntityId: item.resolution.providerEntityId!,
        locationId: item.resolution.locationId,
        claimId: item.resolution.claimId!,
        billingModule: item.resolution.module!,
        submissionId: item.resolution.submissionId!,
        evidenceId: evidence?.id ?? null,
        responseId: item.source.responseId,
        sourceRepresentation: interpreted.sourceRepresentation,
        senderId: safeCode(interpreted.senderId),
        messageCode: safeCode(interpreted.messageCode),
        parentStatus: safeCode(interpreted.parentStatus),
        messageStatus: safeCode(interpreted.messageStatus),
        interpreterVersion: interpreted.version,
        proposedAction: interpreted.proposedAction,
        outcome: decision.outcome,
        previousState: decision.previousState,
        newState: decision.newState,
        reasonCode: decision.reasonCode,
      });
      return { result: "recorded", outcome: decision.outcome };
    });
  };
  return {
    processOne,
    async runOnce(): Promise<{
      readonly recorded: number;
      readonly duplicates: number;
      readonly failures: number;
    }> {
      const leases = await input.source.claim(25);
      let recorded = 0;
      let duplicates = 0;
      let failures = 0;
      for (const lease of leases) {
        let item: ResolvedClaimMdAck | null;
        try {
          item = await input.source.load(lease);
        } catch {
          item = null;
        }
        if (!item) {
          failures++;
          try {
            await input.source.retry(lease, "SOURCE_UNAVAILABLE");
          } catch {
            /* lease expiry retries on next tick */
          }
          continue;
        }
        try {
          const result = await processOne(item, lease.attemptNumber);
          if (result.outcome === "held") {
            await input.source.retry(lease, "HELD_FOR_REVIEW");
            recorded += result.result === "recorded" ? 1 : 0;
            duplicates += result.result === "duplicate" ? 1 : 0;
            continue;
          }
          // If a crash occurs before this mark, the next lease sees the ledger and cannot repeat the mutation.
          if (!(await input.source.complete(lease))) {
            failures++;
            continue;
          }
          if (result.result === "recorded") recorded++;
          else duplicates++;
        } catch {
          failures++;
          try {
            await input.source.retry(lease, "APPLICATION_FAILED");
          } catch {
            /* lease expiry retries on next tick */
          }
        }
      }
      return { recorded, duplicates, failures };
    },
  };
}
