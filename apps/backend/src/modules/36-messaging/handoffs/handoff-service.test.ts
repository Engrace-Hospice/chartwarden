// WP 3.5 - the handoff policy on in-memory stores: offer (verification, replay, clashes), per-item accept/decline/cancel,
// accountability, deadline and policy cap, task transfer, participant-only reads and the PHI-free events.
import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  ALICE,
  BOB,
  CAROL,
  type Kit,
  NOW,
  ORG,
  P1,
  P2,
  P3,
  REFILL,
  VISIT,
  actor,
  buildKit,
  codeOf,
  item,
  offerStandard,
} from "./handoff-test-kit";

const CH = "00000000-0000-4000-8000-0000000000c1";
const MSG = "00000000-0000-4000-8000-0000000000d1";

const published = (kit: Kit, name: string) => kit.published.filter((e) => e.eventName === name);
const itemsOf = (dto: { items?: readonly { id: string; kind: string; ref_id: string | null }[] }) =>
  dto.items ?? [];

describe("offer", () => {
  it("creates an offered handoff whose items are pending and still the sender's", async () => {
    const kit = buildKit();
    const { handoff, created } = await offerStandard(kit);
    expect(created).toBe(true);
    expect(handoff.state).toBe("offered");
    expect(handoff.item_counts.pending).toBe(3);
    expect(handoff.patient_count).toBe(2);
    expect(handoff.items?.every((i) => i.accountable_user_id === ALICE)).toBe(true);
    expect(handoff.expires_at).toBe(new Date(NOW.getTime() + 240 * 60_000).toISOString());
    expect(handoff.allowed_actions).toEqual(["cancel"]);
  });

  it("publishes exactly one PHI-free offered event", async () => {
    const kit = buildKit();
    await offerStandard(kit);
    const events = published(kit, "m36.handoff.offered");
    expect(events).toHaveLength(1);
    const keys = Object.keys(events[0]?.payload ?? {}).sort();
    expect(keys).toEqual([
      "at",
      "expiresAt",
      "fromUserId",
      "handoffId",
      "itemCount",
      "organizationId",
      "toUserId",
    ]);
    expect(JSON.stringify(events[0]?.payload)).not.toContain(P1);
  });

  it("replays to the sender's own open handoff: nothing inserted, nothing published, new body ignored", async () => {
    const kit = buildKit();
    const first = await offerStandard(kit);
    const again = await kit.service.offer(actor(ALICE), {
      toUserId: BOB,
      items: [item("patient", P1)],
    });
    expect(again.created).toBe(false);
    expect(again.handoff.id).toBe(first.handoff.id);
    expect(again.handoff.item_counts.pending).toBe(3);
    expect(kit.store.handoffs.size).toBe(1);
    expect(published(kit, "m36.handoff.offered")).toHaveLength(1);
  });

  it("settles an open offer past its deadline (sweep not yet run) and creates a fresh one", async () => {
    const kit = buildKit();
    const first = await offerStandard(kit);
    kit.advanceMinutes(241);
    const again = await offerStandard(kit);
    expect(again.created).toBe(true);
    expect(again.handoff.id).not.toBe(first.handoff.id);
    expect(kit.store.handoffs.get(first.handoff.id)).toMatchObject({
      state: "expired",
      closedReason: "deadline",
    });
    expect([...kit.store.items.values()].filter((i) => i.handoffId === first.handoff.id)).toSatisfy(
      (rows: { state: string }[]) => rows.length === 3 && rows.every((r) => r.state === "expired"),
    );
    expect(published(kit, "m36.handoff.unaccepted")).toHaveLength(1);
    expect(published(kit, "m36.handoff.offered")).toHaveLength(2);
  });

  it.each([
    ["recipient is the sender", () => buildKit(), ALICE],
    ["recipient is inactive", () => buildKit({ inactive: [BOB] }), BOB],
    [
      "recipient lacks a permission",
      () => buildKit({ missingPermission: [`${BOB}:patient.read`] }),
      BOB,
    ],
    ["recipient has no Part 2 release", () => buildKit({ part2Denied: [`${BOB}:${P1}`] }), BOB],
    ["the Part 2 gate cannot answer", () => buildKit({ part2Throws: true }), BOB],
  ])("refuses with a uniform 422 and writes nothing when %s", async (_n, make, to) => {
    const kit = make();
    const result = await codeOf(
      kit.service.offer(actor(ALICE), { toUserId: to, items: [item("patient", P1)] }),
    );
    expect(result.startsWith("422:HANDOFF_")).toBe(true);
    expect(kit.store.handoffs.size).toBe(0);
    expect(kit.published).toHaveLength(0);
  });

  it("refuses a patient off the sender's caseload", async () => {
    const kit = buildKit();
    expect(
      await codeOf(
        kit.service.offer(actor(ALICE), { toUserId: BOB, items: [item("patient", P3)] }),
      ),
    ).toBe("422:HANDOFF_ITEM_INVALID");
    expect(kit.store.handoffs.size).toBe(0);
  });

  it("refuses an item the server cannot verify as open work", async () => {
    const kit = buildKit();
    const bogus = "00000000-0000-4000-8000-0000000000ff";
    expect(
      await codeOf(
        kit.service.offer(actor(ALICE), { toUserId: BOB, items: [item("visit", P1, bogus)] }),
      ),
    ).toBe("422:HANDOFF_ITEM_INVALID");
  });

  it("fails closed when the source for an offered kind is unavailable, but still offers the patient anchor", async () => {
    const kit = buildKit({ sourceDown: ["visit"] });
    expect(
      await codeOf(
        kit.service.offer(actor(ALICE), { toUserId: BOB, items: [item("visit", P1, VISIT)] }),
      ),
    ).toBe("422:HANDOFF_ITEM_INVALID");
    const ok = await kit.service.offer(actor(ALICE), {
      toUserId: BOB,
      items: [item("patient", P1)],
    });
    expect(ok.created).toBe(true);
  });

  it("rejects structural problems before touching anything", async () => {
    const kit = buildKit();
    expect(await codeOf(kit.service.offer(actor(ALICE), { toUserId: BOB, items: [] }))).toBe(
      "422:HANDOFF_ITEMS_REQUIRED",
    );
  });

  it("answers an item already pending in another open handoff with a generic 409 that names nothing", async () => {
    const kit = buildKit();
    await kit.service.offer(actor(ALICE), { toUserId: BOB, items: [item("visit", P1, VISIT)] });
    const clash = kit.service.offer(actor(ALICE), {
      toUserId: CAROL,
      items: [item("visit", P1, VISIT)],
    });
    expect(await codeOf(clash)).toBe("409:HANDOFF_ITEM_CONFLICT");
    await clash.catch((e: Error) => {
      expect(e.message).not.toContain(BOB);
      expect(e.message).not.toContain(VISIT);
    });
    expect(kit.store.handoffs.size).toBe(1);
  });
});

