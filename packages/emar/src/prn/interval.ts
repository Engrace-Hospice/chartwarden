// @wardenx/emar — §2.4 D3 PRN minimum-interval enforcement (M13-T04). PURE, IO-free, `Date.now()`-free.
//
// The M12 order's `sigStructured.prnPolicy.minimumIntervalMinutes` (e.g. "no more than every 4 hours") is a
// HARD rule at the PRN-administration write: the route queries M13 for the most-recent PRN administration of
// this order on this patient, computes the delta against the requested `administeredAt`, and returns
// `422 PRN_INTERVAL_VIOLATION` when the delta is under the minimum. The only escape is a supervisor override
// — `interval_override_reason` (≥40 chars, denylisted) + the `prn_interval_override` permission (clinical
// supervisor + medical director + hospice physician) — which emits an `administration.prn_interval_overridden`
// warn audit event (the route writes the audit; this module only resolves the decision). PURE: the
// most-recent-administration instant + the requested instant + the override facts are all injected, so the
// boundary is unit-testable with no DB and no clock (the M12 webhook `verifyWebhookEnvelope` precedent).
import type { IsoInstant } from "@wardenx/types";
import { AdministrationStateError } from "../lifecycle/errors";

/** §2.4 D3 — the minimum override-reason length (mirrors the §2.2 void-reason / M8 late-entry floor). */
export const PRN_INTERVAL_OVERRIDE_REASON_MIN_LENGTH = 40;

/** The inputs the route resolves for the §2.4 D3 minimum-interval check. */
export interface PrnIntervalCheckInput {
  /** The order's `sigStructured.prnPolicy.minimumIntervalMinutes`; null/≤0 ⇒ no minimum (always passes). */
  readonly minimumIntervalMinutes: number | null;
  /** The `administeredAt` of the most-recent prior PRN administration of THIS order on THIS patient;
   * null when there is no prior PRN administration (the first dose always passes). */
  readonly lastAdministeredAt: IsoInstant | null;
  /** The requested administration's `administeredAt` (clinician-entered). */
  readonly requestedAdministeredAt: IsoInstant;
}

/** The §2.4 D3 check verdict: `ok`, plus the delta + minimum the route echoes to the client on violation. */
export interface PrnIntervalCheckResult {
  readonly ok: boolean;
  /** The whole-minute delta between the requested dose and the prior PRN dose (null when no prior dose). */
  readonly currentDeltaMinutes: number | null;
  /** The enforced minimum (echoed on violation); null when the order sets no minimum. */
  readonly minimumIntervalMinutes: number | null;
}

/**
 * §2.4 D3 — check the PRN minimum interval. Passes when the order sets no positive minimum, when there is no
 * prior PRN administration, or when the delta from the prior dose meets-or-exceeds the minimum. A prior dose
 * recorded AFTER the requested one (negative delta, e.g. an out-of-order offline sync) is treated as a
 * violation of magnitude 0 (the route surfaces it; the override path applies). Pure — no clock, no IO.
 */
export function checkPrnInterval(input: PrnIntervalCheckInput): PrnIntervalCheckResult {
  const min = input.minimumIntervalMinutes;
  if (min === null || !Number.isFinite(min) || min <= 0 || input.lastAdministeredAt === null) {
    return { ok: true, currentDeltaMinutes: null, minimumIntervalMinutes: min ?? null };
  }
  const deltaMs = Date.parse(input.requestedAdministeredAt) - Date.parse(input.lastAdministeredAt);
  const currentDeltaMinutes = Math.floor(deltaMs / 60_000);
  return {
    ok: currentDeltaMinutes >= min,
    currentDeltaMinutes,
    minimumIntervalMinutes: min,
  };
}

/** §2.4 D3 — the supervisor-override facts the route carries when bypassing a minimum-interval violation. */
export interface PrnIntervalOverride {
  /** The actor holds the `prn_interval_override` permission (clinical supervisor + medical director +
   * hospice physician). */
  readonly hasOverridePermission: boolean;
  /** The override reason (≥40 chars; denylisted). */
  readonly reason: string;
}

/**
 * §2.4 D3 — the server-side throwing gate. Runs {@link checkPrnInterval}; on a violation it permits the write
 * only when a valid override is supplied (permission + a ≥40-char reason), else throws the precise code:
 *   - `PRN_INTERVAL_VIOLATION` (422) when no override is given;
 *   - `PRN_INTERVAL_OVERRIDE_NOT_PERMITTED` (403) when the override lacks the permission;
 *   - `PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT` (422) when the reason is too short.
 * Returns `{ overridden }` so the route knows whether to emit the `administration.prn_interval_overridden`
 * warn audit event. A passing interval returns `{ overridden: false }` with no override required.
 */
export function assertPrnInterval(
  input: PrnIntervalCheckInput,
  override?: PrnIntervalOverride,
): { readonly overridden: boolean } {
  const r = checkPrnInterval(input);
  if (r.ok) return { overridden: false };

  if (override === undefined) {
    throw new AdministrationStateError(
      "PRN_INTERVAL_VIOLATION",
      `PRN minimum interval not met: ${r.currentDeltaMinutes ?? 0} min since last dose, minimum ${r.minimumIntervalMinutes} min`,
    );
  }
  if (!override.hasOverridePermission) {
    throw new AdministrationStateError(
      "PRN_INTERVAL_OVERRIDE_NOT_PERMITTED",
      "the PRN minimum-interval override requires the prn_interval_override permission",
    );
  }
  if (override.reason.trim().length < PRN_INTERVAL_OVERRIDE_REASON_MIN_LENGTH) {
    throw new AdministrationStateError(
      "PRN_INTERVAL_OVERRIDE_REASON_TOO_SHORT",
      `the PRN interval override reason must be at least ${PRN_INTERVAL_OVERRIDE_REASON_MIN_LENGTH} characters`,
    );
  }
  return { overridden: true };
}
