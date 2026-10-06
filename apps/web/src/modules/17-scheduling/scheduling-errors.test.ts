import { describe, expect, it } from "vitest";
import { mapSchedulingApiError } from "./scheduling-errors";

describe("scheduling error mapping", () => {
  it("maps a backend reason validation detail to a field error", () => {
    const mapped = mapSchedulingApiError(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "request validation failed",
          details: [
            {
              field: "reason",
              message: "Expected string length greater or equal to 20",
            },
          ],
        },
      },
      422,
    );
    expect(mapped.fieldErrors.reason).toBe(
      "Please enter at least 20 characters.",
    );
    expect(mapped.message).not.toContain("request validation failed");
  });
  it("never exposes credential predicate names", () => {
    const mapped = mapSchedulingApiError(
      {
        error: {
          message: "abac predicate 'clinician_credentials_active' denied",
        },
      },
      403,
    );
    expect(mapped.message).toBe(
      "This clinician does not have an active clinical credential for the selected visit date.",
    );
    expect(mapped.message).not.toContain("clinician_credentials_active");
  });
});
