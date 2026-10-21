// @chartwarden/emar — §2.11 D11 IV continuous administration (M13-T06). PURE, IO-free, `Date.now()`-free.
//
// A continuous infusion (morphine drip, midazolam drip) is NOT a discrete dose — it is a *session*: a sequence
// of `administration_record` rows sharing one `iv_session_id`. Modeling each event as its own append-only row
// (rather than a single mutable-rate row) preserves the audit trail and lets the M28 FHIR projection compose
// the segments cleanly (D11). This module is the pure core of that surface (the M13-T08 route + the M13-T07
// `getIvContinuousSession` seam bind the row reads/writes):
//   - the legal segment ORDERING — `start → (rate_change | pause→resume)* → stop` — enforced by
//     `deriveIvSessionState` + `assertIvSegmentLegal` (out-of-sequence segments raise
//     `ILLEGAL_IV_SESSION_TRANSITION`);
//   - the titration safety BOUNDS — a `rate_change` `newRate` must sit within the order's
//     `sigStructured.ivContinuousPolicy.[minRate, maxRate]`, else `IV_RATE_OUT_OF_RANGE` (the pump enforces the
//     same at the device level; M13's check is the audit-trail enforcement);
//   - `planIvSegment`, which combines both and derives the controlled-substance flags the §2.2 `commit` event
//     needs (every controlled segment is witnessed; a controlled `stop` with wastage drives `controlled_wasted`);
//   - `composeIvSession`, the ordered-sequence → session projection the `getIvContinuousSession` seam returns.
// The administration-record `commit` machine (§2.2) still owns the outbox emission (`m13.administration.*`); this
// module is orthogonal — it owns the session ordering, the rate bounds, and the projection. Every fact is
// injected, so the logic is unit-testable with no DB and no clock — the M13-T03/T04/T05 pure-domain precedent.
import type {
  AdministrationMode,
  IsoInstant,
  IvSessionId,
  MedicationOrderId,
} from "@chartwarden/types";
import { AdministrationStateError, require_ } from "../lifecycle/errors";

/** §2.1 — the five IV-continuous modes (the `iv_continuous_*` subset of {@link AdministrationMode}). */
export type IvSegmentMode = Extract<AdministrationMode, `iv_continuous_${string}`>;

/** §2.11 — the derived state of a session from its segment sequence; `none` is the pre-`start` genesis. */
export type IvSessionState = "none" | "running" | "paused" | "stopped";

/** §2.11 — the legal segment ORDERING graph (current derived state → segment modes accepted next). */
export const IV_SESSION_GRAPH: Readonly<Record<IvSessionState, ReadonlyArray<IvSegmentMode>>> = {
  none: ["iv_continuous_start"],
  running: ["iv_continuous_rate_change", "iv_continuous_pause", "iv_continuous_stop"],
  paused: ["iv_continuous_resume", "iv_continuous_stop"],
  stopped: [],
} as const;

/** §2.11 — the state a segment moves the session INTO (the legal target of each mode). */
const IV_SEGMENT_TARGET: Readonly<Record<IvSegmentMode, IvSessionState>> = {
  iv_continuous_start: "running",
  iv_continuous_rate_change: "running",
  iv_continuous_pause: "paused",
  iv_continuous_resume: "running",
  iv_continuous_stop: "stopped",
} as const;

/** §2.11 — one prior segment of the session (the worker projects these from the `iv_session_id` row set). */
export interface IvSegment {
  readonly mode: IvSegmentMode;
  readonly administeredAt: IsoInstant;
  /** The infusion rate after this segment (start / rate_change carry it; pause/resume/stop may omit). */
  readonly rate?: number | null;
  readonly rateUnit?: string | null;
}

/**
 * §2.11 — derive the current session state from its ordered prior segments. An empty set is `none` (genesis,
 * pre-`start`); otherwise the state is the target of the LAST segment. Pure — the caller orders the segments by
 * `administered_at` (the `admin_rec_iv_session_idx` ascending index).
 */
