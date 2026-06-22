// @wardenx/emar — §2.5 D8 late-entry tier ladder (M13-T03). PURE, IO-free, `Date.now()`-free.
//
// The §2.2 administration write gate resolves the late-entry tier from the gap between the clinician-entered
// `administeredAt` and the server-receive `recordedAt` (§3 line 1381): ≤4h normal · 4–24h late · 24h–7d
// significant_late · >7d administrative_override. This mirrors M8's encounter late-entry tier framework with
// M13-scoped permission keys (the per-tier permission gate lives at the route, M13-T08). The tier is
// computed server-side from both instants; the offline path cannot lower it (§2.10) — an administration
// captured at 0300 and synced 18h later is `late`, computed off `administeredAt` vs `recordedAt`, not off
// the sync time alone. PURE: both instants are passed in, so the ladder is deterministic.
import type { IsoInstant, AdministrationLateEntryTier } from "@wardenx/types";

const HOUR_MS = 3_600_000;
const FOUR_HOURS_MS = 4 * HOUR_MS;
const ONE_DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

/**
 * §2.5 D8 — resolve the late-entry tier from the administered→recorded gap. A non-positive gap (recorded at
 * or before administered, including small forward clock skew) is `normal`. The `administrative_override`
 * tier (>7d) additionally requires the route-layer step-up + permission; this function resolves the tier
 * only — it never authorizes the override.
 */
export function resolveLateEntryTier(
  administeredAt: IsoInstant,
  recordedAt: IsoInstant,
): AdministrationLateEntryTier {
  const gapMs = Date.parse(recordedAt) - Date.parse(administeredAt);
  if (gapMs <= FOUR_HOURS_MS) return "normal";
  if (gapMs <= ONE_DAY_MS) return "late";
  if (gapMs <= SEVEN_DAYS_MS) return "significant_late";
  return "administrative_override";
}

/** Whether a tier needs the elevated per-tier permission gate at the route (§2.5 D8 / §4.6). */
export function tierRequiresElevatedPermission(tier: AdministrationLateEntryTier): boolean {
  return tier === "significant_late" || tier === "administrative_override";
}
