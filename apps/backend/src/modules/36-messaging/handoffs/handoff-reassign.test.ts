// WP 3.5 - offboarding: a leaving recipient's offers close declined (the sender keeps every item), a leaving sender is
// flagged once and supervisors told, failures are isolated and rethrown, and a second run changes nothing.
import { describe, expect, it } from "vitest";
import { reassignHandoffsForLeaver } from "./handoff-reassign";
import {
  ALICE,
  BOB,
  CAROL,
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

describe("reassignHandoffsForLeaver", () => {
  it("closes an offer whose recipient left as declined/recipient_left; the sender stays accountable", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    expect(await reassignHandoffsForLeaver(deps(kit), ORG, BOB)).toEqual({
      recipientClosed: 1,
      senderFlagged: 0,
      failed: 0,
    });
    const dto = await kit.service.get(actor(ALICE), handoff.id);
    expect(dto.state).toBe("declined");
    expect(dto.closed_reason).toBe("recipient_left");
    expect(dto.items?.every((i) => i.state === "declined" && i.accountable_user_id === ALICE)).toBe(
      true,
    );
    expect(unaccepted(kit)[0]?.payload).toMatchObject({
      cause: "recipient_left",
      unacceptedItemCount: 3,
    });
  });

  it("leaves items the leaving recipient already accepted alone", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    const first = handoff.items?.[0]?.id as string;
    await kit.service.accept(actor(BOB), handoff.id, [first]);
    await reassignHandoffsForLeaver(deps(kit), ORG, BOB);
    expect(kit.store.items.get(first)).toMatchObject({ state: "accepted", accountableUserId: BOB });
    expect(unaccepted(kit)[0]?.payload).toMatchObject({
      unacceptedItemCount: 2,
      acceptedItemCount: 1,
    });
  });

  it("flags a leaving sender once, announces it, and leaves the offer open for the recipient", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    expect(await reassignHandoffsForLeaver(deps(kit), ORG, ALICE)).toMatchObject({
      senderFlagged: 1,
      recipientClosed: 0,
    });
    expect(unaccepted(kit)[0]?.payload).toMatchObject({
      cause: "sender_left",
      unacceptedItemCount: 3,
    });
    expect(kit.store.handoffs.get(handoff.id)?.state).toBe("offered");
    const count = kit.published.length;
    expect(await reassignHandoffsForLeaver(deps(kit), ORG, ALICE)).toMatchObject({
      senderFlagged: 0,
    });
    expect(kit.published).toHaveLength(count);
    expect(kit.store.eventLog.filter((e) => e.eventType === "sender_left")).toHaveLength(1);
  });

  it("a second run after a recipient left is a no-op", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    await reassignHandoffsForLeaver(deps(kit), ORG, BOB);
    expect(await reassignHandoffsForLeaver(deps(kit), ORG, BOB)).toEqual({
      recipientClosed: 0,
      senderFlagged: 0,
      failed: 0,
    });
  });

  it("isolates a failure, processes the rest, then rethrows without the error text", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    await kit.service.offer(actor(ALICE), {
      toUserId: CAROL,
      items: [item("refill_request", P1, REFILL)],
    });
    const warnings: Array<Record<string, string>> = [];
    let first = true;
    const failing = {
      ...kit.store,
      getForUpdate: async (...a: Parameters<typeof kit.store.getForUpdate>) => {
        if (first) {
          first = false;
          throw new RangeError("secret detail");
        }
        return kit.store.getForUpdate(...a);
      },
    };
    await expect(
      reassignHandoffsForLeaver(
        deps(kit, {
          store: failing,
          warn: (_m: string, c: Record<string, string>) => warnings.push(c),
        }),
        ORG,
        ALICE,
      ),
    ).rejects.toThrow("offboarding handoff resolution failed for 1 handoff(s)");
    expect(JSON.stringify(warnings)).not.toContain("secret");
    expect(warnings[0]?.error_name).toBe("RangeError");
    // The handoff that did not fail was still flagged.
    expect(kit.store.eventLog.filter((e) => e.eventType === "sender_left")).toHaveLength(1);
  });
});
