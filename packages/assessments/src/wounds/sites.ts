// @chartwarden/assessments — the anatomical site vocabulary for wounds (M9 longitudinal wounds).
//
// A wound's site is a CODE from this list plus a laterality, never typed text. `sides` says which lateralities make
// sense for the site: a `paired` site (heel, knee, ear...) is left, right or bilateral; a `midline` site (sacrum,
// coccyx...) is midline or not applicable; `other` is the catch-all for anything the list does not name and takes any.

import type { WoundLaterality } from "./value-sets";

export type WoundSiteSides = "paired" | "midline" | "any";

export interface WoundSite {
  readonly code: string;
  /** Singular display name, lower case, used in a sentence ("left heel"). */
  readonly label: string;
  /** Plural, for a bilateral wound ("bilateral heels"). */
  readonly plural: string;
  readonly sides: WoundSiteSides;
}

const paired = (code: string, label: string, plural = `${label}s`): WoundSite => ({
  code,
  label,
  plural,
  sides: "paired",
});
const midline = (code: string, label: string): WoundSite => ({
  code,
  label,
  plural: label,
  sides: "midline",
});

export const WOUND_SITES = [
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
] as const satisfies readonly WoundSite[];

export type WoundSiteCode = (typeof WOUND_SITES)[number]["code"];

export const WOUND_SITE_CODES: readonly WoundSiteCode[] = WOUND_SITES.map((s) => s.code);

const SITE_BY_CODE: ReadonlyMap<string, WoundSite> = new Map(WOUND_SITES.map((s) => [s.code, s]));

export function woundSiteOf(code: string): WoundSite | undefined {
  return SITE_BY_CODE.get(code);
}

const LATERALITIES_BY_SIDES: Readonly<Record<WoundSiteSides, readonly WoundLaterality[]>> = {
  paired: ["left", "right", "bilateral"],
  midline: ["midline", "not_applicable"],
  any: ["left", "right", "midline", "bilateral", "not_applicable"],
};

/** True when `laterality` is one the site accepts (a left sacrum, or a midline heel, is a data-entry mistake). */
export function lateralityFitsSite(siteCode: string, laterality: WoundLaterality): boolean {
  const site = SITE_BY_CODE.get(siteCode);
  return site !== undefined && LATERALITIES_BY_SIDES[site.sides].includes(laterality);
}

/**
 * The display phrase for a wound's location: "left heel", "sacrum", "bilateral heels". An unknown site code reads as
 * "other site" rather than throwing: a stored row must always render.
 */
export function siteLabel(siteCode: string, laterality: WoundLaterality): string {
  const site = SITE_BY_CODE.get(siteCode) ?? SITE_BY_CODE.get("other");
  const label = site?.label ?? "other site";
  if (laterality === "left" || laterality === "right") return `${laterality} ${label}`;
  if (laterality === "bilateral") return `bilateral ${site?.plural ?? label}`;
  return label;
}