describe("accept and decline are per item", () => {
  async function setup(over = {}) {
    const kit = buildKit(over);
    const { handoff } = await offerStandard(kit);
    return { kit, id: handoff.id, ids: itemsOf(handoff).map((i) => i.id) };
  }

  it("accepting a subset keeps the handoff offered and moves accountability only for those items", async () => {
    const { kit, id, ids } = await setup();
    const dto = await kit.service.accept(actor(BOB), id, [ids[0] as string]);
    expect(dto.state).toBe("offered");
    expect(dto.item_counts).toMatchObject({ accepted: 1, pending: 2 });
    const byId = new Map((dto.items ?? []).map((i) => [i.id, i]));
    expect(byId.get(ids[0] as string)?.accountable_user_id).toBe(BOB);
    expect(byId.get(ids[1] as string)?.accountable_user_id).toBe(ALICE);
    const [event] = published(kit, "m36.handoff.accepted");
    expect(event?.payload).toMatchObject({ acceptedItemCount: 1, pendingItemCount: 2 });
  });

  it("accepting the last pending item closes the handoff as accepted", async () => {
    const { kit, id, ids } = await setup();
    const dto = await kit.service.accept(actor(BOB), id, ids);
    expect(dto.state).toBe("accepted");
    expect(dto.accepted_at).not.toBeNull();
    expect(dto.closed_reason).toBe("all_resolved");
    expect(published(kit, "m36.handoff.unaccepted")).toHaveLength(0);
  });

  it("declining everything closes it declined, leaves the sender accountable and announces it", async () => {
    const { kit, id } = await setup();
    const dto = await kit.service.decline(actor(BOB), id);
    expect(dto.state).toBe("declined");
    expect(dto.items?.every((i) => i.accountable_user_id === ALICE && i.state === "declined")).toBe(
      true,
    );
    const [event] = published(kit, "m36.handoff.unaccepted");
    expect(event?.payload).toMatchObject({
      cause: "declined",
      unacceptedItemCount: 3,
      acceptedItemCount: 0,
    });
  });

  it("accepting some and declining the rest closes accepted and still announces the declined items", async () => {
    const { kit, id, ids } = await setup();
    await kit.service.accept(actor(BOB), id, [ids[0] as string]);
    const dto = await kit.service.decline(actor(BOB), id);
    expect(dto.state).toBe("accepted");
    expect(published(kit, "m36.handoff.unaccepted")[0]?.payload).toMatchObject({
      unacceptedItemCount: 2,
      acceptedItemCount: 1,
    });
  });

  it("a repeated accept is a no-op that publishes nothing", async () => {
    const { kit, id, ids } = await setup();
    await kit.service.accept(actor(BOB), id, [ids[0] as string]);
    const before = kit.published.length;
    const again = await kit.service.accept(actor(BOB), id, [ids[0] as string]);
    expect(again.item_counts.accepted).toBe(1);
    expect(kit.published).toHaveLength(before);
    await kit.service.decline(actor(BOB), id);
    const afterClose = kit.published.length;
    await kit.service.decline(actor(BOB), id);
    expect(kit.published).toHaveLength(afterClose);
  });

  it("refuses to accept an item that was already declined", async () => {
    const { kit, id, ids } = await setup();
    await kit.service.decline(actor(BOB), id, [ids[0] as string]);
    expect(await codeOf(kit.service.accept(actor(BOB), id, [ids[0] as string]))).toBe(
      "409:HANDOFF_STATE_CONFLICT",
    );
  });

  it("refuses an item id that is not part of the handoff", async () => {
    const { kit, id } = await setup();
    expect(
      await codeOf(kit.service.accept(actor(BOB), id, ["00000000-0000-4000-8000-0000000000aa"])),
    ).toBe("422:HANDOFF_ITEM_INVALID");
  });

  it("refuses accept and decline after the deadline even before the tick runs", async () => {
    const { kit, id, ids } = await setup();
    kit.advanceMinutes(241);
    expect(await codeOf(kit.service.accept(actor(BOB), id, ids))).toBe(
      "409:HANDOFF_STATE_CONFLICT",
    );
    expect(await codeOf(kit.service.decline(actor(BOB), id))).toBe("409:HANDOFF_STATE_CONFLICT");
  });

  it("re-checks the recipient at accept", async () => {
    const opts = { missingPermission: [] as string[] };
    const { kit, id, ids } = await setup(opts);
    opts.missingPermission.push(`${BOB}:messaging.send`);
    expect(await codeOf(kit.service.accept(actor(BOB), id, ids))).toBe(
      "422:HANDOFF_RECIPIENT_INVALID",
    );
    expect(kit.store.items.size).toBe(3);
    expect([...kit.store.items.values()].every((i) => i.state === "pending")).toBe(true);
  });

  it("only the recipient may accept or decline", async () => {
    const { kit, id, ids } = await setup();
    await expect(kit.service.accept(actor(ALICE), id, ids)).rejects.toThrow("not permitted");
    await expect(kit.service.decline(actor(ALICE), id)).rejects.toThrow("not permitted");
  });
});

