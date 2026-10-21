// GAP-033 Wave 2 - the typed render-payload producers of M11 (order_record) and M12 (medication_order). Driven over
// programmed rows (the recording Drizzle fake) and fake M5 / M40 sources, then round-tripped through M22's form
// compiler: what the producer builds is what the form draws. Real-Postgres coverage of the same builders is in
// m22-order-render-payloads.live.test.ts.
import { RenderPayloadError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type RenderBuildCtx,
  RenderPayloadBuildError,
  type RenderSourcesPort,
  buildRenderPayloadOrOmit,
} from "../src/bootstrap/render-payload-sources";
import {
  NO_PUBLISHED_CONTRACT_NOTE,
  buildOrderRecordRenderPayload,
} from "../src/modules/11-orders/render-payloads";
import { buildMedicationOrderRenderPayload } from "../src/modules/12-dosespot/render-payloads";
import { COMPILED_FORMS } from "../src/modules/22-documents/render-pdf/forms";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { fakeDb } from "./_fake-drizzle";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PATIENT = "11111111-0000-4000-8000-000000000001";
const MD_MDM = "22222222-0000-4000-8000-000000000002";
const PRESCRIBER_MEMBERSHIP = "33333333-0000-4000-8000-000000000003";
const OTHER_MEMBERSHIP = "44444444-0000-4000-8000-000000000004";
const SIGNED_AT = new Date("2026-09-30T14:05:00.000Z");

const SOURCES: RenderSourcesPort = {
  patient: async (_org, id) =>
    id === PATIENT ? { name: "Zelda Quillfeather", mrn: "MRN-9", dateOfBirth: "1941-03-07" } : null,
  physician: async (_org, id) =>
    id === MD_MDM ? { name: "Dr. Imani Okafor", credentials: "MD", npi: "1234567893" } : null,
};

