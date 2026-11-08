import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { CapturedClaimMdMessage } from "./interpret";

export const CLAIMMD_ACK_JOB_ID = "m23-claimmd-ack-dispatch";
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type Cipher = { open(streamId: string, cursor: string, sealed: Buffer): string };
type Usage = "test" | "production";
export interface AckDeliveryLease { readonly eventId: string; readonly leaseToken: string; readonly attemptNumber: number }
export interface ResolvedClaimMdAck {
  readonly source: CapturedClaimMdMessage;
  readonly resolution: typeof schema.claimmdResponseResolutions.$inferSelect;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const entries = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Account-scoped lease/read methods; they never move the BIL-1.1 response cursor. */
export function createClaimMdAckSource(input: { readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<Tx>; readonly cipher: Cipher;
  readonly accountReference: string; readonly usage: Usage; readonly mode: "shadow" | "apply" }) {
  const mode = input.mode;
  const R = schema.claimmdResponseResolutions;
  const E = schema.claimmdResponseEvents;
  const B = schema.claimmdResponseBatches;
  const S = schema.claimmdResponseStreams;
  const D = schema.claimmdAckDeliveries;
  const run = <T>(reason: string, fn: (tx: Tx) => Promise<T>) => withPlatformContext(input.platformDb,
    { jobId: CLAIMMD_ACK_JOB_ID, reason, crossTenant: true }, input.auditBypass, fn);
  const scope = and(eq(D.accountReference, input.accountReference), eq(D.usage, input.usage), eq(D.mode, mode));
  return {
    async claim(limit: number): Promise<readonly AckDeliveryLease[]> {
      const leaseToken = randomUUID();
      return run("Claim.MD acknowledgment delivery lease", async (tx) => {
        const due = await tx.select({ eventId: D.eventId, attempts: D.attempts }).from(D)
          .where(and(scope, eq(D.state, "pending"), lte(D.nextAttemptAt, sql`now()`),
            or(isNull(D.leaseUntil), lte(D.leaseUntil, sql`now()`))))
          .orderBy(asc(D.nextAttemptAt), asc(D.eventId)).limit(Math.max(1, Math.min(25, limit)))
          .for("update", { skipLocked: true });
        for (const row of due) await tx.update(D).set({ leaseOwner: leaseToken,
          leaseUntil: sql`now() + interval '90 seconds'`, updatedAt: sql`now()` })
          .where(and(scope, eq(D.eventId, row.eventId)));
        return due.map((row) => ({ eventId: row.eventId, leaseToken, attemptNumber: row.attempts + 1 }));
      });
    },
    async load(lease: AckDeliveryLease): Promise<ResolvedClaimMdAck | null> {
      return run("Claim.MD captured response read", async (tx) => {
        const [row] = await tx.select({ resolution: R, event: E, batch: B, stream: S }).from(D)
          .innerJoin(R, eq(R.eventId, D.eventId))
          .innerJoin(E, eq(E.id, R.eventId)).innerJoin(B, eq(B.id, E.batchId))
          .innerJoin(S, eq(S.id, E.streamId))
          .where(and(scope, eq(D.eventId, lease.eventId), eq(D.leaseOwner, lease.leaseToken),
            sql`${D.leaseUntil} > now()`, eq(R.state, "resolved"),
            eq(S.accountReference, input.accountReference), eq(S.usage, input.usage),
            eq(S.streamType, "claim_responses"))).limit(1);
        if (!row) return null;
        let body: unknown;
        try { body = JSON.parse(input.cipher.open(row.stream.id, row.batch.afterCursor, row.batch.payloadCipher)); }
        catch { throw new Error("CLAIMMD_ACK_SOURCE_UNAVAILABLE"); }
        if (!record(body)) throw new Error("CLAIMMD_ACK_SOURCE_MALFORMED");
        const root = record(body.result) ? body.result : body;
        const parent = entries(root.claim)[row.event.parentIndex];
        const messages = record(parent) ? entries(parent.messages) : [];
        const message = row.event.messageIndex < 0 ? null : messages[row.event.messageIndex];
        if (digest([parent, message]) !== row.event.payloadDigest)
          throw new Error("CLAIMMD_ACK_SOURCE_DIGEST_MISMATCH");
        return { source: { eventId: row.event.id, responseId: row.event.responseId,
          accountReference: row.stream.accountReference, usage: row.stream.usage,
          capturedAt: row.event.capturedAt, parent, message }, resolution: row.resolution };
      });
    },
    async complete(lease: AckDeliveryLease): Promise<boolean> {
      return run("Claim.MD acknowledgment delivery complete", async (tx) => {
        const [row] = await tx.update(D).set({ state: "complete", leaseOwner: null, leaseUntil: null,
          errorCode: null, updatedAt: sql`now()` })
          .where(and(scope, eq(D.eventId, lease.eventId), eq(D.leaseOwner, lease.leaseToken),
            sql`${D.leaseUntil} > now()`, eq(D.state, "pending"))).returning({ eventId: D.eventId });
        return !!row;
      });
    },
    async retry(lease: AckDeliveryLease, code: "SOURCE_UNAVAILABLE" | "APPLICATION_FAILED" | "HELD_FOR_REVIEW"): Promise<void> {
      await run("Claim.MD acknowledgment delivery retry", async (tx) => {
        await tx.update(D).set({ attempts: sql`${D.attempts} + 1`,
          state: sql`CASE WHEN ${D.attempts} >= 7 THEN 'needs_review' ELSE 'pending' END`,
          nextAttemptAt: sql`now() + (LEAST(30, power(2, LEAST(${D.attempts}, 4))) * interval '1 minute')`,
          leaseOwner: null, leaseUntil: null, errorCode: code, updatedAt: sql`now()` })
          .where(and(scope, eq(D.eventId, lease.eventId), eq(D.leaseOwner, lease.leaseToken),
            eq(D.state, "pending")));
      });
    },
  };
}
