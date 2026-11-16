// Group g2: what `formatTargetDate` does with a value that is exactly midnight UTC. A date column serializes a date that way, and a
// clinician's own datetime-local entry of 8:00 PM EDT (zero seconds) is sent as the same string, so the two cannot be told apart.
// This pins the CHOSEN behaviour (the stored calendar day wins) so a change to it is deliberate; the ambiguity itself is a product
// call (see the doc comment on `formatTargetDate`). A US zone BEFORE any Date is built.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/New_York";

import { afterAll, describe, expect, it } from "vitest";
import { formatInstantDateTime, formatTargetDate } from "../hope-format";

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});

describe("formatTargetDate at exactly midnight UTC", () => {
  it("shows the stored calendar day, even for an instant a clinician entered as the previous evening", () => {
    // 8:00 PM EDT on Sep 8 is 2026-09-09T00:00:00.000Z: indistinguishable from the date column's Sep 9.
    expect(formatTargetDate("2026-09-09T00:00:00.000Z")).toBe("Sep 9, 2026");
    expect(formatTargetDate("2026-09-09")).toBe("Sep 9, 2026");
  });

  it("shows any other instant on the viewer's own day", () => {
    expect(formatTargetDate("2026-09-09T00:01:00.000Z")).toBe("Sep 8, 2026");
    expect(formatTargetDate("2026-09-09T00:00:00.001Z")).toBe("Sep 8, 2026");
  });
});

describe("formatInstantDateTime", () => {
  it("shows an instant as the viewer's own date and time", () => {
    expect(formatInstantDateTime("2026-09-12T01:30:00.000Z")).toBe("2026-09-11 21:30");
  });

  it("returns what it cannot read, and nothing for none", () => {
    expect(formatInstantDateTime("not a date")).toBe("not a date");
    expect(formatInstantDateTime(null)).toBe("");
    expect(formatInstantDateTime(undefined)).toBe("");
    expect(formatInstantDateTime("")).toBe("");
  });
});