function ctx(
  rows: Record<string, unknown[]> = { membership: [{ name: "Imani Okafor" }] },
  sources: RenderSourcesPort = SOURCES,
): RenderBuildCtx {
  const { db } = fakeDb(rows);
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

const drawn = (doc: Parameters<typeof layoutDocument>[0]): string =>
  pageTexts(layoutDocument(doc)).flat().join("\n");

// ── M12 medication order ───────────────────────────────────────────────────────────────────────────
const MO_DATA = {
  sigStructured: {
    doseQuantity: 5,
    doseUnit: "mg",
    route: "oral",
    frequencyCode: "q4h",
    duration: { durationValue: 30, durationUnit: "days" },
    asNeeded: true,
    asNeededReasonCode: "dyspnea",
  },
  sigFreeText: "Give 5 mg by mouth every 4 hours as needed for shortness of breath.",
  indication: "Dyspnea at rest",
  clinicalJustification: "Opioid-naive patient with refractory dyspnea; low starting dose.",
  refillsAuthorized: 0,
  dispenseQuantity: { value: 30, unit: "mL" },
  daysSupply: 30,
  daw: false,
  deaSchedule: "II",
  prescriberDea: "AB1234563",
};

function medicationOrderRow(over: Record<string, unknown> = {}) {
  return {
    id: "55555555-0000-4000-8000-000000000005",
    organizationId: ORG,
    providerEntityId: "pe-1",
    patientId: PATIENT,
    admissionId: "adm-1",
    medClass: "controlled_substance",
    isControlledSubstance: true,
    deaSchedule: "II",
    isSudTreatment: false,
    drugName: "Morphine sulfate oral solution",
    strength: "20 mg/mL",
    doseForm: "solution",
    route: "oral",
    data: MO_DATA,
    prescriberMembershipId: PRESCRIBER_MEMBERSHIP,
    prescribingPhysicianMdmId: MD_MDM,
    refillsAuthorized: 0,
    cosignRequired: false,
    cosignStatus: null,
    hospiceCoverage: "covered_related",
    coverageReason: null,
    ...over,
  } as never;
}

describe("M12 buildMedicationOrderRenderPayload", () => {
  const signing = {
    signerMembershipId: PRESCRIBER_MEMBERSHIP,
    signedAt: SIGNED_AT,
    viaVerbal: false,
  };

  it("snapshots the signed order, and the form draws exactly what was built", async () => {
    const payload = await buildMedicationOrderRenderPayload(ctx(), medicationOrderRow(), signing);
    expect(payload.patient).toMatchObject({ name: "Zelda Quillfeather", mrn: "MRN-9" });
    expect(payload.hospiceName).toBe("Evergreen Hospice LLC");
    expect(payload.sig.duration).toBe("30 days");
    expect(payload.deaSchedule).toBe("II");
    expect(payload.signature).toMatchObject({
      printedName: "Imani Okafor",
      credentials: "MD",
      npi: "1234567893",
      meaning: "order_authorization",
      signedAt: "2026-09-30T14:05:00.000Z",
    });
    const text = drawn(COMPILED_FORMS.medication_order(payload));
    expect(text).toContain("Morphine sulfate oral solution");
    expect(text).toContain("Give 5 mg by mouth every 4 hours");
  });

  it("never carries the prescriber's DEA number", async () => {
    const payload = await buildMedicationOrderRenderPayload(ctx(), medicationOrderRow(), signing);
    expect(JSON.stringify(payload)).not.toContain("AB1234563");
  });

  it("credentials and NPI belong to the signer only when the signer IS the prescriber of record", async () => {
    const payload = await buildMedicationOrderRenderPayload(ctx(), medicationOrderRow(), {
      ...signing,
      signerMembershipId: OTHER_MEMBERSHIP,
    });
    expect(payload.signature.credentials).toBeNull();
    expect(payload.signature.npi).toBeNull();
    expect(payload.prescribingPhysician?.npi).toBe("1234567893");
  });

  it("maps a compounded formulation, an allergy override and the coverage determination", async () => {
    const payload = await buildMedicationOrderRenderPayload(
      ctx(),
      medicationOrderRow({
        medClass: "compounded",
        isControlledSubstance: false,
        deaSchedule: null,
        hospiceCoverage: "not_covered_unrelated",
        coverageReason: "Unrelated to the terminal illness.",
        cosignRequired: true,
        cosignStatus: "pending",
        data: {
          ...MO_DATA,
          formulationDescription: "Haloperidol and lorazepam gel for topical use.",
          containsControlled: true,
          components: [
            { componentName: "Haloperidol", componentStrength: "2 mg/mL", quantityRatio: "1:1" },
          ],
          allergyOverride: {
            reason: "Tolerated previously without reaction.",
            acknowledgedByMembershipId: PRESCRIBER_MEMBERSHIP,
            acknowledgedAt: "2026-09-30T13:50:00.000Z",
            matchedClasses: ["benzodiazepine"],
          },
        },
      }),
      signing,
    );
    expect(payload.compounded?.components).toEqual([
      { name: "Haloperidol", strength: "2 mg/mL", quantityRatio: "1:1" },
    ]);
    expect(payload.allergyOverride).toMatchObject({ matchedClasses: ["benzodiazepine"] });
    expect(payload.coverage).toEqual({
      status: "not_covered_unrelated",
      reason: "Unrelated to the terminal illness.",
    });
    expect(payload.cosign).toEqual({ required: true, status: "pending" });
    // the acknowledging membership id is plumbing, not content
    expect(JSON.stringify(payload)).not.toContain("acknowledgedByMembershipId");
  });

  it("refuses to build when the patient or the signer's name does not resolve", async () => {
    const noPatient: RenderSourcesPort = { ...SOURCES, patient: async () => null };
    await expect(
      buildMedicationOrderRenderPayload(ctx(undefined, noPatient), medicationOrderRow(), signing),
    ).rejects.toBeInstanceOf(RenderPayloadBuildError);
    await expect(
      buildMedicationOrderRenderPayload(ctx({ membership: [] }), medicationOrderRow(), signing),
    ).rejects.toBeInstanceOf(RenderPayloadBuildError);
  });

  it("an order whose data does not satisfy the typed contract builds no payload (schema assertion)", async () => {
    await expect(
      buildMedicationOrderRenderPayload(
        ctx(),
        medicationOrderRow({ data: { ...MO_DATA, sigFreeText: "" } }),
        signing,
      ),
    ).rejects.toBeInstanceOf(RenderPayloadError);
  });
});

// ── M11 order record ───────────────────────────────────────────────────────────────────────────────
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: "66666666-0000-4000-8000-000000000006",
    organizationId: ORG,
    providerEntityId: "pe-1",
    patientId: PATIENT,
    admissionId: "adm-1",
    kind: "lab",
    kindVersion: "lab.v1",
    data: {
      testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
      fastingRequired: false,
      collectionInstructions: "Draw at the next visit.",
    },
    priority: "urgent",
    indicationText: "Rising creatinine",
    orderingPhysicianMdmId: MD_MDM,
    replacesOrderId: null,
    standingOrderId: null,
    cosignRequired: false,
    cosignStatus: null,
    ...over,
  } as never;
}

