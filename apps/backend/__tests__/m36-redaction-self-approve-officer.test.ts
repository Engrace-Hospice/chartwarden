// WP 5.6 (ADR-0055 D9 / ADR-0086, PROVISIONAL): the single-officer fallback lets the sole eligible officer approve their OWN request. A requester
// who is NOT that officer (they reach the route through a path the holder reader does not count) must be refused, not waved through because
// "exactly one approver exists". Unit level: the tenant transaction is faked; the live suite proves the same against real Postgres.
import { describe, expect, it, vi } from "vitest";

const update = vi.fn();
const row = {
  id: "r1",
  organizationId: "o1",
  messageId: "m1",
  requestedBy: "requester",
  approvedAt: null,
  selfApprovedAt: null,
  countersignDeadlineAt: null,
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

const actor = { organizationId: "o1", userId: "requester", auditContext: {} as never };
const service = (approvers: readonly string[]) =>
  createMessageRedactionService({
    db: {} as never,
    activeHolds: async () => [],
    singleOfficerFallback: {
      enabled: async () => true,
      eligibleApprovers: async () => new Set(approvers),
    },
  });

describe("self-approval needs the requester to BE the sole eligible officer", () => {
  it("refuses with REDACTION_FALLBACK_UNAVAILABLE and writes nothing when the one eligible approver is someone else", async () => {
    update.mockClear();
    await expect(service(["someone-else"]).selfApprove(actor, "r1")).rejects.toMatchObject({
      code: "REDACTION_FALLBACK_UNAVAILABLE",
      statusCode: 403,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("passes the gate when the requester is the single eligible approver", async () => {
    update.mockClear();
    update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
    // The fake update returns no row => 409; reaching it proves the officer gate was passed.
    await expect(service(["requester"]).selfApprove(actor, "r1")).rejects.toMatchObject({
      code: "REDACTION_ALREADY_APPROVED",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("countersign does not require the countersigner to be the officer", () => {
  it("still gates only on the fallback being open (exactly one eligible approver)", async () => {
    update.mockClear();
    const countersigning = {
      ...row,
      selfApprovedAt: new Date(Date.now() - 3_600_000),
      countersignDeadlineAt: new Date(Date.now() + 3_600_000),
    };
    Object.assign(row, countersigning);
    update.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => ({ catch: async () => [] }) }) }),
    });
    await expect(
      service(["requester"]).countersign({ ...actor, userId: "counter" }, "r1"),
    ).rejects.toMatchObject({ code: "REDACTION_NOT_AWAITING_COUNTERSIGN" });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
