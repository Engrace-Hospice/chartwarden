import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAndRender837i = vi.fn();
vi.mock("../services/claim-837i-loader", () => ({
  loadAndRender837i: (...a: unknown[]) => loadAndRender837i(...a),
  buildClaim837iPersistencePort: () => ({ persistence: true }),
}));

import { renderClaimForTransport } from "../services/claim-837i-submit";

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
  interchangeNumberFor: async () => 4242,
  now: new Date("2026-01-02T00:00:00Z"),
};

describe("renderClaimForTransport", () => {
  beforeEach(() => loadAndRender837i.mockReset());

  it("returns both renderings, loading under the attempt's control number and the interchange number the caller allocated", async () => {
    loadAndRender837i.mockResolvedValue({
      ok: true,
      rendered: { reveal: () => ({ x12: "ISA*00~", stediJson: { j: 1 } }) },
    });

    const rendered = await renderClaimForTransport(ARGS);

    expect(rendered).toEqual({ x12: "ISA*00~", stediJson: { j: 1 } });
    expect(loadAndRender837i.mock.calls[0]?.[1]).toMatchObject({
      claimId: "claim-1",
      context: CONTEXT,
      claimControlNumber: "ABC123260101000a1b2c3",
      interchangeControlNumber: 4242,
    });
  });

  it("asks the caller for the number with the context it resolved, and never derives one itself", async () => {
    loadAndRender837i.mockResolvedValue({
      ok: true,
      rendered: { reveal: () => ({ x12: "ISA*00~" }) },
    });
    const interchangeNumberFor = vi.fn(async () => 7);

    await renderClaimForTransport({ ...ARGS, interchangeNumberFor });

    expect(interchangeNumberFor).toHaveBeenCalledExactlyOnceWith(CONTEXT);
    expect(loadAndRender837i.mock.calls[0]?.[1]).toMatchObject({ interchangeControlNumber: 7 });
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
