// WP 5.9 (ADR-0084): the per-item decisions, idempotency and fail-closed behaviour of the offboarding orchestration, on fake steps.
import { NotFoundError, OFFBOARDING_ITEM_KEYS, type OffboardingItemKey } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { createOffboardingService } from "./offboarding-service";
import type {
  Inspection,
  OffboardingAuditEntry,
  OffboardingDeps,
  OffboardingStep,
  Standing,
} from "./offboarding-types";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OFFICER = "00000000-0000-4000-8000-0000000000b1";
const LEAVER = "00000000-0000-4000-8000-0000000000c1";
const actor = { organizationId: ORG, userId: OFFICER, sessionId: "officer-session" };

interface FakeStep extends OffboardingStep {
  state: Inspection;
}

/** A step whose `run` clears `auto` (a sweep) or leaves some behind (a reassign that found nobody). */
function fake(
  key: OffboardingItemKey,
  kind: OffboardingStep["kind"],
  start: Inspection,
  onRun: (s: FakeStep) => void = (s) => {
    s.state = { auto: 0, human: s.state.human };
  },
): FakeStep {
  const step: FakeStep = {
    key,
    kind,
    state: start,
    inspect: async () => step.state,
    run: async () => {
      const before = step.state.auto;
      onRun(step);
      return before - step.state.auto;
    },
  };
  return step;
}

function deps(
  steps: readonly OffboardingStep[],
  standing: Standing = "offboarded",
): { d: OffboardingDeps; audits: OffboardingAuditEntry[] } {
  const audits: OffboardingAuditEntry[] = [];
  return {
    audits,
    d: {
      standing: async () => standing,
      steps,
      audit: async (e) => {
        audits.push(e);
      },
    },
  };
}

const allKeys = (over: Partial<Record<OffboardingItemKey, FakeStep>>): FakeStep[] =>
  OFFBOARDING_ITEM_KEYS.map(
    (key) =>
      over[key] ??
      fake(key, key === "ack_sent" || key === "drafts" ? "kept" : "sweep", { auto: 0, human: 0 }),
  );

