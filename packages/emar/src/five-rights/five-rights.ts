// @wardenx/emar — §5.11 five-rights validator (M13-T03). PURE, IO-free, shared with the frontend.
//
// The five rights of medication administration — right patient, right drug, right dose, right route, right
// time — checked at the administration write gate against M12's order (§2.2 / §5.11 / §2.9 D10 caregiver
// path). The §5.11 wrong-route catch is the canonical case: an order for "Haloperidol 0.5 mg PO BID"
// administered with route='IM' fails the `route` right and returns `422 FIVE_RIGHTS_VIOLATION
// { failedRights: ['route'] }`. The validator is a pure function so the frontend renders the same banner
// (`FiveRightsBanner.tsx`) the server enforces — one source of truth, no drift. It returns a result rather
// than throwing so the UI can highlight every failed right at once; `assertFiveRights` is the server-side
// throwing wrapper that maps onto the M13 error catalog (the route returns 422).
import type { IsoInstant } from "@wardenx/types";
import { AdministrationStateError } from "../lifecycle/errors";

/** One of the five rights of medication administration (§5.11). */
export type FiveRight = "patient" | "drug" | "dose" | "route" | "time";

/** The requested administration (clinician- or caregiver-entered) checked against the order. */
export interface FiveRightsRequest {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly route: string;
  /** The administered dose amount (null for non-discrete IV-continuous modes). */
  readonly doseAmount: number | null;
  readonly doseUnit: string | null;
  readonly administeredAt: IsoInstant;
}

/** The M12 order context the request is checked against (projected from `MedicationOrderProvider`). */
export interface FiveRightsOrderContext {
  readonly patientId: string;
  readonly medicationOrderId: string;
  /** The order's authorized route (`sigStructured.route`). */
  readonly route: string;
  /** The order's authorized dose amount (the per-administration maximum; null when not discrete). */
  readonly doseAmount: number | null;
  readonly doseUnit: string | null;
}

/** Tunable tolerances for the `time` right (clock skew). */
export interface FiveRightsOptions {
  /** Allowed clock skew (minutes) for an administeredAt slightly ahead of `now` (default 5). */
  readonly futureToleranceMinutes?: number;
}

/** The five-rights check result — `ok` plus the list of rights that failed (empty when `ok`). */
export interface FiveRightsResult {
  readonly ok: boolean;
  readonly failedRights: readonly FiveRight[];
}

/** Case-insensitive, whitespace-trimmed route/unit comparison. */
function sameToken(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * §5.11 — check the five rights of a requested administration against the M12 order. `now` is injected (the
 * function is pure / `Date.now()`-free so the frontend and server agree). The `dose` right permits a partial
 * dose (a clinician giving "half" per §5.12) — a dose *larger* than the order's authorized amount, a
 * unit mismatch, or a non-positive amount fails; a smaller positive amount passes. A null order dose
 * (non-discrete) skips the dose right. `time` fails only for an administeredAt in the future beyond the
 * skew tolerance (a far-past administeredAt is a *late entry*, scored by the late-entry tier, not a
 * five-rights failure).
 */
export function checkFiveRights(
  request: FiveRightsRequest,
  order: FiveRightsOrderContext,
  now: IsoInstant,
  options: FiveRightsOptions = {},
): FiveRightsResult {
  const failed: FiveRight[] = [];

  if (request.patientId !== order.patientId) failed.push("patient");
  if (request.medicationOrderId !== order.medicationOrderId) failed.push("drug");

  // Right dose: unit must match; a positive dose at or below the order's authorized amount passes (partial
  // doses are clinically legitimate); a larger dose or a non-positive dose fails. Skipped when not discrete.
  if (order.doseAmount !== null) {
    const doseOk =
      request.doseAmount !== null &&
      request.doseAmount > 0 &&
      request.doseAmount <= order.doseAmount &&
      sameToken(request.doseUnit, order.doseUnit);
    if (!doseOk) failed.push("dose");
  }

  // Right route: the §5.11 wrong-route catch.
  if (!sameToken(request.route, order.route)) failed.push("route");

  // Right time: an administeredAt in the future beyond the clock-skew tolerance is a five-rights failure.
  const toleranceMs = (options.futureToleranceMinutes ?? 5) * 60_000;
  if (Date.parse(request.administeredAt) - Date.parse(now) > toleranceMs) failed.push("time");

  return { ok: failed.length === 0, failedRights: failed };
}

/**
 * Server-side throwing wrapper: runs {@link checkFiveRights} and throws `AdministrationStateError`
 * `FIVE_RIGHTS_VIOLATION` (HTTP 422) when any right fails, with the failed rights named in the message.
 * The route handler catches it and echoes `failedRights` to the client (§5.11 UI hint).
 */
export function assertFiveRights(
  request: FiveRightsRequest,
  order: FiveRightsOrderContext,
  now: IsoInstant,
  options: FiveRightsOptions = {},
): void {
  const r = checkFiveRights(request, order, now, options);
  if (!r.ok) {
    throw new AdministrationStateError(
      "FIVE_RIGHTS_VIOLATION",
      `five-rights validation failed: ${r.failedRights.join(", ")}`,
    );
  }
}
