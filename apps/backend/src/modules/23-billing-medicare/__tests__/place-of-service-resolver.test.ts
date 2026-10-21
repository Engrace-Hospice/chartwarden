// F-213 (#252) — pure/unit proof of the M23 place-of-service resolver (mapping, RHC/CHC-only rule, coverage,
// move handling). The live suite (m23-claim-assembly-seams) proves the same against real rows under RLS.
import { POS_BY_QCODE } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

import {
  type M23FacilityKind,
  type M23ResidenceSpan,
  QCODE_BY_FACILITY_KIND,
  resolvePlaceOfService,
  resolvePlaceOfServiceLabel,
} from "../services/place-of-service-resolver";

const RANGE = { from: "2026-03-01", to: "2026-03-31" };
const home = (from = "2026-01-01", to: string | null = null): M23ResidenceSpan => ({
  kind: "home",
  facilityId: null,
  effectiveFrom: from,
  effectiveTo: to,
});
const fac = (id: string, from = "2026-01-01", to: string | null = null): M23ResidenceSpan => ({
  kind: "facility",
  facilityId: id,
  effectiveFrom: from,
  effectiveTo: to,
});
const kinds = (k: Record<string, M23FacilityKind>) => new Map(Object.entries(k));

describe("resolvePlaceOfServiceLabel — mapping table (target: POS_BY_QCODE)", () => {
  it("every mapped facility kind targets a Q-code that exists in POS_BY_QCODE", () => {
    for (const q of Object.values(QCODE_BY_FACILITY_KIND)) {
      expect(POS_BY_QCODE[q as string]).toBeDefined();
    }
  });

  it("home -> Q5001 label", () => {
    expect(resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [home()], new Map())).toBe(
      POS_BY_QCODE.Q5001,
    );
  });

  it.each([
    ["alf", "Q5002"],
    ["nf", "Q5003"],
    ["snf", "Q5004"],
    ["hospital", "Q5005"],
    ["ipu", "Q5006"],
    ["ltch", "Q5007"],
    ["psych", "Q5008"],
  ] as const)("facility kind %s -> %s", (kind, q) => {
    expect(
      resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [fac("f1")], kinds({ f1: kind })),
    ).toBe(POS_BY_QCODE[q]);
  });

  it.each(["clinic", "other"] as const)(
    "facility kind %s is NOT mapped (null -> Q5009)",
    (kind) => {
      expect(
        resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [fac("f1")], kinds({ f1: kind })),
      ).toBeNull();
    },
  );

  it("nf and snf resolve to DIFFERENT labels (the 0183 conflation fix)", () => {
    const nf = resolvePlaceOfServiceLabel(
      RANGE,
      ["routine_home_care"],
      [fac("f")],
      kinds({ f: "nf" }),
    );
    const snf = resolvePlaceOfServiceLabel(
      RANGE,
      ["routine_home_care"],
      [fac("f")],
      kinds({ f: "snf" }),
    );
    expect(nf).not.toBe(snf);
  });

  it("mailing / temporary / prior addresses and a facility with no/unknown facility are null", () => {
    for (const kind of ["mailing", "temporary", "prior"] as const) {
      expect(
        resolvePlaceOfServiceLabel(
          RANGE,
          ["routine_home_care"],
          [{ kind, facilityId: null, effectiveFrom: "2026-01-01", effectiveTo: null }],
          new Map(),
        ),
      ).toBeNull();
    }
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [{ kind: "facility", facilityId: null, effectiveFrom: "2026-01-01", effectiveTo: null }],
        new Map(),
      ),
    ).toBeNull();
    expect(
      resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [fac("gone")], new Map()),
    ).toBeNull();
  });
});

describe("resolvePlaceOfServiceLabel — level of care", () => {
  it("routine and continuous home care only: residence is the site of care", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care", "continuous_home_care"],
        [home()],
        new Map(),
      ),
    ).toBe("home");
  });
  it.each([["general_inpatient_care"], ["inpatient_respite_care"], ["UNKNOWN"]])(
    "any %s period -> null (residence is not the site)",
    (l) => {
      expect(
        resolvePlaceOfServiceLabel(RANGE, ["routine_home_care", l], [home()], new Map()),
      ).toBeNull();
    },
  );
  it("no LOC period -> null", () => {
    expect(resolvePlaceOfServiceLabel(RANGE, [], [home()], new Map())).toBeNull();
  });
});

describe("resolvePlaceOfServiceLabel — effective dating over a range", () => {
  it("no address history -> null", () => {
    expect(resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [], new Map())).toBeNull();
  });
  it("history starting after the range start (uncovered head) -> null", () => {
    expect(
      resolvePlaceOfServiceLabel(RANGE, ["routine_home_care"], [home("2026-03-05")], new Map()),
    ).toBeNull();
  });
  it("history ending before the range end (uncovered tail) -> null", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [home("2026-01-01", "2026-03-20")],
        new Map(),
      ),
    ).toBeNull();
  });
  it("a gap between two same-site spans -> null", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [home("2026-01-01", "2026-03-10"), home("2026-03-15")],
        new Map(),
      ),
    ).toBeNull();
  });
  it("contiguous same-site spans (ALF A -> ALF B) -> that site", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [fac("a", "2026-01-01", "2026-03-14"), fac("b", "2026-03-15")],
        kinds({ a: "alf", b: "alf" }),
      ),
    ).toBe(POS_BY_QCODE.Q5002);
  });
  it("a move home -> ALF INSIDE the range -> null (one claim-level Q-code cannot be honest)", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [home("2026-01-01", "2026-03-14"), fac("a", "2026-03-15")],
        kinds({ a: "alf" }),
      ),
    ).toBeNull();
  });
  it("a move that ended BEFORE the range does not matter (only overlapping spans are passed)", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [fac("a", "2026-02-01")],
        kinds({ a: "snf" }),
      ),
    ).toBe(POS_BY_QCODE.Q5004);
  });
  it("a shared boundary day (prior ends the day the next starts) is tolerated", () => {
    expect(
      resolvePlaceOfServiceLabel(
        RANGE,
        ["routine_home_care"],
        [home("2026-01-01", "2026-03-15"), home("2026-03-15")],
        new Map(),
      ),
    ).toBe("home");
  });
});

describe("resolvePlaceOfService (ports)", () => {
  it("skips both port reads when the level of care makes residence irrelevant", async () => {
    let calls = 0;
    const ports = {
      residence: {
        residencesBetween: async () => {
          calls++;
          return [home()];
        },
      },
      facilityKinds: {
        kindsFor: async () => {
          calls++;
          return new Map<string, M23FacilityKind>();
        },
      },
    };
    expect(
      await resolvePlaceOfService(ports, "o", "p", RANGE, ["general_inpatient_care"]),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("does not call the facility reader for a home-only history", async () => {
    let kindCalls = 0;
    const ports = {
      residence: { residencesBetween: async () => [home()] },
      facilityKinds: {
        kindsFor: async () => {
          kindCalls++;
          return new Map<string, M23FacilityKind>();
        },
      },
    };
    expect(await resolvePlaceOfService(ports, "o", "p", RANGE, ["routine_home_care"])).toBe("home");
    expect(kindCalls).toBe(0);
  });

  it("resolves through both ports for a facility residence", async () => {
    const ports = {
      residence: { residencesBetween: async () => [fac("f9")] },
      facilityKinds: { kindsFor: async () => kinds({ f9: "ltch" }) },
    };
    expect(await resolvePlaceOfService(ports, "o", "p", RANGE, ["continuous_home_care"])).toBe(
      POS_BY_QCODE.Q5007,
    );
  });
});