describe("cancel", () => {
  it("lets the sender withdraw: pending items cancelled, sender still accountable, nothing announced", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    const dto = await kit.service.cancel(actor(ALICE), handoff.id);
    expect(dto.state).toBe("cancelled");
    expect(dto.closed_reason).toBe("sender_cancelled");
    expect(
      dto.items?.every((i) => i.state === "cancelled" && i.accountable_user_id === ALICE),
    ).toBe(true);
    expect(published(kit, "m36.handoff.unaccepted")).toHaveLength(0);
    const after = kit.published.length;
    await kit.service.cancel(actor(ALICE), handoff.id);
    expect(kit.published).toHaveLength(after);
  });

  it("is the sender's alone, and a closed handoff cannot be cancelled again with a different outcome", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    await expect(kit.service.cancel(actor(BOB), handoff.id)).rejects.toThrow("not permitted");
    await kit.service.decline(actor(BOB), handoff.id);
    expect(await codeOf(kit.service.cancel(actor(ALICE), handoff.id))).toBe(
      "409:HANDOFF_STATE_CONFLICT",
    );
  });
});

describe("participant-only reads", () => {
  it("answers a non-participant exactly like a missing id", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    const missing = "00000000-0000-4000-8000-0000000000bb";
    const errors = await Promise.all(
      [
        kit.service.get(actor(CAROL), handoff.id),
        kit.service.get(actor(CAROL), missing),
        kit.service.accept(actor(CAROL), handoff.id, [handoff.items?.[0]?.id as string]),
        kit.service.cancel(actor(CAROL), handoff.id),
      ].map((p) =>
        p.then(
          () => null,
          (e: Error) => e,
        ),
      ),
    );
    for (const e of errors) expect(e).toBeInstanceOf(NotFoundError);
    expect(
      new Set(errors.map((e) => `${(e as NotFoundError).code}|${(e as NotFoundError).message}`))
        .size,
    ).toBe(1);
  });

  it("lists incoming and outgoing by role, active before closed", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    const q = { scope: "incoming" as const, state: "active" as const, limit: 50 };
    expect((await kit.service.list(actor(BOB), q)).map((h) => h.id)).toEqual([handoff.id]);
    expect(await kit.service.list(actor(ALICE), q)).toEqual([]);
    expect(
      (await kit.service.list(actor(ALICE), { ...q, scope: "outgoing" }))[0]?.items,
    ).toBeUndefined();
    await kit.service.decline(actor(BOB), handoff.id);
    expect(await kit.service.list(actor(BOB), q)).toEqual([]);
    expect(await kit.service.list(actor(BOB), { ...q, state: "closed" })).toHaveLength(1);
  });

  it("renders an item as restricted, with no label or id, when the viewer fails the Part 2 gate", async () => {
    const opts = { part2Denied: [] as string[] };
    const kit = buildKit(opts);
    const { handoff } = await offerStandard(kit);
    opts.part2Denied.push(`${BOB}:${P1}`);
    const dto = await kit.service.get(actor(BOB), handoff.id);
    const restricted = (dto.items ?? []).filter((i) => i.summary.state === "restricted");
    expect(restricted).toHaveLength(2);
    for (const r of restricted) {
      expect(r.patient_id).toBeNull();
      expect(r.patient_display_name).toBeNull();
      expect(r.ref_id).toBeNull();
    }
    const shown = (dto.items ?? []).find((i) => i.patient_id === P2);
    expect(shown?.patient_display_name).toMatch(/^Pat /);
  });

  it("treats a Part 2 gate outage on read as restricted, never as admitted", async () => {
    const opts = { part2Throws: false };
    const kit = buildKit(opts);
    const { handoff } = await offerStandard(kit);
    opts.part2Throws = true;
    const dto = await kit.service.get(actor(BOB), handoff.id);
    expect((dto.items ?? []).every((i) => i.summary.state === "restricted")).toBe(true);
  });
});

