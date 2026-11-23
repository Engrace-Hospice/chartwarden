// ADR-0114 S5b — what finalize, sign and a section's resolution do about the IDG follow-up's own section. A confirmed section that a recompute no longer
// drafts (the item was reassigned, M14 no longer clears the viewer, M14 hands nothing for it) is refused, naming `idg_followup` and nothing of the item,
// instead of dropping out of the note without a word; a viewer without `idg.act` is refused nothing (VN-D66); and the link row's Part 2 flag is raised whenever
// a recompute sees the section Part 2 derived, as a plan section's resolution raises its plan links. Fake seams, in-memory store; no database.
import type { IdgFollowUpItem } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { restrictToNamed } from "../src/modules/08-encounters/drafting/amendment-note";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { assertResolved, readNoteDraft } from "../src/modules/08-encounters/drafting/note-draft";
import { NOW, fakePorts, reader, selectionFor } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const ITEM = "00000000-0000-4000-8000-0000000000e1";
const IDG_MD = draftEncounterRow({ encounterType: "idg_followup", discipline: "md" });
const SCOPE = { organizationId: IDG_MD.organizationId, userId: "u", now: NOW };
const WITH_KEY = reader({ roles: ["md"], permissions: new Set(["idg.act"]) });
const WITHOUT_KEY = reader({ roles: ["md"] });

const item = (over: Partial<IdgFollowUpItem> = {}): IdgFollowUpItem => ({
  actionItemId: ITEM,
  meetingAt: "2026-11-02T15:00:00.000Z" as IdgFollowUpItem["meetingAt"],
  decisionKind: "referral",
  dueAt: null,
  status: "open",
  sudRelated: false,
  ...over,
});
const link = (part2Derived = false) => ({
  id: "idg-link-1",
  actionItemId: ITEM,
  removedAt: null,
  removedByMembershipId: null,
  part2Derived,
  linkedByMembershipId: MEMBER,
});

/** A harness whose M14 hands `handed` for the linked item, with the link and the author's confirmation of the section as given. */
function harness(over: {
  handed?: IdgFollowUpItem | null;
  link?: boolean;
  resolution?: "confirmed" | "deselected" | null;
  part2Link?: boolean;
}) {
  const mem = memoryRunInOrg({
    encounter: IDG_MD,
    selection: selectionFor("idg_followup", "md"),
    idgLinks: over.link === false ? [] : [link(over.part2Link ?? false)],
  });
  const seams = fakePorts({
    linkedIdgFollowUpItem: async () => (over.handed === undefined ? item() : over.handed),
  });
  const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
  return { ...mem, seams, svc };
}

/** The author confirms the section while M14 hands the item (so there is a confirmation to be dropped). */
async function confirmed(h: ReturnType<typeof harness>, who = WITH_KEY) {
  const draft = await h.svc.getDraft(
    {
      organizationId: SCOPE.organizationId,
      userId: "u",
      roles: who.roles,
      membershipId: MEMBER,
      permissions: who.permissions,
    },
    IDG_MD.id,
  );
  const section = draft.sections.find((s) => s.sectionId === "idg_followup");
  expect(section?.state).toBe("unresolved");
  await h.unit.store.saveConfirmation({
    encounter: { ...IDG_MD, status: "draft", providerEntityId: null, locationId: null },
    sectionId: "idg_followup",
    resolution: "confirmed",
    contentHash: section?.contentHash as string,
    corpusVersion: section?.corpusVersion as string,
    edited: false,
    part2Derived: false,
    sourceRefs: [],
    resolvedByMembershipId: MEMBER,
    resolvedAt: NOW,
  });
}

const recompute = (h: ReturnType<typeof harness>, who = WITH_KEY) =>
  h.runInOrg(SCOPE, (unit) => readNoteDraft(unit, h.seams, IDG_MD, who, NOW));

