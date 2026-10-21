import type { PatientIdentity, PatientReader } from "@chartwarden/types";
// apps/backend/src/modules/29-external-interfaces/__tests__ — M29-T05 inbound ORU lab pipeline unit tests
// (§4.6 D7/D8, W-XI-05/06). Every pure core: the ORU projection, the OBX-8 abnormal classification, the
// LOINC terminology gate, the D15 SUD ingress redaction, the two-stage patient resolution, the embedded-PDF
// extraction, and the attach planner (matched attach vs unmatched routing).
import { describe, expect, it, vi } from "vitest";
import { projectOru } from "../inbound/hl7-oru-projection";
import {
  computeAbnormalSummary,
  isCriticalFlagSet,
  mapAbnormalFlag,
  selectValueFlag,
} from "../inbound/lab-abnormal";
import {
  type LabAttachInput,
  SUD_REDACTED_SENTINEL,
  planLabAttach,
} from "../inbound/lab-attach-planner";
import { type LabOrderPort, resolveLabPatient } from "../inbound/lab-patient-resolver";
import type { LabPatientResolution } from "../inbound/lab-patient-resolver";
import {
  type LabConsentPort,
  type LabSudTerminologyPort,
  decideLabSudRedaction,
} from "../inbound/lab-sud-redaction";
import {
  type LabTerminologyPort,
  classifyObservationTerminology,
} from "../inbound/lab-terminology";
import { decodeEncapsulatedPdf, extractPdfAttachments } from "../inbound/obx-pdf";

const ORG = "org_engrace";
const AUTH = "ENGRACE_INTERNAL";

// ── Raw ORU^R01 frame builder ────────────────────────────────────────────────────────────────────────────
interface ObxSpec {
  setId: number;
  valueType: string;
  loinc: string;
  loincText?: string;
  value: string;
  units?: string;
  refRange?: string;
  flag?: string;
  status?: string;
}
interface OruSpec {
  obr2?: string;
  obr4?: string;
  obr7?: string;
  pid3?: { value: string; authority: string; typeCode?: string };
  lastName?: string;
  firstName?: string;
  dob?: string;
  sex?: string;
  ssn?: string;
  obx: ObxSpec[];
}
function mkOru(spec: OruSpec): string {
  const lines: string[] = [];
  lines.push("MSH|^~\\&|LAB|QUEST|WARDENX|ENGRACE|20260801120000||ORU^R01|MCID-1|P|2.5.1");
  const cx = spec.pid3
    ? `${spec.pid3.value}^^^${spec.pid3.authority}^${spec.pid3.typeCode ?? "MR"}`
    : `MRN-001^^^${AUTH}^MR`;
  lines.push(
    `PID|1||${cx}||${spec.lastName ?? "DOE"}^${spec.firstName ?? "JANE"}||${spec.dob ?? "19480322"}|${spec.sex ?? "F"}|||||||||||${spec.ssn ?? ""}`,
  );
  lines.push(
    `OBR|1|${spec.obr2 ?? ""}||${spec.obr4 ?? "24323-8^COMPREHENSIVE METABOLIC PANEL^LN"}|||${spec.obr7 ?? "20260801"}`,
  );
  for (const o of spec.obx) {
    lines.push(
      `OBX|${o.setId}|${o.valueType}|${o.loinc}^${o.loincText ?? "TEST"}^LN||${o.value}|${o.units ?? ""}|${o.refRange ?? ""}|${o.flag ?? ""}|||${o.status ?? "F"}`,
    );
  }
  return lines.join("\r");
}

