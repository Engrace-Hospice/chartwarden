// ADR-0114 S5b — the exit from a stale refusal. A confirmed `idg_followup` section that a recompute no longer drafts (M14 reassigned the item, or no longer clears the
// viewer) is refused DRAFT_SECTION_STALE at finalize, sign and an addendum's sign; the author must always have a way out of it. For an unsigned note the way is to clear the
// link and write their own words, but a SIGNED note's link row is frozen and an addendum has no void, so the way out for both is to WITHDRAW the confirmation: a deselect
// of a section that has a stored confirmation and no longer drafts writes the withdrawn row a deselect of a section that went empty writes today. A section that is not
// drafted can never be CONFIRMED. Fake seams, in-memory store; no database.
import type { IdgFollowUpItem } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { restrictToNamed } from "../src/modules/08-encounters/drafting/amendment-note";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { assertResolved, readNoteDraft } from "../src/modules/08-encounters/drafting/note-draft";
import { NOW, fakePorts, reader, selectionFor } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const ITEM = "00000000-0000-4000-8000-0000000000e1";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
const NOTE = draftEncounterRow({ encounterType: "idg_followup", discipline: "md" });
const SIGNED = draftEncounterRow({
  encounterType: "idg_followup",
  discipline: "md",
  status: "signed",
});
const SCOPE = { organizationId: NOTE.organizationId, userId: "u", now: NOW };
const KEYED = reader({ roles: ["md"], permissions: new Set(["idg.act"]) });
const caller = {
  organizationId: NOTE.organizationId,
  userId: "u",
  roles: KEYED.roles,
  membershipId: MEMBER,
  permissions: KEYED.permissions,
};

const item = (): IdgFollowUpItem => ({
  actionItemId: ITEM,
  meetingAt: "2026-11-02T15:00:00.000Z" as IdgFollowUpItem["meetingAt"],
  decisionKind: "referral",
  dueAt: null,
  status: "open",
  sudRelated: false,
});
const link = () => ({
  id: "idg-link-1",
  actionItemId: ITEM,
  removedAt: null,
  removedByMembershipId: null,
  part2Derived: false,
  linkedByMembershipId: MEMBER,
});

function harness(over: { signed?: boolean } = {}) {
  const encounter = over.signed === true ? SIGNED : NOTE;
  const mem = memoryRunInOrg({
    encounter,
    selection: selectionFor("idg_followup", "md"),
    idgLinks: [link()],
    ...(over.signed === true
      ? {
          amendment: {
            id: ADDENDUM,
            status: "draft" as const,
            authoredByMembershipId: MEMBER,
            sectionIds: ["idg_followup"],
          },
        }
      : {}),
  });
  const seams = fakePorts({ linkedIdgFollowUpItem: async () => item() });
  const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
  return { ...mem, encounter, seams, svc };
}
type Harness = ReturnType<typeof harness>;

/** The section as the draft shows it to the author now (a note's, or the addendum's). */
async function seen(h: Harness, addendum: boolean) {
  const draft = addendum
    ? await h.svc.getAmendmentDraft(caller, h.encounter.id, ADDENDUM)
    : await h.svc.getDraft(caller, h.encounter.id);
  return draft.sections.find((s) => s.sectionId === "idg_followup");
}
const confirm = async (h: Harness, addendum: boolean) => {
  const section = await seen(h, addendum);
  const body = {
    resolution: "confirmed" as const,
    contentHash: section?.contentHash as string,
    corpusVersion: section?.corpusVersion as string,
  };
  return addendum
    ? h.svc.resolveAmendmentSection(caller, h.encounter.id, ADDENDUM, "idg_followup", body, AUDIT)
    : h.svc.resolveSection(caller, h.encounter.id, "idg_followup", body, AUDIT);
};
/** What the client has for a section that is not drafted: no hash of its own, so whatever well-formed value it sends is ignored. */
const NOTHING_SEEN = { contentHash: "0".repeat(64), corpusVersion: "none" };
const resolveUndrafted = (h: Harness, addendum: boolean, resolution: "confirmed" | "deselected") =>
  addendum
    ? h.svc.resolveAmendmentSection(
        caller,
        h.encounter.id,
        ADDENDUM,
        "idg_followup",
        { resolution, ...NOTHING_SEEN },
        AUDIT,
      )
    : h.svc.resolveSection(
        caller,
        h.encounter.id,
        "idg_followup",
        { resolution, ...NOTHING_SEEN },
        AUDIT,
      );
const saved = (h: Harness, addendum: boolean) =>
  (addendum ? h.amendmentSaved : h.saved).get("idg_followup");

/** The recompute the sign takes: the note's, or the addendum's own (through its resolutions, restricted to the sections it names). */
const recompute = (h: Harness, addendum: boolean) =>
  h.runInOrg(SCOPE, async (unit) => {
    const draft = await readNoteDraft(
      addendum ? { enabled: unit.enabled, store: unit.amendmentStore(ADDENDUM) } : unit,
      h.seams,
      h.encounter,
      KEYED,
      NOW,
    );
    return draft === null || !addendum ? draft : restrictToNamed(draft, ["idg_followup"]);
  });

const codeOf = async (p: Promise<unknown>): Promise<[string, number]> => {
  const error = (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code: string; statusCode: number } | undefined;
  expect(error).toBeDefined();
  return [error?.code ?? "", error?.statusCode ?? 0];
};

