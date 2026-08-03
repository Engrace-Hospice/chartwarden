// task-15 — the M6 admission-event applier binding's structural invariants (the pure decision core
// `decideAdmissionEvent` has its own suite; this covers the consumer wrapper's fail directions).
import { describe, expect, it } from "vitest";
import { buildM6ProposalAcceptedConsumer } from "../src/modules/06-admission/outbox-consumers/live-binding";

const ORG = "00000000-0000-4000-9000-000000000001";

describe("m6.admission-event-applier binding", () => {
  it("skips m5-owned payloads without judging their shape (multi-consumer retry idempotency)", async () => {
    const consumer = buildM6ProposalAcceptedConsumer(); // depless — would throw on any m6 payload
    await expect(
      consumer.handle({ organizationId: ORG, payload: { ownerModule: "m5", garbage: true } }),
    ).resolves.toBeUndefined();
  });

  it("dead-letters m6-owned payloads when constructed without deps (never a silent completion)", async () => {
    const consumer = buildM6ProposalAcceptedConsumer();
    await expect(
      consumer.handle({ organizationId: ORG, payload: { ownerModule: "m6" } }),
    ).rejects.toThrow(/cannot execute|dead-lettering/);
  });

  it("throws on a cross-tenant payload org (refusing a cross-tenant apply)", async () => {
    const consumer = buildM6ProposalAcceptedConsumer({
      gateway: {
        resolveFacts: async () => {
          throw new Error("unreachable — parse must refuse first");
        },
        recordRefusal: async () => {
          throw new Error("unreachable");
        },
      } as never,
    });
    await expect(
      consumer.handle({
        organizationId: ORG,
        payload: {
          ownerModule: "m6",
          proposalId: "p-1",
          organizationId: "00000000-0000-4000-9000-00000000dead",
          resourceKind: "discharge_event",
        },
      }),
    ).rejects.toThrow(/cross-tenant|malformed/);
  });
});
