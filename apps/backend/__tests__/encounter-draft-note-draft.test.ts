// S1 PR C2b2 - reading the draft for the gate and for sign (VN-D7, VN-D12, VN-D17, design §3.2 "Gate" and "Sign"): off when the tenant
// switch is off, otherwise the signer's own recomputed draft against the stored confirmations. A draft that cannot be computed - or a
// switch that cannot be read - is `COMPLIANCE_GATE_UNAVAILABLE`, never a pass. Fake seams, in-memory store; no database.
import type { SelectionState } from "@chartwarden/hearthnote";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { describe, expect, it } from "vitest";
import type { DraftEncounterRow } from "../src/modules/08-encounters/drafting/draft-store";
import {
  assertResolved,
  confirmedSectionIds,
  readNoteDraft,
} from "../src/modules/08-encounters/drafting/note-draft";
import { EncounterStateError } from "../src/modules/08-encounters/lifecycle/errors";
import { NOW, carePlan, change, fakePorts, viewer } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

const encounter = draftEncounterRow();
const AUTHOR = viewer();
/** The store port owns the previous visit: with one, the medication change since it is drafted into `interventions`. */
const WITH_PREVIOUS = { previous: new Date("2026-11-10T15:00:00.000Z") };
const MEMBER = "00000000-0000-4000-8000-0000000000aa";

const selection = (sections: SelectionState["sections"]): SelectionState => ({
  templateKey: "routine_visit:rn",
  vocabVersion: VOCAB_VERSION,
  encounterType: "routine_visit",
  discipline: "rn",
  sections,
});

/** A goal (-> `plan`), an intervention (-> `interventions`), and a SUD medication change since the previous visit (-> `interventions`). */
const seams = (over: Parameters<typeof fakePorts>[0] = {}) =>
  fakePorts({
    carePlanAsOf: async () => carePlan(),
    medicationChangesBetween: async () => [
      change("started", "2026-11-12T16:00:00.000Z", { id: "order-a", isSudTreatment: true }),
    ],
    part2DisclosureAllowed: async ({ viewer: v }) => v.roles.includes("part2"),
    ...over,
  });

async function read(
  options: Parameters<typeof memoryRunInOrg>[0] = {},
  seamPorts = seams(),
  who = viewer({ roles: ["rn", "part2"] }),
  confirm: (
    unit: ReturnType<typeof memoryRunInOrg>["unit"],
    hashes: Hashes,
  ) => Promise<void> = async () => {},
) {
  const harness = memoryRunInOrg({ ...WITH_PREVIOUS, ...options });
  const scope = { organizationId: encounter.organizationId, userId: "u", now: NOW };
  const hashes = await harness.runInOrg(scope, async (unit) => {
    const first = await readNoteDraft(unit, seamPorts, encounter, who, NOW);
    return Object.fromEntries(
      (first?.computed.draft.sections ?? []).flatMap((s) =>
        s.state === "drafted" ? [[s.sectionId, s]] : [],
      ),
    ) as Hashes;
  });
  await confirm(harness.unit, hashes);
  const result = await harness.runInOrg(scope, (unit) =>
    readNoteDraft(unit, seamPorts, encounter, who, NOW),
  );
  return { ...harness, result, hashes };
}

type Hashes = Record<string, { contentHash: string; corpusVersion: string }>;

const confirmation = (
  sectionId: string,
  how: "confirmed" | "deselected",
  seen: { contentHash: string; corpusVersion: string },
) => ({
  encounter: encounter as DraftEncounterRow,
  sectionId,
  resolution: how,
  contentHash: seen.contentHash,
  corpusVersion: seen.corpusVersion,
  edited: false,
  part2Derived: false,
  sourceRefs: [],
  resolvedByMembershipId: MEMBER,
  resolvedAt: NOW,
});

const confirmAll =
  (how: "confirmed" | "deselected" = "confirmed") =>
  async (unit: ReturnType<typeof memoryRunInOrg>["unit"], hashes: Hashes) => {
    for (const [id, seen] of Object.entries(hashes)) {
      await unit.store.saveConfirmation(confirmation(id, how, seen));
    }
  };

