import { ConflictError, NotFoundError } from "@wardenx/types";
import { InMemoryAttemptStore, attemptReservationFixture, scopeKey } from "@wardenx/x12-837-client";
import { describe, expect, it } from "vitest";
import { buildClearinghouseAttemptResolutionService } from "./clearinghouse-attempt-resolution-service";

const IDS = { orgA: "org-a", orgB: "org-b", providerEntityA: "pe-a", providerEntityB: "pe-b" };
const ACTOR = { organizationId: "org-a", userId: "user-1" };
const FIRST = "2026-10-11T10:00:00.000Z";
const scope = scopeKey({ organizationId: "org-a", providerEntityId: "pe-a", usage: "test" });

async function setup(nowIso: string) {
  const attempts = new InMemoryAttemptStore();
  await attempts.reserve(attemptReservationFixture(IDS, { scope, firstReservedAt: FIRST }));
  const service = buildClearinghouseAttemptResolutionService(attempts, () => new Date(nowIso));
  return { attempts, service };
}
const input = { providerEntityId: "pe-a", usage: "test" as const, idempotencyKey: "idem-1" };

describe("clearinghouse attempt resolution", () => {
  it("settles a reservation past the vendor window as sent, with the operator's vendor id", async () => {
    const { service, attempts } = await setup("2026-10-13T10:00:00.000Z");
    const r = await service.resolveStale(ACTOR, {
      ...input,
      outcome: "sent",
      clearinghouseSubmissionId: "ch-found",
    });
    expect(r).toMatchObject({ status: "sent", clearinghouseSubmissionId: "ch-found" });
    expect((await attempts.find("org-a", scope, "idem-1"))?.status).toBe("sent");
  });

  it("settles it as released, freeing the control number", async () => {
    const { service, attempts } = await setup("2026-10-13T10:00:00.000Z");
    await service.resolveStale(ACTOR, { ...input, outcome: "released" });
    const again = await attempts.reserve(
      attemptReservationFixture(IDS, { scope, idempotencyKey: "idem-2" }),
    );
    expect(again.reserved).toBe(true);
  });

  it("refuses an attempt still inside the window: the transport owns it", async () => {
    const { service } = await setup("2026-10-11T11:00:00.000Z");
    await expect(service.resolveStale(ACTOR, { ...input, outcome: "released" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("refuses an attempt that is already settled, and one that does not exist", async () => {
    const { service } = await setup("2026-10-13T10:00:00.000Z");
    await service.resolveStale(ACTOR, { ...input, outcome: "released" });
    await expect(service.resolveStale(ACTOR, { ...input, outcome: "released" })).rejects.toThrow(
      NotFoundError,
    );
    await expect(
      service.resolveStale(ACTOR, { ...input, idempotencyKey: "nope", outcome: "released" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("cannot reach another tenant's attempt", async () => {
    const { service } = await setup("2026-10-13T10:00:00.000Z");
    await expect(
      service.resolveStale(
        { organizationId: "org-b", userId: "u" },
        { ...input, outcome: "released" },
      ),
    ).rejects.toThrow(NotFoundError);
  });
});
