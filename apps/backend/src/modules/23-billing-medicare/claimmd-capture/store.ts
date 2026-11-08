import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import type { AccountResponsePage, ClaimMdUsage } from "@chartwarden/x12-837-client";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { createClaimMdInboxCipher } from "./cipher";

export const CLAIMMD_CAPTURE_JOB_ID = "m23-claimmd-response-capture";
const S = schema.claimmdResponseStreams;
const B = schema.claimmdResponseBatches;
const E = schema.claimmdResponseEvents;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
export interface StreamLease {
  readonly streamId: string;
  readonly owner: string;
  readonly generation: bigint;
  readonly accountReference: string;
  readonly usage: ClaimMdUsage;
  readonly cursor: string;
}
const identity = (accountReference: string, usage: ClaimMdUsage) =>
  and(
    eq(S.accountReference, accountReference),
    eq(S.usage, usage),
    eq(S.streamType, "claim_responses"),
  );
const owned = (lease: StreamLease) =>
  and(
    eq(S.id, lease.streamId),
    eq(S.leaseOwner, lease.owner),
    eq(S.generation, lease.generation),
    sql`${S.leaseUntil} > now()`,
  );

/** The injected DB must be the audited platform pool whose role inherits only claimmd_capture grants. */
export function createClaimMdResponseStore(input: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<Tx>;
  readonly cipher: ReturnType<typeof createClaimMdInboxCipher>;
}) {
  const run = <T>(reason: string, fn: (tx: Tx) => Promise<T>) =>
    withPlatformContext(
      input.platformDb,
      { jobId: CLAIMMD_CAPTURE_JOB_ID, reason, crossTenant: true },
      input.auditBypass,
      fn,
    );
  return {
    /** No implicit stream creation or cursor=0: an operator must bootstrap a row explicitly. */
    async acquire(accountReference: string, usage: ClaimMdUsage): Promise<StreamLease | null> {
      const owner = randomUUID();
      return run("claimmd response lease acquire", async (tx) => {
        const [row] = await tx
          .update(S)
          .set({
            leaseOwner: owner,
            leaseUntil: sql`now() + interval '90 seconds'`,
            generation: sql`${S.generation} + 1`,
            lastAttemptAt: sql`now()`,
            updatedAt: sql`now()`,
            errorCode: null,
          })
          .where(
            and(
              identity(accountReference, usage),
              or(isNull(S.leaseUntil), lt(S.leaseUntil, sql`now()`)),
            ),
          )
          .returning({
            id: S.id,
            accountReference: S.accountReference,
            usage: S.usage,
            generation: S.generation,
            cursor: S.cursor,
          });
        return row
          ? {
              streamId: row.id,
              owner,
              generation: row.generation,
              accountReference: row.accountReference,
              usage: row.usage,
              cursor: row.cursor,
            }
          : null;
      });
    },
    async commit(
      lease: StreamLease,
      page: AccountResponsePage,
    ): Promise<{ cursor: string; inserted: number; duplicates: number; review: number }> {
      if (page.afterCursor !== lease.cursor || BigInt(page.nextCursor) < BigInt(page.afterCursor))
        throw new Error("CLAIMMD_CURSOR_MISMATCH");
      const plaintext = JSON.stringify(page.body);
      const encrypted = input.cipher.seal(lease.streamId, page.afterCursor, plaintext);
      return run("claimmd response page capture", async (tx) => {
        const [stream] = await tx
          .select({ cursor: S.cursor })
          .from(S)
          .where(owned(lease))
          .for("update")
          .limit(1);
        if (!stream) throw new Error("CLAIMMD_LEASE_FENCED");
        if (stream.cursor !== page.afterCursor) throw new Error("CLAIMMD_CURSOR_MISMATCH");
        const seen = new Map<string, string>();
        for (const event of page.events) {
          if (!event.responseId) continue;
          const prior = seen.get(event.responseId);
          if (prior && prior !== event.digest) throw new Error("CLAIMMD_VENDOR_ID_CONFLICT");
          seen.set(event.responseId, event.digest);
        }
        const [batch] = await tx
          .insert(B)
          .values({
            streamId: lease.streamId,
            afterCursor: page.afterCursor,
            nextCursor: page.nextCursor,
            payloadCipher: encrypted,
            payloadDigest: page.digest,
            parentCount: page.parentCount,
            eventCount: page.events.length,
          })
          .returning({ id: B.id });
        if (!batch) throw new Error("CLAIMMD_CAPTURE_FAILED");
        let inserted = 0;
        for (let offset = 0; offset < page.events.length; offset += 500) {
          const group = page.events.slice(offset, offset + 500);
          const ids = group.flatMap((event) => (event.responseId ? [event.responseId] : []));
          if (ids.length) {
            const existing = await tx
              .select({ responseId: E.responseId, digest: E.payloadDigest })
              .from(E)
              .where(and(eq(E.streamId, lease.streamId), inArray(E.responseId, ids)));
            for (const event of existing) {
              const incoming = seen.get(event.responseId ?? "");
              if (incoming && incoming !== event.digest)
                throw new Error("CLAIMMD_VENDOR_ID_CONFLICT");
            }
          }
          const rows = await tx
            .insert(E)
            .values(
              group.map((event) => ({
                streamId: lease.streamId,
                batchId: batch.id,
                responseId: event.responseId,
                sourceCursor: page.afterCursor,
                parentIndex: event.parentIndex,
                messageIndex: event.messageIndex,
                payloadDigest: event.digest,
                captureState: event.state,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: E.id });
          inserted += rows.length;
        }
        const [moved] = await tx
          .update(S)
          .set({
            cursor: page.nextCursor,
            leaseUntil: sql`now() + interval '90 seconds'`,
            lastSuccessAt: sql`now()`,
            updatedAt: sql`now()`,
            errorCode: null,
          })
          .where(owned(lease))
          .returning({ cursor: S.cursor });
        if (!moved) throw new Error("CLAIMMD_LEASE_FENCED");
        return {
          cursor: moved.cursor,
          inserted,
          duplicates: page.events.length - inserted,
          review: page.events.filter((event) => event.state !== "captured").length,
        };
      });
    },
    async release(lease: StreamLease, errorCode: string | null = null): Promise<void> {
      if (errorCode && !/^[A-Z_]{1,40}$/.test(errorCode))
        throw new Error("CLAIMMD_ERROR_CODE_INVALID");
      await run("claimmd response lease release", async (tx) => {
        await tx
          .update(S)
          .set({ leaseOwner: null, leaseUntil: null, errorCode, updatedAt: sql`now()` })
          .where(owned(lease));
      });
    },
  };
}
