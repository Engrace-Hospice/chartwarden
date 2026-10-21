// @chartwarden/routing-client — the coord-hash cache port (M17-T07, spec §4.10 / §7.10 / D9).
//
// The matrix/directions cache key is a SHA-256 of the SORTED, rounded coordinate list — NEVER an address,
// name, MRN, or any patient/clinician identifier (§7.10 D9 PHI minimisation: the pen-test asserts zero PHI
// crosses the routing boundary, and the cache key is a coord hash by construction). Coordinates are rounded
// to 5 decimals (~1.1 m) so trivially-different fixes share a cache slot and the 24 h TTL is effective.
import { createHash } from "node:crypto";
import type { RoutingCoord } from "./interface";

/** The minimal Valkey surface the adapter needs (the prod ValkeyClient is structurally assignable). */
export interface RoutingCache {
  get(key: string): Promise<string | null>;
  /** `set(key, value, 'EX', seconds)` — string value with a TTL in seconds (the §4.10 24 h cache). */
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
}

/** 5-decimal rounding (~1.1 m) — the §4.10 `round(c.lat, 5)` so near-identical coords hit the same cache slot. */
function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

/**
 * The §4.10 matrix cache key: `osrm:m:<sha256(sorted rounded coords)>`. Sorting makes the key order-invariant
 * (the same set of stops caches once regardless of input order); the hash guarantees no coordinate — let alone
 * any PHI — is legible in the key. D9 / §7.10.
 */
export function matrixCacheKey(coords: ReadonlyArray<RoutingCoord>): string {
  const normalised = coords.map((c) => [round5(c.lat), round5(c.lng)] as const).sort(compareCoord);
  return `osrm:m:${sha256(JSON.stringify(normalised))}`;
}

/** The §4.10 directions cache key: `osrm:d:<sha256([from,to] rounded)>` — direction-significant (not sorted). */
export function directionsCacheKey(from: RoutingCoord, to: RoutingCoord): string {
  const pair = [
    [round5(from.lat), round5(from.lng)],
    [round5(to.lat), round5(to.lng)],
  ];
  return `osrm:d:${sha256(JSON.stringify(pair))}`;
}

function compareCoord(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
