// GAP-033 - M6's typed render-payload producers (06-admission/render-payloads). Driven over programmed rows (the
// recording Drizzle fake) and fake M5 / M40 sources, then round-tripped through M22's form compiler: what the
// producer builds must be what the form draws. The same builders run against real Postgres in
// m6-render-payloads.live.test.ts.
import { RenderPayloadError, isPart2Diagnosis, partitionPart2Diagnoses } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  type RenderBuildCtx,
  RenderPayloadBuildError,
  type RenderSourcesPort,
  buildCtiRenderPayload,
  buildDischargeRenderPayload,
  buildF2fRenderPayload,
  buildNorRenderPayload,
  buildOrOmit,
  buildRevocationRenderPayload,
  buildTransferRenderPayload,
} from "../src/modules/06-admission/render-payloads";
import { COMPILED_FORMS } from "../src/modules/22-documents/render-pdf/forms";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { fakeDb } from "./_fake-drizzle";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PATIENT = "pat-1";
const MD = "md-1";

const SOURCES: RenderSourcesPort = {
  patient: async (_org, id) =>
    id === PATIENT ? { name: "Zelda Quillfeather", mrn: "MRN-9", dateOfBirth: "1941-03-07" } : null,
  physician: async (_org, id) =>
    id === MD ? { name: "Dr. Imani Okafor", credentials: "MD", npi: "1234567893" } : null,
};

function ctx(
  rows: Record<string, unknown[]>,
  sources: RenderSourcesPort = SOURCES,
): RenderBuildCtx {
  const { db } = fakeDb(rows);
  // The fake hands its statement chain to the transaction callback, which runs synchronously up to its first await.
  let tx: unknown;
  void (
    db as unknown as { transaction: (f: (t: unknown) => Promise<void>) => Promise<void> }
  ).transaction(async (t) => {
    tx = t;
  });
  return {
    tx: tx as RenderBuildCtx["tx"],
    organizationId: ORG,
    sources,
    hospiceName: async (id) => (id ? "Evergreen Hospice LLC" : null),
  };
}

const ADMISSION = { patientId: PATIENT, providerEntityId: "pe-1" };
const PERIOD = { admissionId: "adm-1", sequence: 3 };
const USERS = (name: string | null) => [{ name }];
const T = (s: string) => new Date(s);

const CTI_ROW = {
  id: "cti-1",
  electionPeriodId: "ep-1",
  hospiceMdId: MD,
  attendingMdId: null,
  hospiceMdSignedAt: T("2026-09-30T14:05:00.000Z"),
  attendingMdSignedAt: null,
  terminalDiagnosisIcd10: "C34.90",
  relatedConditionsIcd10: ["J44.9", "F10.20"],
  narrative: "Progressive decline with weight loss.",
  periodStart: "2026-10-01",
  periodEnd: "2026-11-29",
  signedLate: false,
  lateReason: null,
};

const drawn = (doc: Parameters<typeof layoutDocument>[0]): string =>
  pageTexts(layoutDocument(doc)).flat().join("\n");

describe("Part 2 producer filter", () => {
  it("F10-F19 are substance-related; other F-codes and everything else are not", () => {
    expect(["F10.20", "F11.90", "f19.10", " F14.2 "].every(isPart2Diagnosis)).toBe(true);
    expect(["F03.90", "F20.0", "C34.90", "G30.9"].some(isPart2Diagnosis)).toBe(false);
  });
  it("partitions codes preserving order and reports only the count withheld", () => {
    expect(partitionPart2Diagnoses(["C34.90", "F10.20", "J44.9"])).toEqual({
      shown: [{ code: "C34.90" }, { code: "J44.9" }],
      withheldCount: 1,
    });
  });
});

