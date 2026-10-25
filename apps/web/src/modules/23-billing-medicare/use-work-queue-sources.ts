// apps/web/src/modules/23-billing-medicare — the reads behind the Billing work queue. Each source is fetched on its
// own through the same list endpoints the claim workbench, the NOE/NOTR queues and the DDE queue already use, with the
// caller's own scope (the server stays the only authz point; nothing is fetched across tenants or providers). A source
// that fails or is refused is reported as that, never as an empty list, so a failed read can never look like "no work".
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { DdeItem } from "./dde-queue-model";
import type { ClaimRow, NoticeRow, SourceState } from "./work-queue-model";

/** The first page of each list; a source with more pages says so (`hasMore`) and the counts show "N+". */
export const QUEUE_PAGE_SIZE = 50;

/** The claim states that need a person; claims in flight or finished are not work (see work-queue-model). */
export const ACTIONABLE_CLAIM_STATES = [
  "draft",
  "ready",
  "denied",
  "ack_partial",
  "partial_paid",
] as const;

interface RawResult {
  data?: unknown;
  error?: unknown;
  response?: { status?: number };
}
interface Page<T> {
  items: T[];
  hasMore: boolean;
}

async function readPage<T>(call: Promise<unknown>): Promise<SourceState<T>> {
  try {
    const r = (await call) as RawResult;
    if (r.error || !r.data) return { status: r.response?.status === 403 ? "denied" : "error" };
    const page = r.data as Page<T>;
    return { status: "ok", items: page.items ?? [], hasMore: page.hasMore === true };
  } catch {
    return { status: "error" };
  }
}

/** Several reads that make up one source: whole only when every read is whole; a refusal needs every read refused. */
function combine<T>(parts: SourceState<T>[]): SourceState<T> {
  const failed = parts.find((p) => p.status === "error");
  if (failed) return failed;
  if (parts.every((p) => p.status === "denied")) return { status: "denied" };
  const ok = parts.filter((p): p is Extract<SourceState<T>, { status: "ok" }> => p.status === "ok");
  if (ok.length !== parts.length) return { status: "error" };
  return {
    status: "ok",
    items: ok.flatMap((p) => p.items),
    hasMore: ok.some((p) => p.hasMore),
  };
}

export interface WorkQueueSources {
  claims: SourceState<ClaimRow>;
  noe: SourceState<NoticeRow>;
  notr: SourceState<NoticeRow>;
  dde: SourceState<DdeItem>;
}

const LOADING: WorkQueueSources = {
  claims: { status: "loading" },
  noe: { status: "loading" },
  notr: { status: "loading" },
  dde: { status: "loading" },
};

export function useWorkQueueSources(client: ApiClient): {
  sources: WorkQueueSources;
  reload: () => void;
} {
  const [sources, setSources] = useState<WorkQueueSources>(LOADING);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs every read after "Try again".
  useEffect(() => {
    let active = true;
    setSources(LOADING);
    // Each source lands as soon as it answers, so one slow or failing list never holds the others back.
    const land = <K extends keyof WorkQueueSources>(key: K, read: Promise<WorkQueueSources[K]>) =>
      void read.then((state) => {
        if (active) setSources((prev) => ({ ...prev, [key]: state }));
      });
    const query = { params: { query: { limit: QUEUE_PAGE_SIZE } } };
    land(
      "claims",
      Promise.all(
        ACTIONABLE_CLAIM_STATES.map((state) =>
          readPage<ClaimRow>(
            client.GET("/api/v1/billing/claims", {
              params: { query: { limit: QUEUE_PAGE_SIZE, state } },
            } as never),
          ),
        ),
      ).then(combine),
    );
    land("noe", readPage<NoticeRow>(client.GET("/api/v1/noe-records" as never, query as never)));
    land("notr", readPage<NoticeRow>(client.GET("/api/v1/notr-records" as never, query as never)));
    land("dde", readPage<DdeItem>(client.GET("/api/v1/billing/dde-items", query as never)));
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  return { sources, reload };
}
