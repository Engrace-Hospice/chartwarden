// F-238 — the per-document identity check: does each document in a fax belong to the patient (or the
// referral) it is filed under? Two identifiers (DOB + name); OCR-tolerant; never confirms on one.
import {
  compareIdentity,
  normaliseDob,
  splitFullName,
  worstIdentity,
} from "@chartwarden/intake-extraction";
import { describe, expect, it } from "vitest";

const ARTHUR = { lastName: "Doclens", firstName: "Arthur", dateOfBirth: "1941-03-02" };

describe("identity check", () => {
  it("reads DOBs the way referral documents write them", () => {
    expect(normaliseDob("03/02/1941")).toBe("1941-03-02");
    expect(normaliseDob("3/2/41")).toBe("1941-03-02");
    expect(normaliseDob("1941-03-02")).toBe("1941-03-02");
    expect(normaliseDob("March 2, 1941")).toBe("1941-03-02");
    expect(normaliseDob("13/45/1941")).toBeNull();
  });

  it("splits a referral's name-at-receipt either way round", () => {
    expect(splitFullName("DOCLENS, ARTHUR J")).toEqual({
      lastName: "DOCLENS",
      firstName: "ARTHUR",
    });
    expect(splitFullName("Arthur Doclens")).toEqual({ lastName: "Doclens", firstName: "Arthur" });
  });

  it("matches on DOB + last name, tolerating one OCR slip and an initial", () => {
    expect(
      compareIdentity(
        { lastName: "DOCLENS", firstName: "ARTHUR", dateOfBirth: "03/02/1941" },
        ARTHUR,
      ).status,
    ).toBe("match");
    // The packet's wound note really reads "DICLENS".
    expect(
      compareIdentity(
        { lastName: "DICLENS", firstName: "ARTHUR", dateOfBirth: "03/02/1941" },
        ARTHUR,
      ).status,
    ).toBe("match");
    expect(
      compareIdentity({ lastName: "Doclens", firstName: "A.", dateOfBirth: "3/2/41" }, ARTHUR)
        .status,
    ).toBe("match");
  });

  it("same DOB, different surname or first name → possible (married name, wrong chart) — never a match", () => {
    expect(
      compareIdentity(
        { lastName: "Whitfield", firstName: "Arthur", dateOfBirth: "03/02/1941" },
        ARTHUR,
      ),
    ).toEqual({ status: "possible", disagreeing: ["lastName"] });
    expect(
      compareIdentity({ lastName: "Doclens", firstName: "Mae", dateOfBirth: "03/02/1941" }, ARTHUR),
    ).toEqual({ status: "possible", disagreeing: ["firstName"] });
  });

  it("same name, DOB one slip or a day/month swap away → possible; a different DOB → mismatch", () => {
    expect(
      compareIdentity(
        { lastName: "Doclens", firstName: "Arthur", dateOfBirth: "02/03/1941" },
        ARTHUR,
      ).status,
    ).toBe("possible");
    expect(
      compareIdentity(
        { lastName: "Doclens", firstName: "Arthur", dateOfBirth: "03/02/1947" },
        ARTHUR,
      ).status,
    ).toBe("possible");
    expect(
      compareIdentity(
        { lastName: "Doclens", firstName: "Arthur", dateOfBirth: "11/19/1950" },
        ARTHUR,
      ),
    ).toEqual({ status: "mismatch", disagreeing: ["dateOfBirth"] });
    expect(
      compareIdentity({ lastName: "Vance", firstName: "Ada", dateOfBirth: "11/19/1950" }, ARTHUR)
        .status,
    ).toBe("mismatch");
  });

  it("one identifier never confirms: DOB only or name only is unverified; a different name alone refutes", () => {
    expect(compareIdentity({ dateOfBirth: "03/02/1941" }, ARTHUR).status).toBe("unverified");
    expect(compareIdentity({ lastName: "Doclens", firstName: "Arthur" }, ARTHUR).status).toBe(
      "unverified",
    );
    expect(compareIdentity({}, ARTHUR).status).toBe("unverified");
    expect(compareIdentity({ lastName: "Vance" }, ARTHUR)).toEqual({
      status: "mismatch",
      disagreeing: ["lastName"],
    });
  });

  it("a short surname needs to be exact (one letter makes another name)", () => {
    expect(
      compareIdentity(
        { lastName: "Lee", dateOfBirth: "03/02/1941" },
        { ...ARTHUR, lastName: "Lew" },
      ).status,
    ).toBe("possible");
  });

  it("a batch shows its worst document", () => {
    expect(worstIdentity(["match", "unverified", "possible"])).toBe("possible");
    expect(worstIdentity(["match", "mismatch", "possible"])).toBe("mismatch");
    expect(worstIdentity([])).toBeNull();
  });
});
