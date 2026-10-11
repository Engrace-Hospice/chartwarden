// M25 — a clearinghouse-stage rejection (ADR-0053 D2) is an edit failure before the payer saw the claim: it must not
// seed the payer-denial worklist. A payer-stage or 999 rejection still does.
import { describe, expect, it, vi } from "vitest";
import { buildM23ClaimRejectedConsumer } from "../src/modules/25-remittance/outbox-consumers/m23-claim-rejected";

function build() {
  const seedDenial = vi.fn(async () => null);
  const resolve = vi.fn(async () => "pe-1");
  const consumer = buildM23ClaimRejectedConsumer({
    db: {} as never,
    seedStore: { seedDenial } as never,
    outbox: { publish: vi.fn() } as never,
    resolveProviderEntityForClaim: resolve,
  });
  return { consumer, seedDenial, resolve };
}

const event = (rejectionStage: string) => ({
  organizationId: "org-1",
  createdAt: new Date("2026-10-09T12:00:00Z"),
  payload: {
    claimId: "claim-1",
    acknowledgmentId: "ack-1",
    rejectionStage,
    rejectionCodes: ["A7:21"],
  },
});

describe("m23.claim.rejected → denial seed, by stage", () => {
  it("skips a clearinghouse-stage rejection without touching the worklist", async () => {
    const { consumer, seedDenial, resolve } = build();
    await consumer.handle(event("clearinghouse"));
    expect(resolve).not.toHaveBeenCalled();
    expect(seedDenial).not.toHaveBeenCalled();
  });

  it.each(["999", "277ca"])("still seeds on a %s rejection", async (stage) => {
    const { consumer, resolve } = build();
    await consumer.handle(event(stage)).catch(() => undefined);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
