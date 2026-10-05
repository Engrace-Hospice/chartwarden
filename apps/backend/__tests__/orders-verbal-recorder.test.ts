// apps/backend/__tests__/orders-verbal-recorder.test.ts — M11 §2.2 `recordVerbal`: "recording actor is RN+".
// The recorder RECEIVES an order a prescriber gave, so eligibility is a seniority floor and is independent
// of the order kind (an RN may record a verbal lab order that she could not author herself).
import { describe, expect, it } from "vitest";
import { isVerbalRecorderDiscipline } from "../src/modules/11-orders/routes/server-derived-facts";

describe("isVerbalRecorderDiscipline — RN+ floor (spec §2.2), kind-independent", () => {
  it.each(["rn", "RN", " rn_case_manager ", "np", "pa", "md", "physician", "hospice_physician"])(
    "%s may record a verbal order",
    (discipline) => {
      expect(isVerbalRecorderDiscipline(discipline)).toBe(true);
    },
  );

  it.each(["lpn", "chha", "msw", "chaplain", "volunteer", "clinician", ""])(
    "%s is below the floor",
    (discipline) => {
      expect(isVerbalRecorderDiscipline(discipline)).toBe(false);
    },
  );
});
