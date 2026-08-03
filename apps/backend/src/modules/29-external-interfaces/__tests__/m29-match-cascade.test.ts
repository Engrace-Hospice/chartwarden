// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T04 patient-match cascade unit tests
// (§4.6 D6, W-XI-01/W-XI-02). ≥95% branch on the named-critical service — every level, every fall-through,
// merge-redirect depth, and the fail-fast timeout.
import { describe, expect, it, vi } from "vitest";
import type { PatientIdentity, PatientReader } from "@wardenx/types";
import { type CascadeDeps, type CascadeInput, matchPatient } from "../inbound/match-cascade";

const ORG = "org_engrace";
const AUTH = "ENGRACE_INTERNAL";

function mkPatient(over: Partial<PatientIdentity> = {}): PatientIdentity {
  return {
    id: "pt_default",
    organizationId: ORG,
    mrn: "MRN-DEFAULT",
    externalMrns: [],
    lastName: "DOE",
    firstName: "JANE",
    dateOfBirth: "1948-03-22",
    administrativeSex: "F",
    ...over,
  };
}

function mkInput(overrides: Partial<CascadeInput["pid"]> = {}): CascadeInput {
  return {
    organizationId: ORG,
    internalMrnAuthority: AUTH,
    pid: {
      identifiers: [{ value: "MRN-001234", assigningAuthority: AUTH }],
      lastName: "DOE",
      firstName: "JANE",
      dateOfBirth: "1948-03-22",
      administrativeSex: "F",
      ...overrides,
    },
  };
}

function mkReader(over: Partial<PatientReader> = {}): PatientReader {
  return {
    findByMrn: vi.fn().mockResolvedValue(null),
    findByExternalMrn: vi.fn().mockResolvedValue(null),
    findBySsnLast4AndDob: vi.fn().mockResolvedValue([]),
    findByNameDobSex: vi.fn().mockResolvedValue([]),
    findByLooseName: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    ...over,
  } as PatientReader;
}

const deps = (over: Partial<PatientReader> = {}): CascadeDeps => ({ patientReader: mkReader(over) });

describe("L1 — internal MRN exact", () => {
  it("returns confident_match L1 and does not call lower levels", async () => {
    const reader = mkReader({ findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_l1" })) });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "confident_match", patientId: "pt_l1", level: "L1_MRN_EXACT", mergeRedirectHops: 0 });
    expect(reader.findByMrn).toHaveBeenCalledWith({ organizationId: ORG, mrn: "MRN-001234" });
    expect(reader.findByExternalMrn).not.toHaveBeenCalled();
    expect(reader.findBySsnLast4AndDob).not.toHaveBeenCalled();
  });

  it("skips L1 when no internal MRN authority is configured", async () => {
    const reader = mkReader({ findByMrn: vi.fn().mockResolvedValue(mkPatient()) });
    const result = await matchPatient({ ...mkInput(), internalMrnAuthority: undefined }, { patientReader: reader });
    expect(reader.findByMrn).not.toHaveBeenCalled();
    expect(result.kind).not.toBe("confident_match");
  });

  it("skips L1 when no PID identifier matches the internal authority", async () => {
    const input: CascadeInput = { ...mkInput(), pid: { ...mkInput().pid, identifiers: [{ value: "OTHER-123", assigningAuthority: "OTHER_HOSPITAL" }] } };
    const reader = mkReader({ findByMrn: vi.fn() });
    await matchPatient(input, { patientReader: reader });
    expect(reader.findByMrn).not.toHaveBeenCalled();
  });

  it("follows a single merge redirect", async () => {
    const reader = mkReader({
      findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_old", mergedIntoId: "pt_new" })),
      findById: vi.fn().mockResolvedValue(mkPatient({ id: "pt_new" })),
    });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "confident_match", patientId: "pt_new", level: "L1_MRN_EXACT", mergeRedirectHops: 1 });
  });

  it("treats a dangling merge redirect as no-match (fails closed)", async () => {
    const reader = mkReader({
      findByMrn: vi.fn().mockResolvedValue(mkPatient({ mergedIntoId: "pt_missing" })),
      findById: vi.fn().mockResolvedValue(null),
    });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result.kind).not.toBe("confident_match");
  });

  it("resolves a 3-deep merge chain", async () => {
    const reader = mkReader({
      findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_a", mergedIntoId: "pt_b" })),
      findById: vi
        .fn()
        .mockResolvedValueOnce(mkPatient({ id: "pt_b", mergedIntoId: "pt_c" }))
        .mockResolvedValueOnce(mkPatient({ id: "pt_c", mergedIntoId: "pt_d" }))
        .mockResolvedValueOnce(mkPatient({ id: "pt_d" })),
    });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "confident_match", patientId: "pt_d", level: "L1_MRN_EXACT", mergeRedirectHops: 3 });
  });

  it("treats a 4+ deep merge chain as no-match (hops exceeded)", async () => {
    const reader = mkReader({
      findByMrn: vi.fn().mockResolvedValue(mkPatient({ mergedIntoId: "next" })),
      findById: vi.fn().mockResolvedValue(mkPatient({ mergedIntoId: "next" })),
    });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result.kind).not.toBe("confident_match");
  });

  it("propagates a seam timeout as a thrown error", async () => {
    const reader = mkReader({ findByMrn: vi.fn().mockReturnValue(new Promise(() => {})) });
    await expect(matchPatient(mkInput(), { patientReader: reader, perCallTimeoutMs: 20 })).rejects.toThrow(/cascade_seam_timeout_L1/);
  });

  it("forwards a structured trace to the injected log port", async () => {
    const log = vi.fn();
    const reader = mkReader({ findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_l1" })) });
    await matchPatient(mkInput(), { patientReader: reader, log });
    expect(log).toHaveBeenCalledWith("hl7.cascade.confident_match", expect.objectContaining({ level: "L1_MRN_EXACT" }));
  });
});

