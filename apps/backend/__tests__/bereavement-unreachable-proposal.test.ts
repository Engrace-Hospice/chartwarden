import { describe, expect, it } from "vitest";
import { unreachableProposalOf } from "../src/modules/16-bereavement/routes/read-service";

describe("unreachableProposalOf", () => {
  const STAMP = new Date("2026-10-01T12:00:00.000Z");

  it("is not proposed when the detector has not stamped the contact", () => {
    expect(unreachableProposalOf({ status: "active", unreachableProposedThroughAt: null })).toEqual(
      { unreachableProposed: false, unreachableProposedAt: null },
    );
  });

  it("is proposed with the stamp instant while the contact is still active", () => {
    expect(
      unreachableProposalOf({ status: "active", unreachableProposedThroughAt: STAMP }),
    ).toEqual({ unreachableProposed: true, unreachableProposedAt: "2026-10-01T12:00:00.000Z" });
  });

  it("accepts a string stamp from the driver", () => {
    expect(
      unreachableProposalOf({
        status: "active",
        unreachableProposedThroughAt: "2026-10-01T12:00:00Z",
      }).unreachableProposedAt,
    ).toBe("2026-10-01T12:00:00.000Z");
  });

  it("stops proposing once the counselor has marked the contact unreachable", () => {
    expect(
      unreachableProposalOf({ status: "unreachable", unreachableProposedThroughAt: STAMP }),
    ).toEqual({ unreachableProposed: false, unreachableProposedAt: null });
  });

  it("is not proposed while the counselor's dismissal covers the stamped strike", () => {
    expect(
      unreachableProposalOf({
        status: "active",
        unreachableProposedThroughAt: STAMP,
        unreachableProposalDismissedAt: STAMP,
      }),
    ).toEqual({ unreachableProposed: false, unreachableProposedAt: null });
  });

  it("proposes again once a strictly newer strike re-stamps past the dismissal", () => {
    expect(
      unreachableProposalOf({
        status: "active",
        unreachableProposedThroughAt: new Date("2026-10-02T12:00:00.000Z"),
        unreachableProposalDismissedAt: STAMP,
      }),
    ).toEqual({ unreachableProposed: true, unreachableProposedAt: "2026-10-02T12:00:00.000Z" });
  });
});
