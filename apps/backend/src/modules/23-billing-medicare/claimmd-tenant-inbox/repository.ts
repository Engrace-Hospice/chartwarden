import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { AccountResponsePage } from "@chartwarden/x12-837-client";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { TenantClaimMdAccountFact } from "./account-identity";
import {
  type createTenantClaimMdInboxCipher,
  decodeTenantClaimMdSource,
  encodeTenantClaimMdSource,
} from "./cipher";

const A = schema.claimMdTenantResponseAccounts;
const Q = schema.claimMdTenantResponseAccountCredentials;
const C = schema.tenantClearinghouseConfig;
const B = schema.claimMdTenantResponseBatches;
const I = schema.claimMdTenantResponseItems;
type Cipher = ReturnType<typeof createTenantClaimMdInboxCipher>;

export type TenantClaimMdArchiveResult =
  | { readonly state: "stored"; readonly batchId: string; readonly insertedItems: number }
  | { readonly state: "duplicate"; readonly batchId: string; readonly insertedItems: 0 };

export class TenantClaimMdInboxError extends Error {
  constructor(
    readonly code:
      | "TENANT_ACCOUNT_REVOKED"
      | "TENANT_ACCOUNT_NOT_FOUND"
      | "CLAIMMD_PAGE_INVALID"
      | "CLAIMMD_SOURCE_CONFLICT"
      | "CLAIMMD_CAPTURE_FAILED"
      | "CLAIMMD_EVIDENCE_NOT_FOUND"
      | "CLAIMMD_EVIDENCE_INTEGRITY_FAILURE"
      | "TENANT_CAPTURE_FORBIDDEN",
  ) {
    super(code);
    this.name = "TenantClaimMdInboxError";
  }
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const cursorPattern = /^\d{1,30}$/;

function validatePage(page: AccountResponsePage): void {
  if (
    !cursorPattern.test(page.afterCursor) ||
    !cursorPattern.test(page.nextCursor) ||
    BigInt(page.nextCursor) < BigInt(page.afterCursor) ||
    !/^[0-9a-f]{64}$/.test(page.digest) ||
    sha256(page.rawPayload) !== page.digest ||
    !Number.isSafeInteger(page.parentCount) ||
    page.parentCount < 0 ||
    page.parentCount > 20_000 ||
    page.events.length > 200_000 ||
    page.events.some(
      (event) =>
        !Number.isSafeInteger(event.parentIndex) ||
        event.parentIndex < 0 ||
        event.parentIndex >= 20_000 ||
        !Number.isSafeInteger(event.messageIndex) ||
        event.messageIndex < -1 ||
        event.messageIndex >= 200_000 ||
        !/^[0-9a-f]{64}$/.test(event.digest) ||
        (event.responseId !== null && !/^\d{1,30}$/.test(event.responseId)),
    )
  )
    throw new TenantClaimMdInboxError("CLAIMMD_PAGE_INVALID");
  const responseDigests = new Map<string, string>();
  for (const event of page.events) {
    if (!event.responseId) continue;
    const prior = responseDigests.get(event.responseId);
    if (prior && prior !== event.digest)
      throw new TenantClaimMdInboxError("CLAIMMD_SOURCE_CONFLICT");
    responseDigests.set(event.responseId, event.digest);
  }
}

/** Tenant-scoped immutable evidence store. It does not own/advance the legacy ACK cursors. */
export function createTenantClaimMdResponseRepository(input: {
  readonly db: DbClient;
  readonly cipher: Cipher;
  /** Explicit poll-owner authorization; RLS/account existence alone does not authorize a capture. */
  readonly authorizeCapture: (identity: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly usage: "test" | "production";
  }) => Promise<boolean>;
  /** Explicit internal consumer authorization; denied reads are indistinguishable from missing evidence. */
  readonly authorizeEvidenceRead: (identity: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly batchId: string;
  }) => Promise<boolean>;
}) {
  const hasCurrentVerifiedBinding = async (tx: DbClient, account: TenantClaimMdAccountFact) => {
    const [current] = await tx
      .select({
        fingerprint: C.credentialFingerprint,
        fingerprintKeyId: C.credentialFingerprintKeyId,
      })
      .from(A)
      .innerJoin(C, and(eq(C.id, A.tenantConfigId), eq(C.organizationId, A.organizationId)))
      .where(
        and(
          eq(A.id, account.id),
          eq(A.organizationId, account.organizationId),
          eq(A.tenantConfigId, account.tenantConfigId),
          eq(A.usage, account.usage),
          eq(A.state, "verified"),
          eq(C.vendor, "claimmd"),
          eq(C.mode, account.usage),
          eq(C.status, "active"),
          isNotNull(C.baaVerifiedAt),
          isNull(C.baaRevokedAt),
        ),
      )
      .for("share")
      .limit(1);
    if (!current?.fingerprint || !current.fingerprintKeyId) return false;
    const [credential] = await tx
      .select({ id: Q.id })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, account.organizationId),
          eq(Q.accountId, account.id),
          eq(Q.usage, account.usage),
          eq(Q.credentialFingerprint, current.fingerprint),
          eq(Q.fingerprintKeyId, current.fingerprintKeyId),
        ),
      )
      .limit(1);
    return Boolean(credential);
  };
  const assertAccount = async (account: TenantClaimMdAccountFact) => {
    const isCurrent = await withOrgContext(
      input.db,
      systemOrgContext(account.organizationId),
      (tx) => hasCurrentVerifiedBinding(tx as unknown as DbClient, account),
    );
    if (!isCurrent) throw new TenantClaimMdInboxError("TENANT_ACCOUNT_REVOKED");
  };
  return {
    /** Check the immutable operator-verified account binding under the tenant's RLS context. */
    assertAccount,

    async archive(inputPage: {
      readonly account: TenantClaimMdAccountFact;
      readonly captureId: string;
      readonly page: AccountResponsePage;
    }): Promise<TenantClaimMdArchiveResult> {
      const { account, page, captureId } = inputPage;
      validatePage(page);
      if (
        !(await input.authorizeCapture({
          organizationId: account.organizationId,
          accountId: account.id,
          usage: account.usage,
        }))
      )
        throw new TenantClaimMdInboxError("TENANT_CAPTURE_FORBIDDEN");
      await assertAccount(account);
      const batchId = randomUUID();
      const plaintext = encodeTenantClaimMdSource({
        sourceFormat: page.sourceFormat,
        rawPayload: page.rawPayload,
      });
      const sealed = await input.cipher.seal({
        organizationId: account.organizationId,
        accountId: account.id,
        batchId,
        usage: account.usage,
        afterCursor: page.afterCursor,
        plaintext,
      });
      const data = await withOrgContext(
        input.db,
        systemOrgContext(account.organizationId),
        async (tx) => {
          const current = await hasCurrentVerifiedBinding(tx as unknown as DbClient, account);
          if (!current) throw new TenantClaimMdInboxError("TENANT_ACCOUNT_REVOKED");

          const [created] = await tx
            .insert(B)
            .values({
              id: batchId,
              organizationId: account.organizationId,
              accountId: account.id,
              usage: account.usage,
              afterCursor: page.afterCursor,
              nextCursor: page.nextCursor,
              sourceFormat: page.sourceFormat,
              envelopeVersion: 1,
              keyVersion: sealed.keyVersion,
              payloadCipher: sealed.ciphertext,
              payloadDigest: page.digest,
              parentCount: page.parentCount,
              itemCount: page.events.length,
              captureId,
            })
            .onConflictDoNothing()
            .returning({ id: B.id });

          if (!created) {
            const [existing] = await tx
              .select({ id: B.id, payloadDigest: B.payloadDigest, sourceFormat: B.sourceFormat })
              .from(B)
              .where(
                and(
                  eq(B.organizationId, account.organizationId),
                  eq(B.accountId, account.id),
                  eq(B.usage, account.usage),
                  eq(B.afterCursor, page.afterCursor),
                  eq(B.nextCursor, page.nextCursor),
                ),
              )
              .limit(1);
            if (!existing) throw new TenantClaimMdInboxError("CLAIMMD_CAPTURE_FAILED");
            if (
              existing.payloadDigest !== page.digest ||
              existing.sourceFormat !== page.sourceFormat
            )
              throw new TenantClaimMdInboxError("CLAIMMD_SOURCE_CONFLICT");
            return { state: "duplicate" as const, batchId: existing.id, insertedItems: 0 as const };
          }

          const responseIds = page.events.flatMap((event) =>
            event.responseId ? [event.responseId] : [],
          );
          if (responseIds.length) {
            const prior = await tx
              .select({ responseId: I.responseId, payloadDigest: I.payloadDigest })
              .from(I)
              .where(
                and(
                  eq(I.organizationId, account.organizationId),
                  eq(I.accountId, account.id),
                  inArray(I.responseId, responseIds),
                ),
              );
            const digests = new Map(prior.map((row) => [row.responseId, row.payloadDigest]));
            for (const event of page.events) {
              if (!event.responseId) continue;
              const previous = digests.get(event.responseId);
              if (previous && previous !== event.digest)
                throw new TenantClaimMdInboxError("CLAIMMD_SOURCE_CONFLICT");
            }
          }
          let insertedItems = 0;
          for (let offset = 0; offset < page.events.length; offset += 500) {
            const rows = await tx
              .insert(I)
              .values(
                page.events.slice(offset, offset + 500).map((event) => ({
                  organizationId: account.organizationId,
                  accountId: account.id,
                  batchId,
                  responseId: event.responseId,
                  sourceCursor: page.afterCursor,
                  parentIndex: event.parentIndex,
                  messageIndex: event.messageIndex,
                  payloadDigest: event.digest,
                  captureState: event.state,
                })),
              )
              .onConflictDoNothing()
              .returning({ id: I.id });
            insertedItems += rows.length;
          }
          return { state: "stored" as const, batchId, insertedItems };
        },
      );
      return data;
    },

    /** Bounded, tenant-scoped decrypt for internal replay only; never fetches the vendor or advances a cursor. */
    async readBatch(inputRead: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly batchId: string;
    }): Promise<{
      readonly batchId: string;
      readonly sourceFormat: "json" | "xml";
      readonly rawPayload: string;
    }> {
      if (!(await input.authorizeEvidenceRead(inputRead)))
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      const accountExists = await withOrgContext(
        input.db,
        systemOrgContext(inputRead.organizationId),
        async (tx) => {
          const [account] = await tx
            .select({ id: A.id })
            .from(A)
            .where(
              and(eq(A.id, inputRead.accountId), eq(A.organizationId, inputRead.organizationId)),
            )
            .limit(1);
          return Boolean(account);
        },
      );
      if (!accountExists) throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      const [row] = await withOrgContext(
        input.db,
        systemOrgContext(inputRead.organizationId),
        (tx) =>
          tx
            .select({
              id: B.id,
              accountId: B.accountId,
              usage: B.usage,
              afterCursor: B.afterCursor,
              sourceFormat: B.sourceFormat,
              keyVersion: B.keyVersion,
              payloadCipher: B.payloadCipher,
              payloadDigest: B.payloadDigest,
            })
            .from(B)
            .where(
              and(
                eq(B.id, inputRead.batchId),
                eq(B.organizationId, inputRead.organizationId),
                eq(B.accountId, inputRead.accountId),
              ),
            )
            .limit(1),
      );
      if (!row) throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      let source: ReturnType<typeof decodeTenantClaimMdSource>;
      try {
        const plaintext = await input.cipher.open({
          organizationId: inputRead.organizationId,
          accountId: row.accountId,
          batchId: row.id,
          usage: row.usage,
          afterCursor: row.afterCursor,
          ciphertext: row.payloadCipher,
          keyVersion: row.keyVersion,
        });
        source = decodeTenantClaimMdSource(plaintext);
      } catch {
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_INTEGRITY_FAILURE");
      }
      if (
        source.sourceFormat !== row.sourceFormat ||
        sha256(source.rawPayload) !== row.payloadDigest
      )
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_INTEGRITY_FAILURE");
      return { batchId: row.id, ...source };
    },
  };
}
