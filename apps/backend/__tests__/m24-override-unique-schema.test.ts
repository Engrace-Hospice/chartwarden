import { schema } from "@chartwarden/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

describe("M24 validation override schema mirror (#809)", () => {
  it("declares medicaid_validation_override_unique_per_result as a UNIQUE index, matching migration 0093", () => {
    const idx = getTableConfig(schema.medicaidValidationOverride).indexes.find(
      (i) => i.config.name === "medicaid_validation_override_unique_per_result",
    );
    expect(idx?.config.unique).toBe(true);
  });
});
