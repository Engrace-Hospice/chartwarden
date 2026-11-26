import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { AccountResponsePage } from "@chartwarden/x12-837-client";
import { and, desc, eq, inArray, isNotNull, isNull, notExists } from "drizzle-orm";
import { baaInForceSql } from "../tenant-clearinghouse/config-store";
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
const O = schema.claimMdTenantResponseItemOutcomes;
type Cipher = ReturnType<typeof createTenantClaimMdInboxCipher>;

export type TenantClaimMdArchiveResult =
  | { readonly state: "stored"; readonly batchId: string; readonly insertedItems: number }
  | { readonly state: "duplicate"; readonly batchId: string; readonly insertedItems: 0 };

export interface TenantClaimMdEvidence {
  readonly batchId: string;
  readonly accountId: string;
  readonly organizationId: string;
  readonly usage: "test" | "production";
  readonly afterCursor: string;
  readonly nextCursor: string;
  readonly capturedAt: Date;
  readonly payloadDigest: string;
  readonly sourceFormat: "json" | "xml";
  readonly rawPayload: string;
}

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
      | "TENANT_CAPTURE_FORBIDDEN"
      | "CLAIMMD_OUTCOME_INVALID"
      | "CLAIMMD_OUTCOME_CONFLICT"
      | "CLAIMMD_REPLAY_FORBIDDEN"
      | "CLAIMMD_ENCRYPTION_FAILED"
      | "CLAIMMD_PERSISTENCE_FAILED",
  ) {
    super(code);
    this.name = "TenantClaimMdInboxError";
  }
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const cursorPattern = /^\d{1,30}$/;

