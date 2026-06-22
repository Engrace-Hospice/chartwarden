// apps/backend/__tests__/patient-reader-mutator-seam.test.ts — M5-T08 PatientReader (§4.8) +
// PatientMutator (§4.9) seams. Proves M5 closes the other two boot-gate deny-stubs (validateSeams
// passes), PatientReader resolves merge-redirect transparently (W-M5-18), and PatientMutator strips
// the D12 forbidden identifiers (W-M5-17) while applying the demographic patch + emitting patient.updated.
import type { PatientIdentity } from "@wardenx/types";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import {
  REQUIRED_SEAMS,
  __resetSeamsForTest,
  validateSeams,
} from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  createInMemoryPatientMutatorStore,
  createInMemoryPatientReaderStore,
  getPatientMutator,
  getPatientReader,
  registerPatientSeams,
} from "../src/modules/05-patient/index";

const ORG = "org_a";
const SURVIVOR = "surv-1";
const MERGED = "merged-1";

const survivor: PatientIdentity = {
  id: SURVIVOR,
  organizationId: ORG,
  mrn: "MRN-S",
  externalMrns: [{ assigningAuthority: "ST_ANTHONY", value: "EXT-1" }],
  lastName: "Lovelace",
  firstName: "Ada",
  dateOfBirth: "1990-01-01",
  administrativeSex: "F",
  ssnLast4: "6789",
};
const merged: PatientIdentity = {
  id: MERGED,
  organizationId: ORG,
  mrn: "MRN-M",
  externalMrns: [],
  lastName: "Lovelace",
  firstName: "Ada",
  dateOfBirth: "1990-01-01",
  administrativeSex: "F",
  mergedIntoId: SURVIVOR, // redirects to the survivor
};

function seededReader() {
  return createInMemoryPatientReaderStore([survivor, merged]).store;
}

describe("M5-T08 — PatientReader + PatientMutator close the boot-gate (§4.8, §4.9)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("declares both seams in REQUIRED_SEAMS owned by M5 (PHI) with deny-stubs", () => {
    for (const key of ["PatientReader", "PatientMutator"] as const) {
      const entry = REQUIRED_SEAMS.find((r) => r.key === key);
      expect(entry?.ownerModule).toBe(5);
      expect(entry?.phi).toBe(true);
      expect(entry?.denyStub).toBeDefined();
    }
  });

  it("registers the real impls so validateSeams() passes and the getters resolve them", () => {
    registerPatientSeams({ readerStore: seededReader() });
    expect(() => validateSeams()).not.toThrow();
    expect(getPatientReader()).toBeDefined();
    expect(getPatientMutator()).toBeDefined();
  });

  it("§4.8 findByMrn / findById return the patient", async () => {
    registerPatientSeams({ readerStore: seededReader() });
    validateSeams();
    const r = getPatientReader();
    expect((await r.findByMrn({ organizationId: ORG, mrn: "MRN-S" }))?.id).toBe(SURVIVOR);
    expect(
      (
        await r.findByExternalMrn({
          organizationId: ORG,
          assigningAuthority: "st_anthony",
          value: "EXT-1",
        })
      )?.id,
    ).toBe(SURVIVOR);
  });

  it("W-M5-18 merge-redirect is transparent — a lookup of a merged patient returns the survivor", async () => {
    registerPatientSeams({ readerStore: seededReader() });
    validateSeams();
    const found = await getPatientReader().findById({ organizationId: ORG, id: MERGED });
    expect(found?.id).toBe(SURVIVOR); // chased mergedIntoId to the survivor
    expect(found?.mrn).toBe("MRN-S");
  });

  it("findBySsnLast4AndDob resolves + dedupes by survivor id", async () => {
    registerPatientSeams({ readerStore: seededReader() });
    validateSeams();
    // both survivor and merged share ssn? only survivor has ssnLast4; merged redirects → just survivor
    const results = await getPatientReader().findBySsnLast4AndDob({
      organizationId: ORG,
      ssnLast4: "6789",
      dateOfBirth: "1990-01-01",
    });
    expect(results.map((p) => p.id)).toEqual([SURVIVOR]);
  });

  it("W-M5-17 PatientMutator STRIPS forbidden identifiers, applies demographics, emits patient.updated", async () => {
    const { store, applied, events } = createInMemoryPatientMutatorStore();
    registerPatientSeams({ readerStore: seededReader(), mutatorStore: store });
    validateSeams();
    const result = await getPatientMutator().apply({
      organizationId: ORG,
      patientId: SURVIVOR,
      patch: {
        legalLastName: "Byron",
        preferredLanguage: "en",
        ssn: "123456789", // STRIPPED (W-M5-17)
        mrn: "HACK", // STRIPPED (D1)
        status: "deceased", // STRIPPED (M5-internal)
      },
      source: "m29_proposal_accept",
      sourceRef: { kind: "hl7_inbound_proposal", id: "prop-1" },
      actorMembershipId: "mem-1",
    });
    expect(result.strippedFields.sort()).toEqual(["mrn", "ssn", "status"]);
    expect(result.appliedFields.sort()).toEqual(["legalLastName", "preferredLanguage"]);
    expect(applied[0]?.fields).toEqual({ legalLastName: "Byron", preferredLanguage: "en" });
    expect(events).toEqual([
      { patientId: SURVIVOR, changed: ["legalLastName", "preferredLanguage"] },
    ]);
  });

  it("a pure-stripped patch is a no-op (no demographics applied, no event)", async () => {
    const { store, events } = createInMemoryPatientMutatorStore();
    registerPatientSeams({ mutatorStore: store });
    validateSeams();
    const result = await getPatientMutator().apply({
      organizationId: ORG,
      patientId: SURVIVOR,
      patch: { ssn: "123456789", mbi: "1EG4TE5MK73" },
      source: "m29_proposal_accept",
      sourceRef: { kind: "hl7_inbound_proposal", id: "prop-2" },
      actorMembershipId: "mem-1",
    });
    expect(result.appliedFields).toEqual([]);
    expect(result.strippedFields.sort()).toEqual(["mbi", "ssn"]);
    expect(events).toEqual([]);
  });

  it("without registration both seams boot FAIL-CLOSED (deny-stubs throw)", () => {
    validateSeams();
    expect(() => getPatientReader().findByMrn({ organizationId: ORG, mrn: "x" })).toThrow(
      NotImplementedError,
    );
    expect(() =>
      getPatientMutator().apply({
        organizationId: ORG,
        patientId: "x",
        patch: {},
        source: "admin_correction",
        sourceRef: { kind: "admin", rationale: "r" },
        actorMembershipId: "m",
      }),
    ).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers both during buildServer() boot", async () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    expect(await getPatientReader().findByMrn({ organizationId: ORG, mrn: "none" })).toBeNull();
    await app.close();
  });
});
