// apps/web/src/modules/09-assessments/wounds — the plain-language label for every wound code, in one place.
//
// The web app does not depend on @chartwarden/assessments, so the vocabulary is held here as typed records: a
// `Record<Code, string>` over the generated client's own union fails to compile when the server adds or renames a
// code, and `wound-labels.test.ts` (run from the repo root, where the package resolves) fails when the ORDER, the
// site list or a site's sides drift from `packages/assessments/src/wounds`.
import type {
  CorrectionReason,
  ExudateAmount,
  ExudateType,
  PeriwoundCondition,
  PressureStage,
  WoundAcquired,
  WoundBedTissue,
  WoundDressing,
  WoundEtiology,
  WoundLaterality,
  WoundOdor,
  WoundResolution,
  WoundSiteCode,
  WoundStatus,
  WoundTrend,
} from "./wounds-api";

export interface LabelOption<C extends string> {
  readonly value: C;
  readonly label: string;
}

/** The labels as select options, in the order the records below are written (the server's value-set order). */
export function optionsOf<C extends string>(labels: Readonly<Record<C, string>>): LabelOption<C>[] {
  return (Object.keys(labels) as C[]).map((value) => ({ value, label: labels[value] }));
}

export const ETIOLOGY_LABELS: Readonly<Record<WoundEtiology, string>> = {
  pressure_injury: "Pressure injury",
  diabetic_ulcer: "Diabetic ulcer",
  venous_ulcer: "Venous ulcer",
  arterial_ulcer: "Arterial ulcer",
  surgical: "Surgical wound",
  traumatic: "Traumatic wound",
  skin_tear: "Skin tear",
  malignant_fungating: "Malignant (fungating) wound",
  moisture_associated: "Moisture-associated skin damage",
  other: "Other",
};

export const STAGE_LABELS: Readonly<Record<PressureStage, string>> = {
  stage_1: "Stage 1",
  stage_2: "Stage 2",
  stage_3: "Stage 3",
  stage_4: "Stage 4",
  unstageable: "Unstageable",
  deep_tissue_injury: "Deep tissue injury",
};

export const WOUND_BED_LABELS: Readonly<Record<WoundBedTissue, string>> = {
  granulation: "Granulation",
  slough: "Slough",
  eschar: "Eschar",
  epithelializing: "Epithelializing",
  necrotic: "Necrotic",
  hypergranulation: "Hypergranulation",
  bone_or_tendon_exposed: "Bone or tendon exposed",
};

export const EXUDATE_AMOUNT_LABELS: Readonly<Record<ExudateAmount, string>> = {
  none: "None",
  scant: "Scant",
  small: "Small",
  moderate: "Moderate",
  large: "Large",
};

export const EXUDATE_TYPE_LABELS: Readonly<Record<ExudateType, string>> = {
  serous: "Serous",
  serosanguineous: "Serosanguineous",
  sanguineous: "Sanguineous",
  purulent: "Purulent",
};

export const ODOR_LABELS: Readonly<Record<WoundOdor, string>> = {
  none: "None",
  mild: "Mild",
  moderate: "Moderate",
  strong: "Strong",
};

export const PERIWOUND_LABELS: Readonly<Record<PeriwoundCondition, string>> = {
  intact: "Intact",
  erythema: "Erythema (redness)",
  macerated: "Macerated",
  indurated: "Indurated (hardened)",
  edematous: "Edematous (swollen)",
  warm: "Warm to the touch",
  excoriated: "Excoriated",
};

export const DRESSING_LABELS: Readonly<Record<WoundDressing, string>> = {
  foam: "Foam",
  hydrocolloid: "Hydrocolloid",
  alginate: "Alginate",
  hydrogel: "Hydrogel",
  gauze: "Gauze",
  silver: "Silver",
  transparent_film: "Transparent film",
  negative_pressure: "Negative pressure",
  other: "Other",
};

export const TREND_LABELS: Readonly<Record<WoundTrend, string>> = {
  new: "New",
  improving: "Improving",
  stable: "Stable",
  worsening: "Worsening",
};

export const LATERALITY_LABELS: Readonly<Record<WoundLaterality, string>> = {
  left: "Left",
  right: "Right",
  midline: "Midline",
  bilateral: "Both sides",
  not_applicable: "Not applicable",
};

export const ACQUIRED_LABELS: Readonly<Record<WoundAcquired, string>> = {
  present_on_admission: "Present on admission",
  acquired_in_care: "Acquired in our care",
  unknown: "Not known",
};

