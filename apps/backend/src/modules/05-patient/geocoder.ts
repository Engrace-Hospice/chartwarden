// apps/backend/src/modules/05-patient/geocoder.ts — the geocoder VENDOR port and its fail-closed default
// (GAP-118; M5 §4.5 `geocode_address`, GAP-054 geofence baseline).
//
// A geocode sends a PATIENT'S HOME ADDRESS to a third party: PHI leaving the platform. No vendor has been
// selected, contracted or covered by a BAA, and there are no credentials in any environment. So this file ships
// the seam, not a guess at a vendor:
//
//   - {@link GeocoderPort} — what the geocode consumer needs (an address in, coordinates or "unresolved" out).
//   - {@link createDeniedGeocoder} — the default: every call throws {@link GeocoderUnconfiguredError}. The
//     consumer lets that propagate, so the outbox row dead-letters visibly (replayable once a vendor is bound)
//     instead of the address silently staying un-geocoded. `m5.geocode_coverage` (GAP-054) keeps reporting the gap.
//   - {@link resolveGeocoder} — binds a REGISTERED vendor adapter only when ALL of: `GEOCODER_VENDOR` names a
//     registered adapter, `GEOCODER_API_KEY` is set, and `GEOCODER_BAA_ATTESTED=true` (an operator's statement
//     that a BAA is in force with that vendor). Anything less stays denied. The vendor registry is EMPTY in this
//     repo: adding a vendor means writing its request/response mapping and registering it — nothing else changes.
import type { GeocodeResult } from "./jobs/index";

export interface GeocodeQuery {
  readonly line1: string;
  readonly city: string;
  readonly state?: string;
  readonly postalCode: string;
}

export interface GeocoderPort {
  geocode(address: GeocodeQuery): Promise<GeocodeResult>;
}

export class GeocoderUnconfiguredError extends Error {
  constructor(reason: string) {
    super(`GEOCODER_UNCONFIGURED: ${reason}`);
    this.name = "GeocoderUnconfiguredError";
  }
}

/** A vendor adapter factory: given the API key, returns the working port. */
export type GeocoderVendorFactory = (apiKey: string) => GeocoderPort;

export function createDeniedGeocoder(reason: string): GeocoderPort {
  return {
    async geocode() {
      throw new GeocoderUnconfiguredError(reason);
    },
  };
}

export interface GeocoderEnv {
  readonly GEOCODER_VENDOR?: string;
  readonly GEOCODER_API_KEY?: string;
  readonly GEOCODER_BAA_ATTESTED?: string;
}

/** The registered vendor adapters. Empty on purpose — see the file header. */
export const GEOCODER_VENDORS: Readonly<Record<string, GeocoderVendorFactory>> = {};

export function resolveGeocoder(
  env: GeocoderEnv,
  vendors: Readonly<Record<string, GeocoderVendorFactory>> = GEOCODER_VENDORS,
): GeocoderPort {
  const vendor = env.GEOCODER_VENDOR?.trim();
  if (!vendor) return createDeniedGeocoder("no GEOCODER_VENDOR selected");
  const factory = vendors[vendor];
  if (!factory) return createDeniedGeocoder(`no adapter registered for vendor '${vendor}'`);
  if (!env.GEOCODER_API_KEY?.trim()) return createDeniedGeocoder("GEOCODER_API_KEY is not set");
  if (env.GEOCODER_BAA_ATTESTED !== "true")
    return createDeniedGeocoder(
      "GEOCODER_BAA_ATTESTED is not 'true' — a patient address may only go to a vendor under a BAA",
    );
  return factory(env.GEOCODER_API_KEY.trim());
}