describe("buildCtiRenderPayload", () => {
  const rows = {
    certification_of_terminal_illness: [CTI_ROW],
    election_period: [PERIOD],
    admission: [ADMISSION],
  };

  it("snapshots the signed certification: identity, period, diagnoses, narrative, the physician's signature", async () => {
    const p = await buildCtiRenderPayload(ctx(rows), "cti-1");
    expect(p.patient).toMatchObject({
      name: "Zelda Quillfeather",
      mrn: "MRN-9",
      dateOfBirth: "1941-03-07",
    });
    expect(p.hospiceName).toBe("Evergreen Hospice LLC");
    expect(p.benefitPeriodSequence).toBe(3);
    expect(p.isRecertification).toBe(true);
    expect(p.terminalDiagnoses).toEqual([{ code: "C34.90" }]);
    expect(p.hospiceMdSignature).toMatchObject({
      printedName: "Dr. Imani Okafor",
      credentials: "MD",
      npi: "1234567893",
      method: "electronic",
      meaning: "certification",
      signedAt: "2026-09-30T14:05:00.000Z",
      recordId: "cti-1",
    });
    expect(p.attendingSignature).toBeNull();
  });

  it("withholds Part 2 codes from the rendering and carries only the count", async () => {
    const p = await buildCtiRenderPayload(ctx(rows), "cti-1");
    expect(p.relatedConditions).toEqual([{ code: "J44.9" }]);
    expect(p.relatedPart2WithheldCount).toBe(1);
    expect(JSON.stringify(p)).not.toContain("F10");
  });

  it("round-trips through the M22 CTI form", async () => {
    const p = await buildCtiRenderPayload(ctx(rows), "cti-1");
    const text = drawn(COMPILED_FORMS.cti(p));
    expect(text).toContain("Zelda Quillfeather");
    expect(text).toContain("Progressive decline with weight loss.");
    expect(text).toContain("Electronically signed by Dr. Imani Okafor, MD (NPI 1234567893)");
    expect(text).toContain("Withheld");
  });

  it("includes the attending's signature only when the attending signed", async () => {
    const p = await buildCtiRenderPayload(
      ctx({
        ...rows,
        certification_of_terminal_illness: [
          { ...CTI_ROW, attendingMdId: MD, attendingMdSignedAt: T("2026-10-02T09:00:00.000Z") },
        ],
      }),
      "cti-1",
    );
    expect(p.attendingSignature?.signedAt).toBe("2026-10-02T09:00:00.000Z");
  });

  it("refuses (build error) when the patient identity or the physician does not resolve", async () => {
    await expect(
      buildCtiRenderPayload(ctx(rows, { ...SOURCES, patient: async () => null }), "cti-1"),
    ).rejects.toThrow(RenderPayloadBuildError);
    await expect(
      buildCtiRenderPayload(ctx(rows, { ...SOURCES, physician: async () => null }), "cti-1"),
    ).rejects.toThrow(/physician did not resolve/);
  });

  it("refuses a certification the physician has not signed, and one with no narrative", async () => {
    await expect(
      buildCtiRenderPayload(
        ctx({
          ...rows,
          certification_of_terminal_illness: [{ ...CTI_ROW, hospiceMdSignedAt: null }],
        }),
        "cti-1",
      ),
    ).rejects.toThrow(/has not signed/);
    await expect(
      buildCtiRenderPayload(
        ctx({ ...rows, certification_of_terminal_illness: [{ ...CTI_ROW, narrative: null }] }),
        "cti-1",
      ),
    ).rejects.toThrow(RenderPayloadError);
  });
});

describe("buildF2fRenderPayload", () => {
  const F2F_ROW = {
    id: "f2f-1",
    electionPeriodId: "ep-1",
    performedByUserId: "u-1",
    performerRole: "hospice_np",
    encounterDate: "2026-09-12",
    encounterLocation: "patient_home",
    withinWindow: true,
    windowOverride: false,
    windowOverrideReason: null,
    telehealthEligibility: null,
    attestationNarrative: "Findings: cachexia, dyspnea at rest.",
    encounterId: null,
    attestationSignedAt: T("2026-09-12T17:00:00.000Z"),
  };
  const rows = {
    face_to_face_encounter: [F2F_ROW],
    election_period: [PERIOD],
    admission: [ADMISSION],
    user: USERS("Nora Practitioner"),
  };

  it("builds the attestation from the performer's own row and signature time", async () => {
    const p = await buildF2fRenderPayload(ctx(rows), "f2f-1");
    expect(p.attestation).toMatchObject({
      printedName: "Nora Practitioner",
      meaning: "attestation",
      signedAt: "2026-09-12T17:00:00.000Z",
    });
    expect(p.performerRole).toBe("hospice_np");
    expect(drawn(COMPILED_FORMS.f2f(p))).toContain("clinical findings of that visit were provided");
  });

  it("refuses an unattested encounter or an unresolvable performer", async () => {
    await expect(
      buildF2fRenderPayload(
        ctx({ ...rows, face_to_face_encounter: [{ ...F2F_ROW, attestationSignedAt: null }] }),
        "f2f-1",
      ),
    ).rejects.toThrow(/not attested/);
    await expect(
      buildF2fRenderPayload(ctx({ ...rows, user: USERS(null) }), "f2f-1"),
    ).rejects.toThrow(/performing clinician/);
  });
});

