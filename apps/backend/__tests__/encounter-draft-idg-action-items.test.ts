// ADR-0114 S5b (VN-D64 to VN-D67) — the IDG follow-up visit's one linked action item, through the draft service: the open items M14 hands the calling viewer
// (never a title or body), one idempotent link or clear, and the draft's own `idg_followup` section. The switch answers 404 first; `idg.act` is asked ONLY for
// this section (a viewer without it gets that section as not drafted and the rest of the draft as it was, never a 403 at the draft), and by the two picker routes
// (403 naming it); an item the viewer is not handed (closed, reassigned, another patient's, Part 2 without disclosure) is the same 404 as an absent one and is
// never drafted. Dates are the organization's. Fakes only; the live suite proves the Drizzle unit and the real M14 seam. Synthetic ids only.
import type { IdgFollowUpItem } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { NOW, PATIENT_ID, fakePorts, selectionFor } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ITEM_1 = "00000000-0000-4000-8000-0000000000e1";
const ITEM_2 = "00000000-0000-4000-8000-0000000000e2";
const ITEM_SUD = "00000000-0000-4000-8000-0000000000e3";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
/** Every key the RN's IDG follow-up draft asks at the draft routes (its sources' keys), plus `idg.act` for the section alone. */
const SOURCE_KEYS = ["care_plan.read", "prescribing.read", "assessment.read_trend"];
const caller = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["rn"],
  membershipId: MEMBER,
  permissions: new Set<string>([...SOURCE_KEYS, "idg.act"]),
};
const withoutIdgKey = { ...caller, permissions: new Set<string>(SOURCE_KEYS) };
const IDG_RN = draftEncounterRow({ encounterType: "idg_followup", discipline: "rn" });
const ROUTINE_RN = {
  encounter: draftEncounterRow(),
  selection: selectionFor("routine_visit", "rn"),
};

// 03:30 UTC on 2026-11-02 is 22:30 on 2026-11-01 in the organization's zone (America/New_York, EST after the clocks change): the picker and the note state
// the organization's date, never the UTC one.
const item = (id: string, over: Partial<IdgFollowUpItem> = {}): IdgFollowUpItem => ({
  actionItemId: id,
  meetingAt: "2026-11-02T03:30:00.000Z" as IdgFollowUpItem["meetingAt"],
  decisionKind: "referral",
  dueAt: "2026-11-20T15:00:00.000Z" as IdgFollowUpItem["dueAt"],
  status: "open",
  sudRelated: false,
  ...over,
});

function service(
  over: {
    items?: readonly IdgFollowUpItem[];
    /** Items M14 no longer lists as open (completed, cancelled, auto-closed) but still hands over BY ID, as the linked item. */
    closed?: readonly IdgFollowUpItem[];
    memory?: Parameters<typeof memoryRunInOrg>[0];
    failing?: Error;
  } = {},
) {
  const mem = memoryRunInOrg({
    encounter: IDG_RN,
    selection: selectionFor("idg_followup", "rn"),
    ...over.memory,
  });
  const seams = fakePorts({
    idgFollowUpItems: async () => {
      if (over.failing !== undefined) throw over.failing;
      return over.items ?? [item(ITEM_1)];
    },
    linkedIdgFollowUpItem: async (_organizationId, _patientId, actionItemId) => {
      if (over.failing !== undefined) throw over.failing;
      return (
        [...(over.items ?? [item(ITEM_1)]), ...(over.closed ?? [])].find(
          (i) => i.actionItemId === actionItemId,
        ) ?? null
      );
    },
  });
  return {
    ...mem,
    seams,
    svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
  };
}

const SENTENCE =
  "This visit follows up the team's decision of 2026-11-01: a referral; due 2026-11-20.";

const liveLink = (actionItemId: string, part2Derived = false) => ({
  id: `idg-link-${actionItemId}`,
  actionItemId,
  removedAt: null,
  removedByMembershipId: null,
  part2Derived,
  linkedByMembershipId: MEMBER,
});

const expectCode = async (p: Promise<unknown>, code: string, status: number) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  expect((error as { code: string }).code).toBe(code);
  expect((error as { statusCode: number }).statusCode).toBe(status);
};

