// apps/backend/src/modules/05-patient/outbox-consumers/m5-geocode-address.ts — M5's own `geocode_address` job
// (§4.5), run as the consumer of `m5.patient.address_changed` (GAP-118). Fills `patient_address.geocode_lat/lng`,
// which M17/M18 read for the EVV geofence baseline (GAP-054) and which nothing ever wrote.
//
// Composition: load the address (org-scoped), geocode through the injected {@link GeocoderPort}, write the
// result back — `runGeocodeAddress` (jobs/index.ts) is the pure core. FAIL DIRECTIONS (each deliberate):
//   - an UNCONFIGURED geocoder throws -> the dispatcher retries -> DLQ: visible and replayable, never a silent
//     skip (see `../geocoder.ts` for why no vendor is bound);
//   - an address that no longer exists / belongs to another org is skipped (nothing of this tenant's to do);
//   - an address the vendor cannot resolve writes nothing and reports `unresolved` (a bad/foreign address is not
//     a retryable failure);
//   - a malformed payload THROWS (an integration defect to surface, not to drop).
// IDEMPOTENT: a redelivery re-geocodes and overwrites with the same coordinates. The write runs as the NULL
// (system) audit actor.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import type { GeocoderPort } from "../geocoder";
import { type GeocodeAddressPorts, type GeocodeResult, runGeocodeAddress } from "../jobs/index";

const ADDR = schema.patientAddresses;

export const M5_GEOCODE_ADDRESS_CONSUMER = {
  eventName: "m5.patient.address_changed",
  consumerName: "m5.geocode-address",
} as const;

export interface GeocodeAddressDeps {
  readonly db: DbClient;
  readonly geocoder: GeocoderPort;
}

export type GeocodeAddressOutcome = "geocoded" | "unresolved" | "skipped_unknown_address";

/** Six decimal places is the column's scale (numeric(9,6)). */
const toColumn = (v: number | null): string | null => (v === null ? null : v.toFixed(6));

function ports(deps: GeocodeAddressDeps): GeocodeAddressPorts {
  return {
    geocode: (address) => deps.geocoder.geocode(address),
    async writeGeocode(organizationId: string, addressId: string, result: GeocodeResult) {
      await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
        await (tx as unknown as DbClient)
          .update(ADDR)
          .set({ geocodeLat: toColumn(result.lat), geocodeLng: toColumn(result.lng) })
          .where(eq(ADDR.id, addressId));
      });
    },
  };
}

export async function applyGeocodeAddress(
  deps: GeocodeAddressDeps,
  event: { readonly organizationId: string; readonly payload: unknown },
): Promise<GeocodeAddressOutcome> {
  const addressId = (event.payload as { addressId?: unknown } | null)?.addressId;
  if (typeof addressId !== "string" || addressId.length === 0)
    throw new Error(`${M5_GEOCODE_ADDRESS_CONSUMER.consumerName}: payload has no addressId`);

  const row = await withOrgContext(deps.db, systemOrgContext(event.organizationId), async (tx) => {
    const [r] = await (tx as unknown as DbClient)
      .select({
        line1: ADDR.line1,
        city: ADDR.city,
        state: ADDR.state,
        postalCode: ADDR.postalCode,
      })
      .from(ADDR)
      .where(eq(ADDR.id, addressId))
      .limit(1);
    return r ?? null;
  });
  if (!row) return "skipped_unknown_address";

  const result = await runGeocodeAddress(
    {
      organizationId: event.organizationId,
      addressId,
      address: {
        line1: row.line1,
        city: row.city,
        postalCode: row.postalCode,
        ...(row.state ? { state: row.state } : {}),
      },
    },
    ports(deps),
  );
  return result.resolved ? "geocoded" : "unresolved";
}

export function buildM5GeocodeAddressConsumer(deps: GeocodeAddressDeps) {
  return {
    consumerName: M5_GEOCODE_ADDRESS_CONSUMER.consumerName,
    consumerModule: "m5" as const,
    eventTypes: [M5_GEOCODE_ADDRESS_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      await applyGeocodeAddress(deps, event);
    },
  };
}