describe("L2 — external-system MRN exact", () => {
  it("returns confident_match L2 when an external MRN hits", async () => {
    const input: CascadeInput = {
      ...mkInput(),
      pid: {
        ...mkInput().pid,
        identifiers: [
          { value: "MRN-WRONG-INT", assigningAuthority: AUTH },
          { value: "ST_ANTH_999", assigningAuthority: "ST_ANTHONY" },
        ],
      },
    };
    const reader = mkReader({
      findByExternalMrn: vi.fn().mockImplementation(({ assigningAuthority }: { assigningAuthority: string }) => Promise.resolve(assigningAuthority === "ST_ANTHONY" ? mkPatient({ id: "pt_l2" }) : null)),
    });
    const result = await matchPatient(input, { patientReader: reader });
    expect(result).toMatchObject({ kind: "confident_match", level: "L2_EXTERNAL_MRN_EXACT", patientId: "pt_l2" });
  });

  it("skips identifiers with empty value or authority", async () => {
    const input = mkInput();
    const reader = mkReader();
    await matchPatient({ ...input, internalMrnAuthority: undefined, pid: { ...input.pid, identifiers: [{ value: "", assigningAuthority: "X" }, { value: "Y", assigningAuthority: "" }] } }, { patientReader: reader });
    expect(reader.findByExternalMrn).not.toHaveBeenCalled();
  });
});

