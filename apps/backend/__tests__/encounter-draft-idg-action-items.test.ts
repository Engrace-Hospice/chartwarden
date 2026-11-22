// ADR-0114 S5b (VN-D64 to VN-D67) — the IDG follow-up visit's one linked action item, through the draft service: the open items M14 hands the calling viewer
// (never a title or body), one idempotent link or clear, and the draft's own `idg_followup` section. The switch answers 404 first; `idg.read` is asked ONLY for
// this section (a viewer without it gets that section as not drafted and the rest of the draft as it was, never a 403 at the draft), and by the two picker routes
// (403 naming it); an item the viewer is not handed (closed, reassigned, another patient's, Part 2 without disclosure) is the same 404 as an absent one and is
// never drafted. Dates are the organization's. Fakes only; the live suite proves the Drizzle unit and the real M14 seam. Synthetic ids only.
import type { IdgFollowUpItem } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { NOW, PATIENT_ID, fakePorts, selectionFor } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ITEM_1 = "00000000-0000-4000-8000-0000000000e1";
const ITEM_2 = "00000000-0000-4000-8000-0000000000e2";
const ITEM_SUD = "00000000-0000-4000-8000-0000000000e3";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
/** Every key the RN's IDG follow-up draft asks at the draft routes (its sources' keys), plus `idg.read` for the section alone. */
const SOURCE_KEYS = ["care_plan.read", "prescribing.read", "assessment.read_trend"];
const caller = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["rn"],
  membershipId: MEMBER,
  permissions: new Set<string>([...SOURCE_KEYS, "idg.read"]),
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
  });
  return {
    ...mem,
    seams,
    svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
  };
}

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

  it("is refused 403 naming idg.read for a caller without it, before M14 is asked", async () => {
    const { svc, seams } = service();
    await expectCode(svc.getIdgActionItems(withoutIdgKey, ENCOUNTER), "FORBIDDEN", 403);
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
    const error = await svc.getIdgActionItems(withoutIdgKey, ENCOUNTER).catch((e: unknown) => e);
    expect((error as Error).message).toContain("idg.read");
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

  it("clears the link with null, and clearing with nothing linked is a no-op that still answers the list", async () => {
    const linked = service({ memory: { idgLinks: [liveLink(ITEM_1)] } });
    const view = await linked.svc.setIdgActionItem(
      caller,
      ENCOUNTER,
      { actionItemId: null },
      AUDIT,
    );
    expect(linked.idgLinks[0]).toMatchObject({ removedAt: NOW, removedByMembershipId: MEMBER });
    expect(view.items.every((i) => !i.linked)).toBe(true);

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

  it("per viewer: an item M14 withholds (a flagged patient, a viewer without disclosure) is the same 404, and a link already made to it is cleared as Part 2 (fails closed)", async () => {
    const hidden = service({ items: [] });
    await expectCode(
      hidden.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: ITEM_SUD }, AUDIT),
      "NOT_FOUND",
      404,
    );
    expect(hidden.idgLinks).toEqual([]);

    const cleared = service({ items: [], memory: { idgLinks: [liveLink(ITEM_SUD, false)] } });
    await cleared.svc.setIdgActionItem(caller, ENCOUNTER, { actionItemId: null }, AUDIT);
    expect(cleared.idgLinks[0]).toMatchObject({
      removedAt: NOW,
      part2Derived: true,
    });
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
      "FORBIDDEN",
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
      text: "This visit follows up the team's decision of 2026-11-01: a referral; due 2026-11-20.",
      origins: ["idg_action_item"],
      part2Derived: false,
    });
  });

  it("is not drafted with no link, and M14 is not asked", async () => {
    const { svc, seams } = service();
    expect(await sectionOf(svc, caller)).toMatchObject({ state: "not_drafted", text: null });
    expect(seams.idgFollowUpItems).not.toHaveBeenCalled();
  });

  it("VN-D66: a viewer without idg.read gets the section as not drafted and the REST of the draft as it was, with no 403 and no M14 read", async () => {
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
