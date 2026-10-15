// WP 3.8 - the supervisor's decisions: reassign and close, never delete; the review row is decided before the task moves;
// ineligible targets change nothing; replays are 200, other repeats 409; restricted and missing rows are the same 404.
import { TASK_CLOSE_REASONS } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  ADMISSION,
  ALICE,
  BOB,
  CAROL,
  DAVE,
  P1,
  SUPERVISOR,
  actor,
  buildKit,
} from "./review-test-kit";

const sup = actor(SUPERVISOR);

async function queued(kit: ReturnType<typeof buildKit>, assignee = ALICE) {
  const t = await kit.task(assignee);
  await kit.queue("discharge", ADMISSION);
  const row = [...kit.store.rows.values()].find((r) => r.itemId === t.id);
  return { task: t, reviewId: row?.id ?? "" };
}

describe("list", () => {
  it("shows an open row with the patient label, the task and the allowed actions", async () => {
    const kit = buildKit();
    await queued(kit);

    const [item] = await kit.service.list(sup, { state: "open", limit: 50 });

    expect(item).toMatchObject({
      cause: "discharge",
      state: "open",
      restricted: false,
      patient_id: P1,
      patient_display_name: "Pat I.",
      allowed_actions: ["reassign", "close"],
    });
    expect(item?.task?.assignee_user_id).toBe(ALICE);
  });

  it("lists a Part 2 restricted row without patient or task detail and without actions", async () => {
    const kit = buildKit({ part2Denied: [`${SUPERVISOR}:${P1}`] });
    await queued(kit);

    const [item] = await kit.service.list(sup, { state: "open", limit: 50 });

    expect(item).toMatchObject({
      restricted: true,
      patient_id: null,
      patient_display_name: null,
      task: null,
      allowed_actions: [],
    });
  });

  it("treats a throwing Part 2 gate as restricted (fail closed), still listing the row", async () => {
    const kit = buildKit({ part2Throws: true });
    await queued(kit);

    const items = await kit.service.list(sup, { state: "open", limit: 50 });

    expect(items).toHaveLength(1);
    expect(items[0]?.restricted).toBe(true);
  });
});

describe("reassign", () => {
  it("decides the review, moves the task with reason review and publishes source review", async () => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);

    const dto = await kit.service.reassign(sup, reviewId, BOB);

    expect(dto).toMatchObject({
      state: "resolved",
      resolution: "reassigned",
      reassigned_to_user_id: BOB,
      resolved_by_user_id: SUPERVISOR,
      allowed_actions: [],
    });
    expect(kit.taskStore.tasks.get(task.id)?.assigneeId).toBe(BOB);
    const event = kit.taskStore.eventLog.find((e) => e.eventType === "reassigned");
    expect(event).toMatchObject({ reasonCode: "review", actorUserId: SUPERVISOR });
    const out = kit.published.find((e) => e.eventName === "m36.task.reassigned");
    expect(out?.payload).toMatchObject({ source: "review", fromUserId: ALICE, toUserId: BOB });
    expect(JSON.stringify(out?.payload)).not.toContain(P1);
  });

  it("decides the review row before the task moves", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);
    const seen: string[] = [];
    const move = kit.taskStore.transition.bind(kit.taskStore);
    kit.taskStore.transition = async (tx, a) => {
      seen.push(kit.store.rows.get(reviewId)?.state ?? "missing");
      return move(tx, a);
    };

    await kit.service.reassign(sup, reviewId, BOB);

    expect(seen).toEqual(["resolved"]);
  });

  it.each([
    ["an ineligible target", DAVE],
    ["the current assignee", ALICE],
  ])("refuses %s with 422 and changes nothing", async (_name, target) => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);

    const outcome = await kit.code(kit.service.reassign(sup, reviewId, target));

    expect(outcome).toBe("422:REVIEW_ASSIGNEE_INVALID");
    expect(kit.store.rows.get(reviewId)?.state).toBe("open");
    expect(kit.taskStore.tasks.get(task.id)?.assigneeId).toBe(ALICE);
    expect(kit.published).toHaveLength(0);
  });

  it("refuses a target who already holds an active task on the message with 422", async () => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);
    await kit.taskStore.createOrGetActive(null as never, {
      orgId: task.organizationId,
      messageId: task.messageId,
      channelId: task.channelId,
      patientId: P1,
      createdBy: CAROL,
      assigneeId: BOB,
      dueAt: null,
      clinicalConcern: true,
    });

    const outcome = await kit.code(kit.service.reassign(sup, reviewId, BOB));

    expect(outcome).toBe("422:REVIEW_ASSIGNEE_INVALID");
    expect(kit.store.rows.get(reviewId)?.state).toBe("open");
  });

  it("returns 200 with the current row when the same user repeats the same decision", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);
    await kit.service.reassign(sup, reviewId, BOB);

    const again = await kit.service.reassign(sup, reviewId, BOB);

    expect(again.resolution).toBe("reassigned");
    expect(kit.taskStore.eventLog.filter((e) => e.eventType === "reassigned")).toHaveLength(1);
  });

  it("answers 409 for a different decision on a decided row", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);
    await kit.service.reassign(sup, reviewId, BOB);

    expect(await kit.code(kit.service.reassign(sup, reviewId, CAROL))).toBe(
      "409:REVIEW_ITEM_STATE_CONFLICT",
    );
    expect(await kit.code(kit.service.close(sup, reviewId, "duplicate"))).toBe(
      "409:REVIEW_ITEM_STATE_CONFLICT",
    );
  });
});

