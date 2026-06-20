// @wardenx/mdm — the transparent merge-redirect chase (M40-T04, spec §2.1, §7.2).
//
// The heart of "the merge redirect is invisible to consumers" (§2.1 principle 2, §7.2). A
// foreign key from `patient.attending_physician_id` to a now-merged ExternalPhysician must
// keep resolving correctly forever, while the background re-pointing job catches up at its
// own pace. This file is the pure, DB-agnostic core of that chase: given a way to look up a
// canonical row's redirect projection by id, follow `merged_into_id` to the surviving row.
//
// Pure by construction — no Drizzle, no Valkey, no clock. T05's `MdmEntityProvider` supplies
// the loader over the per-kind canonical Drizzle tables and layers the overlay join + cache on
// top; the tests build an in-memory `Map`. Both share this one chase so the redirect semantics
// (cycle/chain handling, the §2.5 status↔pointer invariant) are defined exactly once.

import type { MdmEntityKind, MdmEntityStatus } from "../interfaces/kinds";

/**
 * The minimal projection of a canonical row the redirect chase needs (§2.5 invariants). Every
 * canonical table (external_physician/facility/payer in Phase 1, §3.3) carries these three
 * columns; the loader projects just them so the chase never depends on per-kind fields.
 */
export interface CanonicalRedirectRow {
  readonly id: string;
  /** The §2.4.1 lifecycle state. `merged` ⇔ `mergedIntoId` is non-null (the §2.5 CHECK). */
  readonly status: MdmEntityStatus;
  /** The survivor this row was merged into, or `null` when this row is itself canonical (§7.2). */
  readonly mergedIntoId: string | null;
}

/**
 * The status of a *surviving* canonical row — what a consumer ever sees after the redirect is
 * resolved. Never `merged`: a merged row is always chased through to its survivor (§4.5
 * `MdmResolved.status` is documented "always 'active' or 'deactivated' (never 'merged')").
 */
export type ResolvedStatus = Exclude<MdmEntityStatus, "merged">;

/**
 * The outcome of following `merged_into_id` to the surviving canonical (§7.2). `resolvedFrom`
 * is present only when the originally-requested id was itself a merged row — the §4.5 contract
 * the consumer reads to lazily patch its FK (`p.attendingPhysicianId = resolved.id`).
 */
export interface MergeRedirect {
  /** The surviving canonical id (its row's `mergedIntoId` is `null`). */
  readonly id: string;
  /** The originally-requested id, set only when a redirect was actually followed (§7.2). */
  readonly resolvedFrom?: string;
  /** The survivor's terminal status — never `merged`. */
  readonly status: ResolvedStatus;
}

/**
 * Thrown when the canonical graph is corrupt: a redirect cycle (A→B→A) or a chain longer than
 * {@link MAX_REDIRECT_DEPTH}. By §2.5 "merge cannot chain" no *new* merge targets a merged row,
 * but A→B then later B→C is legal and produces a finite chain the service layer follows
 * transitively; only a cycle or an unbounded chain is a data-integrity fault worth surfacing.
 */
export class MergeRedirectError extends Error {
  constructor(
    readonly kind: MdmEntityKind,
    readonly startId: string,
    readonly reason: "cycle" | "max_depth" | "invariant",
    detail: string,
  ) {
    super(`merge redirect for ${kind} ${startId}: ${reason} — ${detail}`);
    this.name = "MergeRedirectError";
  }
}

/** A generous ceiling on the redirect chain length. Real chains are 1–2 hops; anything past
 *  this is corruption, not a deep but legitimate merge history. */
export const MAX_REDIRECT_DEPTH = 32;

/** Assert the §2.5 status↔pointer invariant: `(status === 'merged') === (mergedIntoId !== null)`.
 *  A violation means the canonical row is corrupt — fail loudly rather than redirect blindly. */
function assertInvariant(kind: MdmEntityKind, startId: string, row: CanonicalRedirectRow): void {
  const isMerged = row.status === "merged";
  const hasPointer = row.mergedIntoId !== null;
  if (isMerged !== hasPointer) {
    throw new MergeRedirectError(
      kind,
      startId,
      "invariant",
      `row ${row.id} has status='${row.status}' but mergedIntoId=${
        row.mergedIntoId === null ? "null" : `'${row.mergedIntoId}'`
      }`,
    );
  }
}

