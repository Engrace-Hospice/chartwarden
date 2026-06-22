// apps/backend/src/modules/05-patient/jobs — M5 background jobs (M5-T10, §4.5). Pure processors over
// injected ports + the queue catalog (pure data, no BullMQ import — the worker construction binds at
// app boot, same pattern as M40-T08). T10 ships the geocode job (fills patient_address.geocoded_lat/
// lng after an address change); the SLA/snapshot scans land with their consumers.

/** The §4.5 queue names. */
export const M5_QUEUES = {
  /** On `m5.patient.address_changed`: geocode the new primary address → geocoded_lat/lng. */
  geocodeAddress: "m5.geocode_address",
  /** Daily: amendment 60-day SLA tick → warn/escalate pending requests. */
  amendmentSlaScan: "m5.amendment_sla_scan",
  /** On `m39.consent.*`: recompute patient_privacy_flag_snapshot (consumer; wired when M39 lands). */
  privacyFlagRecompute: "m5.privacy_flag_recompute",
} as const;

export type M5QueueName = (typeof M5_QUEUES)[keyof typeof M5_QUEUES];

/** The §4.5 cron cadences (the scheduler registers the repeatables; event-triggered jobs have none). */
export const M5_JOB_SCHEDULES = {
  amendmentSlaScan: "0 7 * * *", // daily 07:00
} as const;

/** A geocode result (lat/lng in decimal degrees, or null when the geocoder could not resolve). */
export interface GeocodeResult {
  readonly lat: number | null;
  readonly lng: number | null;
}

/** Ports the geocode processor binds (the geocoder adapter + the Drizzle address writer). */
export interface GeocodeAddressPorts {
  /** Resolve an address string to coordinates (the geocoder vendor adapter; out of M5's codePath). */
  geocode(address: {
    line1: string;
    city: string;
    state?: string;
    postalCode: string;
  }): Promise<GeocodeResult>;
  /** Write geocoded_lat/lng back onto the address row. */
  writeGeocode(organizationId: string, addressId: string, result: GeocodeResult): Promise<void>;
}

/** What the geocode job reported. */
export interface GeocodeAddressResult {
  readonly addressId: string;
  readonly resolved: boolean;
}

/**
 * Geocode one address (§4.5) — resolve the coordinates and write them back. Idempotent: a re-run
 * overwrites with the same result. Pure over the ports; `resolved` is false when the geocoder
 * returned no coordinates (a bad/foreign address), in which case lat/lng stay null.
 */
export async function runGeocodeAddress(
  input: {
    organizationId: string;
    addressId: string;
    address: { line1: string; city: string; state?: string; postalCode: string };
  },
  ports: GeocodeAddressPorts,
): Promise<GeocodeAddressResult> {
  const result = await ports.geocode(input.address);
  await ports.writeGeocode(input.organizationId, input.addressId, result);
  return { addressId: input.addressId, resolved: result.lat !== null && result.lng !== null };
}
