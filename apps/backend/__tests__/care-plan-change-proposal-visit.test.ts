// apps/backend/__tests__/care-plan-change-proposal-visit.test.ts — WF09: the visit a change proposal is recorded in is checked, not trusted (no DB).
// M8's `EncounterDraftReader` seam answers who owns the visit; M7 turns the answer into the refusal. What the seam must be (an M8-owned PHI seam that
// fails closed until M8 registers it) and what M7 does with each answer is pinned here; the database half (create / replace under the real reader's
// shape, the per-proposer room cap, the Part 2 cascade) is proven live in m7-change-proposals.live.test.ts.
import type { EncounterDraftFacts, EncounterDraftReader } from "@chartwarden/types";
import { afterEach, describe, expect, it } from "vitest";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  registerSeam,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { createDbChangeProposalService } from "../src/modules/07-care-plan/change-proposals-db";
import {
  assertOwnDraftVisit,
  seamEncounterDraftReader,
  settlementOf,
} from "../src/modules/07-care-plan/change-proposals-visit";

const ORG = "77777777-7777-4777-8777-777777777777";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "11111111-1111-4111-8111-222222222222";
const ENCOUNTER = "55555555-5555-4555-8555-555555555555";
const AUTHOR = "b0000000-0000-4000-8000-000000000001";
const COLLEAGUE = "b0000000-0000-4000-8000-000000000002";

const OPEN_VISIT: EncounterDraftFacts = {
  patientId: PATIENT,
  status: "draft",
  authoredByMembershipId: AUTHOR,
  templateStatesWounds: true, // M9's concern: M7 does not read it
};
const readerOf = (facts: EncounterDraftFacts | null): EncounterDraftReader => ({
  draftOf: async () => facts,
});
const check = (visits: EncounterDraftReader, membershipId = AUTHOR) =>
  assertOwnDraftVisit(visits, {
    organizationId: ORG,
    encounterId: ENCOUNTER,
    patientId: PATIENT,
    membershipId,
  });

afterEach(() => __resetSeamsForTest());

describe("assertOwnDraftVisit", () => {
  it("lets the author bind a draft to their own open note for the plan's patient", async () => {
    await expect(check(readerOf(OPEN_VISIT))).resolves.toBeUndefined();
  });

  it("asks the seam about this organisation and this visit, and nothing else", async () => {
    const calls: unknown[] = [];
    await check({
      draftOf: async (input) => {
        calls.push(input);
        return OPEN_VISIT;
      },
    });
    expect(calls).toEqual([{ organizationId: ORG, encounterId: ENCOUNTER }]);
  });

  it.each([
    ["an unknown (or another organisation's) visit", null],
    ["another patient's visit", { ...OPEN_VISIT, patientId: OTHER_PATIENT }],
    ["another clinician's visit", { ...OPEN_VISIT, authoredByMembershipId: COLLEAGUE }],
  ])("is a 404 for %s", async (_name, facts) => {
    await expect(check(readerOf(facts))).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it.each(["finalized", "signed", "cosign_pending", "cosigned", "voided"] as const)(
    "is a 409 ENCOUNTER_NOT_DRAFT for the author's own %s note, so a late POST is told why instead of being stranded",
    async (status) => {
      await expect(check(readerOf({ ...OPEN_VISIT, status }))).rejects.toMatchObject({
        code: "ENCOUNTER_NOT_DRAFT",
        statusCode: 409,
      });
    },
  );

  it("never reveals a closed note's state to someone who is not its author", async () => {
    await expect(
      check(readerOf({ ...OPEN_VISIT, status: "finalized" }), COLLEAGUE),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets a reader failure through: an unreadable M8 refuses the write", async () => {
    const broken: EncounterDraftReader = {
      draftOf: async () => {
        throw new Error("M8 unreachable");
      },
    };
    await expect(check(broken)).rejects.toThrow("M8 unreachable");
  });
});

describe("settlementOf (a visit that closed while a draft was committing)", () => {
  it.each([
    ["finalized", "release"],
    ["signed", "release"],
    ["cosign_pending", "release"],
    ["cosigned", "release"],
    ["voided", "withdraw"],
  ] as const)(
    "a %s note: the draft is moved the way the lifecycle consumer moves it (%s)",
    (status, move) => {
      expect(settlementOf(status)).toBe(move);
    },
  );

  it("leaves a draft alone while its note is still being written, or when M8 can say nothing", () => {
    expect(settlementOf("draft")).toBeNull();
    expect(settlementOf(undefined)).toBeNull();
  });
});

describe("the EncounterDraftReader seam", () => {
  it("is an M8-owned PHI seam with a deny-stub", () => {
    const entry = REQUIRED_SEAMS.find((s) => s.key === "EncounterDraftReader");
    expect(entry).toMatchObject({ ownerModule: 8, phi: true });
    expect(entry?.denyStub).toBeDefined();
  });

  it("fails closed until M8 registers it: the deny-stub throws, so M7 refuses the write", async () => {
    validateSeams();
    expect(() =>
      getSeam("EncounterDraftReader").draftOf({ organizationId: ORG, encounterId: ENCOUNTER }),
    ).toThrow(NotImplementedError);
    await expect(check(seamEncounterDraftReader)).rejects.toThrow(NotImplementedError);
  });

  it("is resolved per call, so the reader M8 registers is the one consulted", async () => {
    registerSeam("EncounterDraftReader", readerOf(OPEN_VISIT));
    await expect(check(seamEncounterDraftReader)).resolves.toBeUndefined();
    registerSeam("EncounterDraftReader", readerOf({ ...OPEN_VISIT, status: "voided" }));
    await expect(check(seamEncounterDraftReader)).rejects.toMatchObject({
      code: "ENCOUNTER_NOT_DRAFT",
    });
  });
});

describe("a replace cannot make a proposal its own parent", () => {
  it("is refused before any database work", async () => {
    // A database that fails the test if anything touches it.
    const untouchableDb = new Proxy(
      {},
      {
        get() {
          throw new Error("the database must not be reached");
        },
      },
    ) as never;
    const proposalId = "66666666-6666-4666-8666-666666666666";
    const service = createDbChangeProposalService(untouchableDb);
    await expect(
      service.replace(
        ORG,
        "22222222-2222-4222-8222-222222222222",
        proposalId,
        { kind: "goal_add", parentProposalId: proposalId, originalText: "x" } as never,
        { userId: "u", membershipId: AUTHOR, sudDisclosureAllowed: false },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", statusCode: 422 });
  });
});
