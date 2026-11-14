import { describe, expect, it } from "vitest";
import { selectEffectiveMedicareProviderRouting } from "./medicare-provider-routing";

describe("Medicare provider routing selection", () => {
  it("returns the sole organization/provider/date-filtered route", () => {
    expect(selectEffectiveMedicareProviderRouting([{ macJurisdiction: "cgs_j15" }])).toEqual({
      macJurisdiction: "cgs_j15",
    });
  });

  it("fails closed for a missing route", () => {
    expect(() => selectEffectiveMedicareProviderRouting([])).toThrowError(
      expect.objectContaining({ code: "MEDICARE_ROUTING_MISSING", statusCode: 422 }),
    );
  });

  it("rejects ambiguous matches instead of choosing one", () => {
    expect(() =>
      selectEffectiveMedicareProviderRouting([
        { macJurisdiction: "cgs_j15" },
        { macJurisdiction: "noridian_je" },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "MEDICARE_ROUTING_AMBIGUOUS", statusCode: 409 }),
    );
  });
});
