// @wardenx/intake-extraction — the docling-worker HTTP client (M22-T08, §3.1 / §25.14).
//
// The ONLY place the docling-worker HTTP client lives (the §25.14 adapter mandate). It implements the
// {@link DoclingParser} capability over an HTTP POST to the docling-worker sidecar. The worker itself is an M32
// AI-Platform deployment concern — in Phase 1 (`documents.doclens` OFF) it is not deployed and M22 boots with the
// {@link denyStubDoclingParser} instead, so this client is wired only once the capability is registered. `fetchImpl`
// is injected so the client is unit-testable without a live worker (no global `fetch` dependency in the contract).

import type { CapabilityResult, DoclingPage, DoclingParseInput, DoclingParser } from "./seams";

/** A minimal structural `fetch` (injected so the client is testable; matches the global `fetch` shape). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface DoclingClientConfig {
  /** The docling-worker base URL (e.g. `http://docling-worker.internal:8080`). */
  readonly baseUrl: string;
  /** Injected fetch (the global in prod; a fake in tests). */
  readonly fetchImpl: FetchLike;
}

interface DoclingWorkerResponse {
  readonly pages?: ReadonlyArray<{
    pageNumber: number;
    text?: string;
    imageObjectKey?: string | null;
    parseError?: "docling_parse_failed" | null;
  }>;
}

/**
 * Build the real {@link DoclingParser} over the docling-worker HTTP API. On a non-2xx response or a transport
 * throw, returns a fail-safe `{ available: false, reason: 'circuit_open' }` (the orchestrator then pauses the job
 * exactly as it does for a deny-stub) rather than throwing — the pipeline never proceeds on a partial parse.
 */
export function createHttpDoclingParser(config: DoclingClientConfig): DoclingParser {
  return {
    async parse(input: DoclingParseInput): Promise<CapabilityResult<{ pages: readonly DoclingPage[] }>> {
      let body: DoclingWorkerResponse;
      try {
        const res = await config.fetchImpl(`${config.baseUrl}/v1/parse`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId: input.batchId, objectKey: input.objectKey, pageCount: input.pageCount }),
        });
        if (!res.ok) return { available: false, reason: "circuit_open" };
        body = (await res.json()) as DoclingWorkerResponse;
      } catch {
        return { available: false, reason: "circuit_open" };
      }
      const pages: DoclingPage[] = (body.pages ?? []).map((p) => ({
        pageNumber: p.pageNumber,
        text: p.text ?? "",
        imageObjectKey: p.imageObjectKey ?? null,
        parseError: p.parseError ?? null,
      }));
      return { available: true, value: { pages } };
    },
  };
}
