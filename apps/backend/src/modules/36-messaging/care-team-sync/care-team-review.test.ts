// WP 3.9 - a clinician taken off a patient's care team: their open care-team tasks for that patient are queued for a
// supervisor (never reassigned or closed here), only when the clinician is really off the roster.
import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it, vi } from "vitest";
import {
  ALICE,
  BOB,
  CAROL,
  ORG,
  P1,
  P2,
  SUPERVISOR,
  buildKit,
  fakeDb,
} from "../review/review-test-kit";
import { routeRemovedClinicianForReview } from "./care-team-review";

const EVENT = "00000000-0000-4000-8000-0000000000f1";

function harness(
  opts: { roster?: string[]; rosterThrows?: boolean; flag?: boolean; flagThrows?: boolean } = {},
) {
  const kit = buildKit();
  const alertCalls: Array<Parameters<AlertEmitter["emit"]>[1]> = [];
  const alerts: AlertEmitter = {
    emit: async (_o, input) => {
      alertCalls.push(input);
      return { alertId: "a", resolvedRecipientCount: 1 };
    },
  };
  const careTeamMembers = vi.fn(async () => {
    if (opts.rosterThrows) throw new Error("seam down");
    return opts.roster ?? [CAROL, SUPERVISOR];
  });
  const route = (clinician = ALICE, patient = P1, eventId = EVENT) =>
    routeRemovedClinicianForReview(
      {
        db: fakeDb,
        careTeamMembers,
        taskStore: kit.taskStore,
        store: kit.store,
        alerts,
        isFlagOn: async () => {
          if (opts.flagThrows) throw new Error("flag down");
          return opts.flag ?? true;
        },
      },
      { orgId: ORG, patientId: patient, clinicianUserId: clinician, eventId },
    );
  return { kit, route, alertCalls, careTeamMembers };
}

describe("routeRemovedClinicianForReview", () => {
  it("queues the removed clinician's open task with cause care_team_removed and tells the supervisors", async () => {
    const h = harness();
    const t = await h.kit.task(ALICE);

    const out = await h.route();

    expect(out).toEqual({ routed: 1 });
    const rows = await h.kit.store.list(null as never, ORG, { state: "open", limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      itemId: t.id,
      source: "care_team_change",
      cause: "care_team_removed",
      triggerRef: EVENT,
      subjectUserId: ALICE,
      patientId: P1,
    });
    expect(h.alertCalls).toHaveLength(1);
    expect(h.alertCalls[0]?.eventType).toBe("m36.review.queued");
  });

  it("changes nothing on the task itself", async () => {
    const h = harness();
    const t = await h.kit.task(ALICE);
    const before = JSON.stringify(h.kit.taskStore.tasks.get(t.id));

    await h.route();

    expect(JSON.stringify(h.kit.taskStore.tasks.get(t.id))).toBe(before);
  });

  it("routes nothing when the clinician is still on the roster", async () => {
    const h = harness({ roster: [ALICE] });
    await h.kit.task(ALICE);

    expect(await h.route()).toEqual({ routed: 0, skipped: "still_on_team" });
    expect(await h.kit.store.list(null as never, ORG, { state: "all", limit: 50 })).toHaveLength(0);
  });

  it("rethrows when the roster seam fails, queuing nothing", async () => {
    const h = harness({ rosterThrows: true });
    await h.kit.task(ALICE);

    await expect(h.route()).rejects.toThrow("seam down");
    expect(await h.kit.store.list(null as never, ORG, { state: "all", limit: 50 })).toHaveLength(0);
  });

  it("reports nothing_open when the clinician has no active task for the patient", async () => {
    const h = harness();
    await h.kit.task(ALICE, { patientId: P2 });
    await h.kit.task(BOB);

    expect(await h.route()).toEqual({ routed: 0, skipped: "nothing_open" });
    expect(h.alertCalls).toHaveLength(0);
  });

  it("is idempotent on redelivery and still raises the same alert correlation", async () => {
    const h = harness();
    await h.kit.task(ALICE);

    await h.route();
    const second = await h.route();

    expect(second.routed).toBe(0);
    expect(await h.kit.store.list(null as never, ORG, { state: "all", limit: 50 })).toHaveLength(1);
    expect(h.alertCalls[0]?.correlationId).toBe(h.alertCalls[1]?.correlationId);
  });

  it("does not queue a task twice when a lifecycle review already holds it", async () => {
    const h = harness();
    await h.kit.task(ALICE);
    await h.kit.queue("discharge", "00000000-0000-4000-8000-0000000000a9");

    await h.route();

    expect(await h.kit.store.list(null as never, ORG, { state: "all", limit: 50 })).toHaveLength(1);
  });

  it("queues the rows but sends no alert when the tasks flag is off", async () => {
    const h = harness({ flag: false });
    await h.kit.task(ALICE);

    expect((await h.route()).routed).toBe(1);
    expect(h.alertCalls).toHaveLength(0);
  });

  it("rethrows when the flag read fails, with the rows already queued and the alert sent on the retry", async () => {
    const failing = harness({ flagThrows: true });
    await failing.kit.task(ALICE);
    await expect(failing.route()).rejects.toThrow("flag down");
    expect(failing.alertCalls).toHaveLength(0);
    expect(
      await failing.kit.store.list(null as never, ORG, { state: "open", limit: 50 }),
    ).toHaveLength(1);
  });

  it("queues every task of a clinician with more than 500 open tasks", async () => {
    const h = harness();
    for (let i = 0; i < 520; i++) await h.kit.task(ALICE);

    const out = await h.route();

    expect(out.routed).toBe(520);
  });
});
