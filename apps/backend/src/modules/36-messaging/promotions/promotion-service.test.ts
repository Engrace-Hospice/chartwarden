import { describe, expect, it } from "vitest";
import {
  ALICE,
  BOB,
  CAROL,
  CHANNEL,
  MEETING,
  P1,
  actor,
  buildKit,
  codeOf,
  sha,
  standardRequest,
} from "./promotion-test-kit";

describe("promotion service - request", () => {
  it("creates a proposed request with attribution and publishes one PHI-free event", async () => {
    const kit = buildKit();
    const { promotion, created } = await kit.service.request(actor(ALICE), standardRequest);
    expect(created).toBe(true);
    expect(promotion).toMatchObject({
      status: "proposed",
      target_module: "m8",
      target_kind: "encounter_addendum",
      requested_by: ALICE,
      source_author_user_id: BOB,
      source_author_display_name: "Bob",
      patient_id: P1,
      result_ref: null,
      allowed_actions: ["withdraw"],
    });
    expect(kit.published).toHaveLength(1);
    expect(kit.published[0]?.eventName).toBe("m36.promotion.requested");
    const payload = JSON.stringify(kit.published[0]?.payload);
    expect(payload).not.toContain(P1);
    expect(payload).not.toContain(sha("Patient reports new pain in left hip"));
    expect(Object.keys(kit.published[0]?.payload ?? {})).not.toContain("patientId");
  });

  it("returns the existing proposed request on a repeat and publishes nothing more", async () => {
    const kit = buildKit();
    const first = await kit.service.request(actor(ALICE), standardRequest);
    const again = await kit.service.request(actor(ALICE), standardRequest);
    expect(again.created).toBe(false);
    expect(again.promotion.id).toBe(first.promotion.id);
    expect(kit.published).toHaveLength(1);
    expect(kit.store.rows.size).toBe(1);
  });

  it("supersedes the old proposal and inserts a new one when the message was edited", async () => {
    const kit = buildKit();
    const first = await kit.service.request(actor(ALICE), standardRequest);
    kit.editMessage("Corrected: pain is in the right hip");
    const second = await kit.service.request(actor(ALICE), standardRequest);
    expect(second.created).toBe(true);
    expect(second.promotion.id).not.toBe(first.promotion.id);
    expect(kit.store.rows.get(first.promotion.id)).toMatchObject({
      status: "superseded",
      reasonCode: "superseded",
    });
    expect(kit.published).toHaveLength(2);
  });

  it("allows a different target for the same message", async () => {
    const kit = buildKit();
    await kit.service.request(actor(ALICE), standardRequest);
    const idg = await kit.service.request(actor(ALICE), {
      ...standardRequest,
      targetModule: "m14",
      targetKind: "idg_agenda_item",
      suggestedTargetRef: MEETING,
    });
    expect(idg.created).toBe(true);
    expect(idg.promotion.suggested_target_ref).toBe(MEETING);
  });

  it("refuses a message that is not in a patient's channel with 422", async () => {
    const kit = buildKit({ channelKind: "team", subjectId: null });
    expect(await codeOf(kit.service.request(actor(ALICE), standardRequest))).toBe(
      "422:PROMOTION_SOURCE_NOT_PATIENT_LINKED",
    );
    expect(kit.store.rows.size).toBe(0);
  });

  it.each([
    ["a channel the caller cannot see", { viewableChannels: [] }],
    ["a deleted message", { live: false }],
    ["a system-authored message", { authorUserId: null }],
    ["a caller without messaging.promote", { missingPermission: [`${ALICE}:messaging.promote`] }],
    ["a caller without patient.read", { missingPermission: [`${ALICE}:patient.read`] }],
    ["a Part 2 denial", { part2Denied: [`${ALICE}:${P1}`] }],
    ["a Part 2 gate that throws", { part2Throws: true }],
  ])("answers a uniform 404 and writes nothing for %s", async (_name, opts) => {
    const kit = buildKit(opts);
    expect(await codeOf(kit.service.request(actor(ALICE), standardRequest))).toBe("404:NOT_FOUND");
    expect(kit.store.rows.size).toBe(0);
    expect(kit.published).toHaveLength(0);
  });

  it("refuses a target that is not one of the two chart targets", async () => {
    const kit = buildKit();
    for (const [module, kind] of [
      ["m11", "order"],
      ["m8", "idg_agenda_item"],
      ["m12", "medication"],
    ]) {
      expect(
        await codeOf(
          kit.service.request(actor(ALICE), {
            ...standardRequest,
            targetModule: module as string,
            targetKind: kind as string,
          }),
        ),
      ).toBe("422:PROMOTION_TARGET_INVALID");
    }
  });

  it("refuses a suggested meeting on the m8 target and an unknown meeting on m14", async () => {
    const kit = buildKit();
    expect(
      await codeOf(
        kit.service.request(actor(ALICE), { ...standardRequest, suggestedTargetRef: MEETING }),
      ),
    ).toBe("422:PROMOTION_TARGET_INVALID");
    expect(
      await codeOf(
        kit.service.request(actor(ALICE), {
          ...standardRequest,
          targetModule: "m14",
          targetKind: "idg_agenda_item",
          suggestedTargetRef: "00000000-0000-4000-8000-0000000000ff",
        }),
      ),
    ).toBe("422:PROMOTION_SUGGESTED_REF_INVALID");
  });
});

