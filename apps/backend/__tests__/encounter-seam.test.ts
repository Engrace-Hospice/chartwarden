// apps/backend/__tests__/encounter-seam.test.ts — M8-T08 (§4.7 owned seams + the consumed CarePlanReader).
// The four owned seams are pure orchestration over an injected EncounterReaderStore; these cover the
// §2.4/D3/D4/D12 billability rule (`deriveBillability`), the M14 signed-digest reader + M22 render
// payload (with the not-found throw), the M27 payroll mileage window, the EncounterCreator draft mint,
// and the boot wiring (registerEncounterSeams replaces the deny-stubs; validateSeams passes; the
// deny-stubs deny loudly). It also asserts M8 CONSUMES M7's CarePlanReader through the registry.
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, getSeam, registerSeam, validateSeams } from "../src/bootstrap/index";
import {
  type EncounterReaderSeed,
  type StoredEncounterFacts,
  createInMemoryEncounterReaderStore,
  deriveBillability,
  getCarePlanReader,
  registerEncounterSeams,
} from "../src/modules/08-encounters/index";

const PAT = "00000000-0000-4000-8000-0000000000aa";
const ADM = "00000000-0000-4000-8000-0000000000bb";
const NURSE = "00000000-0000-4000-8000-0000000000cc";

/** A signed RN routine visit (the billable base case). */
const rnSigned: StoredEncounterFacts = {
  encounterId: "enc-rn",
  patientId: PAT,
  encounterType: "routine_visit",
  discipline: "rn",
  status: "signed",
  lateEntryTier: "normal",
  cosignatureResolved: false,
  lateEntryAttested: false,
};

describe("deriveBillability (§2.4 / D3 / D4 / D12)", () => {
  it("a signed RN visit is billable", () => {
    expect(deriveBillability(rnSigned)).toEqual({ encounterId: "enc-rn", billable: true });
  });

  it("a voided encounter is not billable (voided)", () => {
    expect(deriveBillability({ ...rnSigned, status: "voided" })).toEqual({
      encounterId: "enc-rn",
      billable: false,
      reason: "voided",
    });
  });

  it("a volunteer visit is not billable (volunteer_non_billable)", () => {
    expect(
      deriveBillability({ ...rnSigned, discipline: "volunteer", encounterType: "volunteer_visit" }),
    ).toEqual({ encounterId: "enc-rn", billable: false, reason: "volunteer_non_billable" });
  });

  it("an LPN visit awaiting its RN cosignature is not billable (awaiting_cosignature) until cosigned", () => {
    const lpn: StoredEncounterFacts = { ...rnSigned, discipline: "lpn", status: "cosign_pending" };
    expect(deriveBillability(lpn).reason).toBe("awaiting_cosignature");
    // …and flips billable once it reaches `cosigned`.
    expect(deriveBillability({ ...lpn, status: "cosigned" })).toEqual({
      encounterId: "enc-rn",
      billable: true,
    });
  });

  it("a significant late entry with an unattested override is not billable (late_entry_unattested)", () => {
    expect(deriveBillability({ ...rnSigned, lateEntryTier: "significant_late_entry" }).reason).toBe(
      "late_entry_unattested",
    );
    // attested ⇒ billable again.
    expect(
      deriveBillability({
        ...rnSigned,
        lateEntryTier: "significant_late_entry",
        lateEntryAttested: true,
      }).billable,
    ).toBe(true);
  });
});

function store(seed: EncounterReaderSeed = {}) {
  return createInMemoryEncounterReaderStore({ facts: [rnSigned], ...seed }).store;
}

describe("BillableEncounterReader.billability (§4.7)", () => {
  it("maps a batch of ids to verdicts and omits ids the store cannot see", async () => {
    registerEncounterSeams({ store: store() });
    const reader = getSeam("BillableEncounterReader");
    const out = await reader.billability(["enc-rn", "ghost"]);
    expect(out).toEqual([{ encounterId: "enc-rn", billable: true }]);
    __resetSeamsForTest();
  });
});

