// M12 GAP-036 follow-up — pure drug-vs-allergy matcher (no IO, no clock). Resolves free text on BOTH sides
// to {generic names, drug classes} using the data tables, then decides whether a recorded allergy conflicts
// with an ordered drug. Order of strength: same generic > whole-class allergy > one-member allergy that
// blocks its class (NSAIDs) > documented cross-reactivity > legacy shared-name-token fallback (covers a
// drug outside the tables, so nothing the previous token matcher caught is lost).
import {
  BRAND_TO_GENERICS,
  CLASS_CROSS_REACTIVITY,
  DRUG_CLASSES,
  type DrugClassDef,
  OTHER_GENERICS,
} from "./drug-allergy-data";

export { DRUG_CLASSES };

export type AllergyMatchKind = "generic" | "class" | "class_member" | "cross_reactive" | "name";

export interface AllergyMatch {
  readonly kind: AllergyMatchKind;
  /** The matched drug class (null only for a direct generic/name match on a drug with no class). */
  readonly classId: string | null;
  /** Non-PHI wording for the matched class, or null when no class applies. */
  readonly label: string | null;
}

/** Lower-case, strip punctuation to single spaces, trim. Hyphens and slashes separate words. */
const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

type TermIndex = ReadonlyArray<{ readonly term: string; readonly padded: string }>;
const indexOf = (terms: Iterable<string>): TermIndex =>
  [...new Set([...terms].map(normalize).filter((t) => t.length > 0))].map((term) => ({
    term,
    padded: ` ${term} `,
  }));

const classEntries = Object.entries(DRUG_CLASSES) as ReadonlyArray<[string, DrugClassDef]>;

const GENERIC_CLASSES = new Map<string, Set<string>>();
const addClass = (generic: string, classId: string): void => {
  const set = GENERIC_CLASSES.get(generic) ?? new Set<string>();
  set.add(classId);
  GENERIC_CLASSES.set(generic, set);
};
const ALIAS_CLASS = new Map<string, string>();
for (const [classId, def] of classEntries) {
  for (const m of def.members) addClass(normalize(m), classId);
  for (const a of def.aliases) ALIAS_CLASS.set(normalize(a), classId);
}
for (const g of OTHER_GENERICS)
  if (!GENERIC_CLASSES.has(normalize(g))) GENERIC_CLASSES.set(normalize(g), new Set());

const GENERIC_INDEX = indexOf(GENERIC_CLASSES.keys());
const BRAND_INDEX = indexOf(Object.keys(BRAND_TO_GENERICS));
const ALIAS_INDEX = indexOf(ALIAS_CLASS.keys());
const BRAND_GENERICS = new Map(
  Object.entries(BRAND_TO_GENERICS).map(([b, g]) => [normalize(b), g.map(normalize)] as const),
);

/** Class ids plus every ancestor (penicillin -> beta_lactam). */
function withAncestors(classIds: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...classIds];
  while (stack.length) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const p of DRUG_CLASSES[id]?.parents ?? []) stack.push(p);
  }
  return out;
}

/** The generic names a piece of text names, directly or through a brand name. */
export function normalizeToGenerics(text: string): ReadonlySet<string> {
  const padded = ` ${normalize(text)} `;
  const out = new Set<string>();
  for (const { term, padded: p } of GENERIC_INDEX) if (padded.includes(p)) out.add(term);
  for (const { term, padded: p } of BRAND_INDEX)
    if (padded.includes(p)) for (const g of BRAND_GENERICS.get(term) ?? []) out.add(g);
  return out;
}

interface Resolved {
  readonly generics: ReadonlySet<string>;
  /** Classes the text names as a CLASS (aliases) — NOT widened to ancestors: a penicillin allergy is not a cephalosporin one. */
  readonly namedClasses: ReadonlySet<string>;
  /** Classes the text's generics directly belong to. */
  readonly directClasses: ReadonlySet<string>;
  /** `directClasses` plus every ancestor (an ordered drug is in its parents too). */
  readonly memberClasses: ReadonlySet<string>;
}

function resolve(text: string): Resolved {
  const padded = ` ${normalize(text)} `;
  const generics = normalizeToGenerics(text);
  const named: string[] = [];
  for (const { term, padded: p } of ALIAS_INDEX)
    if (padded.includes(p)) named.push(ALIAS_CLASS.get(term) as string);
  const member: string[] = [];
  for (const g of generics) for (const c of GENERIC_CLASSES.get(g) ?? []) member.push(c);
  return {
    generics,
    namedClasses: new Set(named),
    directClasses: new Set(member),
    memberClasses: withAncestors(member),
  };
}

const classLabel = (classId: string | null): string | null =>
  classId === null ? null : (DRUG_CLASSES[classId]?.label ?? null);

const firstIn = (a: ReadonlySet<string>, b: ReadonlySet<string>): string | null => {
  for (const x of [...a].sort()) if (b.has(x)) return x;
  return null;
};

/** Words of an allergy sentence / dose decoration that never identify an allergen (legacy token fallback). */
const NON_IDENTIFYING_TOKENS = new Set([
  "allergy",
  "allergic",
  "allergies",
  "sensitivity",
  "intolerance",
  "reaction",
  "rash",
  "hives",
  "anaphylaxis",
  "with",
  "from",
  "sulfate",
  "sodium",
  "hydrochloride",
  "hcl",
  "acetate",
  "tartrate",
  "citrate",
  "oral",
  "tablet",
  "tablets",
  "capsule",
  "solution",
  "injection",
  "liquid",
  "extended",
  "release",
  "sulfa",
]);
const MIN_TOKEN_LENGTH = 4;
const significantTokens = (text: string): Set<string> =>
  new Set(
    normalize(text)
      .split(" ")
      .filter(
        (t) => t.length >= MIN_TOKEN_LENGTH && !/^\d+$/.test(t) && !NON_IDENTIFYING_TOKENS.has(t),
      ),
  );

/**
 * Does one recorded allergy (free text) conflict with the ordered drug? Returns the strongest match or
 * null. A blank side matches nothing; unreadable-data policy (fail closed) belongs to the caller.
 */
export function matchDrugToAllergy(drugName: string, allergenText: string): AllergyMatch | null {
  if (normalize(drugName).length === 0 || normalize(allergenText).length === 0) return null;
  const drug = resolve(drugName);
  const allergy = resolve(allergenText);

  if (firstIn(drug.generics, allergy.generics) !== null) {
    const classId = [...drug.directClasses].sort()[0] ?? null;
    return { kind: "generic", classId, label: classLabel(classId) };
  }
  const named = firstIn(drug.memberClasses, allergy.namedClasses);
  if (named !== null) return { kind: "class", classId: named, label: classLabel(named) };

  for (const c of allergy.directClasses) {
    if (DRUG_CLASSES[c]?.memberAllergyBlocksClass && drug.memberClasses.has(c))
      return { kind: "class_member", classId: c, label: classLabel(c) };
  }
  const allergyClasses = new Set([...allergy.namedClasses, ...allergy.directClasses]);
  for (const c of [...allergyClasses].sort()) {
    const crossed = (CLASS_CROSS_REACTIVITY[c] ?? []).find((x) => drug.memberClasses.has(x));
    if (crossed !== undefined)
      return { kind: "cross_reactive", classId: crossed, label: classLabel(crossed) };
  }

  const drugTokens = significantTokens(drugName);
  for (const t of significantTokens(allergenText))
    if (drugTokens.has(t)) return { kind: "name", classId: null, label: null };
  return null;
}
