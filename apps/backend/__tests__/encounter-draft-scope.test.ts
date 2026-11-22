// S1 rollout scope (ADR-0114, design §3.2 "Scope"): a template the corpus does not draft reads no source, drafts nothing and asks the
// clinician nothing, so finalize, sign, the gate and the draft routes behave as they do with the tenant's switch off - however the seams
// behave. Every legal pair except the RN routine visit (the one template S1 drafts) is exercised with EVERY source made to throw.
// Fake seams, in-memory store, a transaction that fails on any use; no database (the live suite proves the Drizzle path).
import type { DbClient } from "@chartwarden/db";
import {
  ENCOUNTER_DISCIPLINE_RULES,
  type EncounterDiscipline,
  type EncounterType,
} from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import { computeDraftOverview } from "../src/modules/08-encounters/drafting/compute";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { readDraftInputs } from "../src/modules/08-encounters/drafting/inputs";
import { assertResolved, readNoteDraft } from "../src/modules/08-encounters/drafting/note-draft";
import { createNoteDraftFlow } from "../src/modules/08-encounters/drafting/note-draft-flow";
import { AS_OF, NOW, encounter, fakePorts, reader, viewer } from "./_encounter-draft-fixtures";
import { draftEncounterRow, memoryRunInOrg } from "./_encounter-draft-memory-store";

type Pair = readonly [EncounterType, EncounterDiscipline];

/**
 * The pairs that draft: S1's RN routine visit, S2's RN recertification visit and face-to-face visit (physician or nurse practitioner),
 * S2b's RN admission visit, S3's LPN visits and aide visit, S4's social-work and chaplain visits and S5's IDG follow-up of all six disciplines.
 * Stated here, not derived, so widening the corpus is a deliberate edit of this test.
 */
const DRAFTED_PAIRS: ReadonlySet<string> = new Set([
  "routine_visit:rn",
  "routine_visit:lpn",
  "recert_visit:rn",
  "admission_visit:rn",
  "face_to_face:md",
  "face_to_face:np",
  "lpn_visit:lpn",
  "chha_visit:chha",
  "msw_assessment:msw",
  "msw_followup:msw",
  "chaplain_assessment:chaplain",
  "chaplain_visit:chaplain",
  "idg_followup:rn",
  "idg_followup:lpn",
  "idg_followup:msw",
  "idg_followup:chaplain",
  "idg_followup:md",
  "idg_followup:np",
]);
const UNDRAFTED_PAIRS: readonly Pair[] = (
  Object.keys(ENCOUNTER_DISCIPLINE_RULES) as EncounterType[]
).flatMap((type) =>
  ENCOUNTER_DISCIPLINE_RULES[type]
    .filter((discipline) => !DRAFTED_PAIRS.has(`${type}:${discipline}`))
    .map((discipline): Pair => [type, discipline]),
);

const outage = async (): Promise<never> => {
  throw new Error("synthetic upstream outage");
};
const SEAM_NAMES = [
  "carePlanAsOf",
  "disciplinePlanAsOf",
  "idgFollowUpItems",
  "scaleSeries",
  "medicationChangesBetween",
  "part2DisclosureAllowed",
] as const;
const SOURCE_STORE_NAMES = [
  "organizationTimeZone",
  "previousSignedVisitAt",
  "latestVitals",
  "removedCarePlanElementIds",
  "removedDisciplinePlanElementIds",
  "linkedIdgActionItemId",
  "loadSelection",
] as const;

/** Every source seam throws. */
const brokenSeams = () =>
  fakePorts({
    carePlanAsOf: outage,
    disciplinePlanAsOf: outage,
    idgFollowUpItems: outage,
    scaleSeries: outage,
    medicationChangesBetween: outage,
    part2DisclosureAllowed: outage,
  });

/** An in-memory unit whose source reads throw, and whose switch is on. */
function brokenUnit() {
  const mem = memoryRunInOrg({ previous: new Date("2026-11-10T15:00:00.000Z") });
  for (const name of SOURCE_STORE_NAMES) mem.store[name].mockImplementation(outage);
  const enabled = vi.fn(async () => true);
  return { ...mem, enabled, unit: { ...mem.unit, enabled } };
}

const expectNoSourceRead = (
  seams: ReturnType<typeof brokenSeams>,
  store: ReturnType<typeof brokenUnit>["store"],
) => {
  for (const name of SEAM_NAMES) expect(seams[name], name).not.toHaveBeenCalled();
  for (const name of SOURCE_STORE_NAMES) expect(store[name], name).not.toHaveBeenCalled();
};

const keyOf = ([type, discipline]: Pair) => `${type}:${discipline}`;

