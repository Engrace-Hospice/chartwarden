// apps/backend/src/modules/23-billing-medicare/services/place-of-service-resolver.ts — F-213 (#252, #251):
// `mdm.resolveClinicalParticipants().placeOfService`, bound to a REAL producer instead of a hard `null`.
//
// THE PRODUCER (verified against the code, not assumed). F-127's "no place-of-service producer exists" was
// only half right. `patient_address.kind` alone (`home|facility|mailing|temporary|prior`) still carries no
// facility taxonomy, but a `facility`-kind address carries `facility_id` -> M40's `facility.kind`, and migration
// 0183 (`facility_kind` = hospital|alf|snf|nf|ipu|ltch|psych|clinic|other, explicitly "the full 9-value CMS
// hospice Q5001-Q5009 place-of-service space") IS the taxonomy. M5's `PatientAddressReader` is the effective-
// dated seam over the address history (owned by M5, NOT M24 - M24 is merely its first consumer:
// `write-service-drizzle.ts`). This module therefore binds two structural ports (injected by `index.ts`, the
// F-121/F-122 posture - M23 imports neither M5 nor M40): M5 `residencesBetween` and an M40 facility-kind read.
//
// THE MAPPING (target = `POS_BY_QCODE`, the single authoritative Q5001-Q5010 table, F-125; the label emitted
// is `POS_BY_QCODE[qcode]`, which `claim-assembly.ts` inverts back to the Q-code):
//   address kind `home`            -> Q5001 home
//   facility kind `alf`            -> Q5002 alf
//   facility kind `nf`             -> Q5003 ltc (nursing / long-term-care facility)
//   facility kind `snf`            -> Q5004 snf
//   facility kind `hospital`       -> Q5005 hospital
//   facility kind `ipu`            -> Q5006 ipu (inpatient hospice facility)
//   facility kind `ltch`           -> Q5007 ltch
//   facility kind `psych`          -> Q5008 psych
//   facility kind `clinic`|`other` -> NULL (a clinic is not a place a hospice patient resides; `other` is
//                                     by definition unspecific) -> the line honestly falls to Q5009
//   address kind mailing|temporary|prior, a facility address with no/unknown facility -> NULL
//   Q5010 (hospice residential) has no facility kind -> never derived.
//
// WHEN THE RESIDENCE IS NOT THE SITE OF CARE (the F-102/F-127 lesson - do not answer a question the data
// cannot). A residence is where routine/continuous care (RHC/CHC) is delivered. General inpatient / inpatient
// respite (GIP/IRC) is delivered in an inpatient bed (the LOC period's own facility / M37 IPU bed) that a
// home address says nothing about - labelling a GIP day "home" would be a confident WRONG Q-code. M6's claim
// range read does not carry the LOC period's facility, so if ANY level-of-care period overlapping the claim
// range is not RHC/CHC (or none is found) the result is NULL. Follow-up: extend the M6 range read with
// `facility_id`/`ipu_bed_assignment_id` (as M24's `LevelOfCarePeriodReaderPort` already does) to resolve GIP/IRC.
//
// A RANGE THAT SPANS A MOVE. `assemble()` emits ONE claim-level placeOfService (all lines share a Q-code, and
// `place_of_service_consistency` compares every line to one documented value), so a range whose residence
// resolves to two DIFFERENT Q-codes - or is not covered end to end by primary address history - cannot be
// answered honestly: NULL (Q5009). Splitting lines at the move date is the proper fix and is out of scope.
import { POS_BY_QCODE } from "@chartwarden/billing";

import type { DateRange } from "./claim-assembly";

/** M40 `facility.kind` mirrored structurally (no cross-module import; matches `packages/db/src/enums.ts`). */
export type M23FacilityKind =
  | "hospital"
  | "alf"
  | "snf"
  | "nf"
  | "ipu"
  | "ltch"
  | "psych"
  | "clinic"
  | "other";

