// apps/backend/__tests__/wounds-patient-exists.test.ts — WF09 / CW-AC-54: a wound is registered only for a patient that exists in the caller's own
// organisation (no DB). M5's `PatientReader` seam answers; M9 turns the answer into the refusal. What the seam must be (an M5-owned PHI seam that
// fails closed until M5 registers it), what each answer does, and that BOTH wound services ask before they write are pinned here; the database half
// (the real reader over a real `patient` table, RLS, another tenant's patient, no wound row left behind) is wounds.live.test.ts.
import { NotFoundError, type PatientReader } from "@chartwarden/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  getSeam,
  registerSeam,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import {
  type WoundPatientReader,
  createInMemoryWoundService,
  seamWoundPatientReader,
  woundPatientReaderOver,
} from "../src/modules/09-assessments/index";
import { assertPatientExists } from "../src/modules/09-assessments/wounds/patient-exists";

const ORG = "77777777-7777-4777-8777-777777777777";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ACTOR = {
  organizationId: ORG,
  userId: "u1",
  membershipId: "b0000000-0000-4000-8000-000000000001",
};
const WOUND = { siteCode: "heel", laterality: "left", etiology: "pressure_injury" } as const;

const readerOf = (known: readonly string[]): WoundPatientReader => ({
  exists: async ({ patientId }) => known.includes(patientId),
});
const identity = (id: string) =>
  ({ id }) as unknown as NonNullable<Awaited<ReturnType<PatientReader["findById"]>>>;

afterEach(() => __resetSeamsForTest());

describe("assertPatientExists", () => {
  it("passes for a patient the organisation has", async () => {
    await expect(
      assertPatientExists(readerOf([PATIENT]), { organizationId: ORG, patientId: PATIENT }),
    ).resolves.toBeUndefined();
  });

  it("answers 404 for a patient it does not have", async () => {
    const refusal = await assertPatientExists(readerOf([]), {
      organizationId: ORG,
      patientId: PATIENT,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(NotFoundError);
    expect(refusal).toMatchObject({ statusCode: 404 });
  });

  it("refuses when the reader fails: the failure is never read as 'exists'", async () => {
    const broken: WoundPatientReader = {
      exists: async () => {
        throw new Error("patient read failed");
      },
    };
    await expect(
      assertPatientExists(broken, { organizationId: ORG, patientId: PATIENT }),
    ).rejects.toThrow("patient read failed");
  });
});

describe("woundPatientReaderOver / the PatientReader seam", () => {
  it("is an M5-owned PHI seam with a deny-stub", () => {
    const entry = REQUIRED_SEAMS.find((s) => s.key === "PatientReader");
    expect(entry).toMatchObject({ ownerModule: 5, phi: true });
    expect(entry?.denyStub).toBeDefined();
  });

  it("asks M5 by organisation and id, and reads null as absent", async () => {
    const findById = vi.fn(async ({ id }: { organizationId: string; id: string }) =>
      id === PATIENT ? identity(id) : null,
    );
    const reader = woundPatientReaderOver({ findById });
    await expect(reader.exists({ organizationId: ORG, patientId: PATIENT })).resolves.toBe(true);
    await expect(
      reader.exists({ organizationId: ORG, patientId: "11111111-1111-4111-8111-999999999999" }),
    ).resolves.toBe(false);
    expect(findById).toHaveBeenCalledWith({ organizationId: ORG, id: PATIENT });
  });

  it("does not take a merge survivor for the patient asked about: a retired id is not a patient to register a wound for", async () => {
    const SURVIVOR = "11111111-1111-4111-8111-222222222222";
    const reader = woundPatientReaderOver({ findById: async () => identity(SURVIVOR) });
    await expect(reader.exists({ organizationId: ORG, patientId: PATIENT })).resolves.toBe(false);
    await expect(reader.exists({ organizationId: ORG, patientId: SURVIVOR })).resolves.toBe(true);
  });

  it("accepts the same patient under an uppercase or mixed-case id: the route's uuid format is case-insensitive and Postgres answers in lowercase", async () => {
    // an id with hex letters, so that its case really differs (the all-digit PATIENT above reads the same in any case)
    const LETTERED = "ab12cd34-1111-4111-8111-abcdefabcdef";
    const reader = woundPatientReaderOver({ findById: async () => identity(LETTERED) }); // M5 answers the stored, lowercase id
    for (const asked of [
      LETTERED.toUpperCase(),
      `${LETTERED.slice(0, 18)}${LETTERED.slice(18).toUpperCase()}`,
    ]) {
      expect(asked).not.toBe(LETTERED);
      await expect(reader.exists({ organizationId: ORG, patientId: asked })).resolves.toBe(true);
    }
  });

  it("still refuses a different id in any case: a merge survivor asked for under the retired id, upper or lower", async () => {
    const RETIRED = "ab12cd34-1111-4111-8111-abcdefabcdef";
    const SURVIVOR = "cd34ab12-1111-4111-8111-fedcbafedcba";
    const reader = woundPatientReaderOver({ findById: async () => identity(SURVIVOR) });
    await expect(reader.exists({ organizationId: ORG, patientId: RETIRED })).resolves.toBe(false);
    await expect(
      reader.exists({ organizationId: ORG, patientId: RETIRED.toUpperCase() }),
    ).resolves.toBe(false);
    // the survivor itself, asked for in uppercase, is the patient answered
    await expect(
      reader.exists({ organizationId: ORG, patientId: SURVIVOR.toUpperCase() }),
    ).resolves.toBe(true);
  });

  it("fails closed until M5 registers it: the deny-stub throws, so no wound is registered", async () => {
    validateSeams();
    expect(() => getSeam("PatientReader").findById({ organizationId: ORG, id: PATIENT })).toThrow(
      NotImplementedError,
    );
    await expect(
      seamWoundPatientReader.exists({ organizationId: ORG, patientId: PATIENT }),
    ).rejects.toThrow(NotImplementedError);
  });

  it("is resolved per call, so the reader M5 registers is the one consulted", async () => {
    const findById = vi.fn(async () => null);
    registerSeam("PatientReader", { findById } as unknown as PatientReader);
    await expect(
      seamWoundPatientReader.exists({ organizationId: ORG, patientId: PATIENT }),
    ).resolves.toBe(false);
    expect(findById).toHaveBeenCalledTimes(1);
  });
});

describe("createWound asks before it writes", () => {
  it("the in-memory service refuses an unknown patient with a 404 and stores no wound", async () => {
    const backend = createInMemoryWoundService({ patients: readerOf([]) });
    await expect(backend.service.createWound(ACTOR, PATIENT, WOUND)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(backend.wounds()).toEqual([]);
  });

  it("the in-memory service registers the wound for a known patient (the control)", async () => {
    const backend = createInMemoryWoundService({ patients: readerOf([PATIENT]) });
    const wound = await backend.service.createWound(ACTOR, PATIENT, WOUND);
    expect(wound).toMatchObject({ patientId: PATIENT, status: "open" });
    expect(backend.wounds()).toHaveLength(1);
  });
});
