// WP 5.6 (ADR-0055 D9, PROVISIONAL): a countersign completes a fallback row only while the single-officer fallback is still open. The tenant
// setting turned off (or a second officer added) between the self-approval and the countersign must refuse it with REDACTION_FALLBACK_UNAVAILABLE
// and never reach the UPDATE. Unit level: the tenant transaction is faked; the live suite proves the same against real Postgres.
import { describe, expect, it, vi } from "vitest";

const update = vi.fn();
const row = {
  id: "r1",
  organizationId: "o1",
  messageId: "m1",
  requestedBy: "officer",
  approvedAt: null,
  selfApprovedAt: new Date(Date.now() - 3_600_000),
  countersignDeadlineAt: new Date(Date.now() + 3_600_000),
  countersignedBy: null,
};
const fakeTx = {
  select: () => ({
    from: () => ({ where: () => ({ for: () => ({ limit: async () => [row] }) }) }),
  }),
  update,
};
vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx),
}));

import { createMessageRedactionService } from "../src/modules/36-messaging/governance/message-redaction-service";

const actor = { organizationId: "o1", userId: "admin", auditContext: {} as never };
const service = (enabled: boolean, approvers: number) =>
  createMessageRedactionService({
    db: {} as never,
    activeHolds: async () => [],
    singleOfficerFallback: {
      enabled: async () => enabled,
      eligibleApprovers: async () =>
        new Set(Array.from({ length: approvers }, (_, i) => `officer-${i}`)),
    },
  });

describe("countersign is gated like the self-approval", () => {
  it.each([
    ["the tenant setting is off", false, 1],
    ["a second officer exists", true, 2],
    ["nobody can approve", true, 0],
  ])(
    "refuses with REDACTION_FALLBACK_UNAVAILABLE and writes nothing when %s",
    async (_n, enabled, approvers) => {
      update.mockClear();
      await expect(service(enabled, approvers).countersign(actor, "r1")).rejects.toMatchObject({
        code: "REDACTION_FALLBACK_UNAVAILABLE",
        statusCode: 403,
      });
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("refuses when the fallback is not bound at all", async () => {
    update.mockClear();
    const bare = createMessageRedactionService({ db: {} as never, activeHolds: async () => [] });
    await expect(bare.countersign(actor, "r1")).rejects.toMatchObject({
      code: "REDACTION_FALLBACK_UNAVAILABLE",
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe("countersign at the 72 h deadline (app and database clocks disagree)", () => {
  const lapsedByTrigger = Object.assign(
    new Error("message_redaction_lapsed: the countersign period has passed"),
    { code: "23514" },
  );
  const failingUpdate = (error: unknown) => ({
    set: () => ({ where: () => ({ returning: () => Promise.reject(error) }) }),
  });

  it("maps the trigger's message_redaction_lapsed check violation (also when wrapped) to 409 REDACTION_COUNTERSIGN_LAPSED", async () => {
    for (const error of [lapsedByTrigger, new Error("query failed", { cause: lapsedByTrigger })]) {
      update.mockReset();
      update.mockReturnValue(failingUpdate(error));
      await expect(service(true, 1).countersign(actor, "r1")).rejects.toMatchObject({
        code: "REDACTION_COUNTERSIGN_LAPSED",
        statusCode: 409,
      });
    }
  });

  it("does not hide other database errors", async () => {
    update.mockReset();
    update.mockReturnValue(failingUpdate(Object.assign(new Error("boom"), { code: "23514" })));
    await expect(service(true, 1).countersign(actor, "r1")).rejects.toThrow("boom");
  });
});
