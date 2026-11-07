import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { type PlatformBypassAuditor, withPlatformContext } from "@chartwarden/tenancy";
import type { ClaimMdEraListPage } from "@chartwarden/x12-837-client";
import { and, asc, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { ClaimMdPayloadKeyRing } from "../../../bootstrap/claimmd-payload-cipher";
import { createClaimMdProtectedPayloadCipher } from "../../../bootstrap/claimmd-payload-cipher";

export const CLAIMMD_ERA_CAPTURE_JOB_ID = "m25-claimmd-era-capture";
export const CLAIMMD_ERA_RESOLUTION_JOB_ID = "m25-claimmd-era-ownership-resolution";
export const CLAIMMD_ERA_DELIVERY_JOB_ID = "m25-claimmd-era-delivery";
const S = schema.claimmdEraStreams;
const I = schema.claimmdEraInbox;
const R = schema.claimmdEraResolution;
const RH = schema.claimmdEraResolutionHistory;
const D = schema.claimmdEraDelivery;
const DH = schema.claimmdEraDeliveryHistory;
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
  const resolutionCipher = createClaimMdProtectedPayloadCipher(input.keyRing, "claimmd-era-resolution:v1");
  const run = <T>(reason: string, fn: (tx: Tx) => Promise<T>, jobId = CLAIMMD_ERA_CAPTURE_JOB_ID) =>
    withPlatformContext(input.platformDb, { jobId, reason, crossTenant: true }, input.auditBypass, fn);
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

    /** Bounded, account-scoped work list for newly captured sources with no decision yet. */
    async pendingResolution(accountReference: string, usage: "test" | "production", limit = 25): Promise<readonly string[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("CLAIMMD_ERA_RESOLUTION_BATCH_INVALID");
      return run("Claim.MD ERA unresolved captured inbox scan", async (tx) => {
        const prior = tx.select({ id: R.id }).from(R).where(eq(R.inboxId, I.id));
        const rows = await tx.select({ id: I.id }).from(I).where(and(eq(I.vendor, "claimmd"),
          eq(I.accountReference, accountReference), eq(I.usage, usage), eq(I.captureState, "captured"), notExists(prior)))
          .orderBy(asc(I.capturedAt)).limit(limit);
        return rows.map((row) => row.id);
      }, CLAIMMD_ERA_RESOLUTION_JOB_ID);
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

    /** Authorized internal worker read; returns plaintext only to the caller's memory and never logs it. */
    async readCapturedEra(inputRead: { readonly inboxId: string; readonly accountReference: string; readonly usage: "test" | "production";
      readonly executionJobId?: string }) {
      return run("Claim.MD ERA protected source decryption for ownership resolution", async (tx) => {
        const [row] = await tx.select({ id: I.id, streamId: I.streamId, vendor: I.vendor, accountReference: I.accountReference,
          usage: I.usage, eraId: I.eraId, state: I.captureState, digest: I.original835Digest, keyId: I.original835KeyId,
          cipherText: I.original835Cipher, fileCount: I.original835FileCount }).from(I)
          .where(and(eq(I.id, inputRead.inboxId), eq(I.vendor, "claimmd"), eq(I.accountReference, inputRead.accountReference),
            eq(I.usage, inputRead.usage))).limit(1);
        if (!row || row.state !== "captured" || !row.cipherText || !row.digest || !row.keyId || !row.fileCount)
          throw new Error("CLAIMMD_ERA_SOURCE_UNAVAILABLE");
        const sealed = Buffer.from(row.cipherText, "base64");
        const marker = sealed.indexOf(46, 3);
        if (sealed.subarray(0, 3).toString() !== "v1." || marker < 4 || sealed.subarray(3, marker).toString() !== row.keyId)
          throw new Error("CLAIMMD_ERA_SOURCE_INVALID");
        const decoded = cipher.open(row.streamId, `${row.eraId}:835`, sealed);
        let files: unknown;
        try { files = JSON.parse(decoded); } catch { throw new Error("CLAIMMD_ERA_SOURCE_INVALID"); }
        if (!Array.isArray(files) || files.length !== row.fileCount || files.some((file) => typeof file !== "string") ||
            createHash("sha256").update(JSON.stringify(files), "utf8").digest("hex") !== row.digest)
          throw new Error("CLAIMMD_ERA_SOURCE_INTEGRITY_FAILED");
        return { inboxId: row.id, streamId: row.streamId, vendor: row.vendor, accountReference: row.accountReference,
          usage: row.usage as "test" | "production", eraId: row.eraId, originalDigest: row.digest,
          files: files as string[] };
      }, inputRead.executionJobId);
    },

    /** Revalidates and decrypts only a current BIL-1.4.1A verified decision under audited central execution. */
    async readVerifiedResolution(inputRead: { readonly inboxId: string; readonly accountReference: string; readonly usage: "test" | "production" }) {
      return run("Claim.MD ERA verified ownership read for M25 delivery", async (tx) => {
        const [row] = await tx.select({ id: R.id, inboxId: R.inboxId, accountReference: R.accountReference,
          usage: R.usage, digest: R.original835Digest, status: R.status, organizationId: R.organizationId,
          providerEntityId: R.providerEntityId, locationId: R.locationId, algorithmVersion: R.algorithmVersion,
          version: R.resolutionVersion, decisionCipher: R.decisionCipher, decisionKeyId: R.decisionKeyId,
          decisionDigest: R.decisionDigest, sourceStreamId: I.streamId, sourceEraId: I.eraId,
          sourceDigest: I.original835Digest, sourceState: I.captureState, sourceVendor: I.vendor,
          sourceAccount: I.accountReference, sourceUsage: I.usage, sourceCipher: I.original835Cipher,
          sourceKeyId: I.original835KeyId, sourceFileCount: I.original835FileCount }).from(R).innerJoin(I, eq(I.id, R.inboxId))
          .where(and(eq(R.inboxId, inputRead.inboxId), eq(R.accountReference, inputRead.accountReference),
            eq(R.usage, inputRead.usage))).limit(1);
        if (!row || row.status !== "verified" || row.sourceState !== "captured" || row.sourceVendor !== "claimmd" ||
            row.sourceAccount !== inputRead.accountReference || row.sourceUsage !== inputRead.usage ||
            row.accountReference !== inputRead.accountReference || row.usage !== inputRead.usage ||
            row.digest !== row.sourceDigest || !row.sourceCipher || !row.sourceKeyId || !row.sourceFileCount ||
            !row.organizationId || !row.providerEntityId || row.algorithmVersion !== "BIL141A_V1")
          throw new Error("CLAIMMD_ERA_RESOLUTION_NOT_DELIVERABLE");
        const [history] = await tx.select({ status: RH.status, organizationId: RH.organizationId,
          providerEntityId: RH.providerEntityId, algorithmVersion: RH.algorithmVersion, decisionDigest: RH.decisionDigest })
          .from(RH).where(and(eq(RH.resolutionId, row.id), eq(RH.resolutionVersion, row.version))).limit(1);
        if (!history || history.status !== "verified" || history.organizationId !== row.organizationId ||
            history.providerEntityId !== row.providerEntityId || history.algorithmVersion !== row.algorithmVersion ||
            history.decisionDigest !== row.decisionDigest)
          throw new Error("CLAIMMD_ERA_RESOLUTION_HISTORY_MISMATCH");
        const sealed = Buffer.from(row.decisionCipher, "base64");
        const marker = sealed.indexOf(46, 3);
        if (sealed.subarray(0, 3).toString() !== "v1." || marker < 4 ||
            sealed.subarray(3, marker).toString() !== row.decisionKeyId)
          throw new Error("CLAIMMD_ERA_RESOLUTION_INVALID");
        const decisionJson = resolutionCipher.open(row.sourceStreamId, `${row.sourceEraId}:resolution:${row.version}`, sealed);
        if (createHash("sha256").update(decisionJson, "utf8").digest("hex") !== row.decisionDigest)
          throw new Error("CLAIMMD_ERA_RESOLUTION_INTEGRITY_FAILED");
        let decision: unknown;
        try { decision = JSON.parse(decisionJson); } catch { throw new Error("CLAIMMD_ERA_RESOLUTION_INVALID"); }
        if (!decision || typeof decision !== "object" || (decision as { payeeOutcome?: unknown }).payeeOutcome !== "verified")
          throw new Error("CLAIMMD_ERA_RESOLUTION_NOT_DELIVERABLE");
        return { resolutionId: row.id, inboxId: row.inboxId, accountReference: row.accountReference,
          usage: row.usage as "test" | "production", eraId: row.sourceEraId, originalDigest: row.digest,
          version: row.version, algorithmVersion: row.algorithmVersion, organizationId: row.organizationId,
          providerEntityId: row.providerEntityId, locationId: row.locationId, decision: decision as Readonly<Record<string, unknown>> };
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    async pendingDelivery(accountReference: string, usage: "test" | "production", limit = 25): Promise<readonly string[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("CLAIMMD_ERA_DELIVERY_BATCH_INVALID");
      return run("Claim.MD ERA verified delivery work list", async (tx) => {
        const existingDelivery = tx.select({ id: D.id }).from(D).where(eq(D.inboxId, I.id));
        const rows = await tx.select({ id: R.inboxId }).from(R).innerJoin(I, eq(I.id, R.inboxId)).where(and(
          eq(R.status, "verified"), eq(R.algorithmVersion, "BIL141A_V1"), eq(I.vendor, "claimmd"),
          eq(I.accountReference, accountReference), eq(I.usage, usage), eq(I.captureState, "captured"), notExists(existingDelivery)))
          .orderBy(asc(I.capturedAt)).limit(limit);
        const recovery = await tx.select({ inboxId: D.inboxId }).from(D).where(and(
          eq(D.accountReference, accountReference), eq(D.usage, usage),
          or(eq(D.state, "prepared"), eq(D.tenantFinalized, false)))).orderBy(asc(D.updatedAt)).limit(limit);
        return [...new Set([...recovery.map((row) => row.inboxId), ...rows.map((row) => row.id)])].slice(0, limit);
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    async readDeliveryState(inputRead: { readonly inboxId: string; readonly accountReference: string; readonly usage: "test" | "production" }) {
      return run("Claim.MD ERA delivery recovery state read", async (tx) => {
        const [row] = await tx.select({ id: D.id, inboxId: D.inboxId, organizationId: D.organizationId,
          providerEntityId: D.providerEntityId, resolutionId: D.resolutionId, resolutionVersion: D.resolutionVersion,
          originalDigest: D.original835Digest, state: D.state, stageIds: D.stageIds, tenantFinalized: D.tenantFinalized,
          safeErrorCode: D.safeErrorCode, existingAdviceId: D.existingAdviceId }).from(D).where(and(
          eq(D.inboxId, inputRead.inboxId), eq(D.accountReference, inputRead.accountReference), eq(D.usage, inputRead.usage)))
          .limit(1);
        return row ?? null;
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    /** Records safe failure without exposing vendor/parser errors; retries never overwrite a terminal receipt. */
    async holdDelivery(inputHold: { readonly inboxId: string; readonly accountReference: string;
      readonly usage: "test" | "production"; readonly reason: "SOURCE_REVALIDATION_FAILED" | "STALE_OR_UNVERIFIED_RESOLUTION" }) {
      return run("Claim.MD ERA delivery held for source revalidation", async (tx) => {
        const [source] = await tx.select({ id: I.id, streamId: I.streamId, eraId: I.eraId, digest: I.original835Digest,
          state: I.captureState, vendor: I.vendor, accountReference: I.accountReference, usage: I.usage })
          .from(I).where(and(eq(I.id, inputHold.inboxId), eq(I.accountReference, inputHold.accountReference),
            eq(I.usage, inputHold.usage), eq(I.vendor, "claimmd"))).for("update").limit(1);
        const [resolution] = await tx.select({ id: R.id, version: R.resolutionVersion, organizationId: R.organizationId,
          providerEntityId: R.providerEntityId, locationId: R.locationId, digest: R.original835Digest,
          status: R.status, algorithmVersion: R.algorithmVersion }).from(R)
          .where(eq(R.inboxId, inputHold.inboxId)).limit(1);
        if (!source || !resolution || source.state !== "captured" || !source.digest || resolution.digest !== source.digest)
          return null;
        const [existing] = await tx.select().from(D).where(eq(D.inboxId, inputHold.inboxId)).for("update").limit(1);
        if (existing) {
          if (existing.state !== "held") {
            await tx.update(D).set({ state: "held", safeErrorCode: inputHold.reason, completedAt: sql`now()`, updatedAt: sql`now()` })
              .where(eq(D.id, existing.id));
            await tx.insert(DH).values({ deliveryId: existing.id, state: "held", safeReasonCode: inputHold.reason,
              attemptCount: existing.attemptCount, stageIds: existing.stageIds });
            return { id: existing.id, inboxId: existing.inboxId, organizationId: existing.organizationId,
              providerEntityId: existing.providerEntityId, resolutionId: existing.resolutionId,
              resolutionVersion: existing.resolutionVersion, originalDigest: existing.original835Digest,
              state: "held", stageIds: existing.stageIds, tenantFinalized: existing.stageIds.length === 0, safeErrorCode: inputHold.reason,
              existingAdviceId: existing.existingAdviceId };
          }
          return { id: existing.id, inboxId: existing.inboxId, organizationId: existing.organizationId,
            providerEntityId: existing.providerEntityId, resolutionId: existing.resolutionId,
            resolutionVersion: existing.resolutionVersion, originalDigest: existing.original835Digest,
            state: existing.state, stageIds: existing.stageIds, tenantFinalized: existing.tenantFinalized,
            safeErrorCode: existing.safeErrorCode, existingAdviceId: existing.existingAdviceId };
        }
        if (resolution.status !== "verified" || !resolution.organizationId || !resolution.providerEntityId) return null;
        const idempotencyKey = createHash("sha256").update(
          ["claimmd", source.accountReference, source.usage, source.eraId].join("\0"), "utf8").digest("hex");
        const [created] = await tx.insert(D).values({ inboxId: source.id, resolutionId: resolution.id,
          resolutionVersion: resolution.version, vendor: "claimmd", accountReference: source.accountReference,
          usage: source.usage, eraId: source.eraId, original835Digest: source.digest,
          organizationId: resolution.organizationId, providerEntityId: resolution.providerEntityId,
          locationId: resolution.locationId, idempotencyKey, state: "held", tenantFinalized: true,
          safeErrorCode: inputHold.reason, attemptCount: 0, completedAt: sql`now()` })
          .onConflictDoNothing().returning({ id: D.id });
        if (!created) return null;
        await tx.insert(DH).values({ deliveryId: created.id, state: "held", safeReasonCode: inputHold.reason,
          attemptCount: 0, stageIds: [] });
        return { id: created.id, inboxId: source.id, organizationId: resolution.organizationId,
          providerEntityId: resolution.providerEntityId, resolutionId: resolution.id, resolutionVersion: resolution.version,
          originalDigest: source.digest, state: "held", stageIds: [], tenantFinalized: true,
          safeErrorCode: inputHold.reason, existingAdviceId: null };
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    /** Durable prepare fence. Repeated calls reuse the same account/vendor/ERA identity; changed ownership holds. */
    async prepareDelivery(inputDelivery: { readonly inboxId: string; readonly accountReference: string;
      readonly usage: "test" | "production"; readonly resolutionId: string; readonly resolutionVersion: number;
      readonly originalDigest: string; readonly eraId: string; readonly organizationId: string;
      readonly providerEntityId: string; readonly locationId: string | null }) {
      const idempotencyKey = createHash("sha256").update(
        ["claimmd", inputDelivery.accountReference, inputDelivery.usage, inputDelivery.eraId].join("\0"), "utf8").digest("hex");
      return run("Claim.MD ERA M25 delivery prepare", async (tx) => {
        const [source] = await tx.select({ id: I.id, streamId: I.streamId, eraId: I.eraId, digest: I.original835Digest,
          state: I.captureState, vendor: I.vendor, accountReference: I.accountReference, usage: I.usage })
          .from(I).where(eq(I.id, inputDelivery.inboxId)).for("update").limit(1);
        const [resolution] = await tx.select({ id: R.id, version: R.resolutionVersion, status: R.status,
          algorithmVersion: R.algorithmVersion, digest: R.original835Digest, organizationId: R.organizationId,
          providerEntityId: R.providerEntityId, locationId: R.locationId }).from(R)
          .where(eq(R.inboxId, inputDelivery.inboxId)).for("update").limit(1);
        const [existing] = await tx.select().from(D).where(eq(D.inboxId, inputDelivery.inboxId)).for("update").limit(1);
        if (!source || !resolution || source.state !== "captured" || source.vendor !== "claimmd" ||
            source.accountReference !== inputDelivery.accountReference || source.usage !== inputDelivery.usage ||
            source.eraId !== inputDelivery.eraId || source.digest !== inputDelivery.originalDigest ||
            resolution.id !== inputDelivery.resolutionId || resolution.version !== inputDelivery.resolutionVersion ||
            resolution.status !== "verified" || resolution.algorithmVersion !== "BIL141A_V1" ||
            resolution.digest !== inputDelivery.originalDigest || resolution.organizationId !== inputDelivery.organizationId ||
            resolution.providerEntityId !== inputDelivery.providerEntityId || resolution.locationId !== inputDelivery.locationId) {
          if (existing?.state === "prepared") {
            await tx.update(D).set({ state: "held", safeErrorCode: "STALE_OR_UNVERIFIED_RESOLUTION",
              completedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(D.id, existing.id));
            await tx.insert(DH).values({ deliveryId: existing.id, state: "held", safeReasonCode: "STALE_OR_UNVERIFIED_RESOLUTION",
              attemptCount: existing.attemptCount, stageIds: existing.stageIds });
            return { outcome: "held" as const, reason: "STALE_OR_UNVERIFIED_RESOLUTION" as const,
              deliveryId: existing.id, idempotencyKey, stageIds: existing.stageIds, organizationId: existing.organizationId,
              safeReasonCode: "STALE_OR_UNVERIFIED_RESOLUTION", tenantFinalized: existing.stageIds.length === 0 };
          }
          return { outcome: "held" as const, reason: "STALE_OR_UNVERIFIED_RESOLUTION" as const, idempotencyKey };
        }
        if (existing) {
          if (existing.idempotencyKey !== idempotencyKey || existing.resolutionId !== resolution.id ||
              existing.resolutionVersion !== resolution.version || existing.organizationId !== resolution.organizationId ||
              existing.providerEntityId !== resolution.providerEntityId || existing.original835Digest !== source.digest) {
            await tx.update(D).set({ state: "held", safeErrorCode: "DELIVERY_AUTHORIZATION_CHANGED",
              completedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(D.id, existing.id));
            await tx.insert(DH).values({ deliveryId: existing.id, state: "held", safeReasonCode: "DELIVERY_AUTHORIZATION_CHANGED",
              attemptCount: existing.attemptCount, stageIds: existing.stageIds });
            return { outcome: "held" as const, reason: "DELIVERY_AUTHORIZATION_CHANGED" as const, idempotencyKey };
          }
          if (existing.state !== "prepared") return { outcome: existing.state as "delivered" | "possible_duplicate" | "exact_duplicate" | "held",
            deliveryId: existing.id, idempotencyKey, stageIds: existing.stageIds, organizationId: existing.organizationId,
            safeReasonCode: existing.safeErrorCode,
            existingAdviceId: existing.existingAdviceId, tenantFinalized: existing.tenantFinalized };
          if (existing.attemptCount >= 10) {
            await tx.update(D).set({ state: "held", tenantFinalized: existing.stageIds.length === 0,
              safeErrorCode: "DELIVERY_RETRY_LIMIT", completedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(D.id, existing.id));
            await tx.insert(DH).values({ deliveryId: existing.id, state: "held", safeReasonCode: "DELIVERY_RETRY_LIMIT",
              attemptCount: existing.attemptCount, stageIds: existing.stageIds });
            return { outcome: "held" as const, deliveryId: existing.id, idempotencyKey, stageIds: existing.stageIds,
              organizationId: existing.organizationId, safeReasonCode: "DELIVERY_RETRY_LIMIT",
              tenantFinalized: existing.stageIds.length === 0 };
          }
          const [updated] = await tx.update(D).set({ attemptCount: sql`${D.attemptCount}+1`, updatedAt: sql`now()` })
            .where(eq(D.id, existing.id)).returning({ id: D.id, stageIds: D.stageIds });
          await tx.insert(DH).values({ deliveryId: existing.id, state: "prepared", attemptCount: existing.attemptCount + 1,
            stageIds: existing.stageIds });
          return { outcome: "prepared" as const, deliveryId: updated!.id, idempotencyKey, stageIds: updated!.stageIds,
            organizationId: existing.organizationId };
        }
        const [created] = await tx.insert(D).values({ inboxId: source.id, resolutionId: resolution.id,
          resolutionVersion: resolution.version, vendor: "claimmd", accountReference: source.accountReference,
          usage: source.usage, eraId: source.eraId, original835Digest: source.digest,
          organizationId: resolution.organizationId!, providerEntityId: resolution.providerEntityId!,
          locationId: resolution.locationId, idempotencyKey, state: "prepared", attemptCount: 1 })
          .onConflictDoNothing().returning({ id: D.id, stageIds: D.stageIds });
        if (!created) return { outcome: "held" as const, reason: "ACCOUNT_ERA_ALREADY_CLAIMED" as const, idempotencyKey };
        await tx.insert(DH).values({ deliveryId: created.id, state: "prepared", attemptCount: 1, stageIds: [] });
        return { outcome: "prepared" as const, deliveryId: created.id, idempotencyKey, stageIds: created.stageIds,
          organizationId: resolution.organizationId! };
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    /** Commits the recoverable handoff only while the exact verified decision is still current. */
    async finishDelivery(inputFinish: { readonly deliveryId: string; readonly inboxId: string;
      readonly resolutionId: string; readonly resolutionVersion: number; readonly originalDigest: string;
      readonly organizationId: string; readonly providerEntityId: string; readonly locationId: string | null;
      readonly state: "delivered" | "possible_duplicate" | "exact_duplicate" | "held";
      readonly stageIds: readonly string[]; readonly existingAdviceId?: string | null; readonly safeErrorCode?: string | null }) {
      return run("Claim.MD ERA M25 delivery commit", async (tx) => {
        const [delivery] = await tx.select().from(D).where(and(eq(D.id, inputFinish.deliveryId),
          eq(D.inboxId, inputFinish.inboxId))).for("update").limit(1);
        const [source] = await tx.select({ digest: I.original835Digest, state: I.captureState, vendor: I.vendor,
          accountReference: I.accountReference, usage: I.usage }).from(I).where(eq(I.id, inputFinish.inboxId)).limit(1);
        const [resolution] = await tx.select({ id: R.id, version: R.resolutionVersion, status: R.status,
          digest: R.original835Digest, organizationId: R.organizationId, providerEntityId: R.providerEntityId,
          locationId: R.locationId, algorithmVersion: R.algorithmVersion }).from(R).where(eq(R.inboxId, inputFinish.inboxId)).for("update").limit(1);
        const current = delivery && source && resolution && delivery.state === "prepared" && source.state === "captured" &&
          source.vendor === "claimmd" && source.accountReference === delivery.accountReference && source.usage === delivery.usage &&
          source.digest === inputFinish.originalDigest && resolution.id === inputFinish.resolutionId &&
          resolution.version === inputFinish.resolutionVersion && resolution.status === "verified" &&
          resolution.algorithmVersion === "BIL141A_V1" && resolution.digest === inputFinish.originalDigest &&
          resolution.organizationId === inputFinish.organizationId && resolution.providerEntityId === inputFinish.providerEntityId &&
          delivery.resolutionVersion === inputFinish.resolutionVersion && delivery.organizationId === inputFinish.organizationId &&
          delivery.providerEntityId === inputFinish.providerEntityId && resolution.locationId === inputFinish.locationId &&
          delivery.locationId === inputFinish.locationId;
        if (delivery && delivery.state !== "prepared") {
          // A concurrent worker may finish first. Terminal receipts are immutable and retries return that result;
          // never downgrade a committed delivery to held because a stale worker arrived later.
          return { outcome: delivery.state as "delivered" | "possible_duplicate" | "exact_duplicate" | "held",
            reason: delivery.safeErrorCode } as const;
        }
        const state = current ? inputFinish.state : "held";
        const safeErrorCode = current ? inputFinish.safeErrorCode ?? null : "STALE_RESOLUTION_DURING_DELIVERY";
        if (!delivery) return { outcome: "held" as const, reason: "DELIVERY_LEDGER_MISSING" as const };
        await tx.update(D).set({ state, tenantFinalized: inputFinish.stageIds.length === 0, stageIds: [...inputFinish.stageIds],
          existingAdviceId: current ? inputFinish.existingAdviceId ?? null : null,
          safeErrorCode, completedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(D.id, delivery.id));
        await tx.insert(DH).values({ deliveryId: delivery.id, state, safeReasonCode: safeErrorCode,
          attemptCount: delivery.attemptCount, stageIds: [...inputFinish.stageIds] });
        return { outcome: state, reason: safeErrorCode } as const;
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    async confirmDeliveryTenantFinalized(deliveryId: string): Promise<void> {
      await run("Claim.MD ERA tenant staging finalization receipt", async (tx) => {
        const [row] = await tx.update(D).set({ tenantFinalized: true, updatedAt: sql`now()` })
          .where(and(eq(D.id, deliveryId), inArray(D.state, ["delivered", "possible_duplicate", "exact_duplicate", "held"])))
          .returning({ id: D.id, state: D.state, attemptCount: D.attemptCount, stageIds: D.stageIds });
        if (!row) throw new Error("CLAIMMD_ERA_DELIVERY_NOT_FINALIZABLE");
        await tx.insert(DH).values({ deliveryId: row.id, state: row.state, safeReasonCode: null,
          attemptCount: row.attemptCount, stageIds: row.stageIds });
      }, CLAIMMD_ERA_DELIVERY_JOB_ID);
    },

    /** Idempotent, encrypted ownership record with append-only decisions and no silent verified-owner reassignment. */
    async recordResolution(inputResolution: { readonly inboxId: string; readonly accountReference: string;
      readonly usage: "test" | "production"; readonly originalDigest: string;
      readonly status: "verified" | "unmatched" | "ambiguous" | "conflict" | "needs_review" | "invalid_source";
      readonly organizationId: string | null; readonly providerEntityId: string | null; readonly locationId: string | null;
      readonly reasonCode: string | null; readonly algorithmVersion: string; readonly decision: Readonly<Record<string, unknown>>;
      readonly decisionDigest: string }): Promise<{ readonly resolutionId: string; readonly version: number; readonly status: string }> {
      const decisionJson = JSON.stringify(inputResolution.decision);
      const computedDecisionDigest = createHash("sha256").update(decisionJson, "utf8").digest("hex");
      if (!/^[0-9a-f]{64}$/.test(inputResolution.originalDigest) || !/^[0-9a-f]{64}$/.test(inputResolution.decisionDigest) ||
          inputResolution.decisionDigest !== computedDecisionDigest ||
          !/^[A-Z_]{1,64}$/.test(inputResolution.algorithmVersion) ||
          (inputResolution.status === "verified") !== Boolean(inputResolution.organizationId && inputResolution.providerEntityId) ||
          (inputResolution.organizationId === null && inputResolution.locationId !== null))
        throw new Error("CLAIMMD_ERA_RESOLUTION_INVALID");
      return run("Claim.MD ERA ownership resolution persist", async (tx) => {
        const [source] = await tx.select({ id: I.id, digest: I.original835Digest, state: I.captureState,
          streamId: I.streamId, eraId: I.eraId }).from(I).where(and(eq(I.id, inputResolution.inboxId),
          eq(I.accountReference, inputResolution.accountReference), eq(I.usage, inputResolution.usage), eq(I.vendor, "claimmd")))
          .for("update").limit(1);
        if (!source || source.state !== "captured" || source.digest !== inputResolution.originalDigest)
          throw new Error("CLAIMMD_ERA_RESOLUTION_SOURCE_STALE");
        const [existing] = await tx.select().from(R).where(eq(R.inboxId, source.id)).for("update").limit(1);
        const ownerChanged = existing?.reasonCode === "VERIFIED_OWNER_CHANGED" || (existing?.status === "verified" &&
          (inputResolution.status !== "verified" || existing.organizationId !== inputResolution.organizationId ||
            existing.providerEntityId !== inputResolution.providerEntityId));
        const status = ownerChanged ? "conflict" : inputResolution.status;
        const organizationId = ownerChanged ? null : inputResolution.organizationId;
        const providerEntityId = ownerChanged ? null : inputResolution.providerEntityId;
        const locationId = ownerChanged ? null : inputResolution.locationId;
        const reasonCode = ownerChanged ? "VERIFIED_OWNER_CHANGED" : inputResolution.reasonCode;
        const decision = ownerChanged ? { ...inputResolution.decision, disposition: "VERIFIED_OWNER_CHANGED" } : inputResolution.decision;
        const persistedDecisionJson = JSON.stringify(decision);
        const decisionDigest = createHash("sha256").update(persistedDecisionJson, "utf8").digest("hex");
        if (existing && existing.status === status && existing.organizationId === organizationId &&
            existing.providerEntityId === providerEntityId && existing.locationId === locationId && existing.reasonCode === reasonCode &&
            existing.decisionDigest === decisionDigest && existing.algorithmVersion === inputResolution.algorithmVersion)
          return { resolutionId: existing.id, version: existing.resolutionVersion, status: existing.status };
        const version = existing ? existing.resolutionVersion + 1 : 1;
        const sealed = resolutionCipher.seal(source.streamId, `${source.eraId}:resolution:${version}`, persistedDecisionJson).toString("base64");
        const stored = existing ? await tx.update(R).set({ original835Digest: inputResolution.originalDigest, status,
          organizationId, providerEntityId, locationId, reasonCode, algorithmVersion: inputResolution.algorithmVersion,
          resolutionVersion: version, decisionCipher: sealed, decisionKeyId: input.keyRing.activeId, decisionDigest,
          updatedAt: sql`now()` }).where(eq(R.id, existing.id)).returning({ id: R.id }) :
          await tx.insert(R).values({ inboxId: source.id, vendor: "claimmd", accountReference: inputResolution.accountReference,
            usage: inputResolution.usage, original835Digest: inputResolution.originalDigest, status, organizationId,
            providerEntityId, locationId, reasonCode, algorithmVersion: inputResolution.algorithmVersion,
            resolutionVersion: version, decisionCipher: sealed, decisionKeyId: input.keyRing.activeId, decisionDigest })
            .returning({ id: R.id });
        const resolutionId = stored[0]?.id ?? existing?.id;
        if (!resolutionId) throw new Error("CLAIMMD_ERA_RESOLUTION_WRITE_FAILED");
        await tx.insert(RH).values({ resolutionId, resolutionVersion: version, status, organizationId, providerEntityId,
          reasonCode, algorithmVersion: inputResolution.algorithmVersion, decisionCipher: sealed,
          decisionKeyId: input.keyRing.activeId, decisionDigest });
        return { resolutionId, version, status };
      }, CLAIMMD_ERA_RESOLUTION_JOB_ID);
    },

    async release(lease: ClaimMdEraLease, errorCode: string | null = null): Promise<void> {
      if (errorCode && !/^[A-Z_]{1,40}$/.test(errorCode)) throw new Error("CLAIMMD_ERA_ERROR_CODE_INVALID");
      await run("Claim.MD ERA lease release", async (tx) => {
        await tx.update(S).set({ leaseOwner: null, leaseUntil: null, errorCode, updatedAt: sql`now()` }).where(leasePredicate(lease));
      });
    },
  };
}
