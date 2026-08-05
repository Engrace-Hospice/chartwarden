import { describe, expect, it } from "vitest";
import { buildM34ProvisionStartedConsumer } from "./provision-started";

describe("M34 provision outbox bridge", () => {
  it("validates and enqueues the complete provision contract", async () => {
    const calls: unknown[] = [];
    const consumer = buildM34ProvisionStartedConsumer({
      async enqueue(...args) {
        calls.push(args);
      },
    });
    const payload = {
      tenantAccountId: "tenant-1",
      organizationId: "org-1",
      legalBusinessName: "Hospice One",
      billingContactEmail: "billing@example.org",
      firstAdminEmail: "admin@example.org",
      firstAdminFullName: "Admin One",
      actorMembershipId: "membership-1",
      transitionReason: "approved by platform operations",
    };
    await consumer.handle({
      id: "event-1",
      organizationId: "org-1",
      eventType: "m34.tenant.provision_started",
      aggregateKind: "tenant_account",
      aggregateId: "tenant-1",
      payload,
      attemptCount: 1,
      createdAt: new Date(),
    });
    expect(calls).toEqual([["tenant-1", payload]]);
  });
});