describe("promotion service - reads and withdraw", () => {
  it("lets a channel viewer read the request but not withdraw it", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const seen = await kit.service.get(actor(CAROL), promotion.id);
    expect(seen.allowed_actions).toEqual([]);
    expect(await codeOf(kit.service.withdraw(actor(CAROL), promotion.id))).toBe("403:FORBIDDEN");
  });

  it("answers the same 404 for a missing request and one the caller may not see", async () => {
    const kit = buildKit({ part2Denied: [`${CAROL}:${P1}`] });
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const missing = await codeOf(
      kit.service.get(actor(CAROL), "00000000-0000-4000-8000-0000000000ee"),
    );
    const hidden = await codeOf(kit.service.get(actor(CAROL), promotion.id));
    expect(hidden).toBe(missing);
    expect(missing).toBe("404:NOT_FOUND");
  });

  it("hides rows from a caller who lost patient.read", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const lost = buildKit({ missingPermission: [`${ALICE}:patient.read`] });
    expect(await lost.service.listMine(actor(ALICE), { state: "all", limit: 10 })).toEqual([]);
    expect(await kit.service.listMine(actor(ALICE), { state: "all", limit: 10 })).toHaveLength(1);
    expect(promotion.id).toBeTruthy();
  });

  it("lists the requests on a message only to someone who can see the channel", async () => {
    const kit = buildKit();
    await kit.service.request(actor(ALICE), standardRequest);
    expect(
      await kit.service.listForMessage(actor(CAROL), CHANNEL, standardRequest.messageId),
    ).toHaveLength(1);
    kit.viewable.clear();
    expect(
      await codeOf(kit.service.listForMessage(actor(CAROL), CHANNEL, standardRequest.messageId)),
    ).toBe("404:NOT_FOUND");
  });

  it("lets the requester withdraw once; a repeat is idempotent and the closed request leaves the active list", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const withdrawn = await kit.service.withdraw(actor(ALICE), promotion.id);
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      reason_code: "requester",
      allowed_actions: [],
    });
    expect((await kit.service.withdraw(actor(ALICE), promotion.id)).status).toBe("withdrawn");
    expect(await kit.service.listMine(actor(ALICE), { state: "active", limit: 10 })).toEqual([]);
    expect(await kit.service.listMine(actor(ALICE), { state: "closed", limit: 10 })).toHaveLength(
      1,
    );
  });

  it("allows a new proposal after a withdrawal", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.withdraw(actor(ALICE), promotion.id);
    const again = await kit.service.request(actor(ALICE), standardRequest);
    expect(again.created).toBe(true);
  });
});