describe("a confirmed idg_followup section that a recompute no longer drafts is refused, never dropped silently", () => {
  it.each([
    ["M14 hands nothing for the item any more (reassigned, Part 2 not cleared, no decision)", null],
  ])("%s", async (_name, handed) => {
    const h = harness({});
    await confirmed(h);
    const before = await recompute(h);
    expect(before?.actions).toEqual([]);

    h.seams.linkedIdgFollowUpItem.mockImplementation(async () => handed);
    const after = await recompute(h);
    expect(after?.states.find((s) => s.sectionId === "idg_followup")?.state).toBe("not_drafted");
    expect(after?.actions).toEqual([{ sectionId: "idg_followup", reason: "stale" }]);
    // sign's refusal: the existing 409 DRAFT_SECTION_STALE shape, naming the section and nothing of the item
    let refusal: unknown;
    try {
      assertResolved(after);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
    const shown = JSON.stringify(refusal, ["message", "details", "field", "code"]);
    expect(shown).toContain("idg_followup");
    expect(shown).not.toContain(ITEM);
    expect(shown).not.toContain("referral");
  });

  it("an addendum that names the confirmed section is refused the same way (DRAFT_SECTION_STALE), and one that names other sections only is not", async () => {
    const h = harness({});
    await confirmed(h);
    h.seams.linkedIdgFollowUpItem.mockImplementation(async () => null); // M14 reassigned the item since the author confirmed
    const after = await recompute(h);
    if (after === null) throw new Error("the draft is on");

    const naming = restrictToNamed(after, ["idg_followup"]);
    expect(naming.actions).toEqual([{ sectionId: "idg_followup", reason: "stale" }]);
    expect(() => assertResolved(naming)).toThrow(
      expect.objectContaining({ code: "DRAFT_SECTION_STALE" }),
    );

    const other = restrictToNamed(after, ["chief_concern"]);
    expect(other.actions).toEqual([]);
    expect(() => assertResolved(other)).not.toThrow();
  });

  it("is no refusal for a viewer without idg.act (the section is not drafted for them by design, VN-D66)", async () => {
    const h = harness({});
    await confirmed(h);
    h.seams.linkedIdgFollowUpItem.mockImplementation(async () => null);
    const result = await recompute(h, WITHOUT_KEY);
    expect(result?.actions).toEqual([]);
    expect(() => assertResolved(result)).not.toThrow();
  });

  it("is no refusal once the author clears the link (they clear it, then sign again), nor for a deselected section, nor for one never confirmed", async () => {
    const cleared = harness({});
    await confirmed(cleared);
    cleared.seams.linkedIdgFollowUpItem.mockImplementation(async () => null);
    await cleared.svc.setIdgActionItem(
      {
        organizationId: SCOPE.organizationId,
        userId: "u",
        roles: ["md"],
        membershipId: MEMBER,
        permissions: new Set(), // clearing needs no key
      },
      IDG_MD.id,
      { actionItemId: null },
      { organizationId: "o", userId: "u", correlationId: "c" },
    );
    expect((await recompute(cleared))?.actions).toEqual([]);

    const never = harness({ handed: null });
    expect((await recompute(never))?.actions).toEqual([]);

    const deselected = harness({});
    await deselected.unit.store.saveConfirmation({
      encounter: { ...IDG_MD, status: "draft", providerEntityId: null, locationId: null },
      sectionId: "idg_followup",
      resolution: "deselected",
      contentHash: "0".repeat(64),
      corpusVersion: "x",
      edited: false,
      part2Derived: false,
      sourceRefs: [],
      resolvedByMembershipId: MEMBER,
      resolvedAt: NOW,
    });
    deselected.seams.linkedIdgFollowUpItem.mockImplementation(async () => null);
    expect((await recompute(deselected))?.actions).toEqual([]);
  });

  it("still drafts the section for a confirmed item M14's auto-close has closed since: no refusal, the sentence stays", async () => {
    const h = harness({});
    await confirmed(h);
    h.seams.linkedIdgFollowUpItem.mockImplementation(async () => item({ status: "auto_closed" }));
    const result = await recompute(h);
    expect(result?.actions).toEqual([]);
    expect(result?.states.find((s) => s.sectionId === "idg_followup")?.state).toBe("confirmed");
  });
});

describe("the link row's Part 2 flag follows the section's verdict at every recompute", () => {
  it("finalize and sign raise a live row filed lower, when M14 now hands the item flagged; a second recompute finds it right and changes no row", async () => {
    const h = harness({ handed: item({ sudRelated: true }), part2Link: false });
    await recompute(h);
    expect(h.idgLinks[0]).toMatchObject({ part2Derived: true });
    // the second recompute asks the store again, which matches no row now (the flag is up): no row changes, none is added
    const rowsBefore = JSON.stringify(h.idgLinks);
    await recompute(h);
    expect(JSON.stringify(h.idgLinks)).toBe(rowsBefore);
    expect(h.idgLinks).toHaveLength(1);
    const results = await Promise.all(h.store.raiseIdgLinkPart2.mock.results.map((r) => r.value));
    expect(results).toEqual([true, false]);
  });

  it("a plain section raises nothing", async () => {
    const h = harness({ part2Link: false });
    await recompute(h);
    expect(h.store.raiseIdgLinkPart2).not.toHaveBeenCalled();
    expect(h.idgLinks[0]).toMatchObject({ part2Derived: false });
  });

  it("a section's resolution raises the row too, on a confirm and on a deselect", async () => {
    for (const resolution of ["confirmed", "deselected"] as const) {
      const h = harness({ handed: item({ sudRelated: true }), part2Link: false });
      const caller = {
        organizationId: SCOPE.organizationId,
        userId: "u",
        roles: ["md"],
        membershipId: MEMBER,
        permissions: new Set(["idg.act"]),
      };
      const draft = await h.svc.getDraft(caller, IDG_MD.id);
      const seen = draft.sections.find((s) => s.sectionId === "idg_followup");
      expect(seen?.part2Derived).toBe(true);
      expect(h.idgLinks[0]).toMatchObject({ part2Derived: false }); // a read writes nothing
      await h.svc.resolveSection(
        caller,
        IDG_MD.id,
        "idg_followup",
        {
          resolution,
          contentHash: seen?.contentHash as string,
          corpusVersion: seen?.corpusVersion as string,
        },
        { organizationId: "o", userId: "u", correlationId: "c" },
      );
      expect(h.idgLinks[0], resolution).toMatchObject({ part2Derived: true });
    }
  });
});
