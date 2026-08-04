// M35-T05 — §4.15 dunning state machine (D7 ladder over an in-memory store).
import { beforeEach, describe, expect, it } from "vitest";
import {
  DUNNING_ADVANCE_AFTER_DAYS,
  DUNNING_LADDER,
  dunningRetryDelayDays,
  nextDunningStage,
} from "../src/domain/dunning-lifecycle";
import { DunningActionError, DunningStateMachineService } from "../src/service/dunning-service";
import type { DunningStateRecord, DunningStore } from "../src/service/ports";

const ORG = "org-1";
const SUB = "sub-1";
const MS_PER_DAY = 24 * 3600 * 1000;
const T0 = new Date("2026-08-02T12:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * MS_PER_DAY);

class FakeDunningStore implements DunningStore {
  open: DunningStateRecord | null = null;
  closed: Array<{ rowId: string; exitReason: string }> = [];
  seq = 0;

  async openForSubscription(subscriptionId: string) {
    return this.open && this.open.subscriptionId === subscriptionId ? this.open : null;
  }
  async enterStage(input: Parameters<DunningStore["enterStage"]>[0]) {
    if (input.fromRowId)
      this.closed.push({ rowId: input.fromRowId, exitReason: input.exitReason ?? "" });
    const record: DunningStateRecord = {
      id: `dun-${++this.seq}`,
      organizationId: input.organizationId,
      subscriptionId: input.subscriptionId,
      stage: input.toStage,
      attemptCount: input.attemptCount,
      enteredAt: input.enteredAt,
      triggerInvoiceId: input.triggerInvoiceId,
    };
    this.open = record;
    return record;
  }
  async closeOpen(input: { rowId: string; exitedAt: Date; exitReason: string }) {
    this.closed.push({ rowId: input.rowId, exitReason: input.exitReason });
    this.open = null;
  }
}

describe("DunningStateMachineService", () => {
  let store: FakeDunningStore;
  let svc: DunningStateMachineService;
  beforeEach(() => {
    store = new FakeDunningStore();
    svc = new DunningStateMachineService(store);
  });

  it("onPaymentFailed enters day_1 from none and schedules a +24h retry", async () => {
    const r = await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: "inv-1",
      failureCode: "card_declined",
      now: T0,
    });
    expect(r.from).toBe("none");
    expect(r.to).toBe("day_1");
    expect(r.sideEffect).toBe("none");
    expect(r.outbox).toHaveLength(1);
    const intent = r.outbox[0]!;
    expect(intent.eventName).toBe("m35.dunning.entered_stage");
    const payload = intent.payload as { toStage: string; nextAttemptAt: string | null };
    expect(payload.toStage).toBe("day_1");
    // day_1 retries at +24h (distinct from its +6-day ADVANCE interval).
    expect(dunningRetryDelayDays("day_1")).toBe(1);
    expect(payload.nextAttemptAt).toBe(at(1).toISOString());
  });

  it("a repeated payment_failed while in dunning is an idempotent no-op (no duplicate outbox)", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: "inv-1",
      failureCode: "x",
      now: T0,
    });
    const again = await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: "inv-1",
      failureCode: "x",
      now: at(0.5),
    });
    expect(again.to).toBe("day_1");
    expect(again.outbox).toHaveLength(0);
  });

  it("tick does not advance before the stage's unresolved interval elapses", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now: T0,
    });
    const early = await svc.tick({
      subscriptionId: SUB,
      now: at(DUNNING_ADVANCE_AFTER_DAYS.day_1 - 1),
    });
    expect(early.to).toBe("day_1");
    expect(early.outbox).toHaveLength(0);
  });

  it("tick advances day_1 → day_7 once +6 days have elapsed", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now: T0,
    });
    const adv = await svc.tick({ subscriptionId: SUB, now: at(DUNNING_ADVANCE_AFTER_DAYS.day_1) });
    expect(adv.from).toBe("day_1");
    expect(adv.to).toBe("day_7");
    expect(adv.outbox[0]!.eventName).toBe("m35.dunning.entered_stage");
    expect(store.closed).toHaveLength(1); // prior day_1 row closed as "advanced"
    expect(store.closed[0]!.exitReason).toBe("advanced");
  });

  it("advancing to day_28_suspend signals a suspend side effect", async () => {
    // Walk the whole ladder by ticking at each stage's due instant.
    let now = T0;
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now,
    });
    let stage = store.open!.stage;
    let sideEffect = "none";
    // Advance until suspend.
    while (stage !== "day_28_suspend") {
      const days = DUNNING_ADVANCE_AFTER_DAYS[stage as keyof typeof DUNNING_ADVANCE_AFTER_DAYS];
      now = new Date(store.open!.enteredAt.getTime() + days * MS_PER_DAY);
      const r = await svc.tick({ subscriptionId: SUB, now });
      stage = r.to!;
      sideEffect = r.sideEffect;
    }
    expect(stage).toBe("day_28_suspend");
    expect(sideEffect).toBe("suspend");
  });

  it("day_28_suspend → day_60_cancel signals a cancel side effect", async () => {
    // Seed an open day_28_suspend row directly.
    store.open = {
      id: "dun-seed",
      organizationId: ORG,
      subscriptionId: SUB,
      stage: "day_28_suspend",
      attemptCount: 5,
      enteredAt: T0,
      triggerInvoiceId: null,
    };
    const r = await svc.tick({
      subscriptionId: SUB,
      now: at(DUNNING_ADVANCE_AFTER_DAYS.day_28_suspend),
    });
    expect(r.to).toBe("day_60_cancel");
    expect(r.sideEffect).toBe("cancel");
  });

  it("day_60_cancel is terminal — tick is a no-op", async () => {
    store.open = {
      id: "dun-seed",
      organizationId: ORG,
      subscriptionId: SUB,
      stage: "day_60_cancel",
      attemptCount: 6,
      enteredAt: T0,
      triggerInvoiceId: null,
    };
    const r = await svc.tick({ subscriptionId: SUB, now: at(999) });
    expect(r.to).toBe("day_60_cancel");
    expect(r.outbox).toHaveLength(0);
    expect(nextDunningStage("day_60_cancel")).toBeNull();
  });

  it("resolve closes an active dunning row and emits m35.dunning.resolved", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now: T0,
    });
    const r = await svc.resolve({ subscriptionId: SUB, now: at(2) });
    expect(r.from).toBe("day_1");
    expect(r.record).toBeNull();
    expect(store.open).toBeNull();
    expect(r.outbox[0]!.eventName).toBe("m35.dunning.resolved");
    expect((r.outbox[0]!.payload as { lastStage: string }).lastStage).toBe("day_1");
  });

  it("resolve is a no-op when the subscription is not in dunning", async () => {
    const r = await svc.resolve({ subscriptionId: SUB, now: T0 });
    expect(r.outbox).toHaveLength(0);
    expect(r.record).toBeNull();
  });

  it("skipStage force-advances one stage and stamps the actor on the closed row", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now: T0,
    });
    const r = await svc.skipStage({
      subscriptionId: SUB,
      actorMembershipId: "mem-9",
      now: at(0.1),
    });
    expect(r.to).toBe("day_7");
    expect(store.closed[0]!.exitReason).toBe("skipped_by:mem-9");
  });

  it("skipStage refuses when there is no open dunning", async () => {
    await expect(
      svc.skipStage({ subscriptionId: SUB, actorMembershipId: "mem-9", now: T0 }),
    ).rejects.toBeInstanceOf(DunningActionError);
  });

  it("reset clears dunning back to current and emits resolved", async () => {
    await svc.onPaymentFailed({
      subscriptionId: SUB,
      organizationId: ORG,
      triggerInvoiceId: null,
      failureCode: "x",
      now: T0,
    });
    const r = await svc.reset({ subscriptionId: SUB, actorMembershipId: "mem-3", now: at(1) });
    expect(store.open).toBeNull();
    expect(r.outbox[0]!.eventName).toBe("m35.dunning.resolved");
    expect(store.closed.some((c) => c.exitReason === "reset_by:mem-3")).toBe(true);
  });

  it("the ladder ordering is the canonical D7 sequence", () => {
    expect([...DUNNING_LADDER]).toEqual([
      "none",
      "day_1",
      "day_7",
      "day_14",
      "day_21",
      "day_28_suspend",
      "day_60_cancel",
    ]);
  });
});
