// apps/backend/src/modules/18-evv/__tests__/coords.test.ts — the `evv_event.coords_cipher` codec (GAP-032).
//
// The defect this closes was not a bad codec, it was the ABSENCE of one on the read side: the write encoded
// inline and both reads returned a hardcoded `lat: 0, lng: 0`. Round-tripping is therefore the point, and
// so is every way the decode can fail — because the alternative to `null` used to be a plausible-looking
// coordinate off the Gulf of Guinea that no caller could distinguish from a real one.
import { describe, expect, it } from "vitest";
import { decodeStoredCoords, encodeStoredCoords } from "../coords";

describe("M18 coords codec (GAP-032)", () => {
  it("round-trips a captured coordinate", () => {
    const coords = { lat: 45.5152, lng: -122.6784 }; // Portland, OR — the seed data's home base
    expect(decodeStoredCoords(encodeStoredCoords(coords))).toEqual(coords);
  });

  it("round-trips the extremes and a genuine zero pair", () => {
    for (const coords of [
      { lat: 90, lng: 180 },
      { lat: -90, lng: -180 },
      // (0, 0) is a VALID coordinate. It must survive the round-trip, which is exactly why the
      // unavailable case had to become `null` rather than reusing zero as a sentinel.
      { lat: 0, lng: 0 },
    ]) {
      expect(decodeStoredCoords(encodeStoredCoords(coords))).toEqual(coords);
    }
  });

  it("returns null for an absent payload rather than a fabricated origin", () => {
    expect(decodeStoredCoords(null)).toBeNull();
    expect(decodeStoredCoords(undefined)).toBeNull();
    expect(decodeStoredCoords("")).toBeNull();
  });

  it("returns null for a malformed payload", () => {
    expect(decodeStoredCoords(Buffer.from("45.5").toString("base64"))).toBeNull(); // one component
    expect(decodeStoredCoords(Buffer.from("45.5,-122.6,7").toString("base64"))).toBeNull(); // three
    expect(decodeStoredCoords(Buffer.from("north,west").toString("base64"))).toBeNull(); // non-numeric
    expect(decodeStoredCoords("!!!not-base64!!!")).toBeNull();
  });

  it("returns null for an out-of-range pair instead of trusting the parse", () => {
    // A truncated or re-encoded payload can still parse as two finite numbers. A silently wrong
    // coordinate on a supervisor's live-awareness board is worse than an explicit "unavailable".
    expect(decodeStoredCoords(Buffer.from("91,0").toString("base64"))).toBeNull();
    expect(decodeStoredCoords(Buffer.from("0,181").toString("base64"))).toBeNull();
    expect(decodeStoredCoords(Buffer.from("NaN,0").toString("base64"))).toBeNull();
    expect(decodeStoredCoords(Buffer.from("Infinity,0").toString("base64"))).toBeNull();
  });
});
