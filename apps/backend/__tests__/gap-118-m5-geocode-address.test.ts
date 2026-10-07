// GAP-118 — the M5 geocode consumer: loads the address, geocodes through the injected vendor port, writes
// coordinates back; fails closed (throws -> DLQ) when no vendor is bound; resolveGeocoder binds a vendor only
// with a registered adapter + API key + BAA attestation.
import { describe, expect, it, vi } from "vitest";

let addressRow: Record<string, unknown> | null = null;
const writes: Array<Record<string, unknown>> = [];

vi.mock("@wardenx/tenancy", () => ({
  systemOrgContext: (organizationId: string) => ({ organizationId, userId: "" }),
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (addressRow ? [addressRow] : []) }) }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          writes.push(v);
          return { where: async () => undefined };
        },
      }),
    }),
}));

import {
  GeocoderUnconfiguredError,
  type GeocoderPort,
  createDeniedGeocoder,
  resolveGeocoder,
} from "../src/modules/05-patient/geocoder";
import { applyGeocodeAddress } from "../src/modules/05-patient/outbox-consumers/m5-geocode-address";

const event = { organizationId: "org-1", payload: { addressId: "addr-1" } };
const address = { line1: "1 Main St", city: "Reno", state: "NV", postalCode: "89501" };

describe("m5 geocode consumer", () => {
  it("geocodes and writes six-decimal coordinates", async () => {
    addressRow = address;
    writes.length = 0;
    const geocoder: GeocoderPort = { geocode: async () => ({ lat: 39.5296, lng: -119.8138 }) };
    expect(await applyGeocodeAddress({ db: {} as never, geocoder }, event)).toBe("geocoded");
    expect(writes).toEqual([{ geocodeLat: "39.529600", geocodeLng: "-119.813800" }]);
  });

  it("an unresolvable address is reported, not retried", async () => {
    addressRow = address;
    const geocoder: GeocoderPort = { geocode: async () => ({ lat: null, lng: null }) };
    expect(await applyGeocodeAddress({ db: {} as never, geocoder }, event)).toBe("unresolved");
  });

  it("an unknown address is skipped without calling the vendor", async () => {
    addressRow = null;
    const geocode = vi.fn();
    expect(await applyGeocodeAddress({ db: {} as never, geocoder: { geocode } }, event)).toBe(
      "skipped_unknown_address",
    );
    expect(geocode).not.toHaveBeenCalled();
  });

  it("an unconfigured vendor throws so the outbox row dead-letters visibly", async () => {
    addressRow = address;
    await expect(
      applyGeocodeAddress({ db: {} as never, geocoder: createDeniedGeocoder("none") }, event),
    ).rejects.toBeInstanceOf(GeocoderUnconfiguredError);
  });

  it("a malformed payload throws", async () => {
    await expect(
      applyGeocodeAddress(
        { db: {} as never, geocoder: createDeniedGeocoder("none") },
        { organizationId: "org-1", payload: {} },
      ),
    ).rejects.toThrow(/addressId/);
  });
});

describe("resolveGeocoder", () => {
  const working: GeocoderPort = { geocode: async () => ({ lat: 1, lng: 2 }) };
  const vendors = { acme: () => working };

  it("denies with no vendor, an unregistered vendor, no key, or no BAA attestation", async () => {
    for (const env of [
      {},
      { GEOCODER_VENDOR: "nope", GEOCODER_API_KEY: "k", GEOCODER_BAA_ATTESTED: "true" },
      { GEOCODER_VENDOR: "acme", GEOCODER_BAA_ATTESTED: "true" },
      { GEOCODER_VENDOR: "acme", GEOCODER_API_KEY: "k" },
    ]) {
      await expect(resolveGeocoder(env, vendors).geocode(address)).rejects.toBeInstanceOf(
        GeocoderUnconfiguredError,
      );
    }
  });

  it("binds a registered vendor only with key AND BAA attestation", () => {
    expect(
      resolveGeocoder(
        { GEOCODER_VENDOR: "acme", GEOCODER_API_KEY: "k", GEOCODER_BAA_ATTESTED: "true" },
        vendors,
      ),
    ).toBe(working);
  });

  it("the shipped vendor registry is empty — no vendor is guessed", async () => {
    await expect(
      resolveGeocoder({
        GEOCODER_VENDOR: "x",
        GEOCODER_API_KEY: "k",
        GEOCODER_BAA_ATTESTED: "true",
      }).geocode(address),
    ).rejects.toBeInstanceOf(GeocoderUnconfiguredError);
  });
});