describe("SignedEncountersReader (§4.7)", () => {
  afterEach(() => __resetSeamsForTest());

  it("returns digests for the patient since an instant, oldest-first", async () => {
    const digests = [
      {
        encounterId: "enc-old",
        patientId: PAT,
        admissionId: ADM,
        encounterType: "routine_visit" as const,
        discipline: "rn" as const,
        serviceDate: "2026-01-01",
        signedAt: "2026-01-01T12:00:00.000Z",
        signedByMembershipId: NURSE,
        lateEntryTier: "normal" as const,
        status: "signed" as const,
        evvBracketState: "evv_present" as const,
        durationMinutes: null,
      },
      {
        ...{
          encounterId: "enc-new",
          patientId: PAT,
          admissionId: ADM,
          encounterType: "routine_visit" as const,
          discipline: "rn" as const,
          serviceDate: "2026-02-01",
          signedAt: "2026-02-01T12:00:00.000Z",
          signedByMembershipId: NURSE,
          lateEntryTier: "normal" as const,
          status: "signed" as const,
          evvBracketState: "evv_present" as const,
          durationMinutes: null,
        },
      },
    ];
    registerEncounterSeams({ store: store({ digests }) });
    const reader = getSeam("SignedEncountersReader");
    const out = await reader.signedEncountersForPatientSince(
      "org-1",
      PAT,
      "2026-01-15T00:00:00.000Z",
    );
    expect(out.map((d) => d.encounterId)).toEqual(["enc-new"]);
  });

  it("renderPayloadFor returns the payload, or throws when the encounter is not visible", async () => {
    const payloads = [{ encounterId: "enc-rn", final: "Signed narrative.", addenda: [] }];
    registerEncounterSeams({ store: store({ payloads }) });
    const reader = getSeam("SignedEncountersReader");
    expect((await reader.renderPayloadFor("enc-rn")).final).toBe("Signed narrative.");
    await expect(reader.renderPayloadFor("ghost")).rejects.toThrow(/not found/);
  });
});

describe("MileagePayrollReader (§4.5 D10 / §4.7)", () => {
  afterEach(() => __resetSeamsForTest());

  it("returns a clinician's mileage rows within the service-date window", async () => {
    const mileage = [
      {
        mileageId: "m1",
        encounterId: "enc-rn",
        clinicianMembershipId: NURSE,
        serviceDate: "2026-01-10",
        milesDriven: 12,
      },
      {
        mileageId: "m2",
        encounterId: "enc-old",
        clinicianMembershipId: NURSE,
        serviceDate: "2026-02-20",
        milesDriven: 8,
      },
    ];
    registerEncounterSeams({ store: store({ mileage }) });
    const reader = getSeam("MileagePayrollReader");
    const out = await reader.mileageForPayrollPeriod(NURSE, {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(out.map((r) => r.mileageId)).toEqual(["m1"]);
  });
});

describe("EncounterCreator (§4.7)", () => {
  afterEach(() => __resetSeamsForTest());

  it("mints a draft encounter that then resolves as not-yet-billable (awaiting authoring/sign)", async () => {
    const s = createInMemoryEncounterReaderStore().store;
    registerEncounterSeams({ store: s });
    const creator = getSeam("EncounterCreator");
    const { encounterId } = await creator.createDraftEncounter({
      patientId: PAT,
      admissionId: ADM,
      encounterType: "lpn_visit",
      discipline: "lpn",
      serviceDate: "2026-03-01",
      authorMembershipId: NURSE,
    });
    expect(encounterId).toMatch(/^[0-9a-f-]{36}$/);
    // The freshly created LPN draft is held out of billing until its RN cosignature resolves (D3).
    const billable = getSeam("BillableEncounterReader");
    expect((await billable.billability([encounterId]))[0]?.reason).toBe("awaiting_cosignature");
  });
});

describe("boot wiring (registerEncounterSeams)", () => {
  afterEach(() => __resetSeamsForTest());

  it("registers all four owned seams so validateSeams passes and they resolve as real impls", async () => {
    registerEncounterSeams({ store: store() });
    expect(() => validateSeams()).not.toThrow();
    expect((await getSeam("BillableEncounterReader").billability(["enc-rn"]))[0]?.billable).toBe(
      true,
    );
  });

  it("falls back to fail-closed deny-stubs when M8 does not register (deny loudly)", () => {
    validateSeams();
    expect(() => getSeam("BillableEncounterReader").billability(["enc-rn"])).toThrow(
      /not implemented/,
    );
    expect(() =>
      getSeam("MileagePayrollReader").mileageForPayrollPeriod(NURSE, { from: "a", to: "b" }),
    ).toThrow(/not implemented/);
    expect(() => getSeam("EncounterCreator").createDraftEncounter).not.toThrow(); // property access ok
  });

  it("M8 CONSUMES M7's CarePlanReader through the registry (boot-validated seam, not a schema import)", () => {
    const carePlan = {
      relevantElementsForEncounter: async () => null,
      isReviewOverdue: async () => null,
      // The two M30 org rollups the seam also publishes; this case asserts registry round-trip only.
      fifteenDayCycleCountsForOrg: async () => {
        throw new Error("not exercised by this suite");
      },
      terminologyCodeUsageForOrg: async () => {
        throw new Error("not exercised by this suite");
      },
    };
    registerSeam("CarePlanReader", carePlan);
    expect(getCarePlanReader()).toBe(carePlan);
  });
});