function validatePage(page: AccountResponsePage): void {
  if (
    (page.sourceFormat !== "json" && page.sourceFormat !== "xml") ||
    typeof page.rawPayload !== "string" ||
    Buffer.byteLength(page.rawPayload, "utf8") > 8 * 1024 * 1024 ||
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
  /** Explicit authorization for outcome writes, separate from capture and evidence reads. */
  readonly authorizeOutcomeWrite: (identity: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly itemId: string;
    readonly consumerKey: string;
  }) => Promise<boolean>;
  readonly authorizeOutcomeRead: (identity: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly itemId: string;
  }) => Promise<boolean>;
  /** Queue readers may list only unresolved item metadata for an explicitly authorized consumer. */
  readonly authorizePendingRead: (identity: {
    readonly organizationId: string;
    readonly accountId: string;
    readonly consumerKey: string;
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
          // an ended recorded BAA (CW-AC-17) is out of service like a revoked one: no capture under it
          baaInForceSql,
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
      let sealed: Awaited<ReturnType<Cipher["seal"]>>;
      try {
        sealed = await input.cipher.seal({
          organizationId: account.organizationId,
          accountId: account.id,
          batchId,
          usage: account.usage,
          afterCursor: page.afterCursor,
          plaintext,
        });
      } catch {
        throw new TenantClaimMdInboxError("CLAIMMD_ENCRYPTION_FAILED");
      }
      let data: TenantClaimMdArchiveResult;
      try {
        data = await withOrgContext(
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
              return {
                state: "duplicate" as const,
                batchId: existing.id,
                insertedItems: 0 as const,
              };
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
      } catch (error) {
        if (error instanceof TenantClaimMdInboxError) throw error;
        throw new TenantClaimMdInboxError("CLAIMMD_PERSISTENCE_FAILED");
      }
      return data;
    },

    /** Bounded, tenant-scoped decrypt for internal replay only; never fetches the vendor or advances a cursor. */
    async readBatch(inputRead: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly batchId: string;
    }): Promise<TenantClaimMdEvidence> {
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
              nextCursor: B.nextCursor,
              capturedAt: B.capturedAt,
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
      return {
        batchId: row.id,
        accountId: row.accountId,
        organizationId: inputRead.organizationId,
        usage: row.usage,
        afterCursor: row.afterCursor,
        nextCursor: row.nextCursor,
        capturedAt: row.capturedAt,
        payloadDigest: row.payloadDigest,
        ...source,
      };
    },

    /** Bounded item/provenance projection. It never returns fields from the encrypted source. */
    async listBatchItems(inputRead: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly batchId: string;
      readonly limit: number;
    }) {
      if (!Number.isInteger(inputRead.limit) || inputRead.limit < 1 || inputRead.limit > 500)
        throw new TenantClaimMdInboxError("CLAIMMD_PAGE_INVALID");
      if (!(await input.authorizeEvidenceRead(inputRead)))
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      const batchExists = await withOrgContext(
        input.db,
        systemOrgContext(inputRead.organizationId),
        async (tx) => {
          const [batch] = await tx
            .select({ id: B.id })
            .from(B)
            .where(
              and(
                eq(B.id, inputRead.batchId),
                eq(B.organizationId, inputRead.organizationId),
                eq(B.accountId, inputRead.accountId),
              ),
            )
            .limit(1);
          return Boolean(batch);
        },
      );
      if (!batchExists) throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      return withOrgContext(input.db, systemOrgContext(inputRead.organizationId), (tx) =>
        tx
          .select({
            itemId: I.id,
            responseId: I.responseId,
            parentIndex: I.parentIndex,
            messageIndex: I.messageIndex,
            payloadDigest: I.payloadDigest,
            captureState: I.captureState,
            capturedAt: I.capturedAt,
          })
          .from(I)
          .where(
            and(
              eq(I.organizationId, inputRead.organizationId),
              eq(I.accountId, inputRead.accountId),
              eq(I.batchId, inputRead.batchId),
            ),
          )
          .orderBy(I.parentIndex, I.messageIndex)
          .limit(inputRead.limit),
      );
    },

    /** Bounded pending-item projection; source payloads require a separate authorized batch read. */
    async listPendingItems(inputRead: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly consumerKey: string;
      readonly limit: number;
    }) {
      if (
        !Number.isInteger(inputRead.limit) ||
        inputRead.limit < 1 ||
        inputRead.limit > 500 ||
        !/^[a-z0-9._:-]{1,128}$/.test(inputRead.consumerKey)
      )
        throw new TenantClaimMdInboxError("CLAIMMD_PAGE_INVALID");
      if (!(await input.authorizePendingRead(inputRead)))
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      return withOrgContext(input.db, systemOrgContext(inputRead.organizationId), (tx) =>
        tx
          .select({
            itemId: I.id,
            batchId: I.batchId,
            responseId: I.responseId,
            sourceCursor: I.sourceCursor,
            parentIndex: I.parentIndex,
            messageIndex: I.messageIndex,
            payloadDigest: I.payloadDigest,
            captureState: I.captureState,
            capturedAt: I.capturedAt,
          })
          .from(I)
          .where(
            and(
              eq(I.organizationId, inputRead.organizationId),
              eq(I.accountId, inputRead.accountId),
              notExists(
                tx
                  .select({ id: O.id })
                  .from(O)
                  .where(
                    and(
                      eq(O.organizationId, inputRead.organizationId),
                      eq(O.accountId, inputRead.accountId),
                      eq(O.itemId, I.id),
                      eq(O.consumerKey, inputRead.consumerKey),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(I.capturedAt, I.parentIndex, I.messageIndex)
          .limit(inputRead.limit),
      );
    },

    /** Idempotent append-only downstream result or quarantine marker; reason codes must not contain PHI. */
    async recordOutcome(inputOutcome: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly itemId: string;
      readonly consumerKey: string;
      readonly idempotencyKey: string;
      readonly outcome: "processed" | "quarantined";
      readonly reasonCode?: string;
    }): Promise<"recorded" | "duplicate"> {
      if (
        !/^[a-z0-9._:-]{1,128}$/.test(inputOutcome.consumerKey) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(inputOutcome.idempotencyKey) ||
        (inputOutcome.outcome === "quarantined" &&
          !/^[A-Z0-9_]{1,64}$/.test(inputOutcome.reasonCode ?? "")) ||
        (inputOutcome.outcome === "processed" && inputOutcome.reasonCode !== undefined)
      )
        throw new TenantClaimMdInboxError("CLAIMMD_OUTCOME_INVALID");
      if (
        !(await input.authorizeOutcomeWrite({
          organizationId: inputOutcome.organizationId,
          accountId: inputOutcome.accountId,
          itemId: inputOutcome.itemId,
          consumerKey: inputOutcome.consumerKey,
        }))
      )
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      return withOrgContext(input.db, systemOrgContext(inputOutcome.organizationId), async (tx) => {
        const values = {
          organizationId: inputOutcome.organizationId,
          accountId: inputOutcome.accountId,
          itemId: inputOutcome.itemId,
          consumerKey: inputOutcome.consumerKey,
          idempotencyKey: inputOutcome.idempotencyKey,
          outcome: inputOutcome.outcome,
          reasonCode: inputOutcome.reasonCode ?? null,
        };
        const [created] = await tx
          .insert(O)
          .values(values)
          .onConflictDoNothing()
          .returning({ id: O.id });
        if (created) return "recorded" as const;
        const [existing] = await tx
          .select({ outcome: O.outcome, reasonCode: O.reasonCode })
          .from(O)
          .where(
            and(
              eq(O.organizationId, inputOutcome.organizationId),
              eq(O.accountId, inputOutcome.accountId),
              eq(O.itemId, inputOutcome.itemId),
              eq(O.consumerKey, inputOutcome.consumerKey),
              eq(O.idempotencyKey, inputOutcome.idempotencyKey),
            ),
          )
          .limit(1);
        if (
          !existing ||
          existing.outcome !== inputOutcome.outcome ||
          existing.reasonCode !== (inputOutcome.reasonCode ?? null)
        )
          throw new TenantClaimMdInboxError("CLAIMMD_OUTCOME_CONFLICT");
        return "duplicate" as const;
      });
    },

    /** Replays stored bytes only; authorization and a caller-supplied idempotency boundary are required. */
    async replayBatch(inputReplay: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly batchId: string;
      readonly replayKey: string;
      readonly replay: (input: {
        readonly evidence: TenantClaimMdEvidence;
        /** Consumer must use this stable key to make downstream replay idempotent. */
        readonly replayKey: string;
      }) => Promise<void>;
    }): Promise<void> {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(inputReplay.replayKey))
        throw new TenantClaimMdInboxError("CLAIMMD_OUTCOME_INVALID");
      if (!(await input.authorizeEvidenceRead(inputReplay)))
        throw new TenantClaimMdInboxError("CLAIMMD_REPLAY_FORBIDDEN");
      const evidence = await this.readBatch(inputReplay);
      await inputReplay.replay({ evidence, replayKey: inputReplay.replayKey });
    },

    /** Durable outcome history for one item, bounded for queue/work scheduling; no cursor side effects. */
    async listOutcomes(inputRead: {
      readonly organizationId: string;
      readonly accountId: string;
      readonly itemId: string;
      readonly limit: number;
    }) {
      if (!Number.isInteger(inputRead.limit) || inputRead.limit < 1 || inputRead.limit > 100)
        throw new TenantClaimMdInboxError("CLAIMMD_PAGE_INVALID");
      if (!(await input.authorizeOutcomeRead(inputRead)))
        throw new TenantClaimMdInboxError("CLAIMMD_EVIDENCE_NOT_FOUND");
      return withOrgContext(input.db, systemOrgContext(inputRead.organizationId), (tx) =>
        tx
          .select({
            consumerKey: O.consumerKey,
            idempotencyKey: O.idempotencyKey,
            outcome: O.outcome,
            reasonCode: O.reasonCode,
            occurredAt: O.occurredAt,
          })
          .from(O)
          .where(
            and(
              eq(O.organizationId, inputRead.organizationId),
              eq(O.accountId, inputRead.accountId),
              eq(O.itemId, inputRead.itemId),
            ),
          )
          .orderBy(desc(O.occurredAt))
          .limit(inputRead.limit),
      );
    },
  };
}
