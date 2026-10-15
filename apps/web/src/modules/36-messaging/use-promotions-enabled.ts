// M36 WP 3.7 - whether the tenant has chart proposals on, and the caller's own proposals. ONE read per API client
// (`GET /chart-promotions?status=all`) serves every message row: its `enabled` is the signal (useFeatureFlag is never
// loaded in the real app) and its rows feed the per-message status chip. Fails closed on any error (a failure is
// cached only briefly; an "off" answer is cached). A propose or withdraw calls `refreshPromotions` so the chips re-read. The server stays
// the authority: with the flag off its routes answer 404.
import type { ChartPromotionDto } from "@wardenx/types";
import { type ApiClient, useApiClient } from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";

export interface PromotionsIndex {
  readonly enabled: boolean;
  readonly promotions: readonly ChartPromotionDto[];
}

const OFF: PromotionsIndex = { enabled: false, promotions: [] };
const INDEX_LIMIT = 200;
const sharedReads = new WeakMap<ApiClient, Promise<PromotionsIndex>>();
const listeners = new Set<() => void>();
/** A failed read is remembered this long so a screen full of rows does not re-fire it on every mount. */
const FAILURE_TTL_MS = 30_000;
/** The permission that lets a viewer propose (and so read their own proposals). */
export const PROMOTE_PERMISSION = "messaging.promote";

function readIndex(client: ApiClient): Promise<PromotionsIndex> {
  const cached = sharedReads.get(client);
  if (cached) return cached;
  const forget = (): PromotionsIndex => {
    setTimeout(() => {
      if (sharedReads.get(client) === read) sharedReads.delete(client);
    }, FAILURE_TTL_MS);
    return OFF;
  };
  // Deferred a tick so a client that throws (not just rejects) also fails closed.
  const read = Promise.resolve()
    .then(() =>
      client.GET("/api/v1/messaging/chart-promotions", {
        params: { query: { status: "all", limit: INDEX_LIMIT } },
      }),
    )
    .then(
      (result) =>
        result?.data
          ? result.data.enabled === true
            ? { enabled: true, promotions: result.data.promotions }
            : OFF
          : forget(),
      forget,
    );
  sharedReads.set(client, read);
  return read;
}

/** Drop the cached read and tell every mounted row to read again. */
export function refreshPromotions(client: ApiClient): void {
  sharedReads.delete(client);
  for (const listener of listeners) listener();
}

/** No client mounted (a bare row in a test or story) reads as OFF. */
export function useOptionalApiClient(): ApiClient | null {
  try {
    return useApiClient();
  } catch {
    return null;
  }
}

/** `skip` (the viewer cannot propose) issues no read at all and reads as OFF. */
export function usePromotionsIndex(skip = false): PromotionsIndex {
  const client = useOptionalApiClient();
  const [index, setIndex] = useState<PromotionsIndex>(OFF);
  const latestRead = useRef(0);
  useEffect(() => {
    if (!client || skip) return;
    let current = true;
    const load = (): void => {
      const id = ++latestRead.current;
      void readIndex(client).then((value) => {
        // A superseded read (a refresh overtook it) or an unmounted row must not write state.
        if (current && id === latestRead.current) setIndex(value);
      });
    };
    listeners.add(load);
    load();
    return () => {
      current = false;
      listeners.delete(load);
    };
  }, [client, skip]);
  return skip ? OFF : index;
}

export function usePromotionsEnabled(skip = false): boolean {
  return usePromotionsIndex(skip).enabled;
}