export const STATUS_LABELS: Readonly<Record<WoundStatus, string>> = {
  open: "Open",
  healed: "Healed",
  resolved_other: "Resolved (another reason)",
};

export const RESOLUTION_LABELS: Readonly<Record<WoundResolution, string>> = {
  healed: "Healed",
  resolved_other: "Resolved for another reason",
};

export const CORRECTION_REASON_LABELS: Readonly<Record<CorrectionReason, string>> = {
  entered_on_wrong_wound: "Entered on the wrong wound",
  measurement_error: "Measurement error",
  assessment_error: "Assessment error",
  wrong_visit: "Entered at the wrong visit",
  other: "Another reason",
};

// ── the anatomical site vocabulary (mirrors packages/assessments/src/wounds/sites.ts) ───────────────────────────

export type WoundSiteSides = "paired" | "midline" | "any";

export interface WoundSiteDef {
  readonly code: WoundSiteCode;
  /** Singular, lower case, for a sentence ("left heel"). */
  readonly label: string;
  /** Plural, for a bilateral wound ("bilateral heels"). */
  readonly plural: string;
  readonly sides: WoundSiteSides;
}

const paired = (code: WoundSiteCode, label: string, plural = `${label}s`): WoundSiteDef => ({
  code,
  label,
  plural,
  sides: "paired",
});
const midline = (code: WoundSiteCode, label: string): WoundSiteDef => ({
  code,
  label,
  plural: label,
  sides: "midline",
});

export const WOUND_SITES: readonly WoundSiteDef[] = [
  midline("sacrum", "sacrum"),
  midline("coccyx", "coccyx"),
  paired("ischium", "ischium", "ischia"),
  paired("trochanter", "trochanter"),
  paired("buttock", "buttock"),
  paired("hip", "hip"),
  midline("sacral_perineal", "sacral/perineal area"),
  midline("spine", "spine"),
  midline("back", "back"),
  paired("scapula", "scapula", "scapulae"),
  paired("shoulder", "shoulder"),
  paired("elbow", "elbow"),
  paired("arm", "arm"),
  paired("hand", "hand"),
  midline("chest", "chest"),
  midline("abdomen", "abdomen"),
  paired("groin", "groin"),
  paired("thigh", "thigh"),
  paired("knee", "knee"),
  paired("calf_shin", "calf"),
  paired("ankle", "ankle"),
  paired("malleolus", "malleolus", "malleoli"),
  paired("heel", "heel"),
  paired("foot", "foot", "feet"),
  paired("toe", "toe"),
  paired("ear", "ear"),
  midline("head", "head"),
  midline("face", "face"),
  midline("neck", "neck"),
  { code: "other", label: "other site", plural: "other sites", sides: "any" },
];

const LATERALITIES_BY_SIDES: Readonly<Record<WoundSiteSides, readonly WoundLaterality[]>> = {
  paired: ["left", "right", "bilateral"],
  midline: ["midline", "not_applicable"],
  any: ["left", "right", "midline", "bilateral", "not_applicable"],
};

const SITE_BY_CODE: ReadonlyMap<string, WoundSiteDef> = new Map(
  WOUND_SITES.map((s) => [s.code, s]),
);

/** The sides a site accepts, in the server's order. A site the list does not name accepts none. */
export function lateralitiesFor(siteCode: WoundSiteCode): readonly WoundLaterality[] {
  const site = SITE_BY_CODE.get(siteCode);
  return site ? LATERALITIES_BY_SIDES[site.sides] : [];
}

/** True when `laterality` is one the site accepts (a left sacrum, or a midline heel, is a data-entry mistake). */
export function lateralityFitsSite(siteCode: WoundSiteCode, laterality: WoundLaterality): boolean {
  return lateralitiesFor(siteCode).includes(laterality);
}

/** The display phrase for a wound's location, as `siteLabel` in the package builds it: "left heel", "bilateral heels". */
export function siteLabel(siteCode: string, laterality: WoundLaterality): string {
  const site = SITE_BY_CODE.get(siteCode) ?? SITE_BY_CODE.get("other");
  const label = site?.label ?? "other site";
  if (laterality === "left" || laterality === "right") return `${laterality} ${label}`;
  if (laterality === "bilateral") return `bilateral ${site?.plural ?? label}`;
  return label;
}

/** `siteLabel` for a heading or a table cell: the first letter in capitals ("Left heel"). */
export function siteHeading(siteCode: string, laterality: WoundLaterality): string {
  const phrase = siteLabel(siteCode, laterality);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
}
