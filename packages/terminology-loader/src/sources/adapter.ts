// @chartwarden/terminology-loader — source adapters: how a release file reaches the platform bucket without an
// operator upload. This package is the ONLY place a terminology source URL is fetched (vendor-adapter mandate).
import { LoaderDataError } from "../errors";
import type { LoadableSystemId } from "../types";

/** One release the adapter retrieved, ready to be stored, checksummed and registered. */
export interface FetchedSource {
  /** The `code_system_version.version` label (`FY2027`, `2026-10-06`, …). */
  readonly version: string;
  /** ISO dates. */
  readonly releasedOn: string;
  readonly effectiveFrom: string;
  readonly bytes: Uint8Array;
  /** Where it came from (URL) — provenance for the ledger; never a credential. */
  readonly origin: string;
}

export interface FetchContext {
  readonly now: Date;
  readonly fetchImpl: typeof fetch;
  /** The run's intent: `dry_run` resolves the NEXT release (ICD-10-CM Sep 15), `current` the in-force one. */
  readonly mode: "dry_run" | "current";
}

/** A tier-1 (public) source adapter. Returns null when no new release is published yet. */
export interface PublicSourceAdapter {
  readonly system: LoadableSystemId;
  /** True when the adapter performs network egress (so the egress flag gates it); false for a bundled seed. */
  readonly egress: boolean;
  fetchLatest(ctx: FetchContext): Promise<FetchedSource | null>;
}

/** Ceiling on one downloaded release (the largest public file, the NDC zip, is tens of MB). */
export const MAX_DOWNLOAD_BYTES = 250_000_000;
const FETCH_TIMEOUT_MS = 120_000;

/** GET `url`; 404 → null; any other non-2xx or an oversized body → throws (a retryable infrastructure fault). */
export async function fetchBytes(url: string, ctx: FetchContext): Promise<Uint8Array | null> {
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`terminology source fetch failed with HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new LoaderDataError(
      "SOURCE_TOO_LARGE",
      `declared size ${declared} exceeds ${MAX_DOWNLOAD_BYTES}`,
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new LoaderDataError(
      "SOURCE_TOO_LARGE",
      `downloaded size ${bytes.length} exceeds ${MAX_DOWNLOAD_BYTES}`,
    );
  }
  return bytes;
}

/** ISO date (UTC) of a Date. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