describe("getIdgActionItems", () => {
  it("lists the viewer's open items with the organization's dates and the note's fixed label, the linked one marked, and no title, body or payload", async () => {
    const { svc, seams } = service({
      items: [
        item(ITEM_1),
        item(ITEM_2, { decisionKind: "team_note", dueAt: null, status: "in_progress" }),
      ],
      memory: { idgLinks: [liveLink(ITEM_2)] },
    });
    const view = await svc.getIdgActionItems(caller, ENCOUNTER);

    expect(view).toEqual({
      patientId: PATIENT_ID,
      items: [
        {
          actionItemId: ITEM_1,
          meetingDate: "2026-11-01",
          decisionKind: "referral",
          decisionLabel: "a referral",
          dueDate: "2026-11-20",
          status: "open",
          linked: false,
        },
        {
          actionItemId: ITEM_2,
          meetingDate: "2026-11-01",
          decisionKind: "team_note",
          decisionLabel: "a team note",
          dueDate: null,
          status: "in_progress",
          linked: true,
        },
      ],
    });
    expect(seams.idgFollowUpItems).toHaveBeenCalledWith(
      caller.organizationId,
      PATIENT_ID,
      expect.objectContaining({ roles: ["rn"], membershipId: MEMBER }),
    );
    for (const key of Object.keys(view.items[0] ?? {})) {
      expect(["title", "bodyText", "payload", "sudRelated", "part2Derived"]).not.toContain(key);
    }
  });

  it("reads only the zone and the live link from the store: the clinician's stored selections are not loaded", async () => {
    const { svc, store } = service();
    await svc.getIdgActionItems(caller, ENCOUNTER);
    expect(store.loadSelection).not.toHaveBeenCalled();
    expect(store.previousSignedVisitAt).not.toHaveBeenCalled();
    expect(store.latestVitals).not.toHaveBeenCalled();
  });

  it("lists the linked item even when M14's auto-close has closed it, marked linked, with its real status, in meeting order; an item that is closed and NOT linked is never listed", async () => {
    const closedLinked = item(ITEM_2, {
      status: "auto_closed",
      meetingAt: "2026-11-09T15:00:00.000Z" as IdgFollowUpItem["meetingAt"],
    });
    const closedOther = item(ITEM_SUD, { status: "completed" });
    const { svc, seams } = service({
      items: [item(ITEM_1)],
      closed: [closedLinked, closedOther],
      memory: { idgLinks: [liveLink(ITEM_2)] },
    });
    const view = await svc.getIdgActionItems(caller, ENCOUNTER);
    expect(view.items.map((i) => [i.actionItemId, i.status, i.linked])).toEqual([
      [ITEM_2, "auto_closed", true], // the later meeting
      [ITEM_1, "open", false],
    ]);
    expect(seams.linkedIdgFollowUpItem).toHaveBeenCalledTimes(1);
    expect(seams.linkedIdgFollowUpItem).toHaveBeenCalledWith(
      caller.organizationId,
      PATIENT_ID,
      ITEM_2,
      expect.objectContaining({ membershipId: MEMBER }),
    );
  });

  it("does not read the linked item by id when the visit is linked to an item M14 still lists as open, or to none", async () => {
    const open = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    await open.svc.getIdgActionItems(caller, ENCOUNTER);
    const none = service();
    await none.svc.getIdgActionItems(caller, ENCOUNTER);
    expect(open.seams.linkedIdgFollowUpItem).not.toHaveBeenCalled();
    expect(none.seams.linkedIdgFollowUpItem).not.toHaveBeenCalled();
  });

  it("leaves out an item the note cannot state: a decision kind the corpus has no label for, or an instant that is not one", async () => {
    const { svc } = service({
      items: [
        item(ITEM_1),
        item(ITEM_2, { decisionKind: "something_new" as IdgFollowUpItem["decisionKind"] }),
        item(ITEM_SUD, { meetingAt: "yesterday" as IdgFollowUpItem["meetingAt"] }),
      ],
    });
    const view = await svc.getIdgActionItems(caller, ENCOUNTER);
    expect(view.items.map((i) => i.actionItemId)).toEqual([ITEM_1]);
  });

  it("is refused 403 naming idg.act for a caller without it, before M14 is asked", async () => {
    const { svc, seams } = service();
    await expectCode(
      svc.getIdgActionItems(withoutIdgKey, ENCOUNTER),
      "IDG_ACTION_PERMISSION_REQUIRED",
      403,
    );
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
    const error = await svc.getIdgActionItems(withoutIdgKey, ENCOUNTER).catch((e: unknown) => e);
    expect((error as Error).message).toContain("idg.act");
  });

  it("is refused 422 for a visit that is not an IDG follow-up", async () => {
    const { svc, seams } = service({ memory: ROUTINE_RN });
    await expectCode(svc.getIdgActionItems(caller, ENCOUNTER), "UNKNOWN_TEMPLATE_SECTION", 422);
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
  });

  it("answers 404 for a tenant with the switch off, before the encounter or M14 is read, and for an encounter that is not the caller's", async () => {
    const off = service({ memory: { enabled: false } });
    await expectCode(off.svc.getIdgActionItems(caller, ENCOUNTER), "NOT_FOUND", 404);
    expect(off.encounterCalls).toEqual([]);
    const absent = service({ memory: { encounter: null } });
    await expectCode(absent.svc.getIdgActionItems(caller, ENCOUNTER), "NOT_FOUND", 404);
    expect([off, absent].flatMap((s) => s.seams.idgFollowUpItems.mock.calls)).toEqual([]);
  });

  it("is a 503 DRAFT_UNAVAILABLE when M14 cannot answer, never an empty list", async () => {
    const { svc } = service({ failing: new Error("idg store down") });
    await expectCode(svc.getIdgActionItems(caller, ENCOUNTER), "DRAFT_UNAVAILABLE", 503);
  });
});