describe("promotion service - outcomes from the owning module", () => {
  const event = (id: string, over: Record<string, unknown> = {}) => ({
    ownerModule: "m8",
    promotionRequestId: id,
    outcome: "accepted" as const,
    resultRef: "00000000-0000-4000-8000-0000000000b1",
    decidedByUserId: CAROL,
    reasonCode: null,
    at: new Date("2026-10-14T13:00:00.000Z"),
    ...over,
  });

  it("records an acceptance with the result and the decider, and reports the requester", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const r = await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(r).toEqual({ applied: "accepted", requestedByUserId: ALICE });
    expect(kit.store.rows.get(promotion.id)).toMatchObject({
      status: "accepted",
      decidedByUserId: CAROL,
      reasonCode: null,
    });
  });

  it("lets an acceptance land on a withdrawn request (the signed record wins)", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.withdraw(actor(ALICE), promotion.id);
    const r = await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(r.applied).toBe("accepted");
    expect(kit.store.rows.get(promotion.id)).toMatchObject({
      status: "accepted",
      reasonCode: null,
    });
  });

  it("closes the newer proposed sibling when a superseded request is accepted (one signed record per message)", async () => {
    const kit = buildKit();
    const { promotion: r1 } = await kit.service.request(actor(ALICE), standardRequest);
    kit.editMessage("The edited text");
    const { promotion: r2 } = await kit.service.request(actor(ALICE), standardRequest);
    expect(kit.store.rows.get(r1.id)?.status).toBe("superseded");
    expect(kit.store.rows.get(r2.id)?.status).toBe("proposed");
    const r = await kit.service.applyOutcome(actor(ALICE).orgId, event(r1.id));
    expect(r.applied).toBe("accepted");
    expect(kit.store.rows.get(r1.id)?.status).toBe("accepted");
    expect(kit.store.rows.get(r2.id)).toMatchObject({
      status: "superseded",
      reasonCode: "superseded",
    });
  });

  it("leaves a newer sibling alone when the accepted request was itself proposed", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(
      await kit.store.supersedeSiblings(
        {} as never,
        actor(ALICE).orgId,
        kit.store.rows.get(promotion.id) as never,
      ),
    ).toBe(0);
  });

  it("reports (does not apply) an acceptance that arrives for a rejected request", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.applyOutcome(
      actor(ALICE).orgId,
      event(promotion.id, { outcome: "rejected", resultRef: null, reasonCode: "other" }),
    );
    const r = await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(r.applied).toBe("conflict");
    expect(kit.store.rows.get(promotion.id)?.status).toBe("rejected");
  });

  it("converges on redelivery", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    const again = await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(again.applied).toBe("noop");
  });

  it("ignores an event from the wrong owner and one for an unknown request", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    expect(
      (
        await kit.service.applyOutcome(
          actor(ALICE).orgId,
          event(promotion.id, { ownerModule: "m14" }),
        )
      ).applied,
    ).toBe("ignored");
    expect(
      (
        await kit.service.applyOutcome(
          actor(ALICE).orgId,
          event("00000000-0000-4000-8000-0000000000ee"),
        )
      ).applied,
    ).toBe("unknown");
    expect(kit.store.rows.get(promotion.id)?.status).toBe("proposed");
  });

  it("logs ids only and changes nothing when a different result arrives for an accepted request", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    const r = await kit.service.applyOutcome(
      actor(ALICE).orgId,
      event(promotion.id, { resultRef: "00000000-0000-4000-8000-0000000000b2" }),
    );
    expect(r.applied).toBe("conflict");
    expect(Object.keys(kit.warnings[0]?.context ?? {}).sort()).toEqual([
      "organizationId",
      "promotionRequestId",
    ]);
  });

  it("records a rejection with its reason and does nothing on a closed request", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const reject = event(promotion.id, {
      outcome: "rejected",
      resultRef: null,
      reasonCode: "duplicate",
    });
    expect((await kit.service.applyOutcome(actor(ALICE).orgId, reject)).applied).toBe("rejected");
    expect(kit.store.rows.get(promotion.id)).toMatchObject({
      status: "rejected",
      reasonCode: "duplicate",
    });
    expect((await kit.service.applyOutcome(actor(ALICE).orgId, reject)).applied).toBe("noop");
  });

  it("changes nothing for a request whose requester has left (no alert is the consumer's concern)", async () => {
    const kit = buildKit();
    const { promotion } = await kit.service.request(actor(ALICE), standardRequest);
    const r = await kit.service.applyOutcome(actor(ALICE).orgId, event(promotion.id));
    expect(r).toMatchObject({ applied: "accepted", requestedByUserId: ALICE });
  });
});
