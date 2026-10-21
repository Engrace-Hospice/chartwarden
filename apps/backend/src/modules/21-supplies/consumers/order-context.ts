// apps/backend/src/modules/21-supplies/consumers/order-context.ts — M21-T04 (§4.5.1, §7.1, §2.8).
//
// The IO half of the M11 cascade: resolve the facts `decideSupplyFulfillmentIntake` needs, through the M1
// seam registry, and hand them over as plain data. Keeping the reads here is what lets the decider be a
// pure function with no DB, no clock and no seam — the M15/M16 shape.
//
// TWO SEAMS, TWO QUESTIONS:
//   • M11 `OrderProvider.getOrder`         — who is this order for? (§2.8's logical-FK check)
//   • M6  `AdmissionStatusReader`          — which provider entity, location, and is anyone still there?
//                                             (§7.1)
//
// A THIRD READ IS CONDITIONAL. `AdmissionSummary.status` says `discharged` for a death and a live
// discharge alike, and §7.1 wants those recorded with different reasons, so a discharged admission gets one
// narrow `DeathDischargeReader.listDeathDischargesInPeriod` window read to discriminate. It runs ONLY on
// the discharged branch — the common path (an active admission) costs one order read and one admission
// read, which is the right price for a queue that runs on every signed supply order in the agency.
//
// The window is anchored on the admission's own `dischargedAt` and widened by a day either side, because
// M6 records the census row and the admission's discharge date on independent schedules (the same
// tolerance M16-T03's `resolveDeathFact` settled on). A miss returns `false`, not `null`: the admission IS
// discharged, M6's death census does not list it, and "not a death discharge" is the honest reading of
// that pair. `null` is reserved for a read that could not be performed at all.
//
// THE SERVING-LOCATION FACT (F-166, #248) — no longer a separate unresolved port. This file used to carry
// a `resolveServingLocation` port with the header "NO PLATFORM SEAM ANSWERS THIS" — checked again rather
// than trusted, and it was stale: `AdmissionSummary.locationId` (task-11's M6 activation-siting anchor,
// the SAME fact `05-patient/outbox-consumers/m6-admission-activated.ts` denormalizes onto
// `patient.location_id`, F-152) has been on the `getAdmissionSummary` return type the whole time, and this
// file already calls that seam for `admission` — it simply never read the field. `null` on a not-yet-sited
// admission (draft, or a location port unbound at activation) is a real, honest gap `decideSupplyFulfillment
// Intake` already dead-letters on (`M21_SERVING_LOCATION_UNRESOLVED`) — narrower now (a genuinely unsited
// admission) than before (every admission, unconditionally), not fabricated.
import type { AdmissionSummary, IsoInstant, OrderRecordId } from "@chartwarden/types";
import {
  getAdmissionStatusReader,
  getDeathDischargeReader,
  getOrderProvider,
} from "../seams/consumed";
import type {
  M11SupplyFulfillmentRequestedPayload,
  SupplyAdmissionContext,
  SupplyFulfillmentIntakeFacts,
  SupplyOrderContext,
} from "./m11-orders";

/** How far either side of `AdmissionSummary.dischargedAt` the death-census window reaches. */
export const DEATH_DISCHARGE_WINDOW_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for `d`, in UTC — the date form M6's census period takes. */
function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The `[from, to]` census window around a discharge date. Exported for the §9 tests. */
export function deathCensusWindow(dischargedAt: string): { from: string; to: string } {
  const anchor = new Date(`${dischargedAt}T00:00:00.000Z`).getTime();
  return {
    from: utcDate(new Date(anchor - DEATH_DISCHARGE_WINDOW_DAYS * MS_PER_DAY)),
    to: utcDate(new Date(anchor + DEATH_DISCHARGE_WINDOW_DAYS * MS_PER_DAY)),
  };
}

/** The reads {@link resolveSupplyOrderContext} needs that are NOT seams — the M21-side lookups the T05
 *  service layer implements over Drizzle (and the tests implement in memory). */
export interface SupplyIntakePorts {
  /** §7.1 edge 2 — a `supply_request` already written for this order (outbox-retry idempotency). */
  findRequestBySourceOrder(orderId: OrderRecordId): Promise<string | null>;
}

/** Project M6's summary onto the facts the decider reads, resolving the death discriminator on the
 *  discharged branch only. */
async function toAdmissionContext(
  organizationId: string,
  summary: AdmissionSummary,
): Promise<SupplyAdmissionContext> {
  let deathDischarge: boolean | null = null;
  if (summary.status === "discharged" && summary.dischargedAt !== null) {
    try {
      const rows = await getDeathDischargeReader().listDeathDischargesInPeriod(
        organizationId,
        deathCensusWindow(summary.dischargedAt),
      );
      deathDischarge = rows.some((r) => r.admissionId === summary.admissionId);
    } catch {
      // The reader is unbound or erroring. The cancellation still happens (see ./m11-orders on why the
      // fail direction here is OPEN) — only the reason token degrades.
      deathDischarge = null;
    }
  }
  return {
    providerEntityId: summary.providerEntityId,
    // F-166 (#248) — the serving-Location fact was on this projection's own source the whole time.
    locationId: summary.locationId ?? null,
    status: summary.status,
    dischargedAt: summary.dischargedAt,
    deathDischarge,
  };
}

/**
 * §4.5.1 / §7.1 — resolve every fact `decideSupplyFulfillmentIntake` needs for one inbound delivery.
 *
 * Returns the facts with `null` in each slot the reads could not fill; the DECIDER, not this resolver,
 * turns a null into a dead-letter or a degraded reason. That split is deliberate: the fail direction of a
 * fact is a domain decision and belongs next to the rule that depends on it, not next to the IO.
 */
export async function resolveSupplyOrderContext(
  organizationId: string,
  payload: M11SupplyFulfillmentRequestedPayload,
  ports: SupplyIntakePorts,
): Promise<SupplyFulfillmentIntakeFacts> {
  const existingRequestId = await ports.findRequestBySourceOrder(payload.orderId);
  if (existingRequestId !== null) {
    // Short-circuit: a redelivery must not spend two seam reads to conclude it is a redelivery.
    return { existingRequestId, order: null, admission: null, servingLocationId: null };
  }

  const record = await getOrderProvider().getOrder({ orderId: payload.orderId });
  if (record === null) {
    return { existingRequestId: null, order: null, admission: null, servingLocationId: null };
  }
  const order: SupplyOrderContext = {
    orderId: record.orderId,
    patientId: record.patientId,
    admissionId: record.admissionId,
    orderStatus: record.status,
  };

  let admission: SupplyAdmissionContext | null = null;
  try {
    const summary = await getAdmissionStatusReader().getAdmissionSummary(
      organizationId,
      order.admissionId,
    );
    admission = await toAdmissionContext(organizationId, summary);
  } catch {
    // Fail-CLOSED on the tenancy anchor: `provider_entity_id` is NOT NULL on every M21 PHI table and rolls
    // supply cost per CCN to the M27 cost report. A guessed provider entity is a mis-stated cost report.
    admission = null;
  }

  // F-166 (#248) — the serving Location is `admission.locationId` (M6's activation-siting anchor),
  // already carried on the projection above; no second read.
  const servingLocationId = admission === null ? null : admission.locationId;

  return { existingRequestId: null, order, admission, servingLocationId };
}

/** The instant the worker stamps on the intake's `status_changed` emit. Isolated so the workers and the
 *  §9 tests agree on the field rather than each minting their own clock read. */
export function intakeOccurredAt(now: Date): IsoInstant {
  return now.toISOString();
}
