import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import type { ClaimMdEraListPage } from "@chartwarden/x12-837-client";
import { and, asc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { ClaimMdPayloadKeyRing } from "../../../bootstrap/claimmd-payload-cipher";
import { createClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";

export const CLAIMMD_ERA_CAPTURE_JOB_ID = "m25-claimmd-era-capture";
const S = schema.claimmdEraStreams;
const I = schema.claimmdEraInbox;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface ClaimMdEraLease {
  readonly streamId: string; readonly owner: string; readonly generation: bigint;
  readonly accountReference: string; readonly usage: "test" | "production"; readonly cursor: string;
}

/** Central source rows are accessed only through the audited platform context and dedicated grants. */
export function createClaimMdEraStore(input: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<Tx>;
  readonly keyRing: ClaimMdPayloadKeyRing;
}) {
  const cipher = createClaimMdProtectedPayloadCipher(input.keyRing, "claimmd-era:v1");
  const run = <T>(reason: string, fn: (tx: Tx) => Promise<T>) =>
    withPlatformContext(input.platformDb, { jobId: CLAIMMD_ERA_CAPTURE_JOB_ID, reason, crossTenant: true }, input.auditBypass, fn);
  const leasePredicate = (lease: ClaimMdEraLease) => and(
    eq(S.id, lease.streamId), eq(S.leaseOwner, lease.owner), eq(S.generation, lease.generation), sql`${S.leaseUntil} > now()`,
  );
  return {
    /** There is deliberately no stream insert here; bootstrap is an operator-reviewed SQL action. */
    async acquire(accountReference: string, usage: "test" | "production"): Promise<ClaimMdEraLease | null> {
      const owner = randomUUID();
      return run("Claim.MD ERA lease acquire", async (tx) => {
        const [row] = await tx.update(S).set({ leaseOwner: owner, leaseUntil: sql`now() + interval '90 seconds'`,
          generation: sql`${S.generation} + 1`, lastAttemptAt: sql`now()`, updatedAt: sql`now()`, errorCode: null })
          .where(and(eq(S.vendor, "claimmd"), eq(S.accountReference, accountReference), eq(S.usage, usage), eq(S.streamKind, "eras"),
            or(isNull(S.leaseUntil), lt(S.leaseUntil, sql`now()`))))
          .returning({ streamId: S.id, accountReference: S.accountReference, usage: S.usage, generation: S.generation, cursor: S.cursor });
        return row ? { streamId: row.streamId, owner, generation: row.generation, accountReference, usage, cursor: row.cursor } : null;
      });
    },

    async renew(lease: ClaimMdEraLease): Promise<void> {
      await run("Claim.MD ERA lease renew", async (tx) => {
        const [row] = await tx.update(S).set({ leaseUntil: sql`now() + interval '90 seconds'`, updatedAt: sql`now()` })
          .where(leasePredicate(lease)).returning({ id: S.id });
        if (!row) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
      });
    },

    /** Upserts all page identities and advances one cursor atomically. Crash before commit safely rescans. */
    async commitDiscovery(lease: ClaimMdEraLease, inputPage: { readonly afterEraId: string; readonly nextEraId: string;
      readonly leaseGeneration: bigint; readonly pages: readonly ClaimMdEraListPage[] }): Promise<void> {
      if (inputPage.afterEraId !== lease.cursor || inputPage.leaseGeneration !== lease.generation ||
          BigInt(inputPage.nextEraId) < BigInt(lease.cursor)) throw new Error("CLAIMMD_ERA_CURSOR_MISMATCH");
      const pages = inputPage.pages;
      if (pages.length === 0 || pages[0]?.afterEraId !== lease.cursor || pages.some((page, index) =>
        page.page !== index + 1 || page.afterEraId !== lease.cursor || page.lastEraId !== inputPage.nextEraId))
        throw new Error("CLAIMMD_ERA_PAGE_SET_INVALID");
      return run("Claim.MD ERA discovery page commit", async (tx) => {
        const [stream] = await tx.select({ cursor: S.cursor }).from(S).where(leasePredicate(lease)).for("update").limit(1);
        if (!stream || stream.cursor !== lease.cursor) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
        for (const page of pages) for (const item of page.items) {
          const [existing] = await tx.select({ digest: I.sourceMetadataDigest }).from(I)
            .where(and(eq(I.streamId, lease.streamId), eq(I.eraId, item.eraId))).limit(1);
          if (existing) {
            if (existing.digest !== item.digest) throw new Error("CLAIMMD_ERA_ID_CONFLICT");
            continue;
          }
          const sealed = cipher.seal(lease.streamId, item.eraId, JSON.stringify(item.metadata));
          await tx.insert(I).values({ streamId: lease.streamId, vendor: "claimmd", accountReference: lease.accountReference,
            usage: lease.usage, eraId: item.eraId, sourceMetadataCipher: sealed.toString("base64"),
            sourceMetadataKeyId: input.keyRing.activeId, sourceMetadataDigest: item.digest,
            discoveryPageDigest: page.digest, captureState: "discovered" }).onConflictDoNothing();
        }
        const [moved] = await tx.update(S).set({ cursor: inputPage.nextEraId, leaseUntil: sql`now() + interval '90 seconds'`,
          lastSuccessAt: sql`now()`, errorCode: null, updatedAt: sql`now()` }).where(leasePredicate(lease)).returning({ id: S.id });
        if (!moved) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
      });
    },

    async pendingCapture(lease: ClaimMdEraLease, limit = 25): Promise<readonly string[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("CLAIMMD_ERA_CAPTURE_BATCH_INVALID");
      return run("Claim.MD ERA pending capture read", async (tx) => {
        const [stream] = await tx.select({ id: S.id }).from(S).where(leasePredicate(lease)).limit(1);
        if (!stream) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
        const rows = await tx.select({ eraId: I.eraId }).from(I).where(and(eq(I.streamId, lease.streamId),
          or(eq(I.captureState, "discovered"), eq(I.captureState, "retryable_failure"))))
          .orderBy(asc(I.discoveredAt)).limit(limit);
        return rows.map((row) => row.eraId);
      });
    },

    /** Marks an ERA captured only after both vendor sources are encrypted and digested in the same transaction. */
    async recordCapture(lease: ClaimMdEraLease, inputPayload: { readonly eraId: string; readonly files: readonly string[];
      readonly originalDigest: string; readonly details: Readonly<Record<string, unknown>>; readonly detailsDigest: string }): Promise<void> {
      if (!/^[0-9]{1,64}$/.test(inputPayload.eraId) || inputPayload.files.length === 0 || inputPayload.files.length > 100 ||
        !/^[0-9a-f]{64}$/.test(inputPayload.originalDigest) || !/^[0-9a-f]{64}$/.test(inputPayload.detailsDigest))
        throw new Error("CLAIMMD_ERA_CAPTURE_INVALID");
      const rawCipher = cipher.seal(lease.streamId, `${inputPayload.eraId}:835`, JSON.stringify(inputPayload.files));
      const detailsCipher = cipher.seal(lease.streamId, `${inputPayload.eraId}:details`, JSON.stringify(inputPayload.details));
      await run("Claim.MD ERA protected capture", async (tx) => {
        const [stream] = await tx.select({ id: S.id }).from(S).where(leasePredicate(lease)).for("update").limit(1);
        if (!stream) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
        const [row] = await tx.update(I).set({ captureState: "captured", original835Cipher: rawCipher.toString("base64"),
          original835KeyId: input.keyRing.activeId, original835Digest: inputPayload.originalDigest,
          original835FileCount: inputPayload.files.length, structuredDetailsCipher: detailsCipher.toString("base64"),
          structuredDetailsKeyId: input.keyRing.activeId, structuredDetailsDigest: inputPayload.detailsDigest,
          capturedAt: sql`now()`, lastErrorCode: null, updatedAt: sql`now()` })
          .where(and(eq(I.streamId, lease.streamId), eq(I.eraId, inputPayload.eraId),
            or(eq(I.captureState, "discovered"), eq(I.captureState, "retryable_failure"))))
          .returning({ id: I.id });
        if (!row) throw new Error("CLAIMMD_ERA_CAPTURE_ROW_UNAVAILABLE");
      });
    },

    async recordCaptureFailure(lease: ClaimMdEraLease, eraId: string, code: string): Promise<void> {
      if (!/^[A-Z_]{1,40}$/.test(code)) code = "CAPTURE_FAILED";
      await run("Claim.MD ERA capture failure record", async (tx) => {
        const [stream] = await tx.select({ id: S.id }).from(S).where(leasePredicate(lease)).for("update").limit(1);
        if (!stream) throw new Error("CLAIMMD_ERA_LEASE_FENCED");
        await tx.update(I).set({ captureState: "retryable_failure", retryCount: sql`${I.retryCount} + 1`,
          lastErrorCode: code, updatedAt: sql`now()` }).where(and(eq(I.streamId, lease.streamId), eq(I.eraId, eraId),
            or(eq(I.captureState, "discovered"), eq(I.captureState, "retryable_failure"))));
      });
    },

    async release(lease: ClaimMdEraLease, errorCode: string | null = null): Promise<void> {
      if (errorCode && !/^[A-Z_]{1,40}$/.test(errorCode)) throw new Error("CLAIMMD_ERA_ERROR_CODE_INVALID");
      await run("Claim.MD ERA lease release", async (tx) => {
        await tx.update(S).set({ leaseOwner: null, leaseUntil: null, errorCode, updatedAt: sql`now()` }).where(leasePredicate(lease));
      });
    },
  };
}