describe("readNoteDraft: the switch", () => {
  it("is null when the tenant has the draft switched off, and reads nothing else", async () => {
    const seamPorts = seams();
    const { result, store } = await read({ enabled: false }, seamPorts);
    expect(result).toBeNull();
    expect(seamPorts.carePlanAsOf).not.toHaveBeenCalled();
    expect(store.confirmations).not.toHaveBeenCalled();
    expect(store.loadSelection).not.toHaveBeenCalled();
  });

  it("a switch that cannot be read is the gate being unavailable, never the draft being off", async () => {
    const harness = memoryRunInOrg();
    const broken = {
      ...harness.unit,
      enabled: async () => {
        throw new Error("the policy table is unreachable");
      },
    };
    await expect(readNoteDraft(broken, seams(), encounter, AUTHOR, NOW)).rejects.toMatchObject({
      code: "COMPLIANCE_GATE_UNAVAILABLE",
      statusCode: 503,
    });
  });
});

describe("readNoteDraft: the signer's draft against the confirmations", () => {
  it("every drafted section is unresolved before anything is confirmed", async () => {
    const { result } = await read();
    expect(result?.actions).toEqual([
      { sectionId: "interventions", reason: "unresolved" },
      { sectionId: "plan", reason: "unresolved" },
    ]);
    expect(result?.states.find((s) => s.sectionId === "chief_concern")?.state).toBe("not_drafted");
  });

  it("is resolved once every drafted section is confirmed or deselected against what it shows now", async () => {
    const { result } = await read({}, seams(), undefined, confirmAll());
    expect(result?.actions).toEqual([]);
    expect(result?.states.filter((s) => s.state === "confirmed").map((s) => s.sectionId)).toEqual([
      "interventions",
      "plan",
    ]);
    const deselected = await read({}, seams(), undefined, confirmAll("deselected"));
    expect(deselected.result?.actions).toEqual([]);
  });

  it("a confirmation whose content hash no longer matches is stale, including a deselected one", async () => {
    const stale = async (
      unit: ReturnType<typeof memoryRunInOrg>["unit"],
      hashes: Hashes,
      how: "confirmed" | "deselected",
    ) => {
      await unit.store.saveConfirmation(
        confirmation("plan", how, { ...hashes.plan!, contentHash: "0".repeat(64) }),
      );
      await unit.store.saveConfirmation(confirmation("interventions", how, hashes.interventions!));
    };
    for (const how of ["confirmed", "deselected"] as const) {
      const { result } = await read({}, seams(), undefined, (unit, hashes) =>
        stale(unit, hashes, how),
      );
      expect(result?.actions).toEqual([{ sectionId: "plan", reason: "stale" }]);
    }
  });

  it("a confirmation made under another phrase-corpus version is stale", async () => {
    const { result } = await read({}, seams(), undefined, async (unit, hashes) => {
      await unit.store.saveConfirmation(
        confirmation("plan", "confirmed", { ...hashes.plan!, corpusVersion: "2020.01.0" }),
      );
      await unit.store.saveConfirmation(
        confirmation("interventions", "confirmed", hashes.interventions!),
      );
    });
    expect(result?.actions).toEqual([{ sectionId: "plan", reason: "stale" }]);
  });

  it("the signer's own redaction decides: the author's confirmation of content the signer cannot see is stale for the signer", async () => {
    // The author holds the Part 2 disclosure and confirmed the section with the SUD medication change in it.
    const author = await read({}, seams(), viewer({ roles: ["rn", "part2"] }), confirmAll());
    expect(author.result?.actions).toEqual([]);
    // The signer does not: the same section, recomputed for the signer, reads differently.
    const harness = memoryRunInOrg(WITH_PREVIOUS);
    const scope = { organizationId: encounter.organizationId, userId: "u", now: NOW };
    const signer = await harness.runInOrg(scope, async (unit) => {
      for (const [id, seen] of Object.entries(author.hashes)) {
        await unit.store.saveConfirmation(confirmation(id, "confirmed", seen));
      }
      return readNoteDraft(unit, seams(), encounter, viewer({ roles: ["rn"] }), NOW);
    });
    expect(signer?.actions).toEqual([{ sectionId: "interventions", reason: "stale" }]);
  });

  it("a note with nothing to draft from has nothing for the clinician to resolve", async () => {
    const { result } = await read({}, fakePorts());
    expect(result?.actions).toEqual([]);
    expect(result?.states.every((s) => s.state === "not_drafted")).toBe(true);
  });
});

