import { describe, expect, it } from "vitest";
import { assertKindWritable } from "./immutable-kinds";

describe("assertKindWritable", () => {
  it("refuses the signed BAA kind with 409 DOCUMENT_IMMUTABLE", () => {
    expect(() => assertKindWritable("tenant_baa")).toThrowError(
      expect.objectContaining({ statusCode: 409, code: "DOCUMENT_IMMUTABLE" }),
    );
  });

  it("lets every other kind through", () => {
    for (const kind of [
      "other",
      "election_statement",
      "intake_source",
      "referral",
      "consent_record",
    ]) {
      expect(() => assertKindWritable(kind)).not.toThrow();
    }
  });
});
