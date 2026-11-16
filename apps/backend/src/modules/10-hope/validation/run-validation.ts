// apps/backend/src/modules/10-hope/validation/run-validation.ts — the CMS pre-submission validation
// runner (F-057; M10 spec §2.3, §3, line 89 "Validation re-runs on every signed assessment").
//
// This is the IO half the pure engine was written against and never got. `validateHopeAssessment`
// (@chartwarden/hope) is a 268-line deterministic rule set with its own unit suite and, until now, NO
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
} from "@chartwarden/hope";
import type { HopeDischargeReason, HopeRfaKind } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import { errorClassForLog, idForLog } from "../hope-log-id";

/** The M38 value sets M10 consumes (`PLATFORM_VALUE_SETS` ids). */
const HOSPICE_DX_VALUE_SET = "hospice_terminal_diagnosis";
const HOPE_J_CODE_VALUE_SET = "hope_j_codes";
/** The code system Section I's primary diagnosis is drawn from — unambiguous, so it is named here. */
const ICD10CM = "icd10cm";

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
  /** The `data` jsonb exactly as stored — projected by `@chartwarden/hope`, never trusted structurally. */
  readonly data: unknown;
  /** The assessment's `target_date` — the as-of instant for every M38 lookup. */
  readonly targetDate: Date;
  /** The assessment's id, for the log line a failed terminology check writes (an id only; omitted, the line says so). */
  readonly assessmentId?: string;
  /** Sibling target dates for the HUV1/HUV2 cross-RFA temporal rules; omitted when unresolved. */
  readonly admissionTargetDate?: string | null;
  readonly huv1TargetDate?: string | null;
}

/** Called once per failed M38 seam call, with what was being read (a value-set id, or the seam itself) and the error. */
type TerminologyFailureLog = (what: string, error: unknown) => void;

/**
 * A failed M38 call is not an answer, so the check it was for is reported "unavailable" (never a finding the clinician
 * cannot resolve), but it is not silent either: one error line per failed call, with the assessment id (when the caller
 * supplied it), the value-set id and the error CLASS only (a seam message can carry values, so it is never logged).
 */
function terminologyFailureLogger(assessmentId: string | undefined): TerminologyFailureLog {
  const subject =
    assessmentId === undefined ? "an assessment" : `assessment ${idForLog(assessmentId)}`;
  return (what, error) =>
    console.error(
      `m10: pre-submission validation of ${subject}: the M38 terminology read for ${what} failed (${errorClassForLog(error)}); the check it feeds is reported unavailable.`,
    );
}

/** Resolve M38 through the seam, or `null` when it is unregistered / a deny-stub / throwing. */
function terminologyReader(logFailure: TerminologyFailureLog): HopeTerminologyReader | null {
  try {
    const seam = getSeam("TerminologyProvider") as HopeTerminologyReader | undefined;
    return seam && typeof seam.isMemberOf === "function" && typeof seam.expand === "function"
      ? seam
      : null;
  } catch (error) {
    logFailure("the TerminologyProvider seam", error);
    return null;
  }
}

/** True when the value set yields at least one member as of `asOf`. Lazy — stops at the first row. */
async function valueSetHasMembers(
  reader: HopeTerminologyReader,
  valueSetId: string,
  asOf: Date,
  logFailure: TerminologyFailureLog,
): Promise<boolean> {
  try {
    for await (const _member of reader.expand(valueSetId, { asOf })) return true;
    return false;
  } catch (error) {
    // An M38 outage is indistinguishable from an uncurated set from the validator's side, and both
    // mean the same thing to it: this check could not run. Fail toward "unavailable", never toward a
    // blocking error the clinician cannot resolve.
    logFailure(`value set ${valueSetId}`, error);
    return false;
  }
}