// ── Projection ──────────────────────────────────────────────────────────────────────────────────────────
describe("projectOru", () => {
  it("projects OBR, OBX list, and the PID candidate", () => {
    const oru = projectOru(
      mkOru({
        obr2: "ord_abc",
        obr4: "24323-8^CMP^LN",
        obr7: "20260801",
        obx: [
          {
            setId: 1,
            valueType: "NM",
            loinc: "2160-0",
            loincText: "CREATININE",
            value: "3.4",
            units: "mg/dL",
            refRange: "0.6-1.2",
            flag: "HH",
          },
          { setId: 2, valueType: "NM", loinc: "2823-3", value: "4.5", units: "mmol/L", flag: "N" },
        ],
      }),
    );
    expect(oru).not.toBeNull();
    expect(oru!.messageType).toBe("ORU^R01");
    expect(oru!.obr.placerOrderNumber).toBe("ord_abc");
    expect(oru!.obr.universalServiceCode).toBe("24323-8");
    expect(oru!.obr.observationDate).toBe("2026-08-01");
    expect(oru!.obxList).toHaveLength(2);
    expect(oru!.obxList[0]).toMatchObject({
      setId: 1,
      valueType: "NM",
      loincCode: "2160-0",
      value: "3.4",
      units: "mg/dL",
      referenceRange: "0.6-1.2",
    });
    expect(oru!.obxList[0]!.abnormalFlagsRaw).toEqual(["HH"]);
    expect(oru!.patientCandidate).toMatchObject({
      lastName: "DOE",
      firstName: "JANE",
      dateOfBirth: "1948-03-22",
      administrativeSex: "F",
    });
    expect(oru!.patientCandidate.identifiers[0]).toMatchObject({
      value: "MRN-001",
      assigningAuthority: AUTH,
    });
  });

  it("returns null for a frame with no PID", () => {
    expect(
      projectOru("MSH|^~\\&|LAB|Q|WX|E|20260801||ORU^R01|M1|P|2.5.1\rOBR|1\rOBX|1|NM|x||1"),
    ).toBeNull();
  });

  it("returns null for a frame with no OBX", () => {
    expect(
      projectOru(
        "MSH|^~\\&|LAB|Q|WX|E|20260801||ORU^R01|M1|P|2.5.1\rPID|1||X^^^A^MR||DOE^JANE\rOBR|1",
      ),
    ).toBeNull();
  });

  it("returns null for a non-MSH frame", () => {
    expect(projectOru("PID|1||X")).toBeNull();
  });
});

// ── Abnormal flag classification ────────────────────────────────────────────────────────────────────────
describe("lab-abnormal", () => {
  it("maps only the six enum flags, unknown → null", () => {
    expect(mapAbnormalFlag("HH")).toBe("HH");
    expect(mapAbnormalFlag("h")).toBe("H");
    expect(mapAbnormalFlag("AA")).toBeNull();
    expect(mapAbnormalFlag(">")).toBeNull();
    expect(mapAbnormalFlag(undefined)).toBeNull();
  });

  it("selectValueFlag prefers critical > abnormal > normal", () => {
    expect(selectValueFlag(["N", "H", "LL"])).toBe("LL");
    expect(selectValueFlag(["N", "H"])).toBe("H");
    expect(selectValueFlag(["N"])).toBe("N");
    expect(selectValueFlag(["AA"])).toBeNull();
    expect(selectValueFlag([])).toBeNull();
  });

  it("isCriticalFlagSet is true only for HH/LL", () => {
    expect(isCriticalFlagSet(["HH"])).toBe(true);
    expect(isCriticalFlagSet(["LL"])).toBe(true);
    expect(isCriticalFlagSet(["H", "L", "A"])).toBe(false);
    expect(isCriticalFlagSet(["AA"])).toBe(false);
  });

  it("computeAbnormalSummary rolls up correctly", () => {
    expect(computeAbnormalSummary(["N", "HH"])).toBe("any_critical");
    expect(computeAbnormalSummary(["N", "H"])).toBe("any_abnormal");
    expect(computeAbnormalSummary(["A"])).toBe("any_abnormal");
    expect(computeAbnormalSummary(["N", "N"])).toBe("all_normal");
    expect(computeAbnormalSummary([null, null])).toBe("no_flags");
  });
});

// ── Terminology gate ────────────────────────────────────────────────────────────────────────────────────
describe("classifyObservationTerminology", () => {
  const port = (over: Partial<LabTerminologyPort> = {}): LabTerminologyPort => ({
    validateLoinc: vi.fn().mockResolvedValue({ exists: true }),
    ...over,
  });

  it("valid when every code resolves", async () => {
    const p = port();
    expect(await classifyObservationTerminology([{ loincCode: "2160-0" }], "2026-08-01", p)).toBe(
      "valid",
    );
    expect(p.validateLoinc).toHaveBeenCalledWith({ code: "2160-0", asOfDate: "2026-08-01" });
  });

  it("unknown_code when any code is absent", async () => {
    const p = port({
      validateLoinc: vi
        .fn()
        .mockResolvedValueOnce({ exists: true })
        .mockResolvedValueOnce({ exists: false }),
    });
    expect(
      await classifyObservationTerminology(
        [{ loincCode: "2160-0" }, { loincCode: "XXX" }],
        "2026-08-01",
        p,
      ),
    ).toBe("unknown_code");
  });

  it("deprecated when a code is retired-but-known and none unknown", async () => {
    const p = port({
      validateLoinc: vi.fn().mockResolvedValue({ exists: true, deprecated: true }),
    });
    expect(await classifyObservationTerminology([{ loincCode: "old" }], "2026-08-01", p)).toBe(
      "deprecated",
    );
  });

  it("empty code → unknown_code, never dropped", async () => {
    expect(await classifyObservationTerminology([{ loincCode: "" }], "2026-08-01", port())).toBe(
      "unknown_code",
    );
  });

  it("fails closed to unknown_code when M38 throws", async () => {
    const p = port({ validateLoinc: vi.fn().mockRejectedValue(new Error("m38 down")) });
    expect(await classifyObservationTerminology([{ loincCode: "2160-0" }], "2026-08-01", p)).toBe(
      "unknown_code",
    );
  });
});

