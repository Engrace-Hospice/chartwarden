// apps/backend/__tests__/supplies-serving-location.test.ts — GAP-064 (M21): the serving Location of a
// supply request / comfort-kit dispatch is a SERVER fact (admission siting / the stored request row), never
// the request body's claim. The pure verifiers are what the Drizzle write service calls.
import { describe, expect, it } from "vitest";
import {
  M21_ERROR_STATUS,
  SupplyStateError,
  assertDispatchLocationMatchesRequest,
  verifyRequestServingLocation,
} from "../src/modules/21-supplies/index";

const LOC_A = "22222222-2222-4222-8222-222222222222";
const LOC_B = "33333333-3333-4333-8333-333333333333";

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof SupplyStateError ? error.code : "NOT_A_SUPPLY_STATE_ERROR";
  }
};

describe("GAP-064 verifyRequestServingLocation", () => {
  it("returns the admission's location when the body names it", () => {
    expect(
      verifyRequestServingLocation({
        bodyLocationId: LOC_A,
        admissionLocationId: LOC_A,
        actorLocationIds: [],
      }),
    ).toBe(LOC_A);
  });

  it("refuses a body location that differs from the admission's siting (422)", () => {
    const code = codeOf(() =>
      verifyRequestServingLocation({
        bodyLocationId: LOC_A,
        admissionLocationId: LOC_B,
        actorLocationIds: [LOC_A],
      }),
    );
    expect(code).toBe("M21_LOCATION_MISMATCH");
    expect(M21_ERROR_STATUS.M21_LOCATION_MISMATCH).toBe(422);
  });

  it("falls back to the actor's own Locations when the admission is unsited", () => {
    expect(
      verifyRequestServingLocation({
        bodyLocationId: LOC_A,
        admissionLocationId: null,
        actorLocationIds: [LOC_A],
      }),
    ).toBe(LOC_A);
  });

  it("refuses an unsited admission when the body location is outside the actor's Locations", () => {
    expect(
      codeOf(() =>
        verifyRequestServingLocation({
          bodyLocationId: LOC_B,
          admissionLocationId: undefined,
          actorLocationIds: [LOC_A],
        }),
      ),
    ).toBe("M21_SERVING_LOCATION_UNRESOLVED");
  });

  it("refuses an unsited admission when the actor has no Locations at all (never trusts the body)", () => {
    expect(
      codeOf(() =>
        verifyRequestServingLocation({
          bodyLocationId: LOC_A,
          admissionLocationId: null,
          actorLocationIds: [],
        }),
      ),
    ).toBe("M21_SERVING_LOCATION_UNRESOLVED");
  });
});

describe("GAP-064 assertDispatchLocationMatchesRequest", () => {
  it("returns the request's stored Location when the body agrees", () => {
    expect(assertDispatchLocationMatchesRequest(LOC_A, LOC_A)).toBe(LOC_A);
  });

  it("refuses a dispatch body naming a Location other than the request's (422)", () => {
    expect(codeOf(() => assertDispatchLocationMatchesRequest(LOC_B, LOC_A))).toBe(
      "M21_LOCATION_MISMATCH",
    );
  });
});
