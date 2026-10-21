// @chartwarden/cost-report — M27 snapshot canonicalization + content hash (D10). The snapshot-on-submit
// flow freezes every seam-derived input + worksheet state into a `cost_report_snapshot` row and stamps
// it with a SHA-256 `content_hash_sha256`; on every read the stored hash is recomputed and asserted, so
// any out-of-band mutation of the immutable snapshot surfaces as `SNAPSHOT_CORRUPTED` / a P0 system-
// status integrity alert (§2.3, §7.5, architecture §28). For that hash to be stable, the JSON it covers
// must be CANONICAL — independent of object key insertion order — so the same logical snapshot always
// hashes identically across the writer (submit transaction) and every later read-time verification.
//
// PURE DOMAIN: `node:crypto` only — no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`.
// No PHI — the snapshot is aggregate financial/statistical only (D18); these primitives are agnostic to
// content and simply produce a deterministic byte string + digest over whatever value they are given.
import { createHash } from "node:crypto";

/**
 * Recursively normalize a value into a canonical form: object keys are sorted lexicographically at
 * every depth (so insertion order cannot perturb the serialization), arrays keep their order (order is
 * semantically meaningful), and any object exposing a `toJSON()` (e.g. `Date`) is collapsed via that
 * method first to match `JSON.stringify` semantics. Primitives pass through unchanged. The returned
 * tree is then handed to `JSON.stringify`, which drops `undefined` object members and renders
 * non-finite numbers as `null` exactly as standard JSON serialization would.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;

  // Honor `toJSON` (Date, and any value object that defines it) before structural traversal.
  const maybe = value as { toJSON?: () => unknown };
  if (typeof maybe.toJSON === "function") return canonicalize(maybe.toJSON());

  if (Array.isArray(value)) return value.map((v) => canonicalize(v));

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Deterministic, key-sorted JSON serialization of an arbitrary value. Two values that are structurally
 * equal up to object-key ordering produce byte-identical output — the precondition for a stable content
 * hash. This is the exact serialization fed to `contentHashSha256`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * SHA-256 hex digest over the canonical JSON of a value. This is the `cost_report_snapshot
 * .content_hash_sha256` content hash (D10): computed once inside the submit transaction and recomputed
 * on every read to detect tampering of the immutable snapshot. Identical logical inputs always yield an
 * identical 64-char lowercase hex digest.
 */
export function contentHashSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
