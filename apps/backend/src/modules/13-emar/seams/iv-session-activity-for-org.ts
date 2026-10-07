// apps/backend/src/modules/13-emar/seams/iv-session-activity-for-org.ts — the org-explicit, BATCHED read of
// "is this order's infusion running, and when did a clinician last touch it?" that M37's
// `iv-bedside-check-watchdog` (§2.6 / §4.8, GAP-107) needs. M37 must not read `administration_record` (arch:tables)
// and M13's published `MedicationAdministrationProvider` is keyed by session and runs under an ambient request,
// which a cron tick does not have — hence this org-explicit function, the `idgMissedDosesForOrg` precedent.
//
// SOURCE: the order's non-voided `iv_continuous_*` segments. The CURRENT session is the one the latest segment
// belongs to; its state is derived with the same `deriveIvSessionState` the write path and the seam projection
// use, so the three can never disagree about "running".
//
// "LAST BEDSIDE CHECK" = the session's latest segment (start / rate_change / pause / resume / stop). M13 has no
// separate `observation` mode (the spec's `iv_continuous_observation` does not exist in its mode catalog), so a
// recorded segment is the only bedside contact the platform can see.
//
// NO PHI: ids, a state and two instants. Org scoping is the explicit `organizationId` + RLS.
import { type DbClient, schema } from "@wardenx/db";
import { type IvSegment, type IvSegmentMode, deriveIvSessionState } from "@wardenx/emar";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray, ne } from "drizzle-orm";

const ADM = schema.administrationRecords;

/** A cron read with no acting human (the empty-GUC system convention). */
const IV_ACTIVITY_SYSTEM_USER_ID = "";

/** An order list this long is a caller bug (an IPU census is dozens of infusions). */
export const IV_SESSION_ACTIVITY_MAX_ORDERS = 500;

export interface IvSessionActivity {
  readonly medicationOrderId: string;
  /** The current session's derived state; `none` when the order has no IV segment at all. */
  readonly state: "none" | "running" | "paused" | "stopped";
  readonly sessionId: string | null;
  /** The current session's first segment instant (the infusion's start), or null. */
  readonly startedAt: string | null;
  /** The current session's latest segment instant, or null. */
  readonly lastSegmentAt: string | null;
}

const isoOf = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/** Pure: the activity of one order from its ordered (oldest-first) segment rows. Exported for unit tests. */
export function ivActivityOf(
  medicationOrderId: string,
  rows: readonly {
    readonly ivSessionId: string | null;
    readonly mode: string;
    readonly administeredAt: Date | string;
  }[],
): IvSessionActivity {
  const latest = rows[rows.length - 1];
  if (!latest?.ivSessionId) {
    return {
      medicationOrderId,
      state: "none",
      sessionId: null,
      startedAt: null,
      lastSegmentAt: null,
    };
  }
  const sessionRows = rows.filter((r) => r.ivSessionId === latest.ivSessionId);
  const segments: IvSegment[] = sessionRows.map((r) => ({
    mode: r.mode as IvSegmentMode,
    administeredAt: isoOf(r.administeredAt),
  }));
  return {
    medicationOrderId,
    state: deriveIvSessionState(segments),
    sessionId: latest.ivSessionId,
    startedAt: segments[0]?.administeredAt ?? null,
    lastSegmentAt: segments[segments.length - 1]?.administeredAt ?? null,
  };
}

/** One query; every requested order is present in the result (an order with no segments is `none`). */
export async function ivSessionActivityForOrg(
  db: DbClient,
  organizationId: string,
  medicationOrderIds: readonly string[],
): Promise<readonly IvSessionActivity[]> {
  const ids = [...new Set(medicationOrderIds)];
  if (ids.length === 0) return [];
  if (ids.length > IV_SESSION_ACTIVITY_MAX_ORDERS) {
    throw new Error(
      `ivSessionActivityForOrg: ${ids.length} orders exceeds the ${IV_SESSION_ACTIVITY_MAX_ORDERS} cap`,
    );
  }
  return withOrgContext(
    db,
    { organizationId, userId: IV_ACTIVITY_SYSTEM_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({
          medicationOrderId: ADM.medicationOrderId,
          ivSessionId: ADM.ivSessionId,
          mode: ADM.mode,
          administeredAt: ADM.administeredAt,
        })
        .from(ADM)
        .where(
          and(
            eq(ADM.organizationId, organizationId),
            inArray(ADM.medicationOrderId, ids),
            ne(ADM.status, "voided"),
            inArray(ADM.mode, [
              "iv_continuous_start",
              "iv_continuous_rate_change",
              "iv_continuous_pause",
              "iv_continuous_resume",
              "iv_continuous_stop",
            ]),
          ),
        )
        // `recorded_at` breaks a same-minute tie, exactly as the write path's session read does.
        .orderBy(asc(ADM.administeredAt), asc(ADM.recordedAt));
      const byOrder = new Map<string, typeof rows>();
      for (const r of rows)
        byOrder.set(r.medicationOrderId, [...(byOrder.get(r.medicationOrderId) ?? []), r]);
      return ids.map((id) => ivActivityOf(id, byOrder.get(id) ?? []));
    },
  );
}
