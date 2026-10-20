// Finding 8: `ageFromDob` parsed the date-only DOB as a UTC instant, so in a US zone a patient whose
// birthday is TOMORROW read as already having had it (one year too old).
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { afterAll, describe, expect, it } from "vitest";
import { ageFromDob } from "./patient-status";

const pad = (n: number): string => String(n).padStart(2, "0");
const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

describe("ageFromDob", () => {
  it("counts a birthday tomorrow as not yet reached", () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear() - 40, now.getMonth(), now.getDate() + 1);
    expect(ageFromDob(localDate(tomorrow))).toBe(39);
  });

  it("counts a birthday today as reached", () => {
    const now = new Date();
    expect(
      ageFromDob(localDate(new Date(now.getFullYear() - 40, now.getMonth(), now.getDate()))),
    ).toBe(40);
  });

  it("returns null for an unparseable dob", () => {
    expect(ageFromDob("garbage")).toBeNull();
  });
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = ORIGINAL_TZ;
});