describe("tenant policy", () => {
  it("shortens the deadline of new offers and tightens in-flight ones", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    await kit.service.setPolicy(actor(ALICE), 60);
    kit.advanceMinutes(61);
    expect(
      await codeOf(kit.service.accept(actor(BOB), handoff.id, [handoff.items?.[0]?.id as string])),
    ).toBe("409:HANDOFF_STATE_CONFLICT");
    const view = await kit.service.policy(actor(ALICE));
    expect(view).toEqual({ expiry_minutes: 60, platform_max_minutes: 240, customised: true });
  });

  it("reports the ENFORCED deadline as expires_at after the policy tightens, not the stored column", async () => {
    const kit = buildKit();
    const { handoff } = await offerStandard(kit);
    expect(handoff.expires_at).toBe(new Date(NOW.getTime() + 240 * 60_000).toISOString());
    await kit.service.setPolicy(actor(ALICE), 60);
    const seen = await kit.service.get(actor(BOB), handoff.id);
    expect(seen.expires_at).toBe(new Date(NOW.getTime() + 60 * 60_000).toISOString());
    const [listed] = await kit.service.list(actor(BOB), {
      scope: "incoming",
      state: "active",
      limit: 10,
    });
    expect(listed?.expires_at).toBe(seen.expires_at);
  });

  it("offers get the policy minutes as their deadline, and clearing restores the platform value", async () => {
    const kit = buildKit({ policyMinutes: 30 });
    const { handoff } = await offerStandard(kit);
    expect(handoff.expires_at).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
    expect((await kit.service.clearPolicy(actor(ALICE))).expiry_minutes).toBe(240);
  });

  it("rejects a value outside 15..240", async () => {
    const kit = buildKit();
    expect(await codeOf(kit.service.setPolicy(actor(ALICE), 14))).toBe(
      "422:HANDOFF_POLICY_INVALID",
    );
    expect(await codeOf(kit.service.setPolicy(actor(ALICE), 241))).toBe(
      "422:HANDOFF_POLICY_INVALID",
    );
  });
});

