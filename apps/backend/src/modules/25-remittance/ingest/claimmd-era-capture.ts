import type { createClaimMdAccountEraReader } from "@chartwarden/x12-837-client";
import { type ClaimMdEraUsage, discoverClaimMdEraSnapshot } from "@chartwarden/x12-837-client";
import type { createClaimMdEraStore } from "./claimmd-era-store";

type Store = ReturnType<typeof createClaimMdEraStore>;
type Reader = ReturnType<typeof createClaimMdAccountEraReader>;
export interface ClaimMdEraCaptureSummary {
  readonly code:
    | "OK"
    | "NOT_BOOTSTRAPPED_OR_BUSY"
    | "DISCOVERY_FAILED"
    | "CAPTURE_PARTIAL"
    | "CAPTURE_FAILED";
  readonly discovered: number;
  readonly captured: number;
  readonly failed: number;
  readonly cursor: string | null;
}

/** One bounded capture tick. This service persists encrypted source only; it has no M25 posting/staging dependency. */
export function createClaimMdEraCapture(input: {
  readonly store: Store;
  readonly reader: Reader;
  readonly log?: (summary: Omit<ClaimMdEraCaptureSummary, "cursor">) => void;
}) {
  return {
    async runOnce(
      accountReference: string,
      usage: ClaimMdEraUsage,
    ): Promise<ClaimMdEraCaptureSummary> {
      const lease = await input.store.acquire(accountReference, usage);
      if (!lease)
        return {
          code: "NOT_BOOTSTRAPPED_OR_BUSY",
          discovered: 0,
          captured: 0,
          failed: 0,
          cursor: null,
        };
      let discovered = 0;
      let captured = 0;
      let failed = 0;
      let cursor = lease.cursor;
      let code: ClaimMdEraCaptureSummary["code"] = "OK";
      let errorCode: string | null = null;
      try {
        const result = await discoverClaimMdEraSnapshot({
          reader: input.reader,
          commit: {
            commit: (page) => input.store.commitDiscovery(lease, page),
          },
          accountReference,
          usage,
          cursor: lease.cursor,
          leaseGeneration: lease.generation,
          maxPages: 10,
          beforePage: () => input.store.renew(lease),
        });
        if (!result.ok) {
          code = "DISCOVERY_FAILED";
          errorCode = result.code;
        } else {
          discovered = result.discovered;
          cursor = result.cursor;
          // Retry backlog independently of discovery cursor. A failure never erases the durable discovered identity.
          const pending = await input.store.pendingCapture(lease, 25);
          for (const eraId of pending) {
            await input.store.renew(lease);
            const [file, details] = await Promise.all([
              input.reader.download835(accountReference, usage, eraId),
              input.reader.details(accountReference, usage, eraId),
            ]);
            if (!file.ok || !details.ok) {
              failed++;
              await input.store.recordCaptureFailure(
                lease,
                eraId,
                !file.ok ? file.code : !details.ok ? details.code : "CAPTURE_FAILED",
              );
              continue;
            }
            try {
              await input.store.recordCapture(lease, {
                eraId,
                files: file.files,
                originalDigest: file.digest,
                details: details.details,
                detailsDigest: details.digest,
              });
              captured++;
            } catch {
              failed++;
              await input.store.recordCaptureFailure(lease, eraId, "CAPTURE_FAILED");
            }
          }
          if (failed > 0) code = "CAPTURE_PARTIAL";
        }
      } catch {
        code = "CAPTURE_FAILED";
        errorCode = "CAPTURE_FAILED";
      } finally {
        await input.store.release(lease, errorCode).catch(() => {});
        input.log?.({ code, discovered, captured, failed });
      }
      return { code, discovered, captured, failed, cursor };
    },
  };
}
