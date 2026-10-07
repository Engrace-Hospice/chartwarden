// @wardenx/dosespot — the wire <-> domain mappers for the DoseSpot v2 REST API (GAP-037 close-out).
//
// EVERYTHING FIELD-LEVEL LIVES HERE so the part that can only be settled against a vendor sandbox is in one
// reviewable place. What the public swagger confirmed (see ./endpoints.ts): the `Result` envelope
// (`ResultCode`, `ResultDescription`), `IdentifierResponse { Id }`, the send body (`prescriptionIds`, `pin`),
// the `Prescription.Status` enum values and `PrescriptionId` / `PharmacyId` / `DateWritten`. What it did NOT
// show in a form we could read, and so is `WIRE_FIELD_MAPPING_VERIFIED = false` until a sandbox run: the
// add/edit patient body, the coded-prescription body, and the medication-history item. Those mappings use the
// field names the v2 API's own naming convention implies (PascalCase) and are exercised only by the contract
// tests in this package, never presented as vendor-verified. Responses are read TOLERANTLY (case-insensitive,
// absent fields stay absent) so a quirk surfaces as a clear failure, not as an invented value.
import type {
  DoseSpotMedHistoryItem,
  DoseSpotNewRxPayload,
  DoseSpotPatientPayload,
  DoseSpotPrescriptionStatusResponse,
} from "./contract";

/** `false` until the add-patient / coded-prescription / medication-history field names are checked in a sandbox. */
export const WIRE_FIELD_MAPPING_VERIFIED = false as const;

type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Case-insensitive property read. */
export function pick(obj: unknown, ...names: readonly string[]): unknown {
  if (!isRecord(obj)) return undefined;
  const lower = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const n of names) {
    const key = lower.get(n.toLowerCase());
    if (key !== undefined) return obj[key];
  }
  return undefined;
}

export const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : undefined;

/** The v2 `Result` envelope: `ResultCode` "OK" / "ERROR". Returns the error description when it is an error. */
export function resultError(body: unknown): string | null {
  const result = pick(body, "Result");
  if (!isRecord(result)) return null;
  const code = asString(pick(result, "ResultCode"));
  if (code !== undefined && code.toUpperCase() === "ERROR") {
    return asString(pick(result, "ResultDescription")) ?? "ERROR";
  }
  return null;
}

const GENDER: Readonly<Record<string, string>> = {
  male: "Male",
  m: "Male",
  female: "Female",
  f: "Female",
};

/** Patient add/edit body (PascalCase v2 convention; NOT sandbox-verified — see the header). */
export function toPatientBody(p: DoseSpotPatientPayload): Json {
  return {
    FirstName: p.firstName,
    LastName: p.lastName,
    DateOfBirth: p.dateOfBirth,
    Gender: GENDER[p.gender.toLowerCase()] ?? "Unknown",
    Address1: p.address.line1,
    ...(p.address.line2 ? { Address2: p.address.line2 } : {}),
    City: p.address.city,
    State: p.address.state,
    ZipCode: p.address.postalCode,
    ...(p.phone ? { PrimaryPhone: p.phone, PrimaryPhoneType: "Cell" } : {}),
    Active: p.active,
  };
}

/** Human sig line from the structured sig (the adapter never sends the raw free text; see §4.10). */
export function sigDirections(sig: Record<string, unknown>): string {
  const dose = typeof sig.doseQuantity === "number" ? String(sig.doseQuantity) : "";
  const unit = typeof sig.doseUnit === "string" ? sig.doseUnit : "";
  const route = typeof sig.route === "string" ? sig.route : "";
  const freq = typeof sig.frequencyCode === "string" ? sig.frequencyCode : "";
  const prn = sig.asNeeded === true ? "as needed" : "";
  return ["Take", dose, unit, route, freq, prn].filter((s) => s.length > 0).join(" ");
}

/** Coded-prescription body (NOT sandbox-verified — see the header). */
export function toCodedPrescriptionBody(p: DoseSpotNewRxPayload): Json {
  return {
    ...(p.drugName ? { DisplayName: p.drugName } : {}),
    Rxcui: p.rxnormRxcui,
    ...(p.ndc ? { Ndc: p.ndc } : {}),
    Strength: p.strength,
    Quantity: p.quantity,
    DaysSupply: p.daysSupply,
    Refills: p.refillsAuthorized,
    Directions: sigDirections(p.sigStructured),
    NoSubstitutions: false,
    ...(p.pharmacyDosespotId ? { PharmacyId: Number(p.pharmacyDosespotId) } : {}),
    ...(p.deaSchedule ? { Schedule: p.deaSchedule } : {}),
    PrescriberId: Number(p.dosespotPrescriberId),
  };
}

/** `IdentifierResponse.Id` as a string, or `undefined`. */
export function identifierOf(body: unknown): string | undefined {
  return asString(pick(body, "Id"));
}

/** Normalise the swagger `Prescription.Status` enum into the adapter's four phases. */
export function phaseOfStatus(status: string): DoseSpotPrescriptionStatusResponse["phase"] {
  switch (status) {
    case "eRxSent":
    case "FaxSent":
    case "PharmacyVerified":
    case "Printed":
      return "sent";
    case "Error":
    case "EpcsError":
    case "Deleted":
    case "Retracted":
      return "failed";
    case "PharmacySelect":
      return "needs_pharmacy";
    default:
      // Entered, Sending, Requested, Edited, EpcsSigned, ReadyToSign — still in flight on the vendor side.
      return "pending";
  }
}

/** Find one prescription in the `GET .../prescriptions` list body. */
export function findPrescription(body: unknown, prescriptionId: string): Json | null {
  const items = pick(body, "Items", "Prescriptions", "Data");
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (asString(pick(item, "PrescriptionId", "Id")) === prescriptionId && isRecord(item)) {
      return item;
    }
  }
  return null;
}

/** Map one history item tolerantly; nothing is defaulted when the vendor omitted it. */
export function toMedHistoryItem(raw: unknown): DoseSpotMedHistoryItem | null {
  const drugName = asString(pick(raw, "DisplayName", "DrugName", "Name"));
  if (drugName === undefined) return null;
  const rxcui = asString(pick(raw, "Rxcui", "RxCUI", "RxNormCode"));
  const lastFill = asString(pick(raw, "LastFillDate", "DateLastFilled"));
  const pharmacy = asString(pick(raw, "PharmacyName", "Pharmacy"));
  const ndc = asString(pick(raw, "Ndc", "NDC"));
  const strength = asString(pick(raw, "Strength"));
  const sig = asString(pick(raw, "Directions", "Sig"));
  const written = asString(pick(raw, "DateWritten", "WrittenDate"));
  const ncpdp = asString(pick(raw, "PharmacyNcpdp", "NCPDP"));
  const npi = asString(pick(raw, "PrescriberNpi", "NPI"));
  return {
    rxnormRxcui: rxcui ?? null,
    drugName,
    lastFillDate: lastFill ?? null,
    sourcePharmacy: pharmacy ?? null,
    ...(ndc !== undefined ? { ndc } : {}),
    ...(strength !== undefined ? { strength } : {}),
    ...(sig !== undefined ? { sigText: sig } : {}),
    ...(written !== undefined ? { prescribedAt: written } : {}),
    ...(ncpdp !== undefined ? { pharmacyNcpdp: ncpdp } : {}),
    ...(npi !== undefined ? { prescriberNpi: npi } : {}),
  };
}