describe("M11 buildOrderRecordRenderPayload", () => {
  const signing = {
    signerMembershipId: PRESCRIBER_MEMBERSHIP,
    signedAt: SIGNED_AT,
    viaVerbal: false,
  };

  it("builds a lab order's published-contract details and the form draws them", async () => {
    const payload = await buildOrderRecordRenderPayload(ctx(), orderRow(), signing);
    expect(payload.details).toEqual([
      { label: "Tests", value: "Creatinine (LOINC 2160-0)" },
      { label: "Fasting required", value: "No" },
      { label: "Collection instructions", value: "Draw at the next visit." },
    ]);
    expect(payload.detailsNote).toBeNull();
    expect(payload.orderingPhysician).toEqual({
      name: "Dr. Imani Okafor",
      credentials: "MD",
      npi: "1234567893",
    });
    const text = drawn(COMPILED_FORMS.order_record(payload));
    expect(text).toContain("Creatinine (LOINC 2160-0)");
    expect(text).toContain("Rising creatinine");
  });

  it("level-of-care and recertification orders resolve their published fields", async () => {
    const loc = await buildOrderRecordRenderPayload(
      ctx(),
      orderRow({
        kind: "level_of_care_change",
        kindVersion: "level_of_care_change.v1",
        data: {
          fromLevel: "rhc",
          toLevel: "gip",
          effectiveAt: "2026-10-01T00:00:00.000Z",
          clinicalJustification: "Uncontrolled pain requiring inpatient titration.",
          expectedDurationHours: 72,
        },
      }),
      signing,
    );
    expect(loc.details).toContainEqual({
      label: "To level of care",
      value: "General inpatient care",
    });
    expect(loc.details).toContainEqual({ label: "Expected duration", value: "72 hours" });
    const recert = await buildOrderRecordRenderPayload(
      ctx(),
      orderRow({
        kind: "recertification",
        kindVersion: "recertification.v1",
        data: { periodEndDate: "2026-12-30", certifyingPhysicianMdmId: MD_MDM },
      }),
      signing,
    );
    expect(recert.details).toEqual([
      { label: "Period end date", value: "2026-12-30" },
      { label: "Certifying physician", value: "Dr. Imani Okafor" },
    ]);
  });

  it.each([
    ["dme", "dme.v1"],
    ["supply", "supply.v1"],
    ["ancillary_service", "ancillary_service.v1"],
  ])(
    "%s (%s) has no published contract: no invented details, an explicit note",
    async (kind, version) => {
      const payload = await buildOrderRecordRenderPayload(
        ctx(),
        orderRow({
          kind,
          kindVersion: version,
          data: { freeForm: "anything", secret: "do-not-print" },
        }),
        signing,
      );
      expect(payload.details).toEqual([]);
      expect(payload.detailsNote).toBe(NO_PUBLISHED_CONTRACT_NOTE);
      expect(JSON.stringify(payload)).not.toContain("do-not-print");
    },
  );

  it("dme.v2 resolves its closed contract; the catalog item is a short reference, not a uuid", async () => {
    const payload = await buildOrderRecordRenderPayload(
      ctx(),
      orderRow({
        kind: "dme",
        kindVersion: "dme.v2",
        data: {
          skuId: "abcdef12-0000-4000-8000-000000000009",
          quantity: 2,
          rentalCadence: "monthly",
          needsInstallation: true,
        },
      }),
      signing,
    );
    expect(payload.details).toContainEqual({ label: "Catalog item reference", value: "abcdef12" });
    expect(payload.details).toContainEqual({ label: "Quantity", value: "2" });
    expect(payload.details).toContainEqual({ label: "Installation needed", value: "Yes" });
  });

  it("an on-behalf signature names the principal; a standing-order instance inherits the template's", async () => {
    const onBehalf = await buildOrderRecordRenderPayload(ctx(), orderRow(), {
      ...signing,
      onBehalfOfMembershipId: OTHER_MEMBERSHIP,
    });
    expect(onBehalf.signature.capacity).toBe("On behalf of Imani Okafor");
    const standing = await buildOrderRecordRenderPayload(
      ctx(),
      orderRow({ standingOrderId: "77777777-0000-4000-8000-000000000007" }),
      { ...signing, inheritedFromStandingOrder: true },
    );
    expect(standing.signature.capacity).toBe("Standing order authorization");
    expect(standing.fromStandingOrder).toBe(true);
  });

  it("carries the correction link, the verbal flag and a pending cosign", async () => {
    const payload = await buildOrderRecordRenderPayload(
      ctx(),
      orderRow({
        replacesOrderId: "88888888-0000-4000-8000-000000000008",
        cosignRequired: true,
        cosignStatus: "pending",
      }),
      { ...signing, viaVerbal: true },
    );
    expect(payload.viaVerbal).toBe(true);
    expect(payload.replacesOrderId).toBe("88888888-0000-4000-8000-000000000008");
    expect(payload.cosign).toEqual({ required: true, status: "pending" });
  });

  it("refuses to build when the patient or the signer's name does not resolve", async () => {
    const noPatient: RenderSourcesPort = { ...SOURCES, patient: async () => null };
    await expect(
      buildOrderRecordRenderPayload(ctx(undefined, noPatient), orderRow(), signing),
    ).rejects.toBeInstanceOf(RenderPayloadBuildError);
    await expect(
      buildOrderRecordRenderPayload(ctx({ membership: [{ name: "  " }] }), orderRow(), signing),
    ).rejects.toBeInstanceOf(RenderPayloadBuildError);
  });
});