export function deriveIvSessionState(orderedSegments: readonly IvSegment[]): IvSessionState {
  const last = orderedSegments[orderedSegments.length - 1];
  return last ? IV_SEGMENT_TARGET[last.mode] : "none";
}

/**
 * §2.11 — assert the next segment mode is legal from the current state. Raises
 * `ILLEGAL_IV_SESSION_TRANSITION` (409) when a segment is recorded out of sequence — a `rate_change`/`pause`/
 * `stop` before a `start`, a `resume` on a running session, anything after `stop` (terminal). Pure.
 */
export function assertIvSegmentLegal(state: IvSessionState, mode: IvSegmentMode): void {
  if (!IV_SESSION_GRAPH[state].includes(mode)) {
    throw new AdministrationStateError(
      "ILLEGAL_IV_SESSION_TRANSITION",
      `IV-continuous segment '${mode}' is not legal from session state '${state}'`,
    );
  }
}

// ── Titration safety bounds ──────────────────────────────────────────────────────────────────────────────

/** §2.11 — the order's `sigStructured.ivContinuousPolicy` rate bounds (M12-resolved; injected). */
export interface IvContinuousPolicy {
  readonly minRate: number;
  readonly maxRate: number;
}

/** §2.11 — the rate-bounds check verdict (the bounds are echoed to the client on a violation). */
export interface IvRateBoundsResult {
  readonly ok: boolean;
  readonly minRate: number;
  readonly maxRate: number;
}

/** §2.11 — check a `newRate` against the order's `[minRate, maxRate]` bounds (inclusive). Pure. */
export function checkIvRateBounds(policy: IvContinuousPolicy, newRate: number): IvRateBoundsResult {
  return {
    ok: Number.isFinite(newRate) && newRate >= policy.minRate && newRate <= policy.maxRate,
    minRate: policy.minRate,
    maxRate: policy.maxRate,
  };
}

/**
 * §2.11 — the throwing gate for a `rate_change`: the `newRate` must sit within the order's bounds, else
 * `IV_RATE_OUT_OF_RANGE` (422) with the bounds echoed (the prescriber must amend the order via M12 to widen
 * the bounds before the rate change can be recorded). Pure — the route runs this before the commit.
 */
export function assertIvRateBounds(policy: IvContinuousPolicy, newRate: number): void {
  const r = checkIvRateBounds(policy, newRate);
  require_(
    r.ok,
    "IV_RATE_OUT_OF_RANGE",
    `IV rate ${newRate} is outside the order bounds [${r.minRate}, ${r.maxRate}]`,
  );
}

// ── Segment plan (ordering + bounds + the controlled flags the §2.2 commit needs) ────────────────────────

/** §2.11 — the inputs the route resolves for one IV segment write. */
export interface IvSegmentInput {
  readonly mode: IvSegmentMode;
  /** The order is a Schedule II–V controlled substance (every controlled segment requires a witness). */
  readonly isControlled: boolean;
  /** `rate_change` only — the requested new rate (validated against `policy`). */
  readonly newRate?: number | null;
  /** `rate_change` only — the order's `sigStructured.ivContinuousPolicy` bounds. */
  readonly policy?: IvContinuousPolicy | null;
  /** `stop` only — the unused remaining medication wasted at session end (controlled wastage → witnessed). */
  readonly wastageAmount?: number | null;
}

/** §2.11 — the segment plan: the resulting state + the flags the §2.2 `commit` event consumes. */
export interface IvSegmentPlan {
  readonly nextState: IvSessionState;
  /** True for `start` — the worker mints a fresh `iv_session_id` and stamps it on this row. */
  readonly mintsSession: boolean;
  /** §2.6 D7 — a controlled segment requires a second-clinician witness (start / rate_change / stop). */
  readonly requiresWitness: boolean;
  /** §2.11 — a controlled `stop` with wastage drives the §2.2 `controlled_wasted` outbox event. */
  readonly hasControlledWastage: boolean;
}