/**
 * Resolve the surviving canonical for `id` from an in-memory row set — the pure, synchronous
 * core every other entry point delegates to. `lookup` returns the {@link CanonicalRedirectRow}
 * for an id, or `null` when no such row exists (a dangling FK). Follows `merged_into_id` to the
 * survivor, guarding against cycles and over-long chains; returns `null` for an unknown id.
 *
 * `resolvedFrom` is set only when the chain actually moved off the requested id, so a direct hit
 * on a live canonical row carries no `resolvedFrom` (the §4.5 "FK still current" fast path).
 */
export function resolveRedirect(
  lookup: (id: string) => CanonicalRedirectRow | null,
  kind: MdmEntityKind,
  id: string,
): MergeRedirect | null {
  const first = lookup(id);
  if (first === null) return null;

  const seen = new Set<string>([id]);
  let current = first;
  let depth = 0;
  while (current.mergedIntoId !== null) {
    assertInvariant(kind, id, current);
    if (++depth > MAX_REDIRECT_DEPTH) {
      throw new MergeRedirectError(kind, id, "max_depth", `exceeded ${MAX_REDIRECT_DEPTH} hops`);
    }
    const nextId = current.mergedIntoId;
    if (seen.has(nextId)) {
      throw new MergeRedirectError(kind, id, "cycle", `revisited ${nextId}`);
    }
    const next = lookup(nextId);
    if (next === null) {
      // Dangling survivor pointer — the canonical it points at is gone. Corruption, not a
      // resolvable redirect; surface rather than silently return the merged tombstone.
      throw new MergeRedirectError(kind, id, "invariant", `survivor ${nextId} not found`);
    }
    seen.add(nextId);
    current = next;
  }
  // `current` is the survivor: mergedIntoId is null, so by the invariant status !== 'merged'.
  assertInvariant(kind, id, current);
  const status = current.status as ResolvedStatus;
  return current.id === id ? { id: current.id, status } : { id: current.id, resolvedFrom: id, status };
}

/** Async loader port over the canonical tables — T05 supplies a Drizzle-backed implementation
 *  keyed by `(kind, id)`. Returns `null` for an id with no canonical row. */
export type CanonicalRowLoader = (
  kind: MdmEntityKind,
  id: string,
) => Promise<CanonicalRedirectRow | null>;

/**
 * The DB-path counterpart of {@link resolveRedirect}: chase `merged_into_id` one hop at a time
 * over an async loader (each hop is a single-row primary-key fetch). Same cycle/chain/invariant
 * guarantees; same `resolvedFrom` semantics. T05's `MdmEntityProvider.resolveX` calls this, then
 * joins the survivor's overlay (see {@link ./overlay-join}).
 */
export async function followMerge(
  load: CanonicalRowLoader,
  kind: MdmEntityKind,
  id: string,
): Promise<MergeRedirect | null> {
  const first = await load(kind, id);
  if (first === null) return null;

  const seen = new Set<string>([id]);
  let current = first;
  let depth = 0;
  while (current.mergedIntoId !== null) {
    assertInvariant(kind, id, current);
    if (++depth > MAX_REDIRECT_DEPTH) {
      throw new MergeRedirectError(kind, id, "max_depth", `exceeded ${MAX_REDIRECT_DEPTH} hops`);
    }
    const nextId = current.mergedIntoId;
    if (seen.has(nextId)) {
      throw new MergeRedirectError(kind, id, "cycle", `revisited ${nextId}`);
    }
    const next = await load(kind, nextId);
    if (next === null) {
      throw new MergeRedirectError(kind, id, "invariant", `survivor ${nextId} not found`);
    }
    seen.add(nextId);
    current = next;
  }
  assertInvariant(kind, id, current);
  const status = current.status as ResolvedStatus;
  return current.id === id ? { id: current.id, status } : { id: current.id, resolvedFrom: id, status };
}
