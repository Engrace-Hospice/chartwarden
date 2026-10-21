// apps/backend/__tests__/bereavement-gap047-049.test.ts — GAP-047 (D7 early-close cosign) + GAP-049 (D15
// completion kind + M8 source-encounter verification). Pure decisions over injected facts, plus M8's
// BereavementEncounterReader over a fake db.
import type { DbClient } from "@chartwarden/db";
import type { BereavementEncounterReader } from "@chartwarden/types";
import { ForbiddenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { createBereavementEncounterReader } from "../src/modules/08-encounters/seams/bereavement-encounter-reader";
import {
  BereavementStateError,
  assertCompletionKindMatchesOutreach,
  assertCosignerDistinct,
  assertEarlyCloseRequestable,
  transitionBereavementPlan,
  verifySourceEncounter,
} from "../src/modules/16-bereavement/lifecycle/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "22222222-2222-2222-2222-222222222222";
const OTHER_PATIENT = "99999999-9999-9999-9999-999999999999";
const ENCOUNTER = "33333333-3333-3333-3333-333333333333";
const COUNSELOR = "66666666-6666-6666-6666-666666666666";
const SUPERVISOR = "77777777-7777-7777-7777-777777777777";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

const readerOf = (
  facts: Awaited<ReturnType<BereavementEncounterReader["getBereavementEncounterFacts"]>>,
): BereavementEncounterReader => ({ getBereavementEncounterFacts: async () => facts });

const GOOD = {
  encounterId: ENCOUNTER,
  patientId: PATIENT,
  isBereavementContact: true,
  isSigned: true,
};

describe("GAP-047 — the early-close cosign is two different people", () => {
  it("rejects a self-cosign with a 403", () => {
    expect(() => assertCosignerDistinct(COUNSELOR, COUNSELOR)).toThrow(ForbiddenError);
  });

  it("rejects a cosign when the requester is unknown (fail closed)", () => {
    expect(() => assertCosignerDistinct(null, SUPERVISOR)).toThrow(ForbiddenError);
  });

  it("accepts a different supervisor", () => {
    expect(() => assertCosignerDistinct(COUNSELOR, SUPERVISOR)).not.toThrow();
  });

  it("refuses a second pending request and a request on a closed plan", () => {
    expect(code(() => assertEarlyCloseRequestable("active", new Date()))).toBe(
      "EARLY_CLOSE_ALREADY_REQUESTED",
    );
    expect(code(() => assertEarlyCloseRequestable("closed_early", null))).toBe("PLAN_CLOSED");
    expect(() => assertEarlyCloseRequestable("active", null)).not.toThrow();
  });

  it("the machine itself refuses a closeEarly whose cosigner is the requester", () => {
    expect(
      code(() =>
        transitionBereavementPlan("active", {
          type: "closeEarly",
          reason: "tenant_offboarding",
          narrative: "the agency is winding down its hospice license effective next quarter",
          at: "2026-10-05T00:00:00.000Z" as never,
          cosignedByUserId: COUNSELOR as never,
          requestedByUserId: COUNSELOR as never,
        }),
      ),
    ).toBe("EARLY_CLOSE_SELF_COSIGN");
  });
});

describe("GAP-049 — outreach completion", () => {
  it("rejects a completion whose kind differs from the stored outreach kind (409)", () => {
    expect(code(() => assertCompletionKindMatchesOutreach("in_person_visit", "phone_call"))).toBe(
      "OUTREACH_KIND_MISMATCH",
    );
    expect(() => assertCompletionKindMatchesOutreach("phone_call", "phone_call")).not.toThrow();
  });

  it("accepts a signed bereavement_contact encounter for the same patient", async () => {
    await expect(
      verifySourceEncounter({
        reader: readerOf(GOOD),
        organizationId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["unknown encounter", null],
    ["another patient's encounter", { ...GOOD, patientId: OTHER_PATIENT }],
    ["a non-bereavement encounter", { ...GOOD, isBereavementContact: false }],
    ["an unsigned encounter", { ...GOOD, isSigned: false }],
  ])("rejects %s with 422", async (_name, facts) => {
    await expect(
      verifySourceEncounter({
        reader: readerOf(facts),
        organizationId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_ENCOUNTER_INVALID", statusCode: 422 });
  });

  it("fails closed (422) when the M8 seam throws, e.g. the deny-stub", async () => {
    const denying: BereavementEncounterReader = {
      getBereavementEncounterFacts: () => {
        throw new Error("not implemented");
      },
    };
    await expect(
      verifySourceEncounter({
        reader: denying,
        organizationId: ORG,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
      }),
    ).rejects.toBeInstanceOf(BereavementStateError);
  });
});

describe("GAP-049 — M8 BereavementEncounterReader over a fake db", () => {
  function fakeDb(rows: readonly Record<string, unknown>[]) {
    const tx = {
      async execute() {},
      select() {
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
      },
    };
    return {
      async transaction<R>(fn: (t: typeof tx) => Promise<R>) {
        return fn(tx);
      },
    } as unknown as DbClient;
  }
  const row = (over: Record<string, unknown>) => ({
    id: ENCOUNTER,
    patientId: PATIENT,
    encounterType: "bereavement_contact",
    status: "signed",
    voidedAt: null,
    ...over,
  });
  const read = (rows: readonly Record<string, unknown>[]) =>
    createBereavementEncounterReader(fakeDb(rows)).getBereavementEncounterFacts({
      organizationId: ORG,
      encounterId: ENCOUNTER,
    });

  it("returns null for an unknown encounter", async () => {
    expect(await read([])).toBeNull();
  });

  it("projects type and signed state", async () => {
    expect(await read([row({})])).toEqual({
      encounterId: ENCOUNTER,
      patientId: PATIENT,
      isBereavementContact: true,
      isSigned: true,
    });
    expect(await read([row({ status: "draft" })])).toMatchObject({ isSigned: false });
    expect(await read([row({ status: "cosigned", voidedAt: new Date() })])).toMatchObject({
      isSigned: false,
    });
    expect(await read([row({ encounterType: "routine_visit" })])).toMatchObject({
      isBereavementContact: false,
    });
  });
});
