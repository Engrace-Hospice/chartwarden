// @wardenx/assessments — the per-scale scorer contract (§3.1 `scales/<scale>/`, §4.3, D6).
//
// Every scale's module exports one {@link ScaleScorer}: the server-authoritative `score()` (D6 — the
// API ignores any client-sent `score`), the human `interpret()` band label, and the published
// `scoreRange` the dispatcher (`scoring.ts`) sanity-checks the computed score against. The detector
// (`significant-change.ts`) keys off the canonical numeric `score`. M9-T03 lands the four representative
// scorers the plan pins (PPS / FAST / PAINAD / ESAS-r); the remaining ten scales register the same shape
// when their routes/tests land.
import type { ScaleType } from "@wardenx/types";

/** The server-authoritative scoring of one captured scale: the canonical numeric + its interpretation. */
export interface ScaleScoreResult {
  /** The canonical numeric the row's `score` column stores (D6 — server-computed, client value ignored).
   * For ordinal scales (FAST) this is the monotonic stage index the progression rules compare. */
  readonly score: number;
  /** The human-readable band/label the chart + summary render alongside the numeric. */
  readonly interpretation: string;
}

/** One scale's pure scoring module (§3.1). `score`/`interpret` are deterministic over the `data` payload
 * only; no IO, no row context. `scoreRange` is the published inclusive range the dispatcher enforces. */
export interface ScaleScorer<TData> {
  readonly scaleType: ScaleType;
  /** The published inclusive `[min, max]` a valid computed score falls in (D6 composite-score sanity). */
  readonly scoreRange: readonly [number, number];
  /** Compute the canonical numeric from the raw items (server-authoritative). */
  score(data: TData): number;
  /** The human interpretation band/label for the computed capture. */
  interpret(data: TData): string;
}

/** A scorer erased to its registry shape. Concrete `ScaleScorer<PpsData>` etc. are assignable here under
 * strict contravariant function-parameter checking, letting `scoring.ts` hold a heterogeneous registry
 * without an `any`. The dispatcher narrows the `data` it forwards via the request's discriminated union. */
export type AnyScaleScorer = ScaleScorer<never>;
