// @wardenx/dosespot — IAL2 identity-proofing status tracker + expiry alerts (§2.4 §1311.115, M12-T05).
// Pure, IO-free.
//
// 21 CFR §1311.115 requires IAL2 identity proofing before a prescriber may sign for controlled substances.
// The proofing *action* is performed by DoseSpot's IDP (per ADR-006); WardenX receives the status back and
// persists it on `dosespot_prescriber.ial2_status`. M12 does not implement an IAL2-equivalent flow itself —
// it tracks the DoseSpot-administered status and gates signing on it. The status expires per DoseSpot policy
// (currently 2 years); M12 emits an M36 routine alert 30 days before expiry and a high-severity alert 7 days
// before. This module owns:
//   • `isIal2Verified` / `assertIal2Verified` — the §1311.116 sign-route pre-check.
//   • `classifyIal2ExpiryStage` — the `none | warn | critical` stage for days-remaining-to-expiry.
//   • `planIal2ExpiryAlert` — the §2.4/§4.9 side-effect plan (outbox + typed M36 alert) for a stage.
// Every fact (status, expiry instant, `now`) is injected as data — no `Date.now()`, no DB.
import type { Ial2Status } from "@wardenx/types";
import { type EpcsSideEffect } from "./effects";
import { requireEpcs } from "./errors";

/** §2.4 §1311.115 — emit the routine IAL2-expiry warning this many days before `ial2_expires_at`. */
export const IAL2_EXPIRY_WARN_DAYS = 30;

/** §2.4 §1311.115 — emit the high-severity IAL2-expiry alert this many days before `ial2_expires_at`. */
export const IAL2_EXPIRY_CRITICAL_DAYS = 7;

/** §2.4 §1311.115 — is the prescriber's IAL2 identity proofing currently `'verified'`? The only status that
 * permits opening a controlled-substance signing session. `expired` / `revoked` / `in_progress` /
 * `not_started` all block. */
export function isIal2Verified(status: Ial2Status): boolean {
  return status === "verified";
}

/**
 * §2.4 §1311.115 — assert the prescriber's IAL2 status is `'verified'`, throwing
 * `EPCS_PRESCRIBER_NOT_VERIFIED` otherwise. The EPCS sign route (M12-T08) calls this before issuing the 2FA
 * nonce; the medication-order machine repeats the guard inline as defence in depth.
 */
export function assertIal2Verified(status: Ial2Status): void {
  requireEpcs(
    isIal2Verified(status),
    "EPCS_PRESCRIBER_NOT_VERIFIED",
    `the prescriber's IAL2 identity proofing is not verified (status='${status}')`,
  );
}

/** The §2.4 IAL2-expiry alert stage a prescriber's identity proofing has reached. */
export type Ial2ExpiryStage = "none" | "warn" | "critical";

/** §2.4 §1311.115 — whole days until IAL2 expiry: `floor((expiresAt − now) / 1d)`. Negative once expired. */
export function computeDaysUntilIal2Expiry(expiresAtIso: string, nowIso: string): number {
  const expires = Date.parse(expiresAtIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expires) || Number.isNaN(now)) {
    throw new RangeError("computeDaysUntilIal2Expiry: expiresAt / now must be valid ISO instants");
  }
  return Math.floor((expires - now) / 86_400_000);
}

/**
 * §2.4 §1311.115 — the expiry stage for a verified prescriber `daysRemaining` from IAL2 expiry: `critical`
 * once `daysRemaining ≤ 7`, else `warn` once `≤ 30`, else `none`. The daily `dosespot.ial2_expiry_warn` cron
 * (§4.8) calls this per enrolled prescriber and emits at most one new alert per escalation per
 * {@link planIal2ExpiryAlert}.
 */
export function classifyIal2ExpiryStage(daysRemaining: number): Ial2ExpiryStage {
  if (daysRemaining <= IAL2_EXPIRY_CRITICAL_DAYS) return "critical";
  if (daysRemaining <= IAL2_EXPIRY_WARN_DAYS) return "warn";
  return "none";
}

/**
 * §2.4 / §4.9 — the side-effect plan for a prescriber at a given IAL2-expiry stage: `warn` emits the
 * `m12.ial2_expiring_warn` outbox event + the `ial2.expiring_warn` typed M36 alert; `critical` emits the
 * `ial2.expiring_critical` alert (there is no separate critical outbox name in §4.4 — the warn outbox
 * already signals the projection, the alert carries the severity); `none` emits nothing. The cron suppresses
 * re-emission of an already-emitted stage; this function is the pure stage→effects map.
 */
export function planIal2ExpiryAlert(stage: Ial2ExpiryStage): ReadonlyArray<EpcsSideEffect> {
  switch (stage) {
    case "warn":
      return [
        { kind: "outbox", event: "m12.ial2_expiring_warn" },
        { kind: "alert", alert: "ial2.expiring_warn" },
      ];
    case "critical":
      return [
        { kind: "outbox", event: "m12.ial2_expiring_warn" },
        { kind: "alert", alert: "ial2.expiring_critical" },
      ];
    case "none":
      return [];
  }
}
