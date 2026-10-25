import { describe, expect, it } from "vitest";
import { assembleErrorMessage } from "./claim-assembly-errors";

const GENERIC = "The claim could not be assembled. Check the inputs and try again.";

describe("assembleErrorMessage", () => {
  it.each([
    ["PROVIDER_ENTITY_UNRESOLVED", 422, /provider entity could not be found/],
    ["MAC_SUBMITTER_CREDENTIAL_MISSING", 422, /Billing → MAC Credentials/],
    ["WAGE_INDEX_UNAVAILABLE", 422, /wage-index factor/],
    ["RATE_TABLE_MISSING", 422, /hospice rate table/],
    ["RATE_TABLE_LABOR_SHARE_MISSING", 422, /labor shares/],
    ["SEQUESTRATION_POLICY_UNAVAILABLE", 422, /Sequestration Policy/],
    ["CHC_HOURS_UNPRICEABLE", 422, /Continuous home care/],
    ["VALIDATION_FAILED", 422, /service-to date/],
    ["AI_ACTOR_FORBIDDEN", 403, /AI actor/],
    ["NON_MEDICARE_PRIMARY_PAYER", 409, /not Medicare/],
    ["MEDICARE_ADVANTAGE_NEEDS_ORIGINAL_MEDICARE_COVERAGE", 409, /Original Medicare/],
  ])("maps %s to a specific, actionable message", (code, status, expected) => {
    const message = assembleErrorMessage(code, status);
    expect(message).toMatch(expected);
    expect(message).not.toBe(GENERIC);
  });

  it("falls back on the HTTP status for an unknown code", () => {
    expect(assembleErrorMessage("SOMETHING_NEW", 503)).toMatch(/unavailable/);
    expect(assembleErrorMessage(undefined, 403)).toMatch(/do not have scope/);
    expect(assembleErrorMessage(undefined, 500)).toBe(GENERIC);
  });
});
