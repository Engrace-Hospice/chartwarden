// Inactive BIL-1.1 capture service. No cron/route registers this service at boot.
import type { AccountResponseRead, ClaimMdUsage } from "@chartwarden/x12-837-client";
import type { createClaimMdResponseStore, StreamLease } from "./store";

type Store = ReturnType<typeof createClaimMdResponseStore>;
export interface CaptureCounters {
  readonly pages: number;
  readonly events: number;
  readonly duplicates: number;
  readonly needsReview: number;
  readonly cursor: string | null;
  readonly code: "OK" | "NOT_BOOTSTRAPPED_OR_BUSY" | "FETCH_FAILED" | "CAPTURE_FAILED" | "NO_PROGRESS";
}

/** One bounded tick. A later scheduler may retry with jitter; this function never retries HTTP aggressively. */
export function createClaimMdResponseCapture(input: {
  readonly store: Store;
  readonly reader: { fetchAccountResponses(accountReference: string, usage: ClaimMdUsage, cursor: string): Promise<AccountResponseRead> };
  readonly log?: (event: { code: string; pages: number; events: number; duplicates: number; review: number }) => void;
}) {
  return {
    async runOnce(accountReference: string, usage: ClaimMdUsage): Promise<CaptureCounters> {
      let lease = await input.store.acquire(accountReference, usage);
      if (!lease) return { pages: 0, events: 0, duplicates: 0, needsReview: 0, cursor: null, code: "NOT_BOOTSTRAPPED_OR_BUSY" };
      let pages = 0, events = 0, duplicates = 0, needsReview = 0;
      let code: CaptureCounters["code"] = "OK";
      let errorCode: string | null = null;
      try {
        // A full 20k page is a boundary, not end-of-stream. Five pages bound one tick's API/lease work.
        for (; pages < 5; ) {
          const read = await input.reader.fetchAccountResponses(accountReference, usage, lease.cursor);
          if (!read.ok) {
            code = "FETCH_FAILED";
            errorCode = read.code;
            break;
          }
          const page = read.page;
          if (page.full && page.nextCursor === lease.cursor) {
            code = "NO_PROGRESS";
            errorCode = "NO_PROGRESS";
            break;
          }
          const committed = await input.store.commit(lease, page);
          pages++;
          events += committed.inserted;
          duplicates += committed.duplicates;
          needsReview += committed.review;
          lease = { ...lease, cursor: committed.cursor } satisfies StreamLease;
          if (!page.full || page.nextCursor === page.afterCursor) break;
        }
      } catch {
        code = "CAPTURE_FAILED";
        errorCode = "CAPTURE_FAILED";
      } finally {
        // A fenced former owner cannot clear a successor's lease.
        await input.store.release(lease, errorCode).catch(() => {});
        input.log?.({ code, pages, events, duplicates, review: needsReview });
      }
      return { pages, events, duplicates, needsReview, cursor: lease.cursor, code };
    },
  };
}