describe("the gate and sign read nothing for a template the corpus does not draft", () => {
  for (const pair of UNDRAFTED_PAIRS) {
    it(`${keyOf(pair)}: no draft, no source read, not even the switch`, async () => {
      const { unit, store, enabled } = brokenUnit();
      const seams = brokenSeams();
      const encounter = draftEncounterRow({ encounterType: pair[0], discipline: pair[1] });
      const read = await readNoteDraft(unit, seams, encounter, reader(), NOW);
      expect(read).toBeNull();
      expect(() => assertResolved(read)).not.toThrow();
      expectNoSourceRead(seams, store);
      expect(enabled).not.toHaveBeenCalled();
    });
  }

  it("the flow finalize and sign call returns null and touches no transaction, so Layer 1 text and no sealed rows", async () => {
    const touched: string[] = [];
    const tx = new Proxy({} as DbClient, {
      get: (_target, property) => {
        touched.push(String(property));
        throw new Error("the transaction must not be used");
      },
    });
    const seams = brokenSeams();
    const flow = createNoteDraftFlow({
      clock: () => NOW,
      seams: () => seams,
      seal: async () => {
        throw new Error("nothing is sealed");
      },
    });
    const encounter = {
      ...draftEncounterRow({ encounterType: "telephonic", discipline: "msw" }),
      providerEntityId: null,
      locationId: null,
    };
    const draft = await flow.read(tx, encounter, reader());
    expect(draft).toBeNull();
    expect(flow.narrativeOf(draft)).toBeUndefined();
    await expect(flow.sealSigned(tx, encounter, draft)).resolves.toBeUndefined();
    expect(touched).toEqual([]);
    for (const name of SEAM_NAMES) expect(seams[name], name).not.toHaveBeenCalled();
  });

  it("a pair with no template is not drafted either (its own assembly refusal answers, as with the switch off)", async () => {
    const { unit } = brokenUnit();
    const encounter = draftEncounterRow({
      encounterType: "routine_visit",
      discipline: "volunteer",
    });
    await expect(readNoteDraft(unit, brokenSeams(), encounter, reader(), NOW)).resolves.toBeNull();
  });
});

describe("the draft routes for a template the corpus does not draft", () => {
  const caller = {
    organizationId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-0000000000bb",
    roles: ["rn"],
    membershipId: "00000000-0000-4000-8000-0000000000aa",
    // none of these templates draft anything, so none needs M6's read keys
    permissions: new Set<string>(),
  };
  const AUDIT = { organizationId: "o", userId: "u", correlationId: "c" } as const;
  const ENCOUNTER_ID = "00000000-0000-4000-8000-000000000004";

  function service(pair: Pair) {
    const mem = memoryRunInOrg({
      previous: new Date("2026-11-10T15:00:00.000Z"),
      encounter: draftEncounterRow({ encounterType: pair[0], discipline: pair[1] }),
    });
    for (const name of SOURCE_STORE_NAMES) mem.store[name].mockImplementation(outage);
    const seams = brokenSeams();
    const svc = createDraftService({ runInOrg: mem.runInOrg, seams: () => seams, now: () => NOW });
    return { ...mem, seams, svc };
  }

  for (const pair of UNDRAFTED_PAIRS) {
    it(`${keyOf(pair)}: GET answers every template section as not_drafted, read-time asOf, and reads no source`, async () => {
      const { svc, seams, store } = service(pair);
      const view = await svc.getDraft(caller, ENCOUNTER_ID);
      expect(view).toMatchObject({
        encounterId: ENCOUNTER_ID,
        templateKey: keyOf(pair),
        asOf: NOW.toISOString(),
      });
      expect(view.sections.length).toBeGreaterThan(0);
      for (const section of view.sections) {
        expect(section, section.sectionId).toEqual({
          sectionId: section.sectionId,
          state: "not_drafted",
          text: null,
          contentHash: null,
          corpusVersion: null,
          part2Derived: null,
          origins: [],
        });
      }
      expectNoSourceRead(seams, store);
    });
  }

  it("PUT a section is stale (nothing is drafted to confirm), writes nothing and reads no source", async () => {
    const { svc, seams, store, events } = service(["telephonic", "msw"]);
    const error = await svc
      .resolveSection(
        caller,
        ENCOUNTER_ID,
        "plan",
        { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
        AUDIT,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
    expect(store.saveConfirmation).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expectNoSourceRead(seams, store);
  });

  it("PUT a section the template lacks is still a 422", async () => {
    const { svc } = service(["telephonic", "msw"]);
    const error = await svc
      .resolveSection(
        caller,
        ENCOUNTER_ID,
        "vitals_review",
        { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
        AUDIT,
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "UNKNOWN_TEMPLATE_SECTION", statusCode: 422 });
  });

  it("computeDraftOverview refuses a pair with no template like the compiler does", async () => {
    const error = await computeDraftOverview(
      brokenSeams(),
      draftEncounterRow({ encounterType: "routine_visit", discipline: "volunteer" }),
      viewer(),
      NOW,
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INVALID_ENCOUNTER_DISCIPLINE_PAIR" });
  });
});

/** The visits whose draft states the orders in effect: the RN admission visit and the face-to-face visit by a physician or nurse practitioner. */
const ORDER_PAIRS: ReadonlySet<string> = new Set([
  "admission_visit:rn",
  "face_to_face:md",
  "face_to_face:np",
]);

describe("the orders in effect are read by exactly the templates that state them", () => {
  it.each([...DRAFTED_PAIRS])("%s", async (key) => {
    const [type, discipline] = key.split(":") as [EncounterType, EncounterDiscipline];
    const ports = fakePorts();
    await readDraftInputs(
      ports,
      encounter({ encounterType: type, discipline }),
      viewer({ roles: [discipline] }),
      AS_OF,
    );
    if (ORDER_PAIRS.has(key)) expect(ports.activeMedicationsAsOf).toHaveBeenCalledTimes(1);
    else expect(ports.activeMedicationsAsOf).not.toHaveBeenCalled();
  });
});