describe.each([
  ["an unsigned note", false],
  ["an addendum to a signed note", true],
] as const)(
  "%s: a confirmed idg_followup section the recompute no longer drafts",
  (_name, addendum) => {
    /** Confirmed while it drafts, then M14 stops handing the item (reassigned, or no longer cleared for Part 2). */
    async function stale() {
      const h = harness({ signed: addendum });
      expect((await confirm(h, addendum)).state).toBe("confirmed");
      expect((await recompute(h, addendum))?.actions).toEqual([]);
      h.seams.linkedIdgFollowUpItem.mockImplementation(async () => null);
      return h;
    }

    it("is refused DRAFT_SECTION_STALE on every attempt, then withdrawn by a deselect, and then it signs", async () => {
      const h = await stale();
      const refused = await recompute(h, addendum);
      expect(refused?.actions).toEqual([{ sectionId: "idg_followup", reason: "stale" }]);
      expect(() => assertResolved(refused)).toThrow(
        expect.objectContaining({ code: "DRAFT_SECTION_STALE", statusCode: 409 }),
      );
      expect(() => assertResolved(refused)).toThrow(); // the same again: nothing about the refusal changes by itself

      const view = await resolveUndrafted(h, addendum, "deselected");
      expect(view).toMatchObject({ sectionId: "idg_followup", state: "not_drafted" });

      const after = await recompute(h, addendum);
      expect(after?.actions).toEqual([]);
      expect(() => assertResolved(after)).not.toThrow();
    });

    it("writes the withdrawn row a deselect of an emptied section writes (deselected, bound to a hash no draft can equal, no source ids, Part 2 fails closed) and one audit event naming what was withdrawn", async () => {
      const h = await stale();
      const confirmed = saved(h, addendum);
      await resolveUndrafted(h, addendum, "deselected");

      const row = saved(h, addendum);
      expect(row).toMatchObject({
        sectionId: "idg_followup",
        resolution: "deselected",
        sourceRefs: [],
        part2Derived: true,
        resolvedByMembershipId: MEMBER,
      });
      expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.contentHash).not.toBe(confirmed?.contentHash);
      // the client's value is not what is kept or recorded
      expect(JSON.stringify([row, h.events])).not.toContain(NOTHING_SEEN.contentHash);

      expect(h.events.at(-1)).toMatchObject({
        sectionId: "idg_followup",
        resolution: "deselected",
        addendumId: addendum ? ADDENDUM : null,
        contentHash: confirmed?.contentHash,
        boundContentHash: row?.contentHash,
        sourceRefs: [],
        carePlanElementsLinked: 0,
        carePlanElementsRemoved: 0,
      });
    });

    it("never CONFIRMS a section that is not drafted: 409 DRAFT_SECTION_STALE and nothing is written", async () => {
      const h = await stale();
      const before = saved(h, addendum);
      const eventsBefore = h.events.length;
      expect(await codeOf(resolveUndrafted(h, addendum, "confirmed"))).toEqual([
        "DRAFT_SECTION_STALE",
        409,
      ]);
      expect(saved(h, addendum)).toBe(before);
      expect(h.events).toHaveLength(eventsBefore);
    });

    it("has nothing to withdraw once it is withdrawn, and for a section never confirmed (stale as for any section with nothing drafted)", async () => {
      const h = await stale();
      await resolveUndrafted(h, addendum, "deselected");
      expect(await codeOf(resolveUndrafted(h, addendum, "deselected"))).toEqual([
        "DRAFT_SECTION_STALE",
        409,
      ]);

      const never = harness({ signed: addendum });
      never.seams.linkedIdgFollowUpItem.mockImplementation(async () => null);
      expect(await codeOf(resolveUndrafted(never, addendum, "deselected"))).toEqual([
        "DRAFT_SECTION_STALE",
        409,
      ]);
      expect(saved(never, addendum)).toBeUndefined();
    });

    it("is drafted again when M14 hands the item back, and the withdrawn row is then a stale deselect that asks to be resolved afresh", async () => {
      const h = await stale();
      await resolveUndrafted(h, addendum, "deselected");
      h.seams.linkedIdgFollowUpItem.mockImplementation(async () => item());
      const again = await recompute(h, addendum);
      expect(again?.states.find((s) => s.sectionId === "idg_followup")?.state).toBe(
        "needs_reconfirmation",
      );
      expect(again?.actions).toEqual([{ sectionId: "idg_followup", reason: "stale" }]);
      expect((await confirm(h, addendum)).state).toBe("confirmed");
      expect((await recompute(h, addendum))?.actions).toEqual([]);
    });
  },
);

describe("a plain section that went empty keeps the behavior it had", () => {
  it("a stale confirm of a section that was never drafted is still 409, and a drafted section's deselect is unchanged", async () => {
    const h = harness();
    // drafted: an ordinary deselect still binds to the section's own hash
    const section = await seen(h, false);
    const view = await h.svc.resolveSection(
      caller,
      NOTE.id,
      "idg_followup",
      {
        resolution: "deselected",
        contentHash: section?.contentHash as string,
        corpusVersion: section?.corpusVersion as string,
      },
      AUDIT,
    );
    expect(view.state).toBe("deselected");
    expect(h.saved.get("idg_followup")?.contentHash).toBe(section?.contentHash);
    expect(h.saved.get("idg_followup")?.part2Derived).toBe(false);
  });
});