// ── SUD ingress redaction (D15) ─────────────────────────────────────────────────────────────────────────
describe("decideLabSudRedaction", () => {
  const term = (categories: string[]): LabSudTerminologyPort => ({
    validateLoinc: vi.fn().mockResolvedValue({ exists: true }),
    classifyLoinc: vi.fn().mockResolvedValue({ categories }),
  });
  const consent = (allow: boolean): LabConsentPort => ({
    evaluateForIngressRedaction: vi.fn().mockResolvedValue({ allowDisclosure: allow }),
  });

  it("redacts a SUD-class lab when consent is absent (default-on)", async () => {
    const d = await decideLabSudRedaction(
      { patientId: "pt_1", loincCodes: ["14375-7"], asOf: "2026-08-01" },
      { consent: consent(false), terminology: term(["sud_test"]) },
    );
    expect(d).toEqual({ sudDetected: true, redact: true });
  });

  it("does NOT redact a SUD-class lab when explicit consent is present", async () => {
    const d = await decideLabSudRedaction(
      { patientId: "pt_1", loincCodes: ["14375-7"], asOf: "2026-08-01" },
      { consent: consent(true), terminology: term(["sud_test"]) },
    );
    expect(d).toEqual({ sudDetected: true, redact: false });
  });

  it("does NOT redact a non-SUD lab", async () => {
    const c = consent(false);
    const d = await decideLabSudRedaction(
      { patientId: "pt_1", loincCodes: ["2160-0"], asOf: "2026-08-01" },
      { consent: c, terminology: term([]) },
    );
    expect(d).toEqual({ sudDetected: false, redact: false });
    expect(c.evaluateForIngressRedaction).not.toHaveBeenCalled();
  });

  it("unmatched (no patient) is not redacted here — deferred to bind time", async () => {
    const d = await decideLabSudRedaction(
      { patientId: null, loincCodes: ["14375-7"], asOf: "2026-08-01" },
      { consent: consent(false), terminology: term(["sud_test"]) },
    );
    expect(d).toEqual({ sudDetected: false, redact: false });
  });

  it("fails safe (redact) when M38 classification throws", async () => {
    const badTerm: LabSudTerminologyPort = {
      validateLoinc: vi.fn().mockResolvedValue({ exists: true }),
      classifyLoinc: vi.fn().mockRejectedValue(new Error("m38 down")),
    };
    const d = await decideLabSudRedaction(
      { patientId: "pt_1", loincCodes: ["14375-7"], asOf: "2026-08-01" },
      { consent: consent(false), terminology: badTerm },
    );
    expect(d.redact).toBe(true);
  });
});