describe("readNoteDraft: a draft that cannot be computed is never a pass", () => {
  const unavailable = (error: unknown) =>
    expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });

  it("a failing source read is COMPLIANCE_GATE_UNAVAILABLE, with the upstream cause kept off the message", async () => {
    const failing = seams({
      carePlanAsOf: async () => {
        throw new Error("synthetic upstream detail that must not reach the caller");
      },
    });
    const error = await read({}, failing).catch((e: unknown) => e);
    unavailable(error);
    expect((error as EncounterStateError).message).not.toContain("synthetic upstream detail");
    expect((error as { cause?: unknown }).cause).toBeDefined();
  });

  it("a failing store read is COMPLIANCE_GATE_UNAVAILABLE too", async () => {
    unavailable(await read({ failing: ["confirmations"] }).catch((e: unknown) => e));
  });

  it("a selection that cannot be rendered keeps its own actionable code", async () => {
    const error = await read({
      selection: {
        selection: selection([{ sectionId: "plan", entries: [{ code: "nv.no.such.code" }] }]),
        context: { patient: "Patient", serviceDate: "2026-11-18" },
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UNKNOWN_VOCAB_CODE" });
  });
});

describe("assertResolved: sign refuses a note whose drafted sections are not all resolved", () => {
  it("passes for a tenant with the draft off and for a draft with nothing left to resolve", async () => {
    expect(() => assertResolved(null)).not.toThrow();
    const { result } = await read({}, seams(), undefined, confirmAll());
    expect(() => assertResolved(result)).not.toThrow();
  });

  it("is 409 DRAFT_SECTION_STALE naming every unresolved or stale section, each with its own code", async () => {
    const { result } = await read({}, seams(), undefined, async (unit, hashes) => {
      await unit.store.saveConfirmation(
        confirmation("plan", "confirmed", { ...hashes.plan!, contentHash: "0".repeat(64) }),
      );
    });
    try {
      assertResolved(result);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EncounterStateError);
      const refusal = error as EncounterStateError;
      expect(refusal.code).toBe("DRAFT_SECTION_STALE");
      expect(refusal.statusCode).toBe(409);
      expect(refusal.details?.map((d) => [d.field, d.code])).toEqual([
        ["interventions", "DRAFT_SECTION_UNRESOLVED"],
        ["plan", "DRAFT_SECTION_STALE"],
      ]);
    }
  });
});

describe("confirmedSectionIds: what gate check 1 counts as populated (owner-confirmed 2026-11-19)", () => {
  it("is absent when the draft is off, so check 1 is as it was", async () => {
    expect(confirmedSectionIds(null)).toBeUndefined();
    const { result } = await read({ enabled: false });
    expect(confirmedSectionIds(result)).toBeUndefined();
  });

  it("names the drafted sections the clinician confirmed against the draft as it stands now", async () => {
    const { result } = await read({}, seams(), undefined, confirmAll());
    expect([...(confirmedSectionIds(result) ?? [])].sort()).toEqual(["interventions", "plan"]);
  });

  it("does not name a deselected section: its own selections and free text are all that can satisfy it", async () => {
    const { result } = await read({}, seams(), undefined, confirmAll("deselected"));
    expect([...(confirmedSectionIds(result) ?? ["x"])]).toEqual([]);
  });

  it("does not name an unresolved section, a stale confirmation or an undrafted section", async () => {
    const { result } = await read({}, seams(), undefined, async (unit, hashes) => {
      await unit.store.saveConfirmation(
        confirmation("plan", "confirmed", { ...hashes.plan!, contentHash: "0".repeat(64) }),
      );
    });
    expect([...(confirmedSectionIds(result) ?? ["x"])]).toEqual([]);
    expect(result?.states.find((s) => s.sectionId === "chief_concern")?.state).toBe("not_drafted");
  });

  it("names only the sections confirmed when the others are resolved otherwise", async () => {
    const { result } = await read({}, seams(), undefined, async (unit, hashes) => {
      await unit.store.saveConfirmation(confirmation("plan", "confirmed", hashes.plan!));
      await unit.store.saveConfirmation(
        confirmation("interventions", "deselected", hashes.interventions!),
      );
    });
    expect([...(confirmedSectionIds(result) ?? [])]).toEqual(["plan"]);
  });
});
