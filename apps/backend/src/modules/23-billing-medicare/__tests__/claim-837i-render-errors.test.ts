// M23 — a Stedi-only builder refusal must not block a valid raw-X12 Claim.MD claim. The Stedi transport boundary
// separately refuses submission when this optional representation is absent.
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

  it("keeps valid raw X12 when only the Stedi representation refuses the input", () => {
    const r = render837i({} as never);
    expect(r).toEqual({
      ok: true,
      value: { x12: "ISA~" },
    });
  });

  it("rethrows an error that is not an X12BuildError", () => {
    thrown.makeError = () => new TypeError("boom");
    expect(() => render837i({} as never)).toThrow(TypeError);
  });
});
