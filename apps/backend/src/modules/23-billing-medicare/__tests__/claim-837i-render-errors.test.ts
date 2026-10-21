// M23 — render837i turns ANY X12BuildError (the base class, e.g. a refusal raised only by the Stedi-JSON builder)
// into a field-name-only gap, so a validation the raw builder does not share can never crash the loader.
import { afterEach, describe, expect, it, vi } from "vitest";

const thrown = vi.hoisted(() => ({ makeError: null as null | (() => Error) }));

vi.mock("@chartwarden/x12-837-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/x12-837-client")>();
  return {
    ...actual,
    build837iClaim: () => "ISA~",
    buildStediClaimJson: () => {
      throw thrown.makeError?.() ?? new actual.X12BuildError("subscriber.address.state");
    },
  };
});

import { render837i } from "../services/claim-837i-mapper";

describe("render837i", () => {
  afterEach(() => {
    thrown.makeError = null;
  });

  it("reports a base X12BuildError as an invalid-field gap (name only, never a value)", () => {
    const r = render837i({} as never);
    expect(r).toEqual({
      ok: false,
      gaps: [{ field: "subscriber.address.state", reason: "invalid" }],
    });
  });

  it("rethrows an error that is not an X12BuildError", () => {
    thrown.makeError = () => new TypeError("boom");
    expect(() => render837i({} as never)).toThrow(TypeError);
  });
});
