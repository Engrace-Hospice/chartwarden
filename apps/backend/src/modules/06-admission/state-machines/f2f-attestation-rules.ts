// apps/backend/src/modules/06-admission/state-machines/f2f-attestation-rules.ts — FY2027 CoP update (§2.4
// R-F2F-05 / R-F2F-06). Pure validators for the two 42 CFR 418.22 changes the face-to-face lifecycle
// enforces. Source: docs/research/FY2027_HOSPICE_COP_RESEARCH.md §3.
//
// R-F2F-05 — § 418.22(a)(4)(ii), as revised by CMS-1851-F (effective 2026-10-01): a recertification F2F
// may occur via telecommunications technology "during a PHE ... or through December 31, 2027, whichever is
// later". From 2026-01-31 (CAA 2026 § 6209(f)(1)(B)) telehealth is barred when (A) the patient is in a
// hospice enrollment-moratorium area, (B) the hospice is under enhanced oversight, or (C) the performer is
// neither Medicare-enrolled nor an opt-out practitioner. WardenX has no natural home for those three facts
// (no moratorium / oversight flag on `provider_entity`, no practitioner enrollment registry), so they are
// captured as an EXPLICIT ATTESTATION on completion and persisted on the encounter
// (`face_to_face_encounter.telehealth_eligibility`). The PHE branch is not modelled: the sunset is the named
// constant below, to be moved if a PHE is declared.
//
// R-F2F-06 — § 418.22(b)(4) (effective 2025-10-01, FY 2026 rule): the attestation may be a clinical note
// that indicates the encounter occurred, includes its clinical findings and the visit date, and carries the
// performer's signature and signature date. The note is an M8 encounter, validated through the injected
// signed-note reader; when linked, the separate ≥ 100-char narrative is not required.
//
// No IO: every fact is resolved by the caller and passed in.
import type { LocalDate } from "@wardenx/types";
import { AdmissionStateError, require_ } from "./errors";

/** The §3.2 `f2f_encounter_location` values. */
export const F2F_ENCOUNTER_LOCATIONS = [
  "patient_home",
  "alf",
  "snf",
  "ipu",
  "hospital",
  "telehealth",
] as const;
export type F2fEncounterLocation = (typeof F2F_ENCOUNTER_LOCATIONS)[number];

/**
 * Last encounter date on which a telehealth recertification F2F is permitted (§ 418.22(a)(4)(ii) "through
 * December 31, 2027"). The "or the end of a PHE, whichever is later" branch is NOT modelled — no PHE is in
 * effect; change this constant if one is declared.
 */
export const TELEHEALTH_F2F_ALLOWED_THROUGH: LocalDate = "2027-12-31" as LocalDate;

/** First encounter date the (A)–(C) telehealth exclusions apply to (CAA 2026 § 6209(f)(1)(B)). */
export const TELEHEALTH_F2F_EXCLUSIONS_FROM: LocalDate = "2026-01-31" as LocalDate;

/**
 * The completing clinician's attestation of the three § 418.22(a)(4)(ii)(A)–(C) facts. Each is answered
 * explicitly; there is no default.
 */
export interface TelehealthEligibilityAttestation {
  /** (A) the patient is located in an area subject to a hospice enrollment moratorium. */
  readonly patientInMoratoriumArea: boolean;
  /** (B) the hospice is subject to enhanced oversight under § 1866(j)(3). */
  readonly hospiceUnderEnhancedOversight: boolean;
  /** (C) the performer is Medicare-enrolled under § 1866(j) OR is an opt-out practitioner. */
  readonly performerMedicareEnrolledOrOptedOut: boolean;
}

/**
 * R-F2F-05 — validate the encounter modality. In-person locations always pass. Telehealth requires an
 * encounter on or before {@link TELEHEALTH_F2F_ALLOWED_THROUGH}; from {@link TELEHEALTH_F2F_EXCLUSIONS_FROM}
 * it also requires the (A)–(C) attestation with no disqualifying answer.
 */