describe("buildNorRenderPayload", () => {
  const NOR_ROW = {
    id: "nor-1",
    admissionId: "adm-1",
    patientId: PATIENT,
    signerKind: "representative",
    acknowledgedAt: "2026-09-02",
    acknowledgmentMethod: "wet_ink_scanned",
    witnessUserId: "u-w",
  };
  const rows = {
    notice_of_rights_acknowledgment: [NOR_ROW],
    admission: [ADMISSION],
    user: USERS("Pat Witness"),
  };

  it("records the representative capacity, the paper method and the witness", async () => {
    const p = await buildNorRenderPayload(ctx(rows), "nor-1");
    expect(p.acknowledgment).toMatchObject({
      printedName: "Zelda Quillfeather",
      capacity: "Authorized representative of the patient",
      method: "wet_ink_scanned",
      signedAt: "2026-09-02",
    });
    expect(p.witness?.printedName).toBe("Pat Witness");
    expect(drawn(COMPILED_FORMS.nor(p))).toContain("Record of scan");
  });

  it("has no witness block when no witness user is on record", async () => {
    const p = await buildNorRenderPayload(
      ctx({ ...rows, notice_of_rights_acknowledgment: [{ ...NOR_ROW, witnessUserId: null }] }),
      "nor-1",
    );
    expect(p.witness).toBeNull();
  });
});

describe("buildRevocationRenderPayload", () => {
  it("builds the beneficiary's revocation with its effective and signed dates", async () => {
    const p = await buildRevocationRenderPayload(
      ctx({
        revocation_event: [
          {
            id: "rev-1",
            admissionId: "adm-1",
            electionPeriodId: "ep-1",
            signerKind: "patient",
            effectiveAt: "2026-10-05",
            signedAt: "2026-10-04",
            revocationReason: "seek_curative_treatment",
            narrative: null,
          },
        ],
        admission: [ADMISSION],
      }),
      "rev-1",
    );
    expect(p.effectiveDate).toBe("2026-10-05");
    expect(p.revocation).toMatchObject({
      printedName: "Zelda Quillfeather",
      signedAt: "2026-10-04",
    });
    expect(drawn(COMPILED_FORMS.revocation(p))).toContain("Seek Curative Treatment");
  });
});

