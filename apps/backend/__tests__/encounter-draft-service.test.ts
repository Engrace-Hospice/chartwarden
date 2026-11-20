// S1 PR C2b1 — the draft service (ADR-0114): the per-tenant switch answers 404 before anything is read, the draft is computed for the
// SESSION viewer, a signed note refuses a resolution, and a write records its explicit audit event. Fakes only; the live suite
// proves the Drizzle unit.
import { describe, expect, it, vi } from "vitest";
import { admissionReadsFor } from "../src/modules/08-encounters/drafting/admission-reads";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { NOW, carePlan, change, fakePorts, selectionFor } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
const caller = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-0000000000bb",
  roles: ["rn"],
  membershipId: MEMBER,
  permissions: new Set<string>(),
};
const withPrevious = { previous: new Date("2026-11-10T15:00:00.000Z") };

const seamPorts = () =>
  fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" }),
    ],
  });

function service(options: Parameters<typeof memoryRunInOrg>[0] = withPrevious) {
  const mem = memoryRunInOrg(options);
  const seams = seamPorts();
  return {
    ...mem,
    seams,
    svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
  };
}

const expectCode = async (p: Promise<unknown>, code: string, status: number) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeDefined();
  expect((error as { code: string }).code).toBe(code);
  expect((error as { statusCode: number }).statusCode).toBe(status);
};

