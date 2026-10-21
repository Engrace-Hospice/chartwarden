// @chartwarden/terminology — the as-of-date resolution engine (M38-T04, spec §2.1, §7.1–7.2).
//
// The pure, DB-agnostic core of the read path. Given every loaded concept *row* for a
// (system, code) — rows from two coexisting versions never get deleted (§7.2) — pick the
// one that was active at a given `asOf`. T05's `TerminologyProvider` queries the per-system
// Drizzle tables and feeds their rows in here; the loader/tests construct candidates directly.
// No Drizzle, no Valkey, no clock side effects beyond `normalizeAsOf`'s explicit default.
//
// Design invariant (§2.1.1): `asOf` is honored on EVERY query. A 2023 claim re-validated in
// 2025 resolves against the version active at the *service date*, never "valid now". The row
// for a since-retired code is still returned for an `asOf` inside its range — historical record
// validation requires it (§2.4.1).

import type { CodeSystemId, ResolvedConcept } from "../interfaces/kinds";

/**
 * A single candidate concept row, across all coexisting versions of one (system, code).
 * Structurally identical to {@link ResolvedConcept} — resolution *selects* a candidate, it
 * does not reshape it — so the engine's input and output share one type. Dates are ISO
 * `YYYY-MM-DD` strings, lexically ordered (the comparisons below rely on that).
 */
export type ConceptCandidate<S extends CodeSystemId> = ResolvedConcept<S>;

/** Render a `Date` as a UTC `YYYY-MM-DD` calendar date — the as-of granularity the spec works in. */
export function toIsoDate(d: Date): string {
  // toISOString is always UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; the date half is the calendar day.
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize the optional `asOf` parameter to a UTC calendar date. The default is "today" —
 * the parameter always exists (§2.1.1), the default is the only sugar. Callers that need
 * determinism (every test here, the golden FHIR projections) pass an explicit `Date`.
 */
export function normalizeAsOf(asOf?: Date): string {
  return toIsoDate(asOf ?? new Date());
}

/**
 * Inclusion check (§2.5 "As-of consistency", §2.4.1). A row is active at `asOf` when
 * `effectiveDate <= asOf <= endDate` — the upper bound is INCLUSIVE so a row end-dated on
 * its last service day still resolves at that day (the §7.1 retired-code-at-service-date case;
 * a null `endDate` means "still current"). The §2.1 mermaid's `end_date > asOf` is the
 * illustrative SQL form; §2.5's invariant and §2.4.1's "asOf <= end_date" are normative.
 */
export function includesAsOf(
  row: Pick<ResolvedConcept<CodeSystemId>, "effectiveDate" | "endDate">,
  asOfIso: string,
): boolean {
  if (row.effectiveDate > asOfIso) return false;
  return row.endDate === null || asOfIso <= row.endDate;
}

/**
 * Resolve the single concept row active at `asOf` from all coexisting candidate rows for one
 * code (§7.1, §7.2). Returns `null` when no version covers `asOf` (the §7.10 "lookup earlier
 * than any loaded version → NOT_FOUND" path).
 *
 * When more than one version's row covers the same `asOf` — a code re-loaded unchanged in a
 * newer version extends its effective range (§2.4.1) — the most-recently-effective row wins
 * (latest `effectiveDate`, then latest `endDate`, treating a null `endDate` as the furthest
 * future). This makes the answer the *current understanding* of a code that was valid then.
 */
export function resolveAsOf<S extends CodeSystemId>(
  candidates: readonly ConceptCandidate<S>[],
  asOf?: Date,
): ResolvedConcept<S> | null {
  const asOfIso = normalizeAsOf(asOf);
  let best: ResolvedConcept<S> | null = null;
  for (const row of candidates) {
    if (!includesAsOf(row, asOfIso)) continue;
    if (best === null || comparePrecedence(row, best) > 0) best = row;
  }
  return best;
}

/**
 * Batch resolution for the hot path (§4.5 `lookupBatch` — chart loads, claim lines). Groups a
 * flat candidate list by `code` and resolves each at one shared `asOf`. Codes with no row
 * covering `asOf` are absent from the result map (callers treat absence as unresolved).
 */
export function resolveBatchAsOf<S extends CodeSystemId>(
  candidates: readonly ConceptCandidate<S>[],
  asOf?: Date,
): Map<string, ResolvedConcept<S>> {
  const asOfIso = normalizeAsOf(asOf);
  const winners = new Map<string, ResolvedConcept<S>>();
  for (const row of candidates) {
    if (!includesAsOf(row, asOfIso)) continue;
    const incumbent = winners.get(row.code);
    if (incumbent === undefined || comparePrecedence(row, incumbent) > 0) {
      winners.set(row.code, row);
    }
  }
  return winners;
}

/**
 * Order two covering rows by recency: later `effectiveDate` first, then later `endDate` (a null
 * `endDate` is "still current" → sorts after any concrete end date). Returns >0 when `a`
 * outranks `b`. Total and deterministic, so resolution never depends on input order.
 */
function comparePrecedence(
  a: Pick<ResolvedConcept<CodeSystemId>, "effectiveDate" | "endDate">,
  b: Pick<ResolvedConcept<CodeSystemId>, "effectiveDate" | "endDate">,
): number {
  if (a.effectiveDate !== b.effectiveDate) return a.effectiveDate < b.effectiveDate ? -1 : 1;
  if (a.endDate === b.endDate) return 0;
  if (a.endDate === null) return 1; // null = furthest future
  if (b.endDate === null) return -1;
  return a.endDate < b.endDate ? -1 : 1;
}
