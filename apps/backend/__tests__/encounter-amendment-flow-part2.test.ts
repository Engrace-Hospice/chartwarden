// S1 fix wave 2 - the Part 2 refusal of an amendment is ONE answer for the whole note, not one per named section (ADR-0114 VN-D30, VN-D13).
// A signer without disclosure who names a section of a note that holds Part 2 content in ANY section is refused the same way whichever section they
// name; otherwise the 422-versus-201 difference would tell a note's author which sections hold Part 2. Template section ids are public, so
// answering "unknown section" for a Part 2 section would be the same oracle. The flow runs over fakes: the store reads, the switch and the seams.
import type { DbClient } from "@chartwarden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  originalSectionsOf: vi.fn(),
  noteHasPart2Version: vi.fn(),
  nameSections: vi.fn(async () => undefined),
  namedSectionIds: vi.fn(),
}));
vi.mock("../src/modules/08-encounters/drafting/amendment-store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/modules/08-encounters/drafting/amendment-store")
  >()),
  ...store,
}));
const policy = vi.hoisted(() => ({ isVisitNoteDraftEnabled: vi.fn(async () => true) }));
vi.mock("../src/modules/08-encounters/drafting/policy-service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/modules/08-encounters/drafting/policy-service")
  >()),
  ...policy,
}));

import { createAmendmentFlow } from "../src/modules/08-encounters/drafting/amendment-flow";
import { fakePorts } from "./_encounter-draft-fixtures";

const TX = {} as DbClient;
const ORG = "00000000-0000-4000-8000-000000000001";
const PATIENT = "00000000-0000-4000-8000-000000000002";
const ENCOUNTER = "00000000-0000-4000-8000-000000000004";
const ADDENDUM = "00000000-0000-4000-8000-0000000000ad";
const AUTHOR = {
  roles: ["rn"],
  membershipId: "00000000-0000-4000-8000-0000000000aa",
  // a routine visit's draft needs none of M6's read keys
  permissions: new Set<string>(),
};
const addendum = {
  id: ADDENDUM,
  organizationId: ORG,
  encounterId: ENCOUNTER,
  patientId: PATIENT,
  providerEntityId: null,
  locationId: null,
};
const original = (sectionId: string, position: number) => ({
  id: `00000000-0000-4000-8000-0000000000${position}1`,
  sectionId,
  position,
});

function flowWith(disclosure: () => Promise<boolean>) {
  const seams = fakePorts({ part2DisclosureAllowed: vi.fn(disclosure) });
  const flow = createAmendmentFlow({
    clock: () => new Date("2026-11-18T20:00:00.000Z"),
    seams: () => seams,
    seal: async (_org, text) => text,
  });
  return { flow, seams };
}

const refusal = async (p: Promise<unknown>) =>
  (await p.then(
    () => undefined,
    (e: unknown) => e,
  )) as { code: string; statusCode: number; message: string } | undefined;

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  policy.isVisitNoteDraftEnabled.mockResolvedValue(true);
  store.nameSections.mockResolvedValue(undefined);
  store.originalSectionsOf.mockResolvedValue([
    original("chief_concern", 1),
    original("interventions", 2),
    original("plan", 3),
  ]);
});

describe("naming a section of a note that holds Part 2 content", () => {
  it.each(["chief_concern", "interventions", "plan"])(
    "refuses a signer without disclosure with the one generic 422 whichever section they name (%s), writing nothing",
    async (sectionId) => {
      store.noteHasPart2Version.mockResolvedValue(true);
      const { flow } = flowWith(async () => false);
      const error = await refusal(flow.name(TX, addendum, [sectionId], AUTHOR));
      expect(error).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
      expect(error?.message).toBe("this note cannot be amended by this signer");
      expect(error?.message).not.toContain(sectionId);
      expect(store.nameSections).not.toHaveBeenCalled();
    },
  );

  it("answers a Part 2 section and a non-Part 2 section with the same code, status and message", async () => {
    store.noteHasPart2Version.mockResolvedValue(true);
    const { flow } = flowWith(async () => false);
    const part2 = await refusal(flow.name(TX, addendum, ["interventions"], AUTHOR));
    const plain = await refusal(flow.name(TX, addendum, ["plan"], AUTHOR));
    expect(part2).toBeDefined();
    expect({ code: plain?.code, statusCode: plain?.statusCode, message: plain?.message }).toEqual({
      code: part2?.code,
      statusCode: part2?.statusCode,
      message: part2?.message,
    });
  });

  it("names the sections for a signer with disclosure, asking the verdict once", async () => {
    store.noteHasPart2Version.mockResolvedValue(true);
    const { flow, seams } = flowWith(async () => true);
    await flow.name(TX, addendum, ["chief_concern", "interventions"], AUTHOR);
    expect(seams.part2DisclosureAllowed).toHaveBeenCalledTimes(1);
    expect(store.nameSections).toHaveBeenCalledWith(TX, addendum, [
      "chief_concern",
      "interventions",
    ]);
  });

  it("a verdict that cannot be decided is the 503 DRAFT_UNAVAILABLE, never a pass, even for a section that holds no Part 2", async () => {
    store.noteHasPart2Version.mockResolvedValue(true);
    const { flow } = flowWith(async () => {
      throw new Error("synthetic M39 outage");
    });
    expect(await refusal(flow.name(TX, addendum, ["plan"], AUTHOR))).toMatchObject({
      code: "DRAFT_UNAVAILABLE",
      statusCode: 503,
    });
    expect(store.nameSections).not.toHaveBeenCalled();
  });
});

