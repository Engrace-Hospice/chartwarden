// S1 PR E2 - the draft service for an AMENDING addendum (ADR-0114 VN-D30 / VN-D12): the addendum's author reads the draft of the signed note as of
// the visit time and confirms or deselects each section the addendum names, against the addendum's own resolutions. Fakes only; the live suite
// proves the Drizzle unit.
import { describe, expect, it } from "vitest";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { NOW, carePlan, change, fakePorts } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";
const AUTHOR = "00000000-0000-4000-8000-0000000000aa";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
const caller = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["rn"],
  membershipId: AUTHOR,
  // a routine visit's draft needs none of M6's read keys (`assertMayReadAdmissionFacts`)
  permissions: new Set<string>(),
};
const signedNote = draftEncounterRow({ status: "signed" });
const amending = (over: Partial<Parameters<typeof memoryRunInOrg>[0] & object> = {}) => ({
  previous: new Date("2026-11-10T15:00:00.000Z"),
  encounter: signedNote,
  amendment: {
    id: ADDENDUM,
    status: "draft" as const,
    authoredByMembershipId: AUTHOR,
    sectionIds: ["plan"],
  },
  ...over,
});

function service(options: ReturnType<typeof amending> | Parameters<typeof memoryRunInOrg>[0]) {
  const mem = memoryRunInOrg(options);
  const seams = fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
    ],
  });
  return {
    ...mem,
    seams,
    svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
  };
}

const codeOf = async (p: Promise<unknown>): Promise<[string, number]> => {
  const error = (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code: string; statusCode: number } | undefined;
  expect(error).toBeDefined();
  return [error?.code ?? "", error?.statusCode ?? 0];
};

const plan = async (ctx: ReturnType<typeof service>) =>
  (await ctx.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM)).sections.find(
    (s) => s.sectionId === "plan",
  );

const body = (
  section: { contentHash: string | null; corpusVersion: string | null } | undefined,
) => ({
  contentHash: section?.contentHash ?? "",
  corpusVersion: section?.corpusVersion ?? "",
});

