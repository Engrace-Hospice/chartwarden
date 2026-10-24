// M25 milestone 13a - the APPOINTMENT OF REPRESENTATIVE record (hospice ADR/TPE/QIC PRD, milestone 13). PURE.
//
// RECORD-KEEPING ONLY. Nothing here states a CMS rule: the form identity, edition and required elements are the
// organization's own `representative_form_version` data (typed by a person with a source note, nothing seeded); every date
// is typed; the validity end is a typed date with a source note and is NEVER computed from a period; whether an appointment
// is still valid is only "the typed end has passed (as recorded)". There is no `hospice_staff` kind: staff may assist
// (notes and documents) but never act as the representative (milestone 13b, after compliance sign-off). An appointment
// grants no portal, consent or caregiver record. The numbers below are validation bounds, not payer or CMS values.
import { containsMbi } from "./qic";
import { isRealDay } from "./recorded-deadline";

export const REPRESENTATIVE_KINDS = [
  "family_or_friend",
  "legal_representative",
  "attorney",
  "other",
] as const;
export type RepresentativeKind = (typeof REPRESENTATIVE_KINDS)[number];

export const INSTRUMENT_KINDS = ["org_form", "other_written_instrument"] as const;
export type InstrumentKind = (typeof INSTRUMENT_KINDS)[number];

export const APPOINTMENT_STATES = ["draft", "active", "revoked", "superseded"] as const;
export type AppointmentState = (typeof APPOINTMENT_STATES)[number];

/** Validation bounds (not rule values). */
export const REPRESENTATIVE_BOUNDS = {
  nameMax: 200,
  labelMax: 200,
  noteMax: 1000,
  elementsMax: 30,
  elementLabelMax: 200,
} as const;

export type ElementState = "missing" | "confirmed";
export interface ElementStatus {
  readonly label: string;
  readonly state: ElementState;
}

const blank = (v: string | null | undefined): boolean =>
  v === null || v === undefined || v.trim() === "";