describe("buildRenderPayloadOrOmit", () => {
  const logged: Array<[string, Record<string, unknown>]> = [];
  const log = (event: string, detail: Record<string, unknown>) => void logged.push([event, detail]);

  it("returns the payload when it builds", async () => {
    expect(await buildRenderPayloadOrOmit("m11", log, {}, async () => 7)).toBe(7);
  });

  it("an unresolved source or an invalid payload is reported by name (never values) and omitted", async () => {
    logged.length = 0;
    const a = await buildRenderPayloadOrOmit("m12", log, { orderId: "o1" }, async () => {
      throw new RenderPayloadBuildError(
        "medication_order",
        "the patient's name / MRN did not resolve",
      );
    });
    const b = await buildRenderPayloadOrOmit("m11", log, { orderId: "o2" }, async () => {
      throw new RenderPayloadError("order_record", ["/signature/printedName: Expected string"]);
    });
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(logged.map(([e]) => e)).toEqual([
      "m12.render_payload_unavailable",
      "m11.render_payload_invalid",
    ]);
    expect(JSON.stringify(logged)).not.toContain("Expected string");
  });

  it("a genuine error (SQL) is NOT swallowed", async () => {
    await expect(
      buildRenderPayloadOrOmit("m11", log, {}, async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");
  });
});