// ── Two-stage patient resolution (D7/D8) ────────────────────────────────────────────────────────────────
function mkPatient(over: Partial<PatientIdentity> = {}): PatientIdentity {
  return {
    id: "pt_default",
    organizationId: ORG,
    mrn: "MRN-001",
    externalMrns: [],
    lastName: "DOE",
    firstName: "JANE",
    dateOfBirth: "1948-03-22",
    administrativeSex: "F",
    ...over,
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
const orderPort = (over: Partial<LabOrderPort> = {}): LabOrderPort => ({
  getOrderByPlacerId: vi.fn().mockResolvedValue(null),
  ...over,
});

describe("resolveLabPatient", () => {
  it("W-XI-05 — OBR-2 placer hit binds to the order patient (obr_placer_id), skipping the cascade", async () => {
    const reader = mkReader();
    const orders = orderPort({
      getOrderByPlacerId: vi.fn().mockResolvedValue({ id: "ord_abc", patientId: "pt_smith" }),
    });
    const res = await resolveLabPatient(
      {
        organizationId: ORG,
        placerOrderNumber: "ord_abc",
        patientCandidate: {
          identifiers: [],
          lastName: "",
          firstName: "",
          dateOfBirth: "",
          administrativeSex: "",
        },
      },
      { patientReader: reader, orderReader: orders },
    );
    expect(res).toEqual({
      kind: "matched",
      patientId: "pt_smith",
      orderId: "ord_abc",
      matchMethod: "obr_placer_id",
      matchLevel: null,
      matchConfidence: null,
    });
    expect(reader.findByMrn).not.toHaveBeenCalled();
  });

  it("confident cascade (L1) auto-attaches via patient_loinc_date when OBR-2 is absent", async () => {
    const reader = mkReader({ findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_l1" })) });
    const res = await resolveLabPatient(
      {
        organizationId: ORG,
        placerOrderNumber: "",
        internalMrnAuthority: AUTH,
        patientCandidate: {
          identifiers: [{ value: "MRN-001", assigningAuthority: AUTH }],
          lastName: "DOE",
          firstName: "JANE",
          dateOfBirth: "1948-03-22",
          administrativeSex: "F",
        },
      },
      { patientReader: reader, orderReader: orderPort() },
    );
    expect(res).toMatchObject({
      kind: "matched",
      patientId: "pt_l1",
      orderId: null,
      matchMethod: "patient_loinc_date",
      matchLevel: "L1_MRN_EXACT",
    });
  });

  it("W-XI-06 — an L4 candidate is UNMATCHED (labs don't auto-bind loose demographics)", async () => {
    const reader = mkReader({
      findByNameDobSex: vi.fn().mockResolvedValue([mkPatient({ id: "pt_jane" })]),
    });
    const res = await resolveLabPatient(
      {
        organizationId: ORG,
        placerOrderNumber: "",
        patientCandidate: {
          identifiers: [],
          lastName: "DOE",
          firstName: "JANE",
          dateOfBirth: "1948-03-22",
          administrativeSex: "F",
        },
      },
      { patientReader: reader, orderReader: orderPort() },
    );
    expect(res).toEqual({
      kind: "unmatched",
      matchMethod: "unmatched",
      candidatePatientId: "pt_jane",
      candidateMatchLevel: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
      matchConfidence: 0.92,
    });
  });

  it("no match at all is unmatched with NO_MATCH level", async () => {
    const res = await resolveLabPatient(
      {
        organizationId: ORG,
        placerOrderNumber: "",
        patientCandidate: {
          identifiers: [],
          lastName: "NOPE",
          firstName: "X",
          dateOfBirth: "",
          administrativeSex: "M",
        },
      },
      { patientReader: mkReader(), orderReader: orderPort() },
    );
    expect(res).toEqual({
      kind: "unmatched",
      matchMethod: "unmatched",
      candidatePatientId: null,
      candidateMatchLevel: "NO_MATCH",
      matchConfidence: null,
    });
  });

  it("falls through to the cascade when the placer number is unknown", async () => {
    const orders = orderPort({ getOrderByPlacerId: vi.fn().mockResolvedValue(null) });
    const reader = mkReader({ findByMrn: vi.fn().mockResolvedValue(mkPatient({ id: "pt_l1" })) });
    const res = await resolveLabPatient(
      {
        organizationId: ORG,
        placerOrderNumber: "UNKNOWN",
        internalMrnAuthority: AUTH,
        patientCandidate: {
          identifiers: [{ value: "MRN-001", assigningAuthority: AUTH }],
          lastName: "DOE",
          firstName: "JANE",
          dateOfBirth: "1948-03-22",
          administrativeSex: "F",
        },
      },
      { patientReader: reader, orderReader: orders },
    );
    expect(orders.getOrderByPlacerId).toHaveBeenCalled();
    expect(res).toMatchObject({
      kind: "matched",
      patientId: "pt_l1",
      matchMethod: "patient_loinc_date",
    });
  });
});

// ── Embedded PDF extraction (§9) ────────────────────────────────────────────────────────────────────────
describe("obx-pdf", () => {
  const pdf = Buffer.from("%PDF-1.4 fake");
  it("decodes a valid ^PDF^Base64^ payload", () => {
    const bytes = decodeEncapsulatedPdf(`^PDF^Base64^${pdf.toString("base64")}`);
    expect(bytes?.toString()).toBe("%PDF-1.4 fake");
  });
  it("rejects a non-PDF/non-Base64/malformed ED payload", () => {
    expect(decodeEncapsulatedPdf("^TIFF^Base64^abcd")).toBeNull();
    expect(decodeEncapsulatedPdf("^PDF^Hex^abcd")).toBeNull();
    expect(decodeEncapsulatedPdf("too^few")).toBeNull();
    expect(decodeEncapsulatedPdf("^PDF^Base64^")).toBeNull();
  });
  it("extracts only ED OBX segments", () => {
    const out = extractPdfAttachments([
      {
        setId: 1,
        valueType: "NM",
        loincCode: "2160-0",
        loincText: "",
        value: "3.4",
        units: "",
        referenceRange: "",
        abnormalFlagsRaw: [],
        resultStatusRaw: "F",
        observationDateRaw: "",
      },
      {
        setId: 2,
        valueType: "ED",
        loincCode: "11502-2",
        loincText: "",
        value: `^PDF^Base64^${pdf.toString("base64")}`,
        units: "",
        referenceRange: "",
        abnormalFlagsRaw: [],
        resultStatusRaw: "F",
        observationDateRaw: "",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ obxSetId: 2, loincCode: "11502-2" });
    expect(Buffer.from(out[0]!.payloadBase64, "base64").toString()).toBe("%PDF-1.4 fake");
  });
});

// ── Attach planner (the transactional pinch point) ──────────────────────────────────────────────────────
function baseAttachInput(over: Partial<LabAttachInput> = {}): LabAttachInput {
  const proj = projectOru(
    mkOru({
      obr2: "ord_abc",
      obr4: "24323-8^CMP^LN",
      obx: [
        {
          setId: 1,
          valueType: "NM",
          loinc: "2160-0",
          loincText: "CREATININE",
          value: "3.4",
          units: "mg/dL",
          refRange: "0.6-1.2",
          flag: "HH",
        },
      ],
    }),
  )!;
  const resolution: LabPatientResolution = {
    kind: "matched",
    patientId: "pt_smith",
    orderId: "ord_abc",
    matchMethod: "obr_placer_id",
    matchLevel: null,
    matchConfidence: null,
  };
  return {
    organizationId: ORG,
    sourceMessageId: "msg_1",
    providerEntityId: "pe_1",
    obr: proj.obr,
    obxList: proj.obxList,
    resolution,
    terminologyValidation: "valid",
    sudRedacted: false,
    pdfAttachments: [],
    observationId: "obs_1",
    linkId: "link_1",
    receivedAt: new Date("2026-08-01T12:00:00Z"),
    ...over,
  };
}

describe("planLabAttach", () => {
  it("W-XI-05 — placer match materializes observation + value + link and emits received/attached", () => {
    const plan = planLabAttach(baseAttachInput());
    expect(plan.kind).toBe("attach");
    if (plan.kind !== "attach") throw new Error("unreachable");
    expect(plan.observation).toMatchObject({
      id: "obs_1",
      patientId: "pt_smith",
      orderId: "ord_abc",
      loincCode: "24323-8",
      abnormalSummary: "any_critical",
      providerEntityId: "pe_1",
      resultStatus: "final",
    });
    expect(plan.values).toHaveLength(1);
    expect(plan.values[0]).toMatchObject({
      observationId: "obs_1",
      obxSetId: 1,
      loincCode: "2160-0",
      valueType: "NM",
      numericValue: "3.4",
      abnormalFlag: "HH",
    });
    expect(plan.link).toMatchObject({
      id: "link_1",
      observationId: "obs_1",
      matchMethod: "obr_placer_id",
      obrPlacerOrderNumber: "ord_abc",
    });
    const names = plan.events.map((e) => e.name);
    expect(names).toContain("m29.lab_observation.received");
    expect(names).toContain("m29.lab_observation.attached");
    // Critical HH → abnormal_flag alert
    expect(names).toContain("m29.lab_observation.abnormal_flag");
    const attached = plan.events.find((e) => e.name === "m29.lab_observation.attached")!;
    expect(attached.payload).toMatchObject({
      patientId: "pt_smith",
      loincCode: "24323-8",
      abnormalFlag: "HH",
    });
  });

  it("W-XI-07 — a non-critical (H) flag does NOT emit the abnormal_flag alert", () => {
    const input = baseAttachInput({
      obxList: projectOru(
        mkOru({
          obr2: "o",
          obx: [{ setId: 1, valueType: "NM", loinc: "2160-0", value: "1.4", flag: "H" }],
        }),
      )!.obxList,
    });
    const plan = planLabAttach(input);
    if (plan.kind !== "attach") throw new Error("unreachable");
    expect(plan.observation.abnormalSummary).toBe("any_abnormal");
    expect(plan.events.map((e) => e.name)).not.toContain("m29.lab_observation.abnormal_flag");
  });

  it("W-XI-08 — SUD-redacted values carry the sentinel and null numeric", () => {
    const plan = planLabAttach(baseAttachInput({ sudRedacted: true }));
    if (plan.kind !== "attach") throw new Error("unreachable");
    expect(plan.observation.sudRedactedAtIngest).toBe(true);
    expect(plan.values[0]).toMatchObject({
      numericValue: null,
      stringValue: SUD_REDACTED_SENTINEL,
    });
  });

  it("W-XI-06 — an unmatched resolution produces NO observation PARENT, but does enter the review queue", () => {
    const plan = planLabAttach(
      baseAttachInput({
        resolution: {
          kind: "unmatched",
          matchMethod: "unmatched",
          candidatePatientId: "pt_jane",
          candidateMatchLevel: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
          matchConfidence: 0.92,
        },
      }),
    );
    expect(plan.kind).toBe("unmatched");
    if (plan.kind !== "unmatched") throw new Error("unreachable");
    expect(plan.event.name).toBe("m29.lab_observation.unmatched");
    expect(plan.event.payload).toMatchObject({
      sourceMessageId: "msg_1",
      loincCode: "24323-8",
      reason: "no_patient_match",
      candidatePatientId: "pt_jane",
      candidateMatchLevel: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
    });
    // GAP-044 — the parent is DEFERRED (patient_id / provider_entity_id are NOT NULL and neither is
    // known), but the OBX rows and the link row ARE written, under a RESERVED observation id. Before
    // this, the branch returned the event and nothing else, so the §4.2 queue — which reads exactly
    // `lab_observation_inbound_link` — was permanently empty and the result values a reviewer needs to
    // identify the patient were thrown away at the wire boundary.
    expect(plan.event.payload.observationId).toBe("obs_1");
    expect(plan.link).toMatchObject({
      id: "link_1",
      observationId: "obs_1",
      matchMethod: "unmatched",
      candidatePatientId: "pt_jane",
      candidateMatchLevel: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
      matchConfidence: "0.920",
    });
    // The link row enters the queue UNRESOLVED — `resolved_at IS NULL` is what the §4.2 read selects on.
    expect(plan.link.resolvedAt).toBeUndefined();
    expect(plan.link.resolution).toBeUndefined();
    expect(plan.values.length).toBeGreaterThan(0);
    for (const v of plan.values) expect(v.observationId).toBe("obs_1");
  });

  it("multi-OBX panel → one observation + N value rows; ED OBX excluded and emitted as a PDF handshake", () => {
    const proj = projectOru(
      mkOru({
        obr2: "ord_cbc",
        obx: [
          { setId: 1, valueType: "NM", loinc: "789-8", value: "14.5", units: "g/dL", flag: "N" },
          { setId: 2, valueType: "NM", loinc: "787-2", value: "5.5", units: "10*9/L", flag: "N" },
          {
            setId: 3,
            valueType: "ED",
            loinc: "11502-2",
            value: `^PDF^Base64^${Buffer.from("%PDF").toString("base64")}`,
          },
        ],
      }),
    )!;
    const plan = planLabAttach(
      baseAttachInput({
        obxList: proj.obxList,
        pdfAttachments: extractPdfAttachments(proj.obxList),
        obr: proj.obr,
      }),
    );
    if (plan.kind !== "attach") throw new Error("unreachable");
    expect(plan.values).toHaveLength(2); // ED excluded
    const pdfEvents = plan.events.filter((e) => e.name === "m29.document.upload_requested");
    expect(pdfEvents).toHaveLength(1);
    expect(pdfEvents[0]!.payload).toMatchObject({
      requestingModule: "m29",
      mimeType: "application/pdf",
      backRef: { kind: "lab_observation", observationId: "obs_1" },
    });
  });

  it("non-numeric value type stores stringValue, not numericValue", () => {
    const proj = projectOru(
      mkOru({ obr2: "o", obx: [{ setId: 1, valueType: "ST", loinc: "x", value: "POSITIVE" }] }),
    )!;
    const plan = planLabAttach(baseAttachInput({ obxList: proj.obxList }));
    if (plan.kind !== "attach") throw new Error("unreachable");
    expect(plan.values[0]).toMatchObject({
      valueType: "ST",
      numericValue: null,
      stringValue: "POSITIVE",
    });
  });
});
