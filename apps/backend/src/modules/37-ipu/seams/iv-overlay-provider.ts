// apps/backend/src/modules/37-ipu/seams/iv-overlay-provider.ts — M37's `IpuIvSafetyOverlayProvider` (§4.11,
// GAP-107 / D7): the read M13's pre-administration gate makes before an `iv_continuous_start` /
// `iv_continuous_rate_change` reaches `committed`.
//
// ORG-EXPLICIT: M13 calls this from inside a request, but the org is the argument and every read opens its own
// `withOrgContext` for it, so the answer can never come from another tenant's overlay (RLS is the backstop).
//
// WHAT "ACTIVE" MEANS: the overlay is `overlay_active` AND its IPU admission is still open. An overlay is an
// IPU-bedside control (§2.6 / D7: a continuous IV in the home setting has very different observation patterns),
// so once the patient has been discharged, transferred out or has died the overlay no longer gates anything —
// without that join a drip continued at home would be refused IV_BEDSIDE_CHECK_OVERDUE by a unit it left.
//
// FAIL CLOSED where it matters: no overlay row => `overlayApplies=false` (the patient is not on an IPU, M13's
// own checks stand), but an overlay that EXISTS is applied in full — a missing rate, an unrecognized rate unit
// or an unbounded window is decided by the pure `evaluateIvPreAdministration`, not waved through here.
import { type DbClient, schema } from "@wardenx/db";
import { type IvSafetyOverlayFields, evaluateIvPreAdministration } from "@wardenx/inpatient";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  IpuIvPreAdministrationVerdict,
  IpuIvSafetyOverlayProvider,
  IpuIvSafetyOverlayView,
} from "@wardenx/types";
import { and, eq, notInArray } from "drizzle-orm";

const O = schema.ipuIvSafetyOverlay;
const A = schema.ipuAdmission;

/** Admission states in which the patient is no longer on the unit: the overlay stops gating. */
const ENDED_ADMISSION_STATES = ["transferred", "discharged", "deceased", "closed"] as const;

type OverlayRow = typeof O.$inferSelect;

/** numeric(10,4) arrives as a string; a null bound means "no bound recorded" (unseeded drug, no policy). */
function minRateOf(row: OverlayRow): number {
  return row.titrationMinRate === null ? 0 : Number(row.titrationMinRate);
}
function maxRateOf(row: OverlayRow): number {
  return row.titrationMaxRate === null ? Number.POSITIVE_INFINITY : Number(row.titrationMaxRate);
}

export function overlayFieldsOf(row: OverlayRow): IvSafetyOverlayFields {
  return {
    titrationMinRate: minRateOf(row),
    titrationMaxRate: maxRateOf(row),
    rateUnit: row.rateUnit as IvSafetyOverlayFields["rateUnit"],
    dualWitnessRequired: row.dualWitnessRequired,
    maxContinuousDurationHours: row.maxContinuousDurationHours,
    bedsideCheckIntervalMinutes: row.bedsideCheckIntervalMinutes,
    isSedationClass: row.isSedationClass,
  };
}

/** The active overlay for an M12 medication order, or null. One RLS-scoped read as the app role. */
async function loadActiveOverlay(
  db: DbClient,
  organizationId: string,
  orderId: string,
): Promise<OverlayRow | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const [row] = await tx
      .select({ overlay: O })
      .from(O)
      .innerJoin(A, eq(A.id, O.ipuAdmissionId))
      .where(
        and(
          eq(O.organizationId, organizationId),
          eq(O.orderId, orderId),
          eq(O.overlayActive, true),
          notInArray(A.state, [...ENDED_ADMISSION_STATES]),
        ),
      )
      .limit(1);
    return row?.overlay ?? null;
  });
}

export function buildIpuIvSafetyOverlayProvider(db: DbClient): IpuIvSafetyOverlayProvider {
  return {
    async getOverlayForOrder(organizationId, orderId): Promise<IpuIvSafetyOverlayView | null> {
      const row = await loadActiveOverlay(db, organizationId, orderId);
      return row ? overlayFieldsOf(row) : null;
    },

    async evaluatePreAdministration(organizationId, input): Promise<IpuIvPreAdministrationVerdict> {
      const row = await loadActiveOverlay(db, organizationId, input.orderId);
      if (!row) return { overlayApplies: false, pass: true, dualWitnessRequired: false };
      const overlay = overlayFieldsOf(row);
      const verdict = evaluateIvPreAdministration(overlay, {
        proposedRate: input.proposedRate,
        proposedRateUnit: input.proposedRateUnit,
        witnessTokenPresent: input.witnessTokenPresent,
        hoursSinceContinuousStart: input.hoursSinceContinuousStart,
        minutesSinceLastBedsideCheck: input.minutesSinceLastBedsideCheck,
        isTitration: input.isTitration,
      });
      return {
        overlayApplies: true,
        pass: verdict.allowed,
        dualWitnessRequired: overlay.dualWitnessRequired,
        ...(verdict.code
          ? { failureCode: verdict.code as IpuIvPreAdministrationVerdict["failureCode"] }
          : {}),
      };
    },
  };
}
