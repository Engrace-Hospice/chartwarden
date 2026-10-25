import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAndRender837i = vi.fn();
vi.mock("../services/claim-837i-loader", () => ({
  loadAndRender837i: (...a: unknown[]) => loadAndRender837i(...a),
  buildClaim837iPersistencePort: () => ({ persistence: true }),
}));

import { interchangeNumberFor, renderClaimForTransport } from "../services/claim-837i-submit";

const CONTEXT = {
  organizationId: "o",
  providerEntityId: "p",
  usage: "test",
} as ClearinghouseContext;
const ARGS = {
  tx: {} as never,
  deps: { parties: () => ({}) } as never,
  contextFor: async () => CONTEXT,
  organizationId: "o",
  claim: { id: "claim-1", providerEntityId: "p" },
  claimControlNumber: "ABC123260101000a1b2c3",
  now: new Date("2026-01-02T00:00:00Z"),
};

describe("interchangeNumberFor", () => {
  it("is deterministic and within ISA13's 1..999999999", () => {
    const n = interchangeNumberFor("ABC123260101000a1b2c3");

    expect(interchangeNumberFor("ABC123260101000a1b2c3")).toBe(n);
    expect(Number.isInteger(n) && n >= 1 && n <= 999_999_999).toBe(true);
  });

  it("differs between attempts of one claim", () => {
    expect(interchangeNumberFor("ABC123260101000a1b2c3")).not.toBe(
      interchangeNumberFor("ABC123260101010a1b2c3"),
    );
  });
});

describe("renderClaimForTransport", () => {
  beforeEach(() => loadAndRender837i.mockReset());

  it("returns the rendered X12, loading under the attempt's control number and a derived interchange number", async () => {
    loadAndRender837i.mockResolvedValue({
      ok: true,
      rendered: { reveal: () => ({ x12: "ISA*00~" }) },
    });

    const x12 = await renderClaimForTransport(ARGS);

    expect(x12).toBe("ISA*00~");
    expect(loadAndRender837i.mock.calls[0]?.[1]).toMatchObject({
      claimId: "claim-1",
      context: CONTEXT,
      claimControlNumber: "ABC123260101000a1b2c3",
      interchangeControlNumber: interchangeNumberFor("ABC123260101000a1b2c3"),
    });
  });

  it("throws naming every gap (field and reason only)", async () => {
    loadAndRender837i.mockResolvedValue({
      ok: false,
      kind: "gaps",
      gaps: [
        { field: "submitter", reason: "missing" },
        { field: "billingProvider", reason: "missing" },
      ],
    });

    await expect(renderClaimForTransport(ARGS)).rejects.toThrow(
      "claim claim-1 837I is not sendable: submitter (missing), billingProvider (missing)",
    );
  });

  it("throws when the claim is not found for the organization and provider entity", async () => {
    loadAndRender837i.mockResolvedValue({ ok: false, kind: "claim_not_found" });

    await expect(renderClaimForTransport(ARGS)).rejects.toThrow("claim not found");
  });
});