const has = (v: string | null | undefined): v is string => !blank(v);
const oneOf = <T extends string>(set: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (set as readonly string[]).includes(v);

/** TEXT_TOO_LONG / MBI_IN_FREE_TEXT over free-text fields; null when every field is fine. Never stores, only checks. */
export function freeTextRefusal(
  fields: readonly (string | null | undefined)[],
  max: number,
): "TEXT_TOO_LONG" | "MBI_IN_FREE_TEXT" | null {
  for (const f of fields) {
    if (f !== null && f !== undefined && f.length > max) return "TEXT_TOO_LONG";
  }
  for (const f of fields) {
    if (f !== null && f !== undefined && containsMbi(f)) return "MBI_IN_FREE_TEXT";
  }
  return null;
}

/** A typed day must be a real calendar day and not after `today` (a person types what already happened). */
export function dayRefusal(
  day: string | null | undefined,
  today: string,
): "DATE_INVALID" | "DATE_IN_FUTURE" | null {
  if (day === null || day === undefined) return null;
  if (!isRealDay(day)) return "DATE_INVALID";
  return day > today ? "DATE_IN_FUTURE" : null;
}

export interface AppointmentDraftInput {
  readonly instrumentKind: string;
  readonly formVersionId: string | null;
  readonly instrumentNote: string | null;
  readonly representativeName: string;
  readonly relationshipLabel: string | null;
  readonly representativeKind: string;
  readonly beneficiarySignedOn: string | null;
  readonly representativeSignedOn: string | null;
  readonly validThroughOn: string | null;
  readonly validitySourceNote: string | null;
}

export type AppointmentDraftRefusal =
  | "INSTRUMENT_INVALID"
  | "FORM_VERSION_REQUIRED"
  | "FORM_VERSION_NOT_ALLOWED"
  | "INSTRUMENT_NOTE_REQUIRED"
  | "NAME_REQUIRED"
  | "KIND_INVALID"
  | "LABEL_REQUIRED_FOR_OTHER"
  | "DATE_INVALID"
  | "DATE_IN_FUTURE"
  | "VALIDITY_PAIR_REQUIRED"
  | "VALIDITY_DATE_INVALID"
  | "TEXT_TOO_LONG"
  | "MBI_IN_FREE_TEXT";

/**
 * Whether a draft appointment may be written. The validity end is a typed day with its source note (both or neither); a day
 * already past is allowed (it is what the paper says) and is only flagged on read.
 */
export function checkAppointmentDraft(
  input: AppointmentDraftInput,
  today: string,
): AppointmentDraftRefusal | null {
  if (!oneOf(INSTRUMENT_KINDS, input.instrumentKind)) return "INSTRUMENT_INVALID";
  if (input.instrumentKind === "org_form" && !has(input.formVersionId))
    return "FORM_VERSION_REQUIRED";
  if (input.instrumentKind === "other_written_instrument") {
    if (has(input.formVersionId)) return "FORM_VERSION_NOT_ALLOWED";
    if (blank(input.instrumentNote)) return "INSTRUMENT_NOTE_REQUIRED";
  }
  if (blank(input.representativeName)) return "NAME_REQUIRED";
  if (!oneOf(REPRESENTATIVE_KINDS, input.representativeKind)) return "KIND_INVALID";
  if (input.representativeKind === "other" && blank(input.relationshipLabel)) {
    return "LABEL_REQUIRED_FOR_OTHER";
  }
  for (const day of [input.beneficiarySignedOn, input.representativeSignedOn]) {
    const refusal = dayRefusal(day, today);
    if (refusal) return refusal;
  }
  if ((input.validThroughOn === null) !== blank(input.validitySourceNote)) {
    return "VALIDITY_PAIR_REQUIRED";
  }
  if (input.validThroughOn !== null && !isRealDay(input.validThroughOn)) {
    return "VALIDITY_DATE_INVALID";
  }
  const nameFields = [input.representativeName, input.relationshipLabel];
  const long = freeTextRefusal(nameFields, REPRESENTATIVE_BOUNDS.nameMax);
  if (long) return long;
  return freeTextRefusal(
    [input.instrumentNote, input.validitySourceNote],
    REPRESENTATIVE_BOUNDS.noteMax,
  );
}

export interface FormVersionInput {
  readonly label: string;
  readonly formIdentifier: string | null;
  readonly editionText: string | null;
  readonly sourceNote: string;
  readonly verifiedOn: string | null;
  readonly requiredElements: readonly string[];
}

export type FormVersionRefusal =
  | "LABEL_REQUIRED"
  | "SOURCE_NOTE_REQUIRED"
  | "VERIFIED_ON_INVALID"
  | "ELEMENTS_TOO_MANY"
  | "ELEMENT_BLANK"
  | "ELEMENT_DUPLICATE"
  | "TEXT_TOO_LONG"
  | "MBI_IN_FREE_TEXT";

/** Whether an organization's form version may be written: traceable (source note) and typed, never a platform default. */
export function checkFormVersionInput(
  input: FormVersionInput,
  today: string,
): FormVersionRefusal | null {
  if (blank(input.label)) return "LABEL_REQUIRED";
  if (blank(input.sourceNote)) return "SOURCE_NOTE_REQUIRED";
  if (input.verifiedOn !== null && dayRefusal(input.verifiedOn, today) !== null) {
    return "VERIFIED_ON_INVALID";
  }
  if (input.requiredElements.length > REPRESENTATIVE_BOUNDS.elementsMax) return "ELEMENTS_TOO_MANY";
  const seen = new Set<string>();
  for (const e of input.requiredElements) {
    if (blank(e)) return "ELEMENT_BLANK";
    const key = e.trim().toLowerCase();
    if (seen.has(key)) return "ELEMENT_DUPLICATE";
    seen.add(key);
  }
  const long = freeTextRefusal(
    [input.label, input.formIdentifier, input.editionText, ...input.requiredElements],
    REPRESENTATIVE_BOUNDS.elementLabelMax,
  );
  if (long) return long;
  return freeTextRefusal([input.sourceNote], REPRESENTATIVE_BOUNDS.noteMax);
}

/** The element checklist of a new draft: every configured label, none confirmed yet. */
export function snapshotElements(labels: readonly string[]): ElementStatus[] {
  return labels.map((label) => ({ label: label.trim(), state: "missing" as const }));
}

/** A new checklist with exactly the named labels confirmed (the rest missing); an unknown label is refused. */
export function confirmElements(
  snapshot: readonly ElementStatus[],
  confirmedLabels: readonly string[],
): { ok: true; elements: ElementStatus[] } | { ok: false; unknown: string } {
  const known = new Set(snapshot.map((e) => e.label));
  const unknown = confirmedLabels.find((l) => !known.has(l));
  if (unknown !== undefined) return { ok: false, unknown };
  const confirmed = new Set(confirmedLabels);
  return {
    ok: true,
    elements: snapshot.map((e) => ({
      label: e.label,
      state: confirmed.has(e.label) ? ("confirmed" as const) : ("missing" as const),
    })),
  };
}

export type ActivationRefusal =
  | "NOT_DRAFT"
  | "ACTIVATOR_IS_RECORDER"
  | "NO_DOCUMENT"
  | "ELEMENTS_INCOMPLETE";

/** The friendly pre-check; the database trigger decides the same rules atomically on the UPDATE. */
export function checkActivation(input: {
  readonly state: string;
  readonly recordedBy: string;
  readonly activator: string;
  readonly hasDocument: boolean;
  readonly elements: readonly ElementStatus[];
}): ActivationRefusal | null {
  if (input.state !== "draft") return "NOT_DRAFT";
  if (input.activator === input.recordedBy) return "ACTIVATOR_IS_RECORDER";
  if (!input.hasDocument) return "NO_DOCUMENT";
  if (input.elements.some((e) => e.state !== "confirmed")) return "ELEMENTS_INCOMPLETE";
  return null;
}

export type RevocationRefusal =
  | "NOT_REVOCABLE"
  | "REVOKED_ON_INVALID"
  | "NOTE_REQUIRED"
  | "TEXT_TOO_LONG"
  | "MBI_IN_FREE_TEXT";

/** Revoking a draft (discarding it) or an active appointment. It records a typed day and a note; it is never blocked by a second person. */
export function checkRevocation(
  input: { readonly state: string; readonly revokedOn: string; readonly note: string },
  today: string,
): RevocationRefusal | null {
  if (input.state !== "draft" && input.state !== "active") return "NOT_REVOCABLE";
  if (dayRefusal(input.revokedOn, today) !== null) return "REVOKED_ON_INVALID";
  if (blank(input.note)) return "NOTE_REQUIRED";
  return freeTextRefusal([input.note], REPRESENTATIVE_BOUNDS.noteMax);
}

export type AppointmentStatus =
  | "draft"
  | "active"
  | "validity_end_passed_as_recorded"
  | "revoked"
  | "superseded";

/**
 * The displayed status, derived on read from typed values only. A passed typed validity end is flagged
 * ("validity end passed (as recorded) - confirm with compliance"); the stored state never changes by itself and no period is
 * ever added to a signature date.
 */
export function appointmentStatus(
  a: { readonly state: string; readonly validThroughOn: string | null },
  today: string,
): AppointmentStatus {
  if (a.state === "active") {
    return a.validThroughOn !== null && a.validThroughOn < today
      ? "validity_end_passed_as_recorded"
      : "active";
  }
  if (a.state === "revoked" || a.state === "superseded" || a.state === "draft") return a.state;
  return "draft";
}