describe("buildDischargeRenderPayload", () => {
  const DE_ROW = {
    id: "de-1",
    admissionId: "adm-1",
    dischargeType: "for_cause",
    status: "completed",
    effectiveAt: "2026-10-06",
    narrative: "Discharged for cause.",
    forCauseReason: "Unsafe environment",
    cosignRequired: true,
    cosignedAt: T("2026-10-07T10:00:00.000Z"),
    cosignerName: "Dr. Medical Director",
    cosignerNpi: "1234567893",
    medicalDirectorMembershipId: "u-md",
    dischargeOrderSignedByUserId: "u-md",
    dischargeOrderSignedAt: T("2026-10-07T10:00:00.000Z"),
    dischargeOrderSignerCapacity: "medical_director",
    dischargeOrderText: "Discharge per order.",
    dischargeOrderReference: "ORD-1",
    filedByUserId: "u-f",
    createdAt: T("2026-10-06T08:00:00.000Z"),
  };
  const rows = { discharge_event: [DE_ROW], admission: [ADMISSION], user: USERS("Nina Filer") };

  it("builds a cosigned for-cause discharge with filer, order and cosign", async () => {
    const p = await buildDischargeRenderPayload(ctx(rows), "de-1");
    expect(p.cosign).toMatchObject({ required: true, completed: true });
    expect(p.cosign.signature).toMatchObject({
      printedName: "Dr. Medical Director",
      npi: "1234567893",
      capacity: "Hospice medical director",
    });
    expect(p.dischargeOrder?.signature.capacity).toBe("Hospice medical director");
    expect(p.filedBy?.printedName).toBe("Nina Filer");
    expect(COMPILED_FORMS.discharge_summary(p).watermark).toBeUndefined();
  });

  it("a pending-cosign discharge needs no cosign signature and is watermarked", async () => {
    const p = await buildDischargeRenderPayload(
      ctx({
        ...rows,
        discharge_event: [
          { ...DE_ROW, status: "pending_cosign", cosignedAt: null, dischargeOrderSignedAt: null },
        ],
      }),
      "de-1",
    );
    expect(p.cosign).toMatchObject({ completed: false, signature: null });
    expect(COMPILED_FORMS.discharge_summary(p).watermark?.text).toBe("PENDING COSIGN");
  });

  it("an external (HL7) discharge has no filer and renders without one", async () => {
    const p = await buildDischargeRenderPayload(
      ctx({ ...rows, discharge_event: [{ ...DE_ROW, filedByUserId: null }] }),
      "de-1",
    );
    expect(p.filedBy).toBeNull();
  });

  it("a cosigned discharge whose cosigner cannot be named is refused, never drawn unsigned", async () => {
    await expect(
      buildDischargeRenderPayload(
        ctx({
          ...rows,
          discharge_event: [{ ...DE_ROW, cosignerName: null, medicalDirectorMembershipId: null }],
        }),
        "de-1",
      ),
    ).rejects.toThrow(RenderPayloadError);
  });
});

describe("buildTransferRenderPayload", () => {
  it("builds the transfer summary", async () => {
    const p = await buildTransferRenderPayload(
      ctx({
        transfer_event: [
          {
            id: "te-1",
            admissionId: "adm-1",
            direction: "out",
            effectiveAt: "2026-10-07",
            receivingOrSendingName: "Lakeside Hospice",
            receivingOrSendingCcn: "012345",
            receivingCareSetting: "home",
            periodSequenceAtTransfer: 2,
            narrative: null,
          },
        ],
        admission: [ADMISSION],
      }),
      "te-1",
    );
    expect(drawn(COMPILED_FORMS.discharge_summary_transfer(p))).toContain("Lakeside Hospice");
  });
});

describe("buildOrOmit", () => {
  it("returns the payload when it builds", async () => {
    expect(
      await buildOrOmit(
        () => undefined,
        {},
        async () => 7,
      ),
    ).toBe(7);
  });

  it("omits and reports a source failure by ids and reason only (no PHI)", async () => {
    const logged: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const out = await buildOrOmit(
      (event, detail) => logged.push({ event, detail }),
      { ctiId: "cti-1" },
      async () => {
        throw new RenderPayloadBuildError("cti", "the patient's name / MRN did not resolve");
      },
    );
    expect(out).toBeUndefined();
    expect(logged).toEqual([
      {
        event: "m6.render_payload_unavailable",
        detail: {
          ctiId: "cti-1",
          artifact: "cti",
          why: "the patient's name / MRN did not resolve",
        },
      },
    ]);
  });

  it("reports a schema failure by path, never by value", async () => {
    const logged: Array<Record<string, unknown>> = [];
    await buildOrOmit(
      (_e, d) => logged.push(d),
      {},
      async () => {
        throw new RenderPayloadError("cti", [
          "/narrative: Expected string length greater or equal to 1",
        ]);
      },
    );
    expect(logged[0]).toMatchObject({ artifact: "cti", violations: ["/narrative"] });
  });

  it("does NOT swallow an unexpected error (a SQL failure aborts the transaction anyway)", async () => {
    await expect(
      buildOrOmit(
        () => undefined,
        {},
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
  });
});