/**
 * §2.11 D11 — plan one IV-continuous segment: assert the ordering is legal from `currentState`, validate the
 * `rate_change` bounds, and derive the controlled-substance flags the §2.2 `commit` event needs. A controlled
 * infusion requires a witness on the segments that begin/alter/end administration (`start` / `rate_change` /
 * `stop`); a controlled `stop` with `wastageAmount > 0` drives `controlled_wasted`. Raises the precise §2.11
 * code on a violation. Pure — the route runs the §2.2 `commit` with the returned flags + persists the row.
 */
export function planIvSegment(currentState: IvSessionState, input: IvSegmentInput): IvSegmentPlan {
  assertIvSegmentLegal(currentState, input.mode);
  if (input.mode === "iv_continuous_rate_change") {
    require_(
      input.policy != null && typeof input.newRate === "number",
      "IV_RATE_OUT_OF_RANGE",
      "an IV rate change requires a new rate and the order's rate bounds",
    );
    assertIvRateBounds(input.policy, input.newRate);
  }
  const witnessed =
    input.mode === "iv_continuous_start" ||
    input.mode === "iv_continuous_rate_change" ||
    input.mode === "iv_continuous_stop";
  const hasControlledWastage =
    input.mode === "iv_continuous_stop" && input.isControlled && (input.wastageAmount ?? 0) > 0;
  return {
    nextState: IV_SEGMENT_TARGET[input.mode],
    mintsSession: input.mode === "iv_continuous_start",
    requiresWitness: input.isControlled && witnessed,
    hasControlledWastage,
  };
}

// ── Session projection (the `getIvContinuousSession` seam shape) ─────────────────────────────────────────

/** §2.11 / §2.12 — the composed session projection M28 (FHIR) + M37 (IPU overlay) read through the seam. */
export interface IvSessionProjection {
  readonly sessionId: IvSessionId;
  readonly medicationOrderId: MedicationOrderId;
  readonly startedAt: IsoInstant;
  readonly endedAt: IsoInstant | null;
  readonly state: IvSessionState;
  readonly segments: readonly {
    readonly mode: IvSegmentMode;
    readonly administeredAt: IsoInstant;
    readonly rate: number | null;
    readonly rateUnit: string | null;
  }[];
  /** §2.11 — the M37 IPU pump-double-check column; null in Phase 1 (M37 sets it when it locks). */
  readonly pumpVerifiedByMembershipId: string | null;
}

/**
 * §2.11 — compose an ordered segment sequence into the session projection (`effectivePeriod.start` from the
 * `iv_continuous_start` row, `.end` from the `iv_continuous_stop` row when closed, else null). Requires the
 * first segment to be `iv_continuous_start` (`ILLEGAL_IV_SESSION_TRANSITION` otherwise — a session has no
 * meaning without its start). Pure — the seam impl (M13-T07) resolves the rows in `administered_at` order.
 */
export function composeIvSession(
  sessionId: IvSessionId,
  medicationOrderId: MedicationOrderId,
  orderedSegments: readonly IvSegment[],
  pumpVerifiedByMembershipId: string | null,
): IvSessionProjection {
  const first = orderedSegments[0];
  require_(
    first !== undefined && first.mode === "iv_continuous_start",
    "ILLEGAL_IV_SESSION_TRANSITION",
    "an IV-continuous session must begin with an 'iv_continuous_start' segment",
  );
  const stop = orderedSegments.find((s) => s.mode === "iv_continuous_stop");
  return {
    sessionId,
    medicationOrderId,
    startedAt: first.administeredAt,
    endedAt: stop ? stop.administeredAt : null,
    state: deriveIvSessionState(orderedSegments),
    segments: orderedSegments.map((s) => ({
      mode: s.mode,
      administeredAt: s.administeredAt,
      rate: s.rate ?? null,
      rateUnit: s.rateUnit ?? null,
    })),
    pumpVerifiedByMembershipId,
  };
}