export function checkF2fModality(input: {
  readonly encounterLocation: F2fEncounterLocation | null;
  readonly encounterDate: LocalDate;
  readonly telehealthEligibility: TelehealthEligibilityAttestation | null;
}): void {
  if (input.encounterLocation !== "telehealth") return;
  require_(
    input.encounterDate <= TELEHEALTH_F2F_ALLOWED_THROUGH,
    "F2F_TELEHEALTH_NOT_PERMITTED",
    `A telehealth recertification face-to-face is permitted only through ${TELEHEALTH_F2F_ALLOWED_THROUGH} (42 CFR 418.22(a)(4)(ii)); record an in-person encounter`,
  );
  if (input.encounterDate < TELEHEALTH_F2F_EXCLUSIONS_FROM) return;
  const e = input.telehealthEligibility;
  if (e === null) {
    throw new AdmissionStateError(
      "F2F_TELEHEALTH_ATTESTATION_REQUIRED",
      "A telehealth face-to-face requires the 42 CFR 418.22(a)(4)(ii)(A)-(C) eligibility attestation",
    );
  }
  require_(
    !e.patientInMoratoriumArea,
    "F2F_TELEHEALTH_NOT_PERMITTED",
    "Telehealth face-to-face is not permitted: the patient is in a hospice enrollment moratorium area (42 CFR 418.22(a)(4)(ii)(A))",
  );
  require_(
    !e.hospiceUnderEnhancedOversight,
    "F2F_TELEHEALTH_NOT_PERMITTED",
    "Telehealth face-to-face is not permitted: the hospice is subject to enhanced oversight (42 CFR 418.22(a)(4)(ii)(B))",
  );
  require_(
    e.performerMedicareEnrolledOrOptedOut,
    "F2F_TELEHEALTH_NOT_PERMITTED",
    "Telehealth face-to-face is not permitted: the performer is neither Medicare-enrolled nor an opt-out practitioner (42 CFR 418.22(a)(4)(ii)(C))",
  );
}

/** The facts the M8 signed-note reader returns for one encounter (no narrative, no PHI beyond ids). */
export interface SignedNoteFacts {
  readonly encounterId: string;
  readonly patientId: string;
  /** Org-local date the visit occurred (`encounter.service_date`). */
  readonly serviceDate: LocalDate;
  /** True when the note reached primary signature and is not voided. */
  readonly signed: boolean;
  /** The primary signature instant (`encounter.signed_at`), ISO; null when unsigned. */
  readonly signedAt: string | null;
  /** The M1 user who authored and signed the note; null when the author membership cannot be resolved. */
  readonly signerUserId: string | null;
}

/**
 * R-F2F-06 — a linked clinical note satisfies § 418.22(b)(4) only when it is the SAME patient's, is signed
 * (with a signature date), is signed by the F2F performer, and documents a visit on the F2F encounter date.
 * `note === null` means the reader found no such encounter in this org.
 */
export function checkF2fSignedNote(input: {
  readonly note: SignedNoteFacts | null;
  readonly patientId: string;
  readonly performerUserId: string;
  readonly encounterDate: LocalDate | null;
}): void {
  const { note } = input;
  if (note === null) {
    throw new AdmissionStateError(
      "F2F_ATTESTATION_NOTE_INVALID",
      "The linked clinical note was not found",
    );
  }
  require_(
    note.patientId === input.patientId,
    "F2F_ATTESTATION_NOTE_INVALID",
    "The linked clinical note belongs to a different patient",
  );
  require_(
    note.signed && note.signedAt !== null,
    "F2F_ATTESTATION_NOTE_INVALID",
    "The linked clinical note is not signed",
  );
  require_(
    note.signerUserId !== null && note.signerUserId === input.performerUserId,
    "F2F_ATTESTATION_NOTE_INVALID",
    "The linked clinical note was not signed by the face-to-face performer",
  );
  require_(
    input.encounterDate !== null && note.serviceDate === input.encounterDate,
    "F2F_ATTESTATION_NOTE_INVALID",
    "The linked clinical note's visit date does not match the face-to-face encounter date",
  );
}