describe("setIdgActionItem", () => {
  it("links a candidate, locking the encounter row first, and answers the list with the item linked (the row carries M14's Part 2 verdict, false here)", async () => {
    const { svc, encounterCalls, idgLinks } = service({ items: [item(ITEM_1), item(ITEM_2)] });
    const view = await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);

    expect(encounterCalls).toEqual([{ id: ENCOUNTER, forUpdate: true }]);
    expect(idgLinks).toEqual([
      expect.objectContaining({
        actionItemId: ITEM_1,
        removedAt: null,
        part2Derived: false,
        linkedByMembershipId: MEMBER,
      }),
    ]);
    expect(view.items.map((i) => [i.actionItemId, i.linked])).toEqual([
      [ITEM_1, true],
      [ITEM_2, false],
    ]);
  });

  it("is idempotent: naming the linked item again writes nothing", async () => {
    const { svc, idgLinks } = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(idgLinks).toHaveLength(1);
    expect(idgLinks[0]?.removedAt).toBeNull();
  });

  it("replaces the linked item: the old row is removed (stamped with the member) and a new live one filed, so one live row remains", async () => {
    const { svc, idgLinks } = service({
      items: [item(ITEM_1), item(ITEM_2)],
      memory: { idgLinks: [liveLink(ITEM_1)] },
    });
    const view = await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_2 }, AUDIT);

    expect(idgLinks.filter((l) => l.removedAt === null).map((l) => l.actionItemId)).toEqual([
      ITEM_2,
    ]);
    expect(idgLinks.find((l) => l.actionItemId === ITEM_1)).toMatchObject({
      removedAt: NOW,
      removedByMembershipId: MEMBER,
    });
    expect(view.items.map((i) => i.linked)).toEqual([false, true]);
  });

  it("clears the link with null, and clearing with nothing linked is a no-op; a clear asks M14 nothing and answers no items (the client re-reads the list)", async () => {
    const linked = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    const view = await linked.svc.setIdgActionItem(
      caller,
      ENCOUNTER,
      { actionItemId: null },
      AUDIT,
    );
    expect(linked.idgLinks[0]).toMatchObject({ removedAt: NOW, removedByMembershipId: MEMBER });
    expect(view).toEqual({ patientId: PATIENT_ID, items: [] });
    expect(linked.seams.idgFollowUpItems).not.toHaveBeenCalled();

    const none = service();
    await none.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(none.idgLinks).toEqual([]);
  });

  it("answers an item the viewer is not handed (absent, closed, reassigned, another patient's) with the same 404, and writes nothing", async () => {
    const { svc, idgLinks } = service({ items: [item(ITEM_1)] });
    await expectCode(
      svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: UNKNOWN }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(idgLinks).toEqual([]);
  });

  it("files a Part 2 verdict on the row: an item M14 hands over flagged is linked as Part 2", async () => {
    const { svc, idgLinks } = service({ items: [item(ITEM_SUD, { sudRelated: true })] });
    await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT);
    expect(idgLinks[0]).toMatchObject({ actionItemId: ITEM_SUD, part2Derived: true });
  });

  it("naming the linked item again after M14 closed it is the idempotent no-op it was; another closed item is the same 404 as an absent one", async () => {
    const { svc, idgLinks } = service({
      items: [item(ITEM_2)],
      closed: [item(ITEM_1, { status: "auto_closed" }), item(ITEM_SUD, { status: "completed" })],
      memory: { idgLinks: [liveLink(ITEM_1)] },
    });
    const view = await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(idgLinks).toHaveLength(1);
    expect(idgLinks[0]?.removedAt).toBeNull();
    expect(view.items.find((i) => i.linked)).toMatchObject({
      actionItemId: ITEM_1,
      status: "auto_closed",
    });
    await expectCode(
      svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT),
      "NOT_FOUND",
      404,
    );
    // replacing the closed linked item with an open one leaves it removed, judged by its own verdict (not raised to Part 2 on a guess)
    await svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_2 }, AUDIT);
    expect(idgLinks.find((l) => l.actionItemId === ITEM_1)).toMatchObject({
      removedAt: NOW,
      part2Derived: false,
    });
  });

  it("audits a REFUSED link on a new unit: an item not handed is `not_offered`, a full table is `link_limit`, with the encounter and no item id; a bad request, a missing key and a signed note leave none", async () => {
    const hidden = service({ items: [] });
    await expectCode(
      hidden.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(hidden.refusals).toEqual([{ encounterId: ENCOUNTER, reason: "not_offered" }]);
    expect(JSON.stringify(hidden.refusals)).not.toContain(ITEM_SUD);
    // the refusal was written on its OWN unit with the request's audit context (the refused unit rolled back)
    expect(hidden.scopes.at(-1)).toMatchObject({ audit: AUDIT });

    const mem = memoryRunInOrg({
      encounter: IDG_RN,
      selection: selectionFor("idg_followup", "rn"),
    });
    const full = createDraftService({
      runInOrg: mem.runInOrg,
      seams: () => fakePorts({ idgFollowUpItems: async () => [item(ITEM_1)] }),
      now: () => NOW,
    });
    mem.store.setIdgActionItemLink.mockRejectedValueOnce(
      new EncounterStateError("IDG_ACTION_ITEM_LINK_LIMIT", "nothing was changed"),
    );
    await expectCode(
      full.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "IDG_ACTION_ITEM_LINK_LIMIT",
      409,
    );
    expect(mem.refusals).toEqual([{ encounterId: ENCOUNTER, reason: "link_limit" }]);

    const quiet = [
      service({ memory: { enabled: false } }),
      service({ memory: { encounter: null } }),
      service({ memory: { encounter: draftEncounterRow({ ...IDG_RN, status: "signed" }) } }),
      service({ memory: ROUTINE_RN }),
      service(),
    ];
    await Promise.allSettled([
      quiet[0]?.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      quiet[1]?.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      quiet[2]?.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      quiet[3]?.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      quiet[4]?.svc.setIdgActionItem(withoutIdgKey, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
    ]);
    expect(quiet.flatMap((q) => q.refusals)).toEqual([]);
    // a success and a clear audit nothing of this kind either
    const ok = service();
    await ok.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    await ok.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(ok.refusals).toEqual([]);
  });

  it("a refusal whose audit event cannot be written is still the refusal, and is reported", async () => {
    const reported: unknown[] = [];
    const mem = memoryRunInOrg({
      encounter: IDG_RN,
      selection: selectionFor("idg_followup", "rn"),
      refusalAuditFails: true,
    });
    const svc = createDraftService({
      runInOrg: mem.runInOrg,
      seams: () => fakePorts({ idgFollowUpItems: async () => [] }),
      now: () => NOW,
      onRefusalAuditFailure: (error) => reported.push(error),
    });
    await expectCode(
      svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(reported).toHaveLength(1);
  });

  it("a clear needs no idg.act and no M14: a clinician who lost the key, or whose M14 is down, can still clear a link they made (the row is raised to Part 2, fails closed)", async () => {
    const lostKey = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    await lostKey.svc.setIdgActionItem(withoutIdgKey, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(lostKey.idgLinks[0]).toMatchObject({ removedAt: NOW, part2Derived: true });
    expect(lostKey.seams.idgFollowUpItems).not.toHaveBeenCalled();

    const down = service({
      failing: new Error("idg store down"),
      memory: { idgLinks: [liveLink(ITEM_1)] },
    });
    await down.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(down.idgLinks[0]).toMatchObject({ removedAt: NOW, removedByMembershipId: MEMBER });
    expect(down.seams.idgFollowUpItems).not.toHaveBeenCalled();
  });

  it("a clear still takes the author's checks: the switch, the template and an editable note", async () => {
    const off = service({ memory: { enabled: false, idgLinks: [liveLink(ITEM_1)] } });
    await expectCode(
      off.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT),
      "NOT_FOUND",
      404,
    );
    const routine = service({ memory: { ...ROUTINE_RN } });
    await expectCode(
      routine.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT),
      "UNKNOWN_TEMPLATE_SECTION",
      422,
    );
    const signed = service({
      memory: {
        encounter: draftEncounterRow({ ...IDG_RN, status: "signed" }),
        idgLinks: [liveLink(ITEM_1)],
      },
    });
    await expect(
      signed.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(signed.idgLinks[0]?.removedAt).toBeNull();
  });

  it("per viewer: an item M14 withholds (a flagged patient, a viewer without disclosure) is the same 404, and nothing is written", async () => {
    const hidden = service({ items: [] });
    await expectCode(
      hidden.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(hidden.idgLinks).toEqual([]);
  });

  it("replacing the linked item judges the row being left by M14's verdict now: one M14 no longer hands is removed as Part 2 (fails closed), one it still hands clean is not", async () => {
    // ITEM_SUD is linked but M14 hands nothing for it any more (the patient was flagged, a viewer without disclosure, reassigned)
    const withheld = service({
      items: [item(ITEM_2)],
      memory: { idgLinks: [liveLink(ITEM_SUD, false)] },
    });
    await withheld.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_2 }, AUDIT);
    expect(withheld.idgLinks.find((l) => l.actionItemId === ITEM_SUD)).toMatchObject({
      removedAt: NOW,
      part2Derived: true,
    });
    expect(withheld.idgLinks.find((l) => l.actionItemId === ITEM_2)).toMatchObject({
      removedAt: null,
      part2Derived: false,
    });

    // ITEM_1 is linked and M14 still hands it, clean: removed, and NOT raised
    const handed = service({
      items: [item(ITEM_1), item(ITEM_2)],
      memory: { idgLinks: [liveLink(ITEM_1, false)] },
    });
    await handed.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_2 }, AUDIT);
    expect(handed.idgLinks.find((l) => l.actionItemId === ITEM_1)).toMatchObject({
      removedAt: NOW,
      part2Derived: false,
    });
  });

  it("closes a stale verdict: an item that turned Part 2 after M14's candidate read is raised in the SAME unit (also when the item is named again); one still plain is not raised; one M14 no longer hands fails closed", async () => {
    const asked = (byId: IdgFollowUpItem | null, memory?: Parameters<typeof memoryRunInOrg>[0]) => {
      const mem = memoryRunInOrg({
        encounter: IDG_RN,
        selection: selectionFor("idg_followup", "rn"),
        ...memory,
      });
      const seams = fakePorts({
        idgFollowUpItems: async () => [item(ITEM_1)], // the candidate read: plain
        linkedIdgFollowUpItem: async () => byId, // the re-ask after the insert
      });
      return {
        ...mem,
        seams,
        svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
      };
    };

    const flipped = asked(item(ITEM_1, { sudRelated: true }));
    await flipped.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(flipped.idgLinks).toHaveLength(1);
    expect(flipped.idgLinks[0]).toMatchObject({ actionItemId: ITEM_1, part2Derived: true });
    expect(flipped.seams.linkedIdgFollowUpItem).toHaveBeenCalledTimes(1);

    const named = asked(item(ITEM_1, { sudRelated: true }), {
      idgLinks: [liveLink(ITEM_1, false)],
    });
    await named.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(named.idgLinks).toHaveLength(1);
    expect(named.idgLinks[0]).toMatchObject({ part2Derived: true, removedAt: null });

    const gone = asked(null);
    await gone.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(gone.idgLinks[0]).toMatchObject({ part2Derived: true });

    // still plain: the row stays plain (not every link is Part 2), and nothing was raised
    const plain = asked(item(ITEM_1));
    await plain.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT);
    expect(plain.idgLinks[0]).toMatchObject({ part2Derived: false });
    expect(plain.store.raiseIdgLinkPart2).not.toHaveBeenCalled();

    // an item the candidate read already judged Part 2 is not asked again (a flag only goes up)
    const already = service({ items: [item(ITEM_SUD, { sudRelated: true })] });
    await already.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT);
    expect(already.seams.linkedIdgFollowUpItem).not.toHaveBeenCalled();
  });

  it("a re-ask that fails answers 503 DRAFT_UNAVAILABLE, never a success, and is no audited refusal (that nothing persists is proved live: this store does not roll back)", async () => {
    const mem = memoryRunInOrg({
      encounter: IDG_RN,
      selection: selectionFor("idg_followup", "rn"),
    });
    const svc = createDraftService({
      runInOrg: mem.runInOrg,
      seams: () =>
        fakePorts({
          idgFollowUpItems: async () => [item(ITEM_1)],
          linkedIdgFollowUpItem: async () => {
            throw new Error("idg store down");
          },
        }),
      now: () => NOW,
    });
    await expectCode(
      svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "DRAFT_UNAVAILABLE",
      503,
    );
    expect(mem.refusals).toEqual([]);
  });

  it("the service itself asks that the caller authored the visit (the route's own rule is not the only one): anyone else is the same 404 as an absent visit, a link and a clear alike, and nothing is read or written", async () => {
    const other = { ...caller, membershipId: "00000000-0000-4000-8000-0000000000bc" };
    const linked = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    await expectCode(
      linked.svc.setIdgActionItem(other, ENCOUNTER, { actionItemId: ITEM_2 }, AUDIT),
      "NOT_FOUND",
      404,
    );
    await expectCode(
      linked.svc.setIdgActionItem(other, ENCOUNTER, { actionItemId: null }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(linked.idgLinks).toEqual([liveLink(ITEM_1)]);
    expect(linked.seams.idgFollowUpItems).not.toHaveBeenCalled();
    expect(linked.seams.linkedIdgFollowUpItem).not.toHaveBeenCalled();
    // no new signal: it is no refusal of a link the author named, so it audits nothing
    expect(linked.refusals).toEqual([]);

    // the same 404 as an encounter that is not there, and before the note's state is told (a signed note would be 409 to the author)
    const absent = service({ memory: { encounter: null } });
    await expectCode(
      absent.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "NOT_FOUND",
      404,
    );
    const signed = service({
      memory: { encounter: draftEncounterRow({ ...IDG_RN, status: "signed" }) },
    });
    await expectCode(
      signed.svc.setIdgActionItem(other, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "NOT_FOUND",
      404,
    );

    // a clear keeps its own checks and nothing more: the author clears without idg.act, as before
    await linked.svc.setIdgActionItem(withoutIdgKey, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(linked.idgLinks[0]).toMatchObject({ removedAt: NOW });
  });

  it("refuses a signed note's change (an addendum is the way) and writes nothing", async () => {
    const signed = service({
      memory: { encounter: draftEncounterRow({ ...IDG_RN, status: "signed" }) },
    });
    await expect(
      signed.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(signed.idgLinks).toEqual([]);
  });

  it("asks the same switch, template and key as the read, and writes nothing when refused", async () => {
    const off = service({ memory: { enabled: false } });
    await expectCode(
      off.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "NOT_FOUND",
      404,
    );
    const keyless = service();
    await expectCode(
      keyless.svc.setIdgActionItem(withoutIdgKey, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "IDG_ACTION_PERMISSION_REQUIRED",
      403,
    );
    const routine = service({ memory: ROUTINE_RN });
    await expectCode(
      routine.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_1 }, AUDIT),
      "UNKNOWN_TEMPLATE_SECTION",
      422,
    );
    expect([off, keyless, routine].flatMap((s) => s.idgLinks)).toEqual([]);
    expect(keyless.seams.idgFollowUpItems).not.toHaveBeenCalled();
  });
});

const sectionOf = async (
  svc: ReturnType<typeof service>["svc"],
  who: typeof caller,
  id = "idg_followup",
) => (await svc.getDraft(who, ENCOUNTER)).sections.find((s) => s.sectionId === id);

describe("the draft's own idg_followup section", () => {
  it("states the linked item as one sentence in the organization's dates, from kind `idg_action_item`, and not as Part 2", async () => {
    const { svc } = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    const section = await sectionOf(svc, caller);
    expect(section).toMatchObject({
      state: "unresolved",
      text: SENTENCE,
      origins: ["idg_action_item"],
      part2Derived: false,
    });
  });

  it("is not drafted with no link, and M14 is not asked", async () => {
    const { svc, seams } = service();
    expect(await sectionOf(svc, caller)).toMatchObject({ state: "not_drafted", text: null });
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
  });

  it("VN-D66: a viewer without idg.act gets the section as not drafted and the REST of the draft as it was, with no 403 and no M14 read", async () => {
    const { svc, seams } = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    const withKey = await svc.getDraft(caller, ENCOUNTER);
    seams.idgFollowUpItems.mockClear();

    const without = await svc.getDraft(withoutIdgKey, ENCOUNTER);
    expect(without.sections.find((s) => s.sectionId === "idg_followup")).toMatchObject({
      state: "not_drafted",
      text: null,
    });
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
    // Every other section reads exactly as it does for the viewer with the key.
    const rest = (v: typeof withKey) => v.sections.filter((s) => s.sectionId !== "idg_followup");
    expect(rest(without)).toEqual(rest(withKey));
    expect(without.sections.length).toBe(withKey.sections.length);
  });

  it("H1: the draft does not depend on the item staying open: a section whose item M14's auto-close has closed since is still drafted, by id", async () => {
    for (const status of ["completed", "cancelled", "auto_closed"] as const) {
      const { svc, seams } = service({
        items: [],
        closed: [item(ITEM_1, { status })],
        memory: { idgLinks: [liveLink(ITEM_1)] },
      });
      expect(await sectionOf(svc, caller), status).toMatchObject({
        state: "unresolved",
        text: SENTENCE,
        origins: ["idg_action_item"],
      });
      // the draft read is the by-id read alone: it never searches M14's open list
      expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
      expect(seams.linkedIdgFollowUpItem).toHaveBeenCalledTimes(1);
    }
  });

  it("never drafts stale text: an item M14 no longer hands this viewer (closed, completed, reassigned, Part 2 withheld) leaves the section not drafted", async () => {
    const { svc } = service({ items: [item(ITEM_2)], memory: { idgLinks: [liveLink(ITEM_1)] } });
    expect(await sectionOf(svc, caller)).toMatchObject({ state: "not_drafted", text: null });
  });

  it("leaves the section not drafted, without failing the draft, for an item whose decision kind the corpus cannot label", async () => {
    const { svc } = service({
      items: [item(ITEM_1, { decisionKind: "something_new" as IdgFollowUpItem["decisionKind"] })],
      memory: { idgLinks: [liveLink(ITEM_1)] },
    });
    expect(await sectionOf(svc, caller)).toMatchObject({ state: "not_drafted" });
  });

  it("is Part 2 derived when M14 flags the item (fails closed), and states no due date when there is none", async () => {
    const { svc } = service({
      items: [item(ITEM_SUD, { sudRelated: true, dueAt: null })],
      memory: { idgLinks: [liveLink(ITEM_SUD, true)] },
    });
    expect(await sectionOf(svc, caller)).toMatchObject({
      text: "This visit follows up the team's decision of 2026-11-01: a referral.",
      part2Derived: true,
    });
  });

  it("is a 503 DRAFT_UNAVAILABLE when M14 cannot answer for a linked visit, and silent for an unlinked one", async () => {
    const linked = service({
      failing: new Error("idg store down"),
      memory: { idgLinks: [liveLink(ITEM_1)] },
    });
    await expectCode(linked.svc.getDraft(caller, ENCOUNTER), "DRAFT_UNAVAILABLE", 503);
    const unlinked = service({ failing: new Error("idg store down") });
    await expect(unlinked.svc.getDraft(caller, ENCOUNTER)).resolves.toBeDefined();
  });

  it("a visit that is not an IDG follow-up never reads M14 or the link", async () => {
    const { svc, seams, store } = service({ memory: ROUTINE_RN });
    await svc.getDraft(caller, ENCOUNTER);
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
    expect(store.linkedIdgActionItemId).not.toHaveBeenCalled();
  });
});