/**
 * The whole membership of a SMALL value set as of `asOf`, or `null` when it cannot be read.
 *
 * Used for `hope_j_codes` (three items) and NOT for `hospice_terminal_diagnosis`, which is ICD-10-CM
 * and potentially enormous — expanding it to check one diagnosis would be absurd, so that one probes
 * per code with `isMemberOf`. The asymmetry is deliberate and the reason is size, not semantics.
 *
 * Expanding also removes a GUESS this function used to make: `isMemberOf` takes a code SYSTEM, and
 * before F-059 that argument was the literal `"loinc"` — an invention, since CMS HOPE items are not
 * LOINC codes. The set knows its own members' systems; asking it what they are beats asserting one.
 * It is also exactly what the oracle's contract asks of this layer ("resolves both sets … and adapts
 * them to this synchronous shape"), so availability and membership now come from ONE pass and cannot
 * disagree about whether the set exists.
 */
async function expandAll(
  reader: HopeTerminologyReader,
  valueSetId: string,
  asOf: Date,
  logFailure: TerminologyFailureLog,
): Promise<string[] | null> {
  try {
    const codes: string[] = [];
    for await (const member of reader.expand(valueSetId, { asOf })) codes.push(member.code);
    return codes;
  } catch (error) {
    logFailure(`value set ${valueSetId}`, error);
    return null;
  }
}

/**
 * Membership for exactly the codes present, as of `asOf`, or `null` when M38 could not answer for one of them. A code
 * M38 could not answer for must NOT read as "not a member": the set is known to exist, so that reading would raise an
 * error-severity finding (a submission blocker) the clinician cannot resolve, for an outage. The caller marks the set
 * unavailable on `null`, the same rule {@link valueSetHasMembers} follows. Stops at the first failure (it would only be
 * repeated, and logged, once per remaining code).
 */
async function membersOf(
  reader: HopeTerminologyReader,
  valueSetId: string,
  system: string,
  codes: readonly string[],
  asOf: Date,
  logFailure: TerminologyFailureLog,
): Promise<string[] | null> {
  const hits: string[] = [];
  for (const code of codes) {
    try {
      const res = await reader.isMemberOf(valueSetId, system, code, { asOf });
      if (res.isMember) hits.push(code);
    } catch (error) {
      logFailure(`value set ${valueSetId}`, error);
      return null;
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
  const logFailure = terminologyFailureLogger(subject.assessmentId);
  const reader = terminologyReader(logFailure);

  let available: HopeValueSetAvailability = { hospiceTerminalDiagnosis: false, hopeJCodes: false };
  let dxHits: string[] = [];
  let jCodes: string[] = [];
  if (reader !== null) {
    const dxCode = sections.sectionI.primaryDiagnosisIcd10;
    const [dxAvailable, jMembers] = await Promise.all([
      valueSetHasMembers(reader, HOSPICE_DX_VALUE_SET, asOf, logFailure),
      expandAll(reader, HOPE_J_CODE_VALUE_SET, asOf, logFailure),
    ]);
    // `null` = M38 could not answer the per-code probe: the diagnosis check is unavailable, not "no match".
    const dxProbe =
      dxAvailable && dxCode !== null
        ? await membersOf(reader, HOSPICE_DX_VALUE_SET, ICD10CM, [dxCode], asOf, logFailure)
        : [];
    // An unreadable set and an EMPTY one are the same answer here — neither can tell us whether an
    // item is a member — so both leave `hopeJCodes` unavailable and the rule records that it could
    // not run rather than warning about every item on the assessment.
    jCodes = jMembers ?? [];
    dxHits = dxProbe ?? [];
    available = {
      hospiceTerminalDiagnosis: dxAvailable && dxProbe !== null,
      hopeJCodes: jCodes.length > 0,
    };
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
    // Section I carries ONLY the codes M38 confirmed (probed per code, so emptiness means "this
    // diagnosis did not match", never "no set" — which is why `available` is passed explicitly).
    // Section J carries the set's FULL membership, so the oracle answers from the real roster.
    valueSetOracle({ hospiceTerminalDiagnoses: dxHits, hopeJCodes: jCodes, available }),
  );
}