describe("task items transfer for real", () => {
  async function withTask(kit: Kit) {
    const created = await kit.taskStore.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: MSG,
      channelId: CH,
      patientId: P1,
      createdBy: CAROL,
      assigneeId: ALICE,
      dueAt: null,
      clinicalConcern: true,
    });
    kit.store.tasks.push({ id: created.task.id, patientId: P1, status: "open", dueAt: null });
    kit.store.taskStatusById.set(created.task.id, "open");
    const { handoff } = await kit.service.offer(actor(ALICE), {
      toUserId: BOB,
      items: [item("task", P1, created.task.id)],
    });
    return {
      taskId: created.task.id,
      handoffId: handoff.id,
      itemId: handoff.items?.[0]?.id as string,
    };
  }

  it("reassigns the communication task to the acceptor and logs a handoff reason", async () => {
    const kit = buildKit({ viewableChannels: [CH] });
    const { taskId, handoffId, itemId } = await withTask(kit);
    await kit.service.accept(actor(BOB), handoffId, [itemId]);
    expect(kit.taskStore.tasks.get(taskId)?.assigneeId).toBe(BOB);
    const event = kit.taskStore.eventLog.find(
      (e) => e.taskId === taskId && e.eventType === "reassigned",
    );
    expect(event).toMatchObject({ reasonCode: "handoff", actorUserId: BOB, toAssigneeId: BOB });
  });

  it("refuses with 422 and changes nothing when the acceptor cannot view the task's channel", async () => {
    const kit = buildKit({ viewableChannels: [] });
    const { taskId, handoffId, itemId } = await withTask(kit);
    expect(await codeOf(kit.service.accept(actor(BOB), handoffId, [itemId]))).toBe(
      "422:HANDOFF_ITEM_NOT_TRANSFERABLE",
    );
    expect(kit.taskStore.tasks.get(taskId)?.assigneeId).toBe(ALICE);
    expect(kit.store.items.get(itemId)?.state).toBe("pending");
  });

  it("refuses when the task is no longer the sender's", async () => {
    const kit = buildKit({ viewableChannels: [CH] });
    const { taskId, handoffId, itemId } = await withTask(kit);
    await kit.taskStore.transition(null as never, {
      orgId: ORG,
      taskId,
      actor: { kind: "system" },
      action: "reassign",
      toAssigneeId: CAROL,
    });
    expect(await codeOf(kit.service.accept(actor(BOB), handoffId, [itemId]))).toBe(
      "422:HANDOFF_ITEM_NOT_TRANSFERABLE",
    );
  });

  it("refuses when the acceptor already holds an active task on that message", async () => {
    const kit = buildKit({ viewableChannels: [CH] });
    const { handoffId, itemId } = await withTask(kit);
    await kit.taskStore.createOrGetActive(null as never, {
      orgId: ORG,
      messageId: MSG,
      channelId: CH,
      patientId: P1,
      createdBy: CAROL,
      assigneeId: BOB,
      dueAt: null,
      clinicalConcern: true,
    });
    expect(await codeOf(kit.service.accept(actor(BOB), handoffId, [itemId]))).toBe(
      "422:HANDOFF_ITEM_NOT_TRANSFERABLE",
    );
  });
});

describe("prefill and caseload", () => {
  it("lists the sender's caseload with minimum-necessary labels", async () => {
    const kit = buildKit();
    const list = await kit.service.caseload(actor(ALICE));
    expect(list.map((p) => p.patient_id).sort()).toEqual([P1, P2].sort());
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["display_name", "mrn_suffix", "patient_id"]);
  });

  it("collects visit, refill, follow-up and task items and names a failing source only", async () => {
    const kit = buildKit({ sourceDown: ["refill"] });
    const result = await kit.service.prefill(actor(ALICE), [P1]);
    const p1 = result.patients[0];
    expect(p1?.unavailable_sources).toEqual(["refill_request"]);
    expect(p1?.items.map((i) => i.kind).sort()).toEqual(["patient", "symptom_followup", "visit"]);
    expect(p1?.items.find((i) => i.kind === "visit")?.ref_id).toBe(VISIT);
    void REFILL;
  });

  it("refuses patients off the caseload", async () => {
    const kit = buildKit();
    expect(await codeOf(kit.service.prefill(actor(ALICE), [P3]))).toBe("422:HANDOFF_ITEM_INVALID");
  });

  it("drops a visit beyond the 48 hour horizon", async () => {
    const kit = buildKit();
    const far = {
      ...kit.sources,
      nextVisit: async () => ({
        visitId: VISIT,
        status: "scheduled",
        scheduledStartedAt: new Date(NOW.getTime() + 49 * 3_600_000).toISOString(),
      }),
    };
    const { collectOpenWork } = await import("./handoff-sources");
    const out = await collectOpenWork(far, { orgId: ORG, userId: ALICE, now: NOW }, [P1]);
    expect(out.patients[0]?.items.some((i) => i.kind === "visit")).toBe(false);
  });
});
