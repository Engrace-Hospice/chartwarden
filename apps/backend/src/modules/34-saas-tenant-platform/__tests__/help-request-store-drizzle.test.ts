import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { createDrizzleHelpRequestStore } from "../help/help-request-store-drizzle";

const ID = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-11-10T00:00:00.000Z");

const record = (status: "open" | "approved") => ({
  id: ID,
  organizationId: "33333333-3333-4333-8333-333333333333",
  tenantAccountId: "44444444-4444-4444-8444-444444444444",
  stepKey: null,
  message: "Please help with our enrollment setup",
  status,
  requestedByMembershipId: "55555555-5555-4555-8555-555555555555",
  requestedByUserId: "66666666-6666-4666-8666-666666666666",
  requestedAt: AT,
  cursorTs: "2026-11-10T00:00:00.000000Z",
  supportConsentGrantId: status === "approved" ? GRANT : null,
  approvedByMembershipId: status === "approved" ? "77777777-7777-4777-8777-777777777777" : null,
  approvedAt: status === "approved" ? AT : null,
  closedByActorKind: null,
  closedByUserId: null,
  closedAt: null,
  closeNote: null,
  messagePurgedAt: null,
  createdAt: AT,
  updatedAt: AT,
});

describe("the help-request store lock order", () => {
  it("retries when an open request becomes approved while waiting for its row lock", async () => {
    const snapshots = [record("open"), record("approved")];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [snapshots.shift()],
            for: async () => [],
          }),
        }),
      }),
    } as unknown as DbClient;

    await expect(createDrizzleHelpRequestStore(tx).findForUpdate(ID)).rejects.toMatchObject({
      code: "40001",
      severity: "ERROR",
    });
  });
});