describe("the amendment draft read", () => {
  it("answers 404 before anything is read when the tenant has the draft off, the same 404 as an absent addendum", async () => {
    const off = service({ ...amending(), enabled: false });
    expect(await codeOf(off.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM))).toEqual([
      "NOT_FOUND",
      404,
    ]);
    expect(off.seams.carePlanAsOf).not.toHaveBeenCalled();
    expect(off.encounterCalls).toEqual([]);
    const absent = service(amending({ amendment: undefined }));
    expect(await codeOf(absent.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM))).toEqual([
      "NOT_FOUND",
      404,
    ]);
  });

  it("answers 404 for an addendum that names no section (a free addendum has no draft)", async () => {
    const free = service(
      amending({
        amendment: {
          id: ADDENDUM,
          status: "draft",
          authoredByMembershipId: AUTHOR,
          sectionIds: [],
        },
      }),
    );
    expect(await codeOf(free.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM))).toEqual([
      "NOT_FOUND",
      404,
    ]);
  });

  describe("is the addendum author's view alone (the route gates it too; the service does not rely on that)", () => {
    const OTHER = "00000000-0000-4000-8000-0000000000cc";
    const addendum = (sectionIds: readonly string[]) =>
      amending({
        amendment: {
          id: ADDENDUM,
          status: "draft",
          authoredByMembershipId: AUTHOR,
          sectionIds: [...sectionIds],
        },
      });

    it.each([
      ["an amending addendum", ["plan"]],
      ["a free addendum", []],
    ])(
      "refuses anyone but the author of %s with 403, whatever Part 2 disclosure they hold, and reads nothing",
      async (_kind, sectionIds) => {
        for (const disclosure of [true, false]) {
          const ctx = service(addendum(sectionIds));
          ctx.seams.part2DisclosureAllowed.mockResolvedValue(disclosure);
          expect(
            await codeOf(
              ctx.svc.getAmendmentDraft({ ...caller, membershipId: OTHER }, ENCOUNTER, ADDENDUM),
            ),
          ).toEqual(["FORBIDDEN", 403]);
          expect(ctx.seams.carePlanAsOf).not.toHaveBeenCalled();
          expect(ctx.seams.part2DisclosureAllowed).not.toHaveBeenCalled();
        }
      },
    );

    it("refuses a session with no membership with 403 too", async () => {
      const ctx = service(addendum(["plan"]));
      expect(
        await codeOf(
          ctx.svc.getAmendmentDraft({ ...caller, membershipId: null }, ENCOUNTER, ADDENDUM),
        ),
      ).toEqual(["FORBIDDEN", 403]);
    });

    it("still answers its own author's free addendum 404: they know it names nothing", async () => {
      const ctx = service(addendum([]));
      expect(await codeOf(ctx.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM))).toEqual([
        "NOT_FOUND",
        404,
      ]);
    });
  });

  it("returns only the sections the addendum names, as of the visit time, each against the addendum's resolutions", async () => {
    const ctx = service(amending());
    const view = await ctx.svc.getAmendmentDraft(caller, ENCOUNTER, ADDENDUM);
    expect(view).toMatchObject({
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      templateKey: "routine_visit:rn",
    });
    expect(view.sections.map((s) => [s.sectionId, s.state])).toEqual([["plan", "unresolved"]]);
    expect(view.sections[0]?.text).toContain("Pain controlled");
    expect(JSON.stringify(view)).not.toMatch(/goal-1|intervention-1|order-a/);
  });

  it("reads a resolution the note's author left as NOT the addendum's: the note's resolutions are not consulted", async () => {
    const ctx = service(amending());
    const section = await plan(ctx);
    ctx.saved.set("plan", {
      sectionId: "plan",
      resolution: "confirmed",
      ...body(section),
    } as never);
    expect((await plan(ctx))?.state).toBe("unresolved");
  });
});

