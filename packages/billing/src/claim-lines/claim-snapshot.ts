// @chartwarden/billing — the claim's assembly-time SNAPSHOT of the physicians' names and the diagnosis sequence
// (migration 1068), so a claim already sent does not change when the physician master data or the problem list
// does. The snapshot FOLLOWS the NPIs until submission: assembly and every re-validation write NPIs, names and
// diagnoses together (`ClaimRepository.refreshSnapshot`), so a name never belongs to a different physician than the
// NPI beside it; from SUBMITTED onward the database freezes it. The NPIs have their own columns (`physician-npis.ts`); the names follow the SAME rule (the certifying
// physician only when it differs from the attending), and a name is only kept alongside the NPI it belongs to.
// PURE.
import type { Icd10Pointer, MdmResolution, PhysicianResolution } from "../rules/types";
import { claimPhysicianNpis } from "./physician-npis";

/** ABK = principal diagnosis, ABF = other diagnosis (the 837I HI qualifiers). */
export type ClaimDiagnosisQualifier = "ABK" | "ABF";

/** One diagnosis as it stood when the claim was assembled. `presentOnAdmission` is omitted: M7 does not carry it. */
export interface ClaimDiagnosisSnapshotEntry {
  readonly icd10Code: string;
  /** The X12 diagnosis-pointer position (1..12) the claim lines point at. */
  readonly sequence: number;
  readonly qualifier: ClaimDiagnosisQualifier;
}

export interface ClaimPhysicianNames {
  readonly attendingPhysicianFirstName: string | null;
  readonly attendingPhysicianLastName: string | null;
  readonly certifyingPhysicianFirstName: string | null;
  readonly certifyingPhysicianLastName: string | null;
}

/** Everything the snapshot columns of a claim hold. */
export interface ClaimAssemblySnapshot extends ClaimPhysicianNames {
  readonly diagnosisSnapshot: ClaimDiagnosisSnapshotEntry[];
}

/** Matches `claim_physician_name_len_chk` (migration 1068); M40 name text is unbounded, so clip rather than fail the claim. */
const MAX_NAME_LENGTH = 100;

const trimmed = (value: string | undefined): string | null => {
  const t = value?.trim().slice(0, MAX_NAME_LENGTH).trim();
  return t ? t : null;
};

/** Both parts or neither: half a name is never stored. */
function nameOf(p: PhysicianResolution | null): readonly [string | null, string | null] {
  const first = trimmed(p?.firstName);
  const last = trimmed(p?.lastName);
  return first !== null && last !== null ? [first, last] : [null, null];
}

/**
 * The attending / certifying physician names, kept only for the physician whose NPI the claim carries (so the
 * certifying name is null exactly when `certifyingPhysicianNpi` is: absent, malformed, or equal to the attending).
 */
export function claimPhysicianNames(mdm: MdmResolution): ClaimPhysicianNames {
  const npis = claimPhysicianNpis(mdm);
  const [attFirst, attLast] =
    npis.attendingPhysicianNpi !== null ? nameOf(mdm.attending) : [null, null];
  const [certFirst, certLast] =
    npis.certifyingPhysicianNpi !== null ? nameOf(mdm.hospicePhysician) : [null, null];
  return {
    attendingPhysicianFirstName: attFirst,
    attendingPhysicianLastName: attLast,
    certifyingPhysicianFirstName: certFirst,
    certifyingPhysicianLastName: certLast,
  };
}

/**
 * The diagnosis sequence as stored: ordered by position, the first terminal-illness diagnosis is the principal
 * (ABK), every other one is ABF. With no terminal diagnosis there is no principal (all ABF) — the snapshot records
 * what M7 supplied rather than inventing one; the `icd10_sequencing` rule reports the gap.
 */
export function claimDiagnosisSnapshot(
  sequence: readonly Icd10Pointer[],
): ClaimDiagnosisSnapshotEntry[] {
  const ordered = [...sequence].sort((a, b) => a.position - b.position);
  const principal = ordered.find((d) => d.relationship === "terminal");
  return ordered.map((d) => ({
    icd10Code: d.code,
    sequence: d.position,
    qualifier: d === principal ? "ABK" : "ABF",
  }));
}

/** The full snapshot an assembly writes. */
export function buildClaimSnapshot(
  mdm: MdmResolution,
  sequence: readonly Icd10Pointer[],
): ClaimAssemblySnapshot {
  return { ...claimPhysicianNames(mdm), diagnosisSnapshot: claimDiagnosisSnapshot(sequence) };
}