describe("offboarding preview", () => {
  it("reports pending work without changing anything and audits ids and counts only", async () => {
    const sessions = fake("sessions_devices", "sweep", { auto: 2, human: 0 });
    const { d, audits } = deps(allKeys({ sessions_devices: sessions }));
    const out = await createOffboardingService(d).preview(actor, LEAVER);
    const item = out.items.find((i) => i.key === "sessions_devices");
    expect(item).toMatchObject({ state: "pending", count: 2, acted: 0 });
    expect(sessions.state.auto).toBe(2);
    expect(out.complete).toBe(false);
    expect(out.blocked_by).toEqual(["sessions_devices"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "m36.offboarding.viewed", targetUserId: LEAVER });
  });

  it("an unknown or foreign user is a not-found and nothing is audited as a view", async () => {
    const { d, audits } = deps(allKeys({}), "unknown");
    await expect(createOffboardingService(d).preview(actor, LEAVER)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(audits).toHaveLength(0);
  });

  it("an active user is refused with a conflict, for preview and execute", async () => {
    const { d } = deps(allKeys({}), "active");
    const svc = createOffboardingService(d);
    await expect(svc.preview(actor, LEAVER)).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.execute(actor, LEAVER)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("offboarding execute", () => {
  it("runs sweeps to done and reports what it changed", async () => {
    const sessions = fake("sessions_devices", "sweep", { auto: 2, human: 0 });
    const { d } = deps(allKeys({ sessions_devices: sessions }));
    const out = await createOffboardingService(d).execute(actor, LEAVER);
    expect(out.items.find((i) => i.key === "sessions_devices")).toMatchObject({
      state: "done",
      count: 0,
      acted: 2,
    });
    expect(out.complete).toBe(true);
  });

  it("a reassign that finds nobody leaves the item visible as needs_person, never dropped", async () => {
    const ack = fake("ack_assigned", "reassign", { auto: 3, human: 0 }, (s) => {
      s.state = { auto: 1, human: 0 }; // two moved, one has no eligible colleague
    });
    const { d } = deps(allKeys({ ack_assigned: ack }));
    const out = await createOffboardingService(d).execute(actor, LEAVER);
    expect(out.items.find((i) => i.key === "ack_assigned")).toMatchObject({
      state: "needs_person",
      count: 1,
      acted: 2,
      needs_person: 1,
    });
    expect(out.complete).toBe(false);
    expect(out.blocked_by).toEqual(["ack_assigned"]);
  });

  it("work that only a person can move (acknowledged, flagged) is needs_person with no run", async () => {
    const run = vi.fn(async () => 0);
    const tasks: FakeStep = { ...fake("tasks", "reassign", { auto: 0, human: 2 }), run };
    const { d } = deps(allKeys({ tasks }));
    const out = await createOffboardingService(d).execute(actor, LEAVER);
    expect(run).not.toHaveBeenCalled();
    expect(out.items.find((i) => i.key === "tasks")).toMatchObject({
      state: "needs_person",
      count: 2,
      needs_person: 2,
    });
  });

  it("a step that throws is failed, the other steps still run, and no error text is returned", async () => {
    const boom = fake("handoffs", "reassign", { auto: 1, human: 0 });
    boom.run = async () => {
      throw new Error("secret connection string");
    };
    const sessions = fake("sessions_devices", "sweep", { auto: 1, human: 0 });
    const warn = vi.fn();
    const { d } = deps(allKeys({ handoffs: boom, sessions_devices: sessions }));
    const out = await createOffboardingService({ ...d, warn }).execute(actor, LEAVER);
    expect(out.items.find((i) => i.key === "handoffs")).toMatchObject({
      state: "failed",
      count: 1,
    });
    expect(out.items.find((i) => i.key === "sessions_devices")?.state).toBe("done");
    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    expect(out.complete).toBe(false);
  });

  it("a sweep that leaves work behind is failed so the officer runs it again", async () => {
    const stuck = fake("scheduled_sends", "sweep", { auto: 2, human: 0 }, () => {});
    const { d } = deps(allKeys({ scheduled_sends: stuck }));
    const out = await createOffboardingService(d).execute(actor, LEAVER);
    expect(out.items.find((i) => i.key === "scheduled_sends")?.state).toBe("failed");
  });

  it("a re-run after a complete run changes nothing and says so", async () => {
    const sessions = fake("sessions_devices", "sweep", { auto: 2, human: 0 });
    const { d, audits } = deps(allKeys({ sessions_devices: sessions }));
    const svc = createOffboardingService(d);
    await svc.execute(actor, LEAVER);
    const again = await svc.execute(actor, LEAVER);
    expect(again.items.every((i) => i.acted === 0)).toBe(true);
    expect(again.complete).toBe(true);
    expect(audits.filter((a) => a.action === "m36.offboarding.executed")).toHaveLength(2);
  });

  it("kept items never block and the advisory on-call item never blocks", async () => {
    const sent = fake("ack_sent", "kept", { auto: 0, human: 4 });
    const oncall = fake("oncall_seats", "advisory", { auto: 0, human: 0 });
    const { d } = deps(allKeys({ ack_sent: sent, oncall_seats: oncall }));
    const out = await createOffboardingService(d).execute(actor, LEAVER);
    expect(out.items.find((i) => i.key === "ack_sent")).toMatchObject({ state: "kept", count: 4 });
    expect(out.items.find((i) => i.key === "oncall_seats")?.state).toBe("advisory");
    expect(out.complete).toBe(true);
    expect(out.done).toBe(out.total - 1);
  });

  it("access is cut before owned work is moved (sessions run first)", async () => {
    const order: string[] = [];
    const steps = OFFBOARDING_ITEM_KEYS.map((key) => {
      const s = fake(key, "sweep", { auto: 1, human: 0 });
      const run = s.run;
      s.run = async (c) => {
        order.push(key);
        return run?.(c) ?? 0;
      };
      return s;
    });
    await createOffboardingService(deps(steps).d).execute(actor, LEAVER);
    expect(order[0]).toBe("sessions_devices");
    expect(order).toEqual([...OFFBOARDING_ITEM_KEYS]);
  });

  it("audits one executed row with counts per item and the complete flag", async () => {
    const sessions = fake("sessions_devices", "sweep", { auto: 2, human: 0 });
    const { d, audits } = deps(allKeys({ sessions_devices: sessions }));
    await createOffboardingService(d).execute(actor, LEAVER);
    const row = audits.find((a) => a.action === "m36.offboarding.executed");
    expect(row).toMatchObject({ complete: true, actorUserId: OFFICER, targetUserId: LEAVER });
    expect(row?.items.sessions_devices).toEqual({ state: "done", count: 0, acted: 2 });
  });
});