describe("the per-tenant switch", () => {
  it("GET answers 404 when the tenant has the draft off, before the encounter or any source is read", async () => {
    const { svc, seams, encounterCalls, store } = service({ ...withPrevious, enabled: false });
    await expectCode(
      svc.getDraft(caller, "00000000-0000-4000-8000-000000000004"),
      "NOT_FOUND",
      404,
    );
    expect(encounterCalls).toEqual([]);
    expect(seams.carePlanAsOf).not.toHaveBeenCalled();
    expect(store.confirmations).not.toHaveBeenCalled();
  });

  it("a resolution answers 404 when the tenant has the draft off and writes and audits nothing", async () => {
    const { svc, seams, store, events, encounterCalls } = service({
      ...withPrevious,
      enabled: false,
    });
    await expectCode(
      svc.resolveSection(
        caller,
        "00000000-0000-4000-8000-000000000004",
        "plan",
        { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
        AUDIT,
      ),
      "NOT_FOUND",
      404,
    );
    expect(encounterCalls).toEqual([]);
    expect(seams.carePlanAsOf).not.toHaveBeenCalled();
    expect(store.saveConfirmation).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("an off tenant and an absent encounter answer the same 404", async () => {
    const off = service({ ...withPrevious, enabled: false });
    const absent = service({ ...withPrevious, encounter: null });
    const a = await off.svc.getDraft(caller, "x").catch((e: Error) => e.message);
    const b = await absent.svc.getDraft(caller, "x").catch((e: Error) => e.message);
    expect(a).toBe(b);
  });
});

describe("reading the draft", () => {
  it("returns every template section with its state, text, hash, corpus version and Part 2 flag, and no source id", async () => {
    const { svc } = service();
    const view = await svc.getDraft(caller, "00000000-0000-4000-8000-000000000004");
    expect(view).toMatchObject({
      encounterId: "00000000-0000-4000-8000-000000000004",
      patientId: "00000000-0000-4000-8000-000000000002",
      templateKey: "routine_visit:rn",
      asOf: NOW.toISOString(),
    });
    expect(view.sections.map((s) => [s.sectionId, s.state])).toEqual([
      ["chief_concern", "not_drafted"],
      ["vitals_review", "not_drafted"],
      ["assessment", "not_drafted"],
      ["symptom_management", "not_drafted"],
      ["interventions", "unresolved"],
      ["plan", "unresolved"],
    ]);
    const plan = view.sections.find((s) => s.sectionId === "plan");
    expect(plan).toMatchObject({ part2Derived: false, origins: ["care_plan_goal"] });
    expect(plan?.text).toContain("Pain controlled");
    expect(plan?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan?.corpusVersion).toMatch(/\S/);
    const interventions = view.sections.find((s) => s.sectionId === "interventions");
    expect(interventions?.origins).toEqual(["care_plan_intervention", "medication_change"]);
    expect(JSON.stringify(view)).not.toMatch(/goal-1|intervention-1|order-a/);
    const empty = view.sections.find((s) => s.sectionId === "chief_concern");
    expect(empty).toMatchObject({
      text: null,
      contentHash: null,
      corpusVersion: null,
      part2Derived: null,
      origins: [],
    });
  });

  it("is computed for the SESSION viewer: roles and membership reach the care-plan and Part 2 reads", async () => {
    const mem = memoryRunInOrg(withPrevious);
    // A SUD-treatment order is the one thing that makes the draft ask M39 for the viewer's verdict.
    const seams = fakePorts({
      carePlanAsOf: async () => carePlan(),
      medicationChangesBetween: async () => [
        change("started", "2026-11-12T16:00:00.000Z", { id: "order-s", isSudTreatment: true }),
      ],
    });
    const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
    await svc.getDraft(
      { ...caller, roles: ["rn_case_manager"], membershipId: "m-7" },
      "00000000-0000-4000-8000-000000000004",
    );
    expect(seams.carePlanAsOf.mock.calls[0]?.[4]).toEqual({
      actor: { roles: ["rn_case_manager"], membershipId: "m-7" },
    });
    expect(seams.part2DisclosureAllowed.mock.calls[0]?.[0]).toMatchObject({
      viewer: { roles: ["rn_case_manager"], membershipId: "m-7" },
    });
  });

  it("fails closed with DRAFT_UNAVAILABLE (503) when a source cannot be read", async () => {
    const mem = memoryRunInOrg(withPrevious);
    const broken = fakePorts({
      carePlanAsOf: async () => {
        throw new Error("boom");
      },
    });
    const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => broken, now: () => NOW });
    await expectCode(
      svc.getDraft(caller, "00000000-0000-4000-8000-000000000004"),
      "DRAFT_UNAVAILABLE",
      503,
    );
  });

  it("does not lock the encounter row for a read", async () => {
    const { svc, encounterCalls } = service();
    await svc.getDraft(caller, "00000000-0000-4000-8000-000000000004");
    expect(encounterCalls).toEqual([
      { id: "00000000-0000-4000-8000-000000000004", forUpdate: false },
    ]);
  });
});

describe("connections held while a source is asked (S3)", () => {
  const ENCOUNTER = "00000000-0000-4000-8000-000000000004";

  /** A `RunInOrg` that counts the transactions open at any moment, and the ones it ever opened. */
  function counted(options: Parameters<typeof memoryRunInOrg>[0] = withPrevious) {
    const mem = memoryRunInOrg(options);
    const state = { open: 0, opened: 0, openAtSeam: [] as number[] };
    const runInOrg: typeof mem.runInOrg = async (scope, fn) => {
      state.open += 1;
      state.opened += 1;
      try {
        return await mem.runInOrg(scope, fn);
      } finally {
        state.open -= 1;
      }
    };
    const seams = fakePorts({
      carePlanAsOf: async () => {
        state.openAtSeam.push(state.open);
        return carePlan();
      },
      part2DisclosureAllowed: async () => {
        state.openAtSeam.push(state.open);
        return true;
      },
      medicationChangesBetween: async () => {
        state.openAtSeam.push(state.open);
        return [change("started", "2026-11-12T16:00:00.000Z", { id: "order-a" })];
      },
    });
    return {
      ...mem,
      state,
      svc: createDraftService({ runInOrg, seams: () => seams, now: () => NOW }),
    };
  }

  it("a draft READ holds no transaction while M7, M9, M12 or M39 is asked: the facts in one short transaction, the confirmations in a second", async () => {
    const { svc, state } = counted();
    const view = await svc.getDraft(caller, ENCOUNTER);
    expect(view.sections.length).toBeGreaterThan(0);
    expect(state.openAtSeam.length).toBeGreaterThan(0);
    expect(state.openAtSeam.every((open) => open === 0)).toBe(true);
    expect(state.opened).toBe(2);
    expect(state.open).toBe(0);
  });

  it("the amendment draft READ does the same", async () => {
    const { svc, state } = counted({
      ...withPrevious,
      encounter: draftEncounterRow({ status: "signed" }),
      amendment: {
        id: "00000000-0000-4000-8000-0000000000ad",
        status: "draft",
        authoredByMembershipId: MEMBER,
        sectionIds: ["plan"],
      },
    });
    await svc.getAmendmentDraft(caller, ENCOUNTER, "00000000-0000-4000-8000-0000000000ad");
    expect(state.openAtSeam.length).toBeGreaterThan(0);
    expect(state.openAtSeam.every((open) => open === 0)).toBe(true);
    expect(state.opened).toBe(2);
  });

  it("a section WRITE keeps its transaction, and the row lock in it, open across the source reads: the draft it decides over is the one the lock protects", async () => {
    const { svc, state, encounterCalls } = counted();
    const section = (await svc.getDraft(caller, ENCOUNTER)).sections.find(
      (s) => s.sectionId === "plan",
    );
    state.openAtSeam.length = 0;
    await svc.resolveSection(
      caller,
      ENCOUNTER,
      "plan",
      {
        resolution: "confirmed",
        contentHash: section?.contentHash ?? "",
        corpusVersion: section?.corpusVersion ?? "",
      },
      AUDIT,
    );
    expect(state.openAtSeam.length).toBeGreaterThan(0);
    expect(state.openAtSeam.every((open) => open === 1)).toBe(true);
    expect(encounterCalls.at(-1)).toEqual({ id: ENCOUNTER, forUpdate: true });
  });

  it("a read of an encounter whose template the corpus does not draft asks no source and needs no store read after its transaction", async () => {
    const { svc, state } = counted({
      encounter: draftEncounterRow({ discipline: "lpn" }),
    });
    const view = await svc.getDraft(caller, ENCOUNTER);
    expect(view.sections.every((s) => s.state === "not_drafted")).toBe(true);
    expect(state.openAtSeam).toEqual([]);
  });
});

describe("resolving a section", () => {
  const ID = "00000000-0000-4000-8000-000000000004";

  async function planHash(svc: ReturnType<typeof service>["svc"]) {
    const view = await svc.getDraft(caller, ID);
    const plan = view.sections.find((s) => s.sectionId === "plan");
    return {
      contentHash: plan?.contentHash as string,
      corpusVersion: plan?.corpusVersion as string,
    };
  }

  it("locks the encounter, writes, and records the explicit audit event on the same unit", async () => {
    const { svc, store, events, encounterCalls, scopes } = service();
    const seen = await planHash(svc);
    const view = await svc.resolveSection(
      caller,
      ID,
      "plan",
      { resolution: "confirmed", ...seen },
      AUDIT,
    );
    expect(view.state).toBe("confirmed");
    expect(store.saveConfirmation).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        sectionId: "plan",
        resolution: "confirmed",
        contentHash: seen.contentHash,
      }),
    ]);
    expect(encounterCalls.at(-1)).toEqual({ id: ID, forUpdate: true });
    expect(scopes.at(-1)).toMatchObject({ userId: caller.userId, audit: AUDIT });
  });

  it("refuses a stale hash with 409 DRAFT_SECTION_STALE, writing and auditing nothing", async () => {
    const { svc, store, events } = service();
    const seen = await planHash(svc);
    await expectCode(
      svc.resolveSection(
        caller,
        ID,
        "plan",
        { resolution: "confirmed", ...seen, contentHash: "0".repeat(64) },
        AUDIT,
      ),
      "DRAFT_SECTION_STALE",
      409,
    );
    expect(store.saveConfirmation).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it.each(["signed", "cosign_pending", "cosigned", "voided"] as const)(
    "refuses a %s encounter with IMMUTABLE_AFTER_SIGN before reading any source",
    async (status) => {
      const { svc, seams, store } = service({
        ...withPrevious,
        encounter: draftEncounterRow({ status }),
      });
      await expectCode(
        svc.resolveSection(
          caller,
          ID,
          "plan",
          { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
          AUDIT,
        ),
        "IMMUTABLE_AFTER_SIGN",
        409,
      );
      expect(seams.carePlanAsOf).not.toHaveBeenCalled();
      expect(store.saveConfirmation).not.toHaveBeenCalled();
    },
  );

  it("accepts a finalized encounter, as the selection save does (a stale confirmation must stay resolvable before sign)", async () => {
    const { svc } = service({
      ...withPrevious,
      encounter: draftEncounterRow({ status: "finalized" }),
    });
    const seen = await planHash(svc);
    const view = await svc.resolveSection(
      caller,
      ID,
      "plan",
      { resolution: "confirmed", ...seen },
      AUDIT,
    );
    expect(view.state).toBe("confirmed");
  });

  it("records no audit event for an idempotent repeat", async () => {
    const { svc, events } = service();
    const seen = await planHash(svc);
    await svc.resolveSection(caller, ID, "plan", { resolution: "confirmed", ...seen }, AUDIT);
    await svc.resolveSection(caller, ID, "plan", { resolution: "confirmed", ...seen }, AUDIT);
    expect(events).toHaveLength(1);
  });

  it("does not call the audit hook when the write is refused", async () => {
    const { svc, unit } = service();
    const spy = vi.spyOn(unit, "recordResolved");
    await svc
      .resolveSection(
        caller,
        ID,
        "plan",
        { resolution: "confirmed", contentHash: "b".repeat(64), corpusVersion: "x" },
        AUDIT,
      )
      .catch((e: unknown) => e instanceof EncounterStateError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the admission's read keys a recertification or face-to-face draft needs (ADR-0114 S2)", () => {
  const ID = "00000000-0000-4000-8000-000000000004";
  const RECERT_KEYS = ["election.read", "cti.read", "f2f.read", "loc.read"];
  const recert = draftEncounterRow({ encounterType: "recert_visit", discipline: "rn" });
  const faceToFace = draftEncounterRow({ encounterType: "face_to_face", discipline: "md" });
  const holding = (keys: readonly string[]) => ({ ...caller, permissions: new Set(keys) });

  function serviceFor(encounter: ReturnType<typeof draftEncounterRow>, enabled = true) {
    const selection = selectionFor(encounter.encounterType, encounter.discipline);
    const mem = memoryRunInOrg({ ...withPrevious, encounter, enabled, selection });
    const seams = seamPorts();
    return {
      ...mem,
      seams,
      svc: createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW }),
    };
  }

  it("names the keys by template: four for a recertification, the benefit period's for a face-to-face, none for any other", () => {
    expect(admissionReadsFor("recert_visit")).toEqual(RECERT_KEYS);
    expect(admissionReadsFor("face_to_face")).toEqual(["election.read"]);
    expect(admissionReadsFor("routine_visit")).toEqual([]);
    expect(admissionReadsFor("constructor")).toEqual([]);
  });

  it.each(RECERT_KEYS)(
    "refuses a recertification draft to a caller who lacks %s, naming it, before any source is read",
    async (missing) => {
      const { svc, seams } = serviceFor(recert);
      const error = await svc.getDraft(holding(RECERT_KEYS.filter((k) => k !== missing)), ID).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ statusCode: 403 });
      expect((error as Error).message).toContain(missing);
      expect(seams.electionPeriods).not.toHaveBeenCalled();
      expect(seams.carePlanAsOf).not.toHaveBeenCalled();
    },
  );

  it("gives a caller who holds all four the recertification draft", async () => {
    const { svc } = serviceFor(recert);
    const view = await svc.getDraft(holding(RECERT_KEYS), ID);
    expect(view.templateKey).toBe("recert_visit:rn");
  });

  it("refuses the section PUT the same way, before anything is written", async () => {
    const { svc, unit } = serviceFor(recert);
    const spy = vi.spyOn(unit, "recordResolved");
    await expectCode(
      svc.resolveSection(
        holding(["election.read", "cti.read", "f2f.read"]),
        ID,
        "pps",
        { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
        AUDIT,
      ),
      "FORBIDDEN",
      403,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("needs only the benefit period's key for a face-to-face draft, and none of the other three", async () => {
    const { svc } = serviceFor(faceToFace);
    expect((await svc.getDraft(holding(["election.read"]), ID)).templateKey).toBe(
      "face_to_face:md",
    );
    await expectCode(
      svc.getDraft(holding(["cti.read", "f2f.read", "loc.read"]), ID),
      "FORBIDDEN",
      403,
    );
  });

  it("asks a routine visit's draft for none of them", async () => {
    const { svc } = serviceFor(draftEncounterRow());
    expect((await svc.getDraft(holding([]), ID)).templateKey).toBe("routine_visit:rn");
  });

  it("answers 404 while the switch is off even to a caller who lacks the keys: the refusal is no oracle for the switch", async () => {
    const { svc } = serviceFor(recert, false);
    await expectCode(svc.getDraft(holding([]), ID), "NOT_FOUND", 404);
  });
});