describe("naming a section of a note with no Part 2 content", () => {
  it("asks nobody and names the section: the verdict is asked only when the note has Part 2 content", async () => {
    store.noteHasPart2Version.mockResolvedValue(false);
    const { flow, seams } = flowWith(async () => false);
    await flow.name(TX, addendum, ["plan"], AUTHOR);
    expect(seams.part2DisclosureAllowed).not.toHaveBeenCalled();
    expect(store.nameSections).toHaveBeenCalledOnce();
  });

  it("keeps the existing validation error for a section the note does not carry, before any Part 2 question", async () => {
    store.noteHasPart2Version.mockResolvedValue(true);
    const { flow, seams } = flowWith(async () => false);
    expect(await refusal(flow.name(TX, addendum, ["no_such_section"], AUTHOR))).toMatchObject({
      code: "UNKNOWN_TEMPLATE_SECTION",
      statusCode: 422,
    });
    expect(seams.part2DisclosureAllowed).not.toHaveBeenCalled();
  });

  it("a free addendum (no sections) is untouched: nothing is read, nothing is asked", async () => {
    const { flow, seams } = flowWith(async () => false);
    await flow.name(TX, addendum, [], AUTHOR);
    expect(store.noteHasPart2Version).not.toHaveBeenCalled();
    expect(seams.part2DisclosureAllowed).not.toHaveBeenCalled();
    expect(store.nameSections).not.toHaveBeenCalled();
  });
});

describe("signing an amending addendum over a note that holds Part 2 content", () => {
  const parent = {
    id: ENCOUNTER,
    organizationId: ORG,
    patientId: PATIENT,
    encounterType: "routine_visit",
    discipline: "rn",
    serviceDate: "2026-11-01",
    status: "signed",
    providerEntityId: null,
    locationId: null,
  } as never;

  it.each([["plan"], ["interventions"]])(
    "refuses a signer without disclosure with the same generic 422 whichever section the addendum names (%s)",
    async (sectionId) => {
      store.namedSectionIds.mockResolvedValue([sectionId]);
      store.noteHasPart2Version.mockResolvedValue(true);
      const { flow } = flowWith(async () => false);
      const error = await refusal(flow.prepare(TX, parent, ADDENDUM, AUTHOR));
      expect(error).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
      expect(error?.message).toBe("this note cannot be amended by this signer");
    },
  );

  it("a verdict that cannot be decided at sign is the 503 COMPLIANCE_GATE_UNAVAILABLE", async () => {
    store.namedSectionIds.mockResolvedValue(["plan"]);
    store.noteHasPart2Version.mockResolvedValue(true);
    const { flow } = flowWith(async () => {
      throw new Error("synthetic M39 outage");
    });
    expect(await refusal(flow.prepare(TX, parent, ADDENDUM, AUTHOR))).toMatchObject({
      code: "COMPLIANCE_GATE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("asks nobody when the note holds no Part 2 content: it goes on to the draft (here switched off, so the sign is refused for that)", async () => {
    store.namedSectionIds.mockResolvedValue(["plan"]);
    store.noteHasPart2Version.mockResolvedValue(false);
    policy.isVisitNoteDraftEnabled.mockResolvedValue(false);
    const { flow, seams } = flowWith(async () => false);
    const error = await refusal(flow.prepare(TX, parent, ADDENDUM, AUTHOR));
    expect(seams.part2DisclosureAllowed).not.toHaveBeenCalled();
    expect(error?.code).toBe("DRAFT_OFF_AFTER_FINALIZE");
  });

  it("a free addendum signs as it always did: prepare is null and nothing is read", async () => {
    store.namedSectionIds.mockResolvedValue([]);
    const { flow, seams } = flowWith(async () => false);
    expect(await flow.prepare(TX, parent, ADDENDUM, AUTHOR)).toBeNull();
    expect(store.noteHasPart2Version).not.toHaveBeenCalled();
    expect(seams.part2DisclosureAllowed).not.toHaveBeenCalled();
  });
});