describe("resolving a named section", () => {
  it("confirms against the content seen, writes it to the addendum's resolutions only, locks the encounter row, links no care-plan element", async () => {
    const ctx = service(amending());
    const view = await ctx.svc.resolveAmendmentSection(
      caller,
      ENCOUNTER,
      ADDENDUM,
      "plan",
      { resolution: "confirmed", ...body(await plan(ctx)) },
      AUDIT,
    );
    expect(view.state).toBe("confirmed");
    expect(ctx.amendmentSaved.get("plan")).toMatchObject({
      resolution: "confirmed",
      resolvedByMembershipId: AUTHOR,
    });
    expect(ctx.saved.size).toBe(0);
    expect(ctx.links).toEqual([]);
    expect(ctx.encounterCalls.at(-1)).toEqual({ id: ENCOUNTER, forUpdate: true });
    expect((await plan(ctx))?.state).toBe("confirmed");
  });

  it("deselects without touching the note's care-plan links, and the deselection is current", async () => {
    const ctx = service(amending());
    const view = await ctx.svc.resolveAmendmentSection(
      caller,
      ENCOUNTER,
      ADDENDUM,
      "plan",
      { resolution: "deselected", ...body(await plan(ctx)) },
      AUDIT,
    );
    expect(view.state).toBe("deselected");
    expect(ctx.links).toEqual([]);
    expect((await plan(ctx))?.state).toBe("deselected");
  });

  it("refuses a stale hash with 409 DRAFT_SECTION_STALE and writes nothing", async () => {
    const ctx = service(amending());
    expect(
      await codeOf(
        ctx.svc.resolveAmendmentSection(
          caller,
          ENCOUNTER,
          ADDENDUM,
          "plan",
          { resolution: "confirmed", contentHash: "e".repeat(64), corpusVersion: "x" },
          AUDIT,
        ),
      ),
    ).toEqual(["DRAFT_SECTION_STALE", 409]);
    expect(ctx.amendmentSaved.size).toBe(0);
  });

  it("refuses a section the addendum does not name with 422 UNKNOWN_TEMPLATE_SECTION", async () => {
    const ctx = service(amending());
    expect(
      await codeOf(
        ctx.svc.resolveAmendmentSection(
          caller,
          ENCOUNTER,
          ADDENDUM,
          "interventions",
          { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
          AUDIT,
        ),
      ),
    ).toEqual(["UNKNOWN_TEMPLATE_SECTION", 422]);
  });

  it("refuses a signed or voided addendum with 409 ILLEGAL_TRANSITION", async () => {
    for (const status of ["signed", "voided"] as const) {
      const ctx = service(
        amending({
          amendment: { id: ADDENDUM, status, authoredByMembershipId: AUTHOR, sectionIds: ["plan"] },
        }),
      );
      expect(
        await codeOf(
          ctx.svc.resolveAmendmentSection(
            caller,
            ENCOUNTER,
            ADDENDUM,
            "plan",
            { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
            AUDIT,
          ),
        ),
      ).toEqual(["ILLEGAL_TRANSITION", 409]);
    }
  });

  it("refuses anyone but the addendum's author with 403, however the route was reached", async () => {
    const ctx = service(amending());
    expect(
      await codeOf(
        ctx.svc.resolveAmendmentSection(
          { ...caller, membershipId: "00000000-0000-4000-8000-0000000000cc" },
          ENCOUNTER,
          ADDENDUM,
          "plan",
          { resolution: "confirmed", ...body(await plan(ctx)) },
          AUDIT,
        ),
      ),
    ).toEqual(["FORBIDDEN", 403]);
    expect(ctx.amendmentSaved.size).toBe(0);
  });

  it("records the same audit event a note's resolution records, naming the addendum (C1); an idempotent repeat records nothing more", async () => {
    const ctx = service(amending());
    const request = { resolution: "confirmed" as const, ...body(await plan(ctx)) };
    await ctx.svc.resolveAmendmentSection(caller, ENCOUNTER, ADDENDUM, "plan", request, AUDIT);
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]).toMatchObject({
      encounterId: ENCOUNTER,
      addendumId: ADDENDUM,
      sectionId: "plan",
      resolution: "confirmed",
      part2Derived: false,
      carePlanElementsLinked: 0,
      carePlanElementsRemoved: 0,
    });
    await ctx.svc.resolveAmendmentSection(caller, ENCOUNTER, ADDENDUM, "plan", request, AUDIT);
    expect(ctx.events).toHaveLength(1);
  });

  it("a note's own resolution carries no addendum id in its event", async () => {
    const ctx = service(amending({ encounter: draftEncounterRow({ status: "finalized" }) }));
    const noteSection = (await ctx.svc.getDraft(caller, ENCOUNTER)).sections.find(
      (s) => s.sectionId === "plan",
    );
    await ctx.svc.resolveSection(
      caller,
      ENCOUNTER,
      "plan",
      { resolution: "confirmed", ...body(noteSection) },
      AUDIT,
    );
    expect(ctx.events).toHaveLength(1);
    expect(ctx.events[0]?.addendumId).toBeNull();
  });

  it("is idempotent: the same confirmation again writes nothing more", async () => {
    const ctx = service(amending());
    const request = { resolution: "confirmed" as const, ...body(await plan(ctx)) };
    await ctx.svc.resolveAmendmentSection(caller, ENCOUNTER, ADDENDUM, "plan", request, AUDIT);
    const writes = ctx.amendmentSaved.get("plan");
    await ctx.svc.resolveAmendmentSection(caller, ENCOUNTER, ADDENDUM, "plan", request, AUDIT);
    expect(ctx.amendmentSaved.get("plan")).toBe(writes);
  });
});
