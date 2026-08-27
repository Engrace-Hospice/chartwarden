// apps/backend/src/modules/10-hope/validation/run-validation.ts — the CMS pre-submission validation
// runner (F-057; M10 spec §2.3, §3, line 89 "Validation re-runs on every signed assessment").
//
// This is the IO half the pure engine was written against and never got. `validateHopeAssessment`
// (@wardenx/hope) is a 268-line deterministic rule set with its own unit suite and, until now, NO
// production caller anywhere in the repo — so `hope_validation_finding` had exactly one writer (the D8
// missing-PPS warning in `signTimepoint`) and `GET /hope/assessments/:id/validation` returned an empty
// findings list for every assessment ever recorded. An assessment carrying none of its 17 CMS-required
// sections signed clean and the clinician's pre-submission panel said "No findings."
//
// Two facts are resolved here and handed to the pure engine as data (ADR-0005 D1/D2: M10 reaches M38
// only through the boot-registered seam, never a schema import — the structural projection below is the
// M12/M31 precedent for narrowing an opaque seam to the arms this module calls):
//   • MEMBERSHIP, per code actually present on the assessment, as of `target_date` — not "today". A
//     surveyor asks whether the code was valid on the visit date (`asOf` is in every M38 signature for
//     exactly this reason), and a code retired since would otherwise fail a historical record.
//   • AVAILABILITY, per value set. M38 ships `hospice_terminal_diagnosis` and `hope_j_codes` as
//     definitions with no curated members until the per-system loaders run, and `isMemberOf` cannot
//     distinguish "not a member" from "no members exist" — wiring the validator without this would have
//     turned rule 2 (an ERROR, and therefore a submission blocker) on for every assessment carrying a
//     terminal diagnosis. Probed by taking ONE member off the expansion, which is lazy: `expand` is an
//     AsyncIterable, so the loop breaks after the first row rather than materialising the set.
import {
  type HopeValidationFindingDescriptor,
  type HopeValueSetAvailability,
  projectHopeSections,
  validateHopeAssessment,
  valueSetOracle,
} from "@wardenx/hope";
import type { HopeDischargeReason, HopeRfaKind } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";

/** The M38 value sets M10 consumes (`PLATFORM_VALUE_SETS` ids). */
const HOSPICE_DX_VALUE_SET = "hospice_terminal_diagnosis";
const HOPE_J_CODE_VALUE_SET = "hope_j_codes";
/** The code system Section I's primary diagnosis is drawn from. */
const ICD10CM = "icd10cm";
/** Section J's symptom-impact item codes are HOPE instrument items, catalogued by M38 under LOINC. */
const HOPE_J_SYSTEM = "loinc";

/** The M10-side structural projection of M38's `TerminologyProvider` — the two arms this module calls.
 * The seam is `unknown` in the leaf `SeamContracts` (ADR-0005 D2), so it is narrowed at the call site. */
interface HopeTerminologyReader {
  expand(valueSetId: string, opts?: { asOf?: Date }): AsyncIterable<{ readonly code: string }>;
  isMemberOf(
    valueSetId: string,
    system: string,
    code: string,
    opts?: { asOf?: Date },
  ): Promise<{ readonly isMember: boolean }>;
}

/** The row facts the runner needs beside the payload (all already on `hope_assessment`). */
export interface HopeValidationSubject {
  readonly rfaKind: HopeRfaKind;
  readonly dischargeReason: HopeDischargeReason | null;
  /** The `data` jsonb exactly as stored — projected by `@wardenx/hope`, never trusted structurally. */
  readonly data: unknown;
  /** The assessment's `target_date` — the as-of instant for every M38 lookup. */
  readonly targetDate: Date;
  /** Sibling target dates for the HUV1/HUV2 cross-RFA temporal rules; omitted when unresolved. */
  readonly admissionTargetDate?: string | null;
  readonly huv1TargetDate?: string | null;
}

/** Resolve M38 through the seam, or `null` when it is unregistered / a deny-stub / throwing. */
function terminologyReader(): HopeTerminologyReader | null {
  try {
    const seam = getSeam("TerminologyProvider") as HopeTerminologyReader | undefined;
    return seam && typeof seam.isMemberOf === "function" && typeof seam.expand === "function"
      ? seam
      : null;
  } catch {
    return null;
  }
}

