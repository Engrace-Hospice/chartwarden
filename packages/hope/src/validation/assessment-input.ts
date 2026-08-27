// @wardenx/hope — the `hope_assessment.data` → validator-input projection (F-057; §2.1, §2.3).
// PURE, IO-free. The CMS pre-submission validator (`validate-hope-assessment.ts`) consumes TYPED
// per-section projections (`SectionIInput` / `SectionJInput` / `SectionNInput` + the present-section
// list); the column it must read is one opaque `jsonb`. Nothing bridged the two, which is the mechanical
// reason the validator had no caller: the M10 spec's `validation/findings-writer.ts` — the file that was
// meant to hold this — was never written, and the engine sat fully unit-tested with no way to reach a
// real row. This module is that bridge and, by being it, is also the PAYLOAD CONTRACT for the four
// sections the rule set actually reads.
//
// The contract follows the CMS HOPE item numbering the spec already uses for the one section that was
// typed: `data.J.J2051.entries[]` predates this file, so `data.J.J2030` / `data.J.J2050` are named the
// same way, and Section I reuses the platform-wide `primaryDiagnosisIcd10` spelling M6's referral intake
// established. Everything else in `data` stays opaque — the route-boundary TypeBox types these four and
// carries the rest through (`additionalProperties: true`), exactly as it did before.
//
// Every reader is TOLERANT of absence and shape: a section that is missing, null, or the wrong type
// reads as "not documented", never as a throw. That is deliberate — the payload is clinician-entered
// jsonb that predates this contract, and a projection that threw on an old row would turn a validation
// report into a 500. "Not documented" is a finding, which is the whole point.
import { HOPE_SECTION_LETTERS, type HopeSectionLetter } from "../sections/required-items";
import type { SectionIInput, SectionJInput, SectionNInput } from "./validate-hope-assessment";

/** The four projections + the present-section list the validator needs from one `data` payload. */
export interface HopeSectionProjection {
  readonly presentSections: readonly HopeSectionLetter[];
  readonly sectionI: SectionIInput;
  readonly sectionJ: SectionJInput;
  readonly sectionN: SectionNInput;
}

type Bag = Record<string, unknown>;

/** `value` as a plain object, or null for anything else (arrays included — a section is never an array). */
function obj(value: unknown): Bag | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Bag)
    : null;
}

/** A trimmed non-empty string, else null. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * A CMS Yes/No item read as "Yes". Accepts the three spellings a payload realistically carries — the
 * boolean `true`, the string `"yes"` (case-insensitively), and the CMS coded `"1"` — and reads anything
 * else, absence included, as not-Yes. Only "Yes" arms a cross-field rule, so an unrecognised value
 * fails toward silence rather than toward a finding the clinician cannot act on.
 */
function isYes(value: unknown): boolean {
  if (value === true) return true;
  const s = str(value)?.toLowerCase();
  return s === "yes" || s === "y" || s === "1";
}

/**
 * "Something was documented here." True for a non-blank string, a non-empty array, a non-empty object,
 * or boolean `true`. False for absence, null, `false`, `""`, `[]`, and `{}` — an empty container is the
 * shape a half-filled form produces, and treating it as documented would satisfy the exact cross-field
 * rule (J2030/J2050 characteristics) that exists to catch a half-filled form.
 */
function documented(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  const o = obj(value);
  return o !== null && Object.keys(o).length > 0;
}

const SECTION_SET = new Set<string>(HOPE_SECTION_LETTERS);

/**
 * §2.1 — the Section letters this payload actually CARRIES, in the canonical A→Z roster order so the
 * required-items diff is deterministic. A key is a present section only when it is a recognised letter
 * AND something is documented under it: `{ "J": {} }` is a tab the clinician opened and left empty, and
 * the CMS required-items rule is asking whether the section was completed, not whether a key exists.
 * Unrecognised keys (CMS-unused letters, client scratch) are ignored rather than rejected.
 */
export function presentSectionsOf(data: unknown): readonly HopeSectionLetter[] {
  const bag = obj(data);
  if (bag === null) return [];
  return HOPE_SECTION_LETTERS.filter(
    (letter) => SECTION_SET.has(letter) && documented(bag[letter]),
  );
}

/** §2.1 Section I (Active Diagnoses) — the hospice terminal ICD-10-CM primary diagnosis, or null. */
export function sectionIOf(data: unknown): SectionIInput {
  const i = obj(obj(data)?.I);
  return { primaryDiagnosisIcd10: i === null ? null : str(i.primaryDiagnosisIcd10) };
}

/** A CMS HOPE Section-J item identifier: the letter J followed by digits (J2030, J2050, J2051 …). */
const J_ITEM_KEY = /^J\d+$/;

/**
 * §2.1 Section J (Health Conditions) — the pain (J2030) / dyspnea (J2050) screens with their
 * characteristics, and the J ITEMS the payload carries.
 *
 * `jCodes` is the set of Section-J ITEM IDENTIFIERS present in `data.J` — the instrument's questions —
 * NOT the per-symptom severities recorded under J2051, which are its answers (F-059).
 *
 * This distinction is the whole point of the rule those codes feed. §86 checks membership in M38's
 * `hope_j_codes` value set, whose own definition reads "J2030, J2050, J2051 plus related", and whose
 * rule comment says transposed codes are corrected against it — you transpose digits in an item number
 * (J2050 → J2005), not letters in a symptom name. Feeding it the J2051 symptom codes instead, as this
 * function first did, made the rule structurally incapable of failing: `symptomCode` is closed to the
 * eight `HOPE_J2051_SYMPTOM_CODES` at M10's route boundary, so every value reaching storage is already
 * a member of a WardenX-internal vocabulary, and re-checking it asynchronously against a terminology
 * service was a weaker second copy of a check the boundary already makes absolutely.
 *
 * Duplicates are impossible (object keys), and a payload carrying an item the CMS roster does not
 * recognise — a transposed number, or one decommissioned by an annual update — is what now warns.
 */
export function sectionJOf(data: unknown): SectionJInput {
  const j = obj(obj(data)?.J);
  const j2030 = obj(j?.J2030);
  const j2050 = obj(j?.J2050);
  const jCodes =
    j === null ? [] : Object.keys(j).filter((key) => J_ITEM_KEY.test(key) && documented(j[key]));
  return {
    painScreenedYes: isYes(j2030?.screened),
    painCharacteristicsPresent: documented(j2030?.characteristics),
    dyspneaScreenedYes: isYes(j2050?.screened),
    dyspneaCharacteristicsPresent: documented(j2050?.characteristics),
    jCodes,
  };
}

/** §2.1 Section N (Medications) — the opioid / bowel-regimen triple the §2.3 advisory rule reads. */
export function sectionNOf(data: unknown): SectionNInput {
  const n = obj(obj(data)?.N);
  return {
    opioidPrescribed: isYes(n?.opioidPrescribed),
    scheduledBowelRegimenPresent: isYes(n?.scheduledBowelRegimen),
    bowelRegimenContraindicationDocumented: documented(n?.bowelRegimenContraindication),
  };
}

/** Project one `hope_assessment.data` payload into every input the validator reads from it. */
export function projectHopeSections(data: unknown): HopeSectionProjection {
  return {
    presentSections: presentSectionsOf(data),
    sectionI: sectionIOf(data),
    sectionJ: sectionJOf(data),
    sectionN: sectionNOf(data),
  };
}
