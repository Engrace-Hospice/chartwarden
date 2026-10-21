// apps/backend/src/modules/12-dosespot/render-payloads/build.ts - the typed render payload M12 hands M22 for a
// signed medication order (GAP-033). It runs INSIDE the signing transaction on the order's own row, so the PDF is a
// snapshot of what was signed, and it reads the per-class `data` defensively: the final schema assertion
// (`assertMedicationOrderRenderPayload`) is the contract, so an order whose `data` does not satisfy it produces no
// payload and M22 refuses the event rather than drawing a blank prescription.
//
// Identifier minimisation: the prescriber's DEA number is on the row's `data` but is deliberately NOT carried;
// only the DEA schedule of the drug is. 42 CFR Part 2: `isSudTreatment` travels so M22 prints the redisclosure
// notice, and the caller stamps `isSudClass` so the consent gate applies.
import type { schema } from "@chartwarden/db";
import {
  type MedicationOrderRenderPayload,
  RENDER_PAYLOAD_VERSION,
  type SignatureRecord,
  assertMedicationOrderRenderPayload,
} from "@chartwarden/types";
import {
  type RenderBuildCtx,
  RenderPayloadBuildError,
  membershipPrintedName,
} from "../../../bootstrap/render-payload-sources";

type MedicationOrderRow = typeof schema.medicationOrders.$inferSelect;
type Rec = Readonly<Record<string, unknown>>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export interface MedicationOrderSigning {
  readonly signerMembershipId: string;
  readonly signedAt: Date;
  readonly viaVerbal: boolean;
}

function sigOf(data: Rec): MedicationOrderRenderPayload["sig"] {
  const s = rec(data.sigStructured);
  const d = rec(s.duration);
  const durationValue = typeof d.durationValue === "number" ? d.durationValue : null;
  const durationUnit = text(d.durationUnit);
  return {
    doseQuantity: num(s.doseQuantity, 0),
    doseUnit: text(s.doseUnit) ?? "",
    route: text(s.route) ?? "",
    frequencyCode: text(s.frequencyCode) ?? "",
    duration:
      durationValue !== null && durationUnit !== null ? `${durationValue} ${durationUnit}` : null,
    asNeeded: s.asNeeded === true,
    asNeededReason: text(s.asNeededReasonCode),
  };
}

function compoundedOf(data: Rec): MedicationOrderRenderPayload["compounded"] {
  const description = text(data.formulationDescription);
  if (description === null) return null;
  const components = Array.isArray(data.components) ? data.components : [];
  return {
    formulationDescription: description,
    containsControlled: data.containsControlled === true,
    components: components.map((c) => {
      const r = rec(c);
      return {
        name: text(r.componentName) ?? "",
        strength: text(r.componentStrength) ?? "",
        quantityRatio: text(r.quantityRatio) ?? "",
      };
    }),
  };
}

function allergyOverrideOf(data: Rec): MedicationOrderRenderPayload["allergyOverride"] {
  const a = rec(data.allergyOverride);
  const reason = text(a.reason);
  if (reason === null) return null;
  return {
    reason,
    acknowledgedAt: text(a.acknowledgedAt) ?? "",
    matchedClasses: (Array.isArray(a.matchedClasses) ? a.matchedClasses : [])
      .map(text)
      .filter((c): c is string => c !== null),
  };
}

async function signatureOf(
  ctx: RenderBuildCtx,
  order: MedicationOrderRow,
  signing: MedicationOrderSigning,
  prescriber: Awaited<ReturnType<RenderBuildCtx["sources"]["physician"]>>,
): Promise<SignatureRecord> {
  const printedName = await membershipPrintedName(ctx.tx, signing.signerMembershipId);
  if (printedName === null) {
    // The signer is an integrity field of a legal document: never drawn blank.
    throw new RenderPayloadBuildError("medication_order", "the signer's name did not resolve");
  }
  // Credentials / NPI belong to the signer only when the signer IS the prescriber of record.
  const signerIsPrescriber = signing.signerMembershipId === order.prescriberMembershipId;
  return {
    role: "Prescriber",
    printedName,
    credentials: signerIsPrescriber ? (prescriber?.credentials ?? null) : null,
    npi: signerIsPrescriber ? (prescriber?.npi ?? null) : null,
    capacity: null,
    signedAt: signing.signedAt.toISOString(),
    method: "electronic",
    meaning: "order_authorization",
    recordId: order.id,
  };
}

export async function buildMedicationOrderRenderPayload(
  ctx: RenderBuildCtx,
  order: MedicationOrderRow,
  signing: MedicationOrderSigning,
): Promise<MedicationOrderRenderPayload> {
  const patient = await ctx.sources.patient(ctx.organizationId, order.patientId);
  if (!patient || patient.name.trim() === "" || patient.mrn.trim() === "") {
    throw new RenderPayloadBuildError(
      "medication_order",
      "the patient's name / MRN did not resolve",
    );
  }
  const prescriber = await ctx.sources.physician(
    ctx.organizationId,
    order.prescribingPhysicianMdmId,
  );
  const data = rec(order.data);
  const dispense = rec(data.dispenseQuantity);
  const payload: MedicationOrderRenderPayload = {
    schemaVersion: RENDER_PAYLOAD_VERSION,
    orderId: order.id,
    patient: {
      patientId: order.patientId,
      name: patient.name,
      mrn: patient.mrn,
      dateOfBirth: patient.dateOfBirth,
    },
    hospiceName: await ctx.hospiceName(order.providerEntityId ?? null),
    medClass: order.medClass,
    drugName: order.drugName,
    strength: order.strength,
    doseForm: order.doseForm,
    route: order.route,
    sig: sigOf(data),
    sigFreeText: text(data.sigFreeText) ?? "",
    indication: text(data.indication),
    clinicalJustification: text(data.clinicalJustification),
    dispenseQuantity: { value: num(dispense.value, 0), unit: text(dispense.unit) ?? "" },
    daysSupply: num(data.daysSupply, 0),
    refillsAuthorized: order.refillsAuthorized,
    daw: data.daw === true,
    deaSchedule: order.deaSchedule ?? null,
    compounded: order.medClass === "compounded" ? compoundedOf(data) : null,
    coverage: { status: order.hospiceCoverage, reason: text(order.coverageReason) },
    allergyOverride: allergyOverrideOf(data),
    prescribingPhysician: prescriber
      ? { name: prescriber.name, credentials: prescriber.credentials, npi: prescriber.npi }
      : null,
    viaVerbal: signing.viaVerbal,
    cosign: order.cosignRequired ? { required: true, status: order.cosignStatus ?? null } : null,
    isSudTreatment: order.isSudTreatment,
    signature: await signatureOf(ctx, order, signing, prescriber),
  };
  return assertMedicationOrderRenderPayload(payload);
}