/** True when the value set yields at least one member as of `asOf`. Lazy — stops at the first row. */
async function valueSetHasMembers(
  reader: HopeTerminologyReader,
  valueSetId: string,
  asOf: Date,
): Promise<boolean> {
  try {
    for await (const _member of reader.expand(valueSetId, { asOf })) return true;
    return false;
  } catch {
    // An M38 outage is indistinguishable from an uncurated set from the validator's side, and both
    // mean the same thing to it: this check could not run. Fail toward "unavailable", never toward a
    // blocking error the clinician cannot resolve.
    return false;
  }
}

/** Membership for exactly the codes present, as of `asOf`. Unanswerable codes read as non-members —
 * safe only because the caller has already established the set IS available. */
async function membersOf(
  reader: HopeTerminologyReader,
  valueSetId: string,
  system: string,
  codes: readonly string[],
  asOf: Date,
): Promise<string[]> {
  const hits: string[] = [];
  for (const code of codes) {
    try {
      const res = await reader.isMemberOf(valueSetId, system, code, { asOf });
      if (res.isMember) hits.push(code);
    } catch {
      // Leave it out: a code M38 could not answer for is reported as not-in-the-set, which is the
      // conservative reading once the set itself is known to exist.
    }
  }
  return hits;
}

/**
 * Run the CMS HOPE pre-submission rule set over one assessment and return the findings to persist.
 *
 * `envelope` is deliberately `null`: rule 8 compares an iQIES ENVELOPE's CCN/MBI against the admission
 * and patient snapshots, and there is no envelope at capture time — nor any column storing
 * `ccn_at_election` or the election-time MBI. Passing two empty strings would satisfy the rule on every
 * assessment forever, which is the failure this whole change is about. The engine skips it instead, and
 * the submission assembler supplies a real envelope when that pipeline is wired (it is not: see the
 * `cron-workers.ts` header, which declares the submission queues unwired).
 */
export async function runHopeAssessmentValidation(
  subject: HopeValidationSubject,
): Promise<readonly HopeValidationFindingDescriptor[]> {
  const sections = projectHopeSections(subject.data);
  const asOf = subject.targetDate;
  const reader = terminologyReader();

  let available: HopeValueSetAvailability = { hospiceTerminalDiagnosis: false, hopeJCodes: false };
  let dxHits: string[] = [];
  let jHits: string[] = [];
  if (reader !== null) {
    const dxCode = sections.sectionI.primaryDiagnosisIcd10;
    const [dxAvailable, jAvailable] = await Promise.all([
      valueSetHasMembers(reader, HOSPICE_DX_VALUE_SET, asOf),
      valueSetHasMembers(reader, HOPE_J_CODE_VALUE_SET, asOf),
    ]);
    available = { hospiceTerminalDiagnosis: dxAvailable, hopeJCodes: jAvailable };
    if (dxAvailable && dxCode !== null) {
      dxHits = await membersOf(reader, HOSPICE_DX_VALUE_SET, ICD10CM, [dxCode], asOf);
    }
    if (jAvailable && sections.sectionJ.jCodes.length > 0) {
      jHits = await membersOf(
        reader,
        HOPE_J_CODE_VALUE_SET,
        HOPE_J_SYSTEM,
        sections.sectionJ.jCodes,
        asOf,
      );
    }
  }

  return validateHopeAssessment(
    {
      rfaKind: subject.rfaKind,
      dischargeReason: subject.dischargeReason,
      presentSections: sections.presentSections,
      sectionI: sections.sectionI,
      sectionJ: sections.sectionJ,
      sectionN: sections.sectionN,
      envelope: null,
      temporal: {
        targetDate: subject.targetDate.toISOString(),
        admissionTargetDate: subject.admissionTargetDate ?? null,
        huv1TargetDate: subject.huv1TargetDate ?? null,
      },
    },
    // The oracle carries ONLY the codes M38 confirmed, plus the availability flags — membership was
    // probed code-by-code, so set emptiness here means "none of these codes matched", never "no set".
    valueSetOracle({ hospiceTerminalDiagnoses: dxHits, hopeJCodes: jHits, available }),
  );
}
