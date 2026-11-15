import type { AccountResponsePage, AckEvent } from "@chartwarden/x12-837-client";
import type { TenantClaimMdAccountFact } from "./account-identity";

export interface TenantClaimMdCapturedBatchRef {
  readonly organizationId: string;
  readonly accountId: string;
  readonly usage: "test" | "production";
  readonly batchId: string;
  readonly sourceDigest: string;
}

export type TenantClaimMdArchivePort = (input: {
  readonly account: TenantClaimMdAccountFact;
  readonly captureId: string;
  readonly page: AccountResponsePage;
}) => Promise<TenantClaimMdCapturedBatchRef>;

export function tenantClaimMdArchivePort(repository: {
  archive(input: {
    readonly account: TenantClaimMdAccountFact;
    readonly captureId: string;
    readonly page: AccountResponsePage;
  }): Promise<{ readonly batchId: string }>;
}): TenantClaimMdArchivePort {
  return async ({ account, captureId, page }) => {
    const result = await repository.archive({ account, captureId, page });
    return {
      organizationId: account.organizationId,
      accountId: account.id,
      usage: account.usage,
      batchId: result.batchId,
      sourceDigest: page.digest,
    };
  };
}

/**
 * Future adapter boundary for the existing tenant poller. The caller supplies the response it already fetched;
 * this adapter never calls Claim.MD. Archive must commit before the existing ACK callback runs. A rejected ACK
 * callback leaves the legacy cursor unchanged; retry archives idempotently and replays the existing idempotent ACK.
 * This contract is deliberately not wired until the transport exposes exact raw-page provenance.
 */
export function createTenantClaimMdAckHandoff(input: {
  readonly archive: TenantClaimMdArchivePort;
  readonly applyExistingAckPage: (input: {
    readonly batch: TenantClaimMdCapturedBatchRef;
    readonly acks: readonly AckEvent[];
  }) => Promise<void>;
}) {
  return {
    async processFetchedPage(page: {
      readonly account: TenantClaimMdAccountFact;
      readonly captureId: string;
      readonly source: AccountResponsePage;
      readonly acks: readonly AckEvent[];
    }): Promise<TenantClaimMdCapturedBatchRef> {
      const batch = await input.archive({
        account: page.account,
        captureId: page.captureId,
        page: page.source,
      });
      if (
        batch.organizationId !== page.account.organizationId ||
        batch.accountId !== page.account.id ||
        batch.usage !== page.account.usage ||
        batch.sourceDigest !== page.source.digest
      )
        throw new Error("CLAIMMD_CAPTURE_HANDOFF_IDENTITY_MISMATCH");
      await input.applyExistingAckPage({ batch, acks: page.acks });
      return batch;
    },
  };
}
