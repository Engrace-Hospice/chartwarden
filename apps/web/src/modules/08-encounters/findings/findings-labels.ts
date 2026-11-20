// apps/web/src/modules/08-encounters/findings — the value sets of the visit findings (ADLs, nutrition) and the plain-language label of
// every code, in one place.
//
// The value sets are the contract between the capture routes, the stored rows and the sentence the note states, and their source is
// `packages/hearthnote/src/assembly/types.ts`. @chartwarden/hearthnote is not a dependency of this app (the browser must not carry the
// narrative engine), so they are copied here and `findings-labels.test.ts` fails the moment either side moves. Each label table is a
// `Record` over its value set, so a value added here without a label does not compile.

export const ADL_ITEMS = [
  "bathing",
  "dressing",
  "grooming",
  "toileting",
  "transferring",
  "ambulation",
  "eating",
] as const;
export type AdlItem = (typeof ADL_ITEMS)[number];

export const ADL_LEVELS = [
  "independent",
  "supervision",
  "limited_assist",
  "extensive_assist",
  "total_dependence",
  "did_not_occur",
] as const;
export type AdlLevel = (typeof ADL_LEVELS)[number];

export const CONTINENCE_LEVELS = [
  "continent",
  "occasionally_incontinent",
  "frequently_incontinent",
  "incontinent",
  "catheter_or_ostomy",
] as const;
export type ContinenceLevel = (typeof CONTINENCE_LEVELS)[number];

export const ADL_DEVICES = [
  "cane",
  "walker",
  "wheelchair",
  "hospital_bed",
  "mechanical_lift",
  "bedside_commode",
] as const;
export type AdlDevice = (typeof ADL_DEVICES)[number];

export const APPETITE_LEVELS = ["good", "fair", "poor", "none"] as const;
export type AppetiteLevel = (typeof APPETITE_LEVELS)[number];

export const FLUID_INTAKE_LEVELS = ["adequate", "decreased", "minimal"] as const;
export type FluidIntakeLevel = (typeof FLUID_INTAKE_LEVELS)[number];

export const SWALLOWING_LEVELS = [
  "no_difficulty",
  "difficulty_solids",
  "difficulty_liquids",
  "difficulty_solids_and_liquids",
  "unable_to_swallow",
] as const;
export type SwallowingLevel = (typeof SWALLOWING_LEVELS)[number];

export const NUTRITION_SUPPORTS = [
  "none",
  "oral_supplements",
  "tube_feeding",
  "parenteral",
] as const;
export type NutritionSupport = (typeof NUTRITION_SUPPORTS)[number];

/** What a select reads when nothing was recorded: the field is absent from the stored record. */
export const NOT_ASSESSED_LABEL = "Not assessed";

export const ADL_ITEM_LABEL: Record<AdlItem, string> = {
  bathing: "Bathing",
  dressing: "Dressing",
  grooming: "Grooming",
  toileting: "Toileting",
  transferring: "Transferring",
  ambulation: "Ambulation",
  eating: "Eating",
};

export const ADL_LEVEL_LABEL: Record<AdlLevel, string> = {
  independent: "Independent",
  supervision: "Supervision",
  limited_assist: "Limited assist",
  extensive_assist: "Extensive assist",
  total_dependence: "Total dependence",
  did_not_occur: "Did not occur",
};

export const CONTINENCE_LABEL: Record<ContinenceLevel, string> = {
  continent: "Continent",
  occasionally_incontinent: "Occasionally incontinent",
  frequently_incontinent: "Frequently incontinent",
  incontinent: "Incontinent",
  catheter_or_ostomy: "Catheter or ostomy",
};

export const ADL_DEVICE_LABEL: Record<AdlDevice, string> = {
  cane: "Cane",
  walker: "Walker",
  wheelchair: "Wheelchair",
  hospital_bed: "Hospital bed",
  mechanical_lift: "Mechanical lift",
  bedside_commode: "Bedside commode",
};

export const APPETITE_LABEL: Record<AppetiteLevel, string> = {
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  none: "None",
};

export const FLUID_INTAKE_LABEL: Record<FluidIntakeLevel, string> = {
  adequate: "Adequate",
  decreased: "Decreased",
  minimal: "Minimal",
};

export const SWALLOWING_LABEL: Record<SwallowingLevel, string> = {
  no_difficulty: "No difficulty",
  difficulty_solids: "Difficulty with solids",
  difficulty_liquids: "Difficulty with liquids",
  difficulty_solids_and_liquids: "Difficulty with solids and liquids",
  unable_to_swallow: "Unable to swallow",
};

export const NUTRITION_SUPPORT_LABEL: Record<NutritionSupport, string> = {
  none: "None",
  oral_supplements: "Oral supplements",
  tube_feeding: "Tube feeding",
  parenteral: "Parenteral",
};

/** A select's options: "Not assessed" (the empty value, absent from the stored record) then every code in its documented order. */
function notAssessedOptions<T extends string>(
  codes: readonly T[],
  labels: Readonly<Record<T, string>>,
): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "", label: NOT_ASSESSED_LABEL },
    ...codes.map((code) => ({ value: code, label: labels[code] })),
  ];
}

export const ADL_LEVEL_OPTIONS = notAssessedOptions(ADL_LEVELS, ADL_LEVEL_LABEL);
export const CONTINENCE_OPTIONS = notAssessedOptions(CONTINENCE_LEVELS, CONTINENCE_LABEL);
export const APPETITE_OPTIONS = notAssessedOptions(APPETITE_LEVELS, APPETITE_LABEL);
export const FLUID_INTAKE_OPTIONS = notAssessedOptions(FLUID_INTAKE_LEVELS, FLUID_INTAKE_LABEL);
export const SWALLOWING_OPTIONS = notAssessedOptions(SWALLOWING_LEVELS, SWALLOWING_LABEL);
export const NUTRITION_SUPPORT_OPTIONS = notAssessedOptions(
  NUTRITION_SUPPORTS,
  NUTRITION_SUPPORT_LABEL,
);

/** The code a select's `value` names, or null for "Not assessed" (or anything that is not one of `codes`). */
export function codeOf<T extends string>(codes: readonly T[], raw: string): T | null {
  return codes.find((code) => code === raw) ?? null;
}

/** The label of a request field path as the server names it in a 422 (`items.bathing`, `mealIntakePercent`), or null when unknown. */
export function findingFieldLabel(field: string): string | null {
  const [head, tail] = field.split(".");
  if (head === "items") {
    const item = codeOf(ADL_ITEMS, tail ?? "");
    return item === null ? "Activity level" : ADL_ITEM_LABEL[item];
  }
  if (head === "devices") return "Assistive devices";
  const labels: Record<string, string> = {
    bladder: "Bladder",
    bowel: "Bowel",
    appetite: "Appetite",
    mealIntakePercent: "Share of meals eaten",
    fluidIntake: "Fluid intake",
    swallowing: "Swallowing",
    support: "Nutrition support",
  };
  return Object.hasOwn(labels, field) ? (labels[field] ?? null) : null;
}