/** M5 `PatientAddressReader.residencesBetween` row, structurally (kind + facility + window only). */
export interface M23ResidenceSpan {
  readonly kind: "home" | "facility" | "mailing" | "temporary" | "prior";
  readonly facilityId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface M5ResidenceRangeReader {
  residencesBetween(
    orgId: string,
    patientId: string,
    from: string,
    to: string,
  ): Promise<readonly M23ResidenceSpan[]>;
}

export interface M40FacilityKindReader {
  /** Merge-resolved (`merged_into_id` chased) `facility.kind`, keyed by the REQUESTED id; unknown ids absent. */
  kindsFor(facilityIds: readonly string[]): Promise<ReadonlyMap<string, M23FacilityKind>>;
}

/** The two injected ports; both required together (a residence without its facility kind is not a site). */
export interface PlaceOfServicePorts {
  readonly residence: M5ResidenceRangeReader;
  readonly facilityKinds: M40FacilityKindReader;
}

/** Facility kind -> CMS Q-code. `clinic`/`other` deliberately absent (see header). */
export const QCODE_BY_FACILITY_KIND: Readonly<Partial<Record<M23FacilityKind, string>>> = {
  alf: "Q5002",
  nf: "Q5003",
  snf: "Q5004",
  hospital: "Q5005",
  ipu: "Q5006",
  ltch: "Q5007",
  psych: "Q5008",
};

/** Address kind `home` -> Q5001. */
const HOME_QCODE = "Q5001";

/** Levels of care (M6 `level_of_care` enum values) whose site of care IS the patient's residence. */
const RESIDENCE_LEVELS_OF_CARE: ReadonlySet<string> = new Set([
  "routine_home_care",
  "continuous_home_care",
]);

function residenceIsSiteOfCare(levelsOfCare: readonly string[]): boolean {
  return levelsOfCare.length > 0 && levelsOfCare.every((l) => RESIDENCE_LEVELS_OF_CARE.has(l));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Q-code -> the `POS_BY_QCODE` label `claim-assembly.ts` understands; null if the table lacks it. */
function labelFor(qcode: string | undefined): string | null {
  if (qcode === undefined) return null;
  return POS_BY_QCODE[qcode] ?? null;
}

/**
 * PURE. The single `POS_BY_QCODE` label for a claim range, or null when it cannot be stated honestly.
 * `kindByFacilityId` is the merge-resolved facility-kind lookup for every facility id in `spans`.
 */
export function resolvePlaceOfServiceLabel(
  range: DateRange,
  levelsOfCare: readonly string[],
  spans: readonly M23ResidenceSpan[],
  kindByFacilityId: ReadonlyMap<string, M23FacilityKind>,
): string | null {
  if (!residenceIsSiteOfCare(levelsOfCare)) return null;
  if (spans.length === 0) return null;
  const ordered = [...spans].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  // Coverage: the primary-address history must cover [from, to] with no gap (overlap is tolerated: the
  // append-only history may share a boundary day, and overlapping DIFFERENT sites fail the equality below).
  const first = ordered[0];
  if (first === undefined || first.effectiveFrom > range.from) return null;
  let coveredThrough: string | null = first.effectiveTo;
  for (const s of ordered.slice(1)) {
    if (coveredThrough === null) break;
    if (s.effectiveFrom > addDays(coveredThrough, 1)) return null;
    if (s.effectiveTo === null || s.effectiveTo > coveredThrough) coveredThrough = s.effectiveTo;
  }
  if (coveredThrough !== null && coveredThrough < range.to) return null;

  const labels = new Set<string | null>();
  for (const s of ordered) {
    if (s.kind === "home") {
      labels.add(labelFor(HOME_QCODE));
    } else if (s.kind === "facility" && s.facilityId !== null) {
      const kind = kindByFacilityId.get(s.facilityId);
      labels.add(kind === undefined ? null : labelFor(QCODE_BY_FACILITY_KIND[kind]));
    } else {
      labels.add(null); // mailing / temporary / prior / facility address without a facility
    }
  }
  if (labels.size !== 1) return null; // spans a move between different sites, or any unmapped span
  return [...labels][0] ?? null;
}

/**
 * Read + resolve. `levelsOfCare` are the levels of the M6 LOC periods overlapping the range (already read by
 * the caller over the existing `m6ClaimRange` port). Never throws for "no data" - that is null.
 */
export async function resolvePlaceOfService(
  ports: PlaceOfServicePorts,
  orgId: string,
  patientId: string,
  range: DateRange,
  levelsOfCare: readonly string[],
): Promise<string | null> {
  if (!residenceIsSiteOfCare(levelsOfCare)) return null; // skip both reads: residence would not answer
  const spans = await ports.residence.residencesBetween(orgId, patientId, range.from, range.to);
  const facilityIds = [
    ...new Set(spans.flatMap((s) => (s.kind === "facility" && s.facilityId ? [s.facilityId] : []))),
  ];
  const kinds =
    facilityIds.length > 0
      ? await ports.facilityKinds.kindsFor(facilityIds)
      : new Map<string, M23FacilityKind>();
  return resolvePlaceOfServiceLabel(range, levelsOfCare, spans, kinds);
}
