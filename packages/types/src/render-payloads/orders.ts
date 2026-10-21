// @chartwarden/types - the typed render payloads of the signed order documents M22 draws (GAP-033, Wave 2): M11's
// order record (the eight non-medication kinds) and M12's medication order. Both events used to carry identifiers
// only (`kind`, `signedAt`, `viaVerbal`), so a layout had nothing to draw - an "order" PDF was a list of ids.
// Each producer now builds the payload in the signing transaction from the order's own row, so the document is a
// snapshot of what was signed, and M22 draws only the declared fields.
//
// Part 2: a medication order for a SUD treatment drug (`isSudTreatment`) is 42 CFR Part 2 content. The producer
// stamps `isSudClass` on the render payload so M22's consent gate (decide-document-request step 3) applies and the
// form prints the redisclosure notice; free text (indication, justification) is clinician-authored and rendered
// as written (documented residual, as for the CTI narrative).
import { type Static, Type } from "@sinclair/typebox";
import {
  RENDER_PAYLOAD_VERSION,
  RenderPatientIdentity,
  SignatureRecord,
  assertRenderPayload,
} from "./common";

const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([text, Type.Null()]);
const schemaVersion = Type.Literal(RENDER_PAYLOAD_VERSION);

/** A physician as printed on an order (name, credentials, NPI when the master record carries one). */
export const RenderPractitioner = Type.Object({
  name: text,
  credentials: nullableText,
  npi: nullableText,
});
export type RenderPractitioner = Static<typeof RenderPractitioner>;

/** One labelled line of an order's kind-specific details, built by the producer from the validated `data`. */
export const RenderDetailLine = Type.Object({ label: text, value: text });
export type RenderDetailLine = Static<typeof RenderDetailLine>;

export const ORDER_RECORD_KINDS = [
  "lab",
  "dme",
  "level_of_care_change",
  "recertification",
  "comfort_kit",
  "supply",
  "ancillary_service",
  "idg_requested",
] as const;

// ── M11 order record ───────────────────────────────────────────────────────────────────────────────
export const OrderRecordRenderPayload = Type.Object({
  schemaVersion,
  orderId: text,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  kind: Type.Union(ORDER_RECORD_KINDS.map((k) => Type.Literal(k))),
  kindVersion: text,
  priority: text,
  indication: nullableText,
  orderingPhysician: Type.Union([RenderPractitioner, Type.Null()]),
  /** Kind-specific lines the producer derived from the validated `data` (empty when no contract is published). */
  details: Type.Array(RenderDetailLine),
  /** Set when the kind has no reviewed field contract: the order's specifics live in the chart, not on this page. */
  detailsNote: nullableText,
  viaVerbal: Type.Boolean(),
  /** Short reference of the order this one corrects, when it is a correction. */
  replacesOrderId: nullableText,
  fromStandingOrder: Type.Boolean(),
  cosign: Type.Union([
    Type.Object({ required: Type.Literal(true), status: nullableText }),
    Type.Null(),
  ]),
  signature: SignatureRecord,
});
export type OrderRecordRenderPayload = Static<typeof OrderRecordRenderPayload>;
export const assertOrderRecordRenderPayload = (p: unknown): OrderRecordRenderPayload =>
  assertRenderPayload("order_record", OrderRecordRenderPayload, p);

// ── M12 medication order ───────────────────────────────────────────────────────────────────────────
export const MEDICATION_ORDER_CLASSES = ["standard", "controlled_substance", "compounded"] as const;

export const MedicationSig = Type.Object({
  doseQuantity: Type.Number(),
  doseUnit: text,
  route: text,
  frequencyCode: text,
  /** "30 days" - already combined from the structured duration, null when open-ended. */
  duration: nullableText,
  asNeeded: Type.Boolean(),
  asNeededReason: nullableText,
});

export const CompoundedComponent = Type.Object({
  name: text,
  strength: text,
  quantityRatio: text,
});

export const MedicationOrderRenderPayload = Type.Object({
  schemaVersion,
  orderId: text,
  patient: RenderPatientIdentity,
  hospiceName: nullableText,
  medClass: Type.Union(MEDICATION_ORDER_CLASSES.map((k) => Type.Literal(k))),
  drugName: text,
  strength: text,
  doseForm: text,
  route: text,
  sig: MedicationSig,
  sigFreeText: text,
  indication: nullableText,
  clinicalJustification: nullableText,
  dispenseQuantity: Type.Object({ value: Type.Number(), unit: text }),
  daysSupply: Type.Integer({ minimum: 1 }),
  refillsAuthorized: Type.Integer({ minimum: 0 }),
  /** Dispense as written. */
  daw: Type.Boolean(),
  /** DEA schedule (II-V) for a controlled substance; the prescriber's DEA number is deliberately NOT carried. */
  deaSchedule: nullableText,
  /** Compounded formulation; null for every other class. */
  compounded: Type.Union([
    Type.Object({
      formulationDescription: text,
      components: Type.Array(CompoundedComponent),
      containsControlled: Type.Boolean(),
    }),
    Type.Null(),
  ]),
  /** 42 CFR 418.24(c)(6): hospice coverage determination for this drug, with the clinical reason when not covered. */
  coverage: Type.Object({ status: text, reason: nullableText }),
  allergyOverride: Type.Union([
    Type.Object({ reason: text, acknowledgedAt: text, matchedClasses: Type.Array(text) }),
    Type.Null(),
  ]),
  prescribingPhysician: Type.Union([RenderPractitioner, Type.Null()]),
  viaVerbal: Type.Boolean(),
  cosign: Type.Union([
    Type.Object({ required: Type.Literal(true), status: nullableText }),
    Type.Null(),
  ]),
  /** 42 CFR Part 2: the drug treats a substance use disorder. Drives the redisclosure notice with `sudRedacted`. */
  isSudTreatment: Type.Boolean(),
  /** Set on the version appended when the prescription reached the pharmacy (`m12.medication_order.transmitted`). */
  transmission: Type.Optional(
    Type.Union([Type.Object({ transmittedAt: text, prescriptionRef: nullableText }), Type.Null()]),
  ),
  signature: SignatureRecord,
});
export type MedicationOrderRenderPayload = Static<typeof MedicationOrderRenderPayload>;
export const assertMedicationOrderRenderPayload = (p: unknown): MedicationOrderRenderPayload =>
  assertRenderPayload("medication_order", MedicationOrderRenderPayload, p);
