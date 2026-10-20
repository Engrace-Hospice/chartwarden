import { describe, expect, it } from "vitest";
import { findByMarker, matchesDemoPatient } from "../db/cop27/refind";

describe("COP27 re-find", () => {
  it("finds a referral by its externalReferralId, not its name", () => {
    const items = [
      { id: "a", externalReferralId: "DEMO-COP27-02", patientNameAtReceipt: "Ivy Castellan" },
      { id: "b", externalReferralId: "DEMO-COP27-03", patientNameAtReceipt: "Ivy Castellan" },
    ];
    expect(findByMarker(items, "DEMO-COP27-03")?.id).toBe("b");
    expect(findByMarker(items, "DEMO-COP27-09")).toBeNull();
  });

  it("matches a directly-created patient on first + last name", () => {
    const spec = { firstName: "Julian", lastName: "Aldridge", marker: "DEMO-COP27-03" };
    expect(matchesDemoPatient({ firstName: "Julian", lastName: "Aldridge" }, spec)).toBe(true);
    expect(matchesDemoPatient({ firstName: "Julian", lastName: "Other" }, spec)).toBe(false);
  });

  it("still re-finds a patient created by the earlier scheme (marker as legal last name)", () => {
    const spec = { firstName: "Julian", lastName: "Aldridge", marker: "DEMO-COP27-03" };
    expect(matchesDemoPatient({ firstName: "Julian", lastName: "DEMO-COP27-03" }, spec)).toBe(true);
    expect(matchesDemoPatient({ firstName: "Julian", lastName: "DEMO-COP27-04" }, spec)).toBe(
      false,
    );
  });
});