describe("close", () => {
  it.each([
    ["action_taken", "done"],
    ["handled_elsewhere", "done"],
    ["no_action_needed", "cancelled"],
    ["unable_to_complete", "cancelled"],
    ["duplicate", "cancelled"],
  ] as const)("closes with %s and leaves the task %s", async (reason, status) => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);

    const dto = await kit.service.close(sup, reviewId, reason);

    expect(dto).toMatchObject({
      state: "resolved",
      resolution: "closed",
      resolution_reason: reason,
    });
    expect(kit.taskStore.tasks.get(task.id)).toMatchObject({ status, closedReason: reason });
    const out = kit.published.find((e) => e.eventName === "m36.task.status_changed");
    expect(out?.payload).toMatchObject({ to: status });
  });

  it("covers every reason the task domain knows", () => {
    expect([...TASK_CLOSE_REASONS]).toHaveLength(5);
  });

  it("rejects an unknown reason with 422 and changes nothing", async () => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);

    const outcome = await kit.code(kit.service.close(sup, reviewId, "because" as never));

    expect(outcome).toBe("422:REVIEW_REASON_INVALID");
    expect(kit.taskStore.tasks.get(task.id)?.status).toBe("open");
  });

  it("is a 200 replay for the same reason by the same user", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);
    await kit.service.close(sup, reviewId, "action_taken");

    const again = await kit.service.close(sup, reviewId, "action_taken");

    expect(again.resolution).toBe("closed");
    expect(kit.published.filter((e) => e.eventName === "m36.task.status_changed")).toHaveLength(1);
  });

  it("answers 409 when another user repeats a decision already made", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);
    await kit.service.close(sup, reviewId, "action_taken");

    const outcome = await kit.code(kit.service.close(actor(BOB), reviewId, "action_taken"));

    expect(outcome).toBe("409:REVIEW_ITEM_STATE_CONFLICT");
  });
});

describe("closed elsewhere", () => {
  it("resolves the review when the assignee closes the task, and then offers no action", async () => {
    const kit = buildKit();
    const { task, reviewId } = await queued(kit);

    await kit.closeElsewhere(task.id, ALICE);

    const [item] = await kit.service.list(sup, { state: "resolved", limit: 50 });
    expect(item).toMatchObject({
      id: reviewId,
      resolution: "closed_elsewhere",
      resolution_reason: "action_taken",
      allowed_actions: [],
    });
    expect(await kit.code(kit.service.close(sup, reviewId, "duplicate"))).toBe(
      "409:REVIEW_ITEM_STATE_CONFLICT",
    );
  });
});

describe("uniform 404", () => {
  it("answers a restricted row exactly like a missing one", async () => {
    const kit = buildKit({ part2Denied: [`${SUPERVISOR}:${P1}`] });
    const { reviewId } = await queued(kit);
    const missing = "00000000-0000-4000-8000-00000000dead";

    const restricted = await kit.code(kit.service.reassign(sup, reviewId, BOB));
    const gone = await kit.code(kit.service.reassign(sup, missing, BOB));
    const restrictedClose = await kit.code(kit.service.close(sup, reviewId, "duplicate"));

    expect(restricted).toBe(gone);
    expect(restrictedClose).toBe(gone);
    expect(restricted.startsWith("404")).toBe(true);
    expect(kit.store.rows.get(reviewId)?.state).toBe("open");
  });

  it("does not act across tenants", async () => {
    const kit = buildKit();
    const { reviewId } = await queued(kit);

    const outcome = await kit.code(
      kit.service.close(
        { orgId: "00000000-0000-4000-8000-0000000000ff", userId: SUPERVISOR },
        reviewId,
        "duplicate",
      ),
    );

    expect(outcome.startsWith("404")).toBe(true);
  });
});