describe("L3 — SSN-last4 + DOB", () => {
  it("returns confident_match L3 on a single hit", async () => {
    const reader = mkReader({ findBySsnLast4AndDob: vi.fn().mockResolvedValue([mkPatient({ id: "pt_l3" })]) });
    const result = await matchPatient(mkInput({ ssnLast4: "6789" }), { patientReader: reader });
    expect(result).toMatchObject({ kind: "confident_match", level: "L3_SSN_DOB", patientId: "pt_l3" });
  });

  it("returns ambiguous L3 on multiple hits", async () => {
    const reader = mkReader({ findBySsnLast4AndDob: vi.fn().mockResolvedValue([mkPatient({ id: "pt_a" }), mkPatient({ id: "pt_b" })]) });
    const result = await matchPatient(mkInput({ ssnLast4: "6789" }), { patientReader: reader });
    expect(result).toEqual({ kind: "ambiguous", candidateIds: ["pt_a", "pt_b"], level: "L3_SSN_DOB" });
  });

  it("falls through when an L3 hit resolves to a dangling merge", async () => {
    const reader = mkReader({
      findBySsnLast4AndDob: vi.fn().mockResolvedValue([mkPatient({ id: "pt_x", mergedIntoId: "gone" })]),
      findById: vi.fn().mockResolvedValue(null),
      findByNameDobSex: vi.fn().mockResolvedValue([mkPatient({ id: "pt_l4" })]),
    });
    const result = await matchPatient(mkInput({ ssnLast4: "6789" }), { patientReader: reader });
    expect(result).toMatchObject({ kind: "candidate_match", level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE" });
  });

  it("skips L3 when ssn_last4 is missing", async () => {
    const reader = mkReader();
    await matchPatient(mkInput(), { patientReader: reader });
    expect(reader.findBySsnLast4AndDob).not.toHaveBeenCalled();
  });

  it("skips L3 for the 0000 sentinel and non-4-digit and logs the skip", async () => {
    const log = vi.fn();
    const reader = mkReader();
    await matchPatient(mkInput({ ssnLast4: "0000" }), { patientReader: reader, log });
    await matchPatient(mkInput({ ssnLast4: "67" }), { patientReader: reader });
    expect(reader.findBySsnLast4AndDob).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("hl7.cascade.ssn_last4_invalid_skipped", expect.any(Object));
  });

  it("skips L3 when DOB is missing", async () => {
    const reader = mkReader();
    await matchPatient(mkInput({ ssnLast4: "6789", dateOfBirth: "" }), { patientReader: reader });
    expect(reader.findBySsnLast4AndDob).not.toHaveBeenCalled();
  });
});

describe("L4 — exact name + DOB + sex", () => {
  it("returns candidate_match L4 with 0.92 confidence on a single hit", async () => {
    const reader = mkReader({ findByNameDobSex: vi.fn().mockResolvedValue([mkPatient({ id: "pt_l4" })]) });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "candidate_match", patientId: "pt_l4", level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE", confidence: 0.92, mergeRedirectHops: 0 });
  });

  it("returns ambiguous L4 on multiple hits", async () => {
    const reader = mkReader({ findByNameDobSex: vi.fn().mockResolvedValue([mkPatient({ id: "pt_a" }), mkPatient({ id: "pt_b" })]) });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "ambiguous", candidateIds: ["pt_a", "pt_b"], level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE" });
  });

  it("skips L4 when DOB or lastName or firstName is missing", async () => {
    const reader = mkReader();
    await matchPatient(mkInput({ dateOfBirth: "" }), { patientReader: reader });
    await matchPatient(mkInput({ lastName: "" }), { patientReader: reader });
    await matchPatient(mkInput({ firstName: "" }), { patientReader: reader });
    expect(reader.findByNameDobSex).not.toHaveBeenCalled();
  });

  it("falls through to L5 when the L4 hit resolves to a dangling merge", async () => {
    const reader = mkReader({
      findByNameDobSex: vi.fn().mockResolvedValue([mkPatient({ id: "pt_x", mergedIntoId: "gone" })]),
      findById: vi.fn().mockResolvedValue(null),
      findByLooseName: vi.fn().mockResolvedValue([mkPatient({ id: "pt_l5" })]),
    });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toMatchObject({ kind: "candidate_match", level: "L5_LOOSE_NAME_DOB_CANDIDATE" });
  });
});

describe("L5 — loose name + DOB", () => {
  it("returns candidate_match L5 with 0.78 confidence on a single hit", async () => {
    const reader = mkReader({ findByLooseName: vi.fn().mockResolvedValue([mkPatient({ id: "pt_l5" })]) });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "candidate_match", patientId: "pt_l5", level: "L5_LOOSE_NAME_DOB_CANDIDATE", confidence: 0.78, mergeRedirectHops: 0 });
  });

  it("returns no_match when L5 has multiple hits (too loose to propose)", async () => {
    const reader = mkReader({ findByLooseName: vi.fn().mockResolvedValue([mkPatient({ id: "pt_a" }), mkPatient({ id: "pt_b" })]) });
    const result = await matchPatient(mkInput(), { patientReader: reader });
    expect(result).toEqual({ kind: "no_match" });
  });

  it("skips L5 when lastName is missing and returns no_match", async () => {
    const reader = mkReader();
    const result = await matchPatient(mkInput({ lastName: "" }), { patientReader: reader });
    expect(reader.findByLooseName).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "no_match" });
  });
});

describe("no match", () => {
  it("returns no_match when every level misses", async () => {
    const result = await matchPatient(mkInput({ ssnLast4: "6789" }), deps());
    expect(result).toEqual({ kind: "no_match" });
  });
});
