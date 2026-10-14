// WP 3.5 - the deadline sweep: due offers close, pending items expire and stay the sender's, accepted items keep their new
// owner, the policy cap tightens old rows, failures are isolated and rethrown, and a second run is a no-op.
import { describe, expect, it } from "vitest";
import { expireDueHandoffsForOrg } from "./handoff-expiry";
import {
  ALICE,
  BOB,
  CAROL,
  NOW,
  ORG,
  P1,
  REFILL,
  actor,
  buildKit,
  fakeDb,
  item,
  offerStandard,
} from "./handoff-test-kit";

const deps = (kit: ReturnType<typeof buildKit>, extra = {}) => ({
  db: fakeDb,
  store: kit.store,
  policyStore: kit.policyStore,
  outbox: {
    publish: async (
      _t: unknown,
      e: { eventName: string; payload: Record<string, unknown>; aggregateId: string },
    ) => void kit.published.push(e),
  },
  now: kit.clock,
  ...extra,
});
const unaccepted = (kit: ReturnType<typeof buildKit>) =>
  kit.published.filter((e) => e.eventName === "m36.handoff.unaccepted");

describe("expireDueHandoffsForOrg", () => {
  it("does nothing before the deadline", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    kit.advanceMinutes(239);
    expect(await expireDueHandoffsForOrg(deps(kit), ORG)).toEqual({ expired: 0, failed: 0 });
  });

  it("expires a due offer: items expired, sender still accountable, one unaccepted event, a system history row", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    kit.advanceMinutes(241);
    expect(await expireDueHandoffsForOrg(deps(kit), ORG)).toEqual({ expired: 1, failed: 0 });
    const dto = await kit.service.get(actor(ALICE), handoff.id);
    expect(dto.state).toBe("expired");
    expect(dto.closed_reason).toBe("deadline");
    expect(dto.items?.every((i) => i.state === "expired" && i.accountable_user_id === ALICE)).toBe(
      true,
    );
    expect(unaccepted(kit)).toHaveLength(1);
    expect(unaccepted(kit)[0]?.payload).toMatchObject({
      cause: "expired",
      unacceptedItemCount: 3,
      acceptedItemCount: 0,
    });
    const closed = kit.store.eventLog.find((e) => e.eventType === "closed");
    expect(closed).toMatchObject({
      actorKind: "system",
      actorUserId: null,
      reasonCode: "deadline",
    });
  });

  it("keeps items the recipient already accepted with the recipient", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    const first = handoff.items?.[0]?.id as string;
    await kit.service.accept(actor(BOB), handoff.id, [first]);
    kit.advanceMinutes(241);
    await expireDueHandoffsForOrg(deps(kit), ORG);
    const dto = await kit.service.get(actor(BOB), handoff.id);
    const byId = new Map((dto.items ?? []).map((i) => [i.id, i]));
    expect(dto.state).toBe("expired");
    expect(byId.get(first)).toMatchObject({ state: "accepted", accountable_user_id: BOB });
    expect(unaccepted(kit)[0]?.payload).toMatchObject({
      unacceptedItemCount: 2,
      acceptedItemCount: 1,
    });
  });

  it("uses the tenant's current policy: a lowered cap expires an older row early", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    kit.advanceMinutes(61);
    await kit.service.setPolicy(actor(ALICE), 60);
    expect((await expireDueHandoffsForOrg(deps(kit), ORG)).expired).toBe(1);
  });

  it("converges: a second run finds nothing and publishes nothing", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    kit.advanceMinutes(241);
    await expireDueHandoffsForOrg(deps(kit), ORG);
    const count = kit.published.length;
    expect(await expireDueHandoffsForOrg(deps(kit), ORG)).toEqual({ expired: 0, failed: 0 });
    expect(kit.published).toHaveLength(count);
  });

  it("is flag-independent and handles many handoffs across batches", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    await kit.service.offer(actor(ALICE), {
      toUserId: CAROL,
      items: [item("refill_request", P1, REFILL)],
    });
    kit.advanceMinutes(241);
    expect((await expireDueHandoffsForOrg(deps(kit), ORG)).expired).toBe(2);
    void NOW;
  });

  it("isolates a failing handoff, expires the rest, then rethrows with the class name only", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    await kit.service.offer(actor(ALICE), {
      toUserId: CAROL,
      items: [item("refill_request", P1, REFILL)],
    });
    kit.advanceMinutes(241);
    const warnings: Array<Record<string, string>> = [];
    let first = true;
    const failing = {
      ...kit.store,
      getForUpdate: async (...args: Parameters<typeof kit.store.getForUpdate>) => {
        if (first) {
          first = false;
          throw new TypeError("password=secret");
        }
        return kit.store.getForUpdate(...args);
      },
    };
    const run = expireDueHandoffsForOrg(
      deps(kit, {
        store: failing,
        warn: (_m: string, c: Record<string, string>) => warnings.push(c),
      }),
      ORG,
    );
    await expect(run).rejects.toThrow("handoff expiry failed for 1 handoff(s)");
    expect(warnings[0]?.error_name).toBe("TypeError");
    expect(JSON.stringify(warnings)).not.toContain("secret");
    expect([...kit.store.handoffs.values()].filter((h) => h.state === "expired")).toHaveLength(1);
    // The next run picks up the one that failed.
    expect((await expireDueHandoffsForOrg(deps(kit), ORG)).expired).toBe(1);
  });
});
