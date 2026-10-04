// apps/backend/src/modules/22-documents/extraction/docling-client.ts — the M22 client for the
// `docling-worker` sidecar (DocLens stage 2: OCR + layout with page coordinates; F-236, ADR-0048).
//
// The worker is reached over HTTP with a worker-specific bearer, `DOCLING_WORKER_TOKEN` (System Design
// §5.5's shared-secret shape, but NOT the backend's own `INTERNAL_SERVICE_TOKEN`: that one authenticates
// TO the backend as the system, and the parse container has no business holding it), and is handed a short-lived presigned GET URL for the source object, so it never holds object-store
// credentials. Its response is validated STRICTLY here: every box the DocLens grounding step relies on
// comes from this payload, so a malformed page or block is a refused parse, never a best-effort one.
//
// Coordinate system (fixed by the worker, see services/docling-worker/app/layout.py): origin top-left,
// units = PDF points of that page, bbox = [left, top, right, bottom].
//
// Unconfigured (no DOCLING_WORKER_URL or no DOCLING_WORKER_TOKEN) ⇒ `createUnboundDoclingClient`, which refuses with a
// typed 503 — never a silent empty parse that the pipeline would read as "a document with no text".
import { WardenXError } from "@wardenx/types";

export type DoclingBBox = readonly [number, number, number, number];

export interface DoclingBlock {
  readonly text: string;
  readonly bbox: DoclingBBox;
  readonly label: string;
}

export interface DoclingPage {
  readonly page: number;
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly DoclingBlock[];
}

export interface DoclingParseResult {
  readonly doclingVersion: string;
  readonly pages: readonly DoclingPage[];
}

export interface DoclingClient {
  parse(input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly sourceUrl: string;
    readonly correlationId: string;
  }): Promise<DoclingParseResult>;
}

/** A parse that did not produce a usable layout. `kind` decides retry vs terminal at the job layer. */
export class DoclingParseError extends WardenXError {
  constructor(
    readonly kind: "unavailable" | "parse_failed" | "rejected" | "malformed_response",
    detail: string,
    status: number,
  ) {
    super(kind === "unavailable" ? "DOCLING_UNAVAILABLE" : "DOCLING_PARSE_FAILED", detail, status);
    this.name = "DoclingParseError";
  }
}

export interface DoclingClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

export function doclingConfigFromEnv(
  env: Record<string, string | undefined>,
): DoclingClientConfig | null {
  const baseUrl = env.DOCLING_WORKER_URL?.trim();
  const token = env.DOCLING_WORKER_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  const timeout = Number(env.DOCLING_TIMEOUT_MS);
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Validate the worker's JSON into {@link DoclingParseResult}, or throw `malformed_response`. */
export function parseDoclingResponse(raw: unknown): DoclingParseResult {
  const bad = (why: string): never => {
    throw new DoclingParseError("malformed_response", `docling-worker response: ${why}`, 502);
  };
  const body = raw as { docling_version?: unknown; pages?: unknown } | null;
  if (!body || !Array.isArray(body.pages)) bad("no pages array");
  const pages: DoclingPage[] = [];
  let lastPage = 0;
  for (const p of (body as { pages: unknown[] }).pages) {
    const page = p as { page?: unknown; width?: unknown; height?: unknown; blocks?: unknown };
    if (!isNum(page.page) || !Number.isInteger(page.page) || page.page <= lastPage) {
      bad("page numbers must be positive, integral and ascending");
    }
    if (!isNum(page.width) || !isNum(page.height) || page.width <= 0 || page.height <= 0) {
      bad(`page ${String(page.page)} has no size`);
    }
    if (!Array.isArray(page.blocks)) bad(`page ${String(page.page)} has no blocks array`);
    const blocks: DoclingBlock[] = [];
    for (const b of page.blocks as unknown[]) {
      const block = b as { text?: unknown; bbox?: unknown; label?: unknown };
      const box = block.bbox as unknown[];
      if (typeof block.text !== "string" || block.text.length === 0) bad("a block has no text");
      if (!Array.isArray(box) || box.length !== 4 || !box.every(isNum))
        bad("a block bbox is not 4 numbers");
      const [l, t, r, btm] = box as [number, number, number, number];
      if (r <= l || btm <= t) bad("a block bbox is inverted");
      blocks.push({
        text: block.text as string,
        bbox: [l, t, r, btm],
        label: typeof block.label === "string" ? block.label : "text",
      });
    }
    pages.push({
      page: page.page as number,
      width: page.width as number,
      height: page.height as number,
      blocks,
    });
    lastPage = page.page as number;
  }
  return {
    doclingVersion: typeof body?.docling_version === "string" ? body.docling_version : "unknown",
    pages,
  };
}

/** The HTTP client. `fetchImpl` is injectable for tests. */
export function createHttpDoclingClient(
  config: DoclingClientConfig,
  fetchImpl: typeof fetch = fetch,
): DoclingClient {
  const timeoutMs = config.timeoutMs ?? 180_000;
  return {
    async parse(input) {
      let res: Response;
      try {
        res = await fetchImpl(`${config.baseUrl}/parse`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.token}`,
            "x-correlation-id": input.correlationId,
            "x-org-id": input.organizationId,
          },
          body: JSON.stringify({ job_id: input.jobId, source_url: input.sourceUrl }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DoclingParseError(
          "unavailable",
          `docling-worker unreachable (${err instanceof Error ? err.name : "error"})`,
          503,
        );
      }
      if (res.status === 422) {
        throw new DoclingParseError("parse_failed", "docling could not parse the source", 422);
      }
      if (res.status === 413 || res.status === 415) {
        throw new DoclingParseError(
          "rejected",
          `docling-worker rejected the source (HTTP ${res.status})`,
          422,
        );
      }
      if (!res.ok) {
        throw new DoclingParseError(
          "unavailable",
          `docling-worker answered HTTP ${res.status}`,
          503,
        );
      }
      return parseDoclingResponse(await res.json());
    },
  };
}

/** No worker configured: every parse refuses (typed 503), never an empty "document with no text". */
export function createUnboundDoclingClient(): DoclingClient {
  return {
    async parse() {
      throw new DoclingParseError(
        "unavailable",
        "no docling-worker is configured (DOCLING_WORKER_URL / DOCLING_WORKER_TOKEN)",
        503,
      );
    },
  };
}
