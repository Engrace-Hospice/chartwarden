// @chartwarden/inpatient — M37-T05, §2.6 D7. The per-medication titration-window catalog + sedation classifier
// for the IV-continuous safety overlay. Seeded from CMS hospice-pharmacy guidance (a platform floor); a
// tenant overlay can tighten a window at the service layer (M37-T11). Pure data + predicates, IO-free.
import type { IvRateUnit } from "../gip-criteria/schema";

/** A per-medication titration window: the min/max infusion-rate bounds and the rate unit. */
export interface TitrationWindow {
  readonly minRate: number;
  readonly maxRate: number;
  readonly rateUnit: IvRateUnit;
  /** §2.6 — sedation-class drips require dual-witness + a tighter (q-1h) bedside-check cadence. */
  readonly isSedationClass: boolean;
}

/**
 * §2.6 — the sedation-class IV drips (palliative-sedation midazolam, propofol, ketamine at sedating doses,
 * ketorolac PCA at sedating doses, dexmedetomidine). Keyed by a normalized medication name; the overlay
 * builder falls back to a name-substring match so an unseeded RxNorm code still classifies correctly.
 */
export const SEDATION_CLASS_MED_NAMES: readonly string[] = [
  "midazolam",
  "propofol",
  "ketamine",
  "dexmedetomidine",
  "ketorolac",
] as const;

/**
 * The platform-floor titration catalog, keyed by normalized medication name. Unknown medications resolve to
 * a conservative non-sedation default with a wide window the tenant overlay is expected to tighten; the
 * `is_sedation_class` flag still derives from the name classifier so a novel sedation drip is caught.
 */
export const TITRATION_CATALOG: Readonly<Record<string, TitrationWindow>> = {
  midazolam: { minRate: 0.5, maxRate: 10, rateUnit: "mg_per_hour", isSedationClass: true },
  propofol: { minRate: 5, maxRate: 50, rateUnit: "mcg_per_kg_per_min", isSedationClass: true },
  ketamine: { minRate: 0.1, maxRate: 1.0, rateUnit: "mg_per_hour", isSedationClass: true },
  dexmedetomidine: {
    minRate: 0.2,
    maxRate: 1.5,
    rateUnit: "mcg_per_kg_per_min",
    isSedationClass: true,
  },
  ketorolac: { minRate: 1, maxRate: 5, rateUnit: "mg_per_hour", isSedationClass: true },
  morphine: { minRate: 0.5, maxRate: 20, rateUnit: "mg_per_hour", isSedationClass: false },
  hydromorphone: { minRate: 0.1, maxRate: 5, rateUnit: "mg_per_hour", isSedationClass: false },
};

/** A conservative default window for an unseeded medication (the tenant overlay is expected to tighten it). */
export const DEFAULT_TITRATION_WINDOW: TitrationWindow = {
  minRate: 0,
  maxRate: Number.POSITIVE_INFINITY,
  rateUnit: "ml_per_hour",
  isSedationClass: false,
};

/** Normalize a medication display name for catalog lookup (lowercase, trimmed). */
export function normalizeMedName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

/**
 * §2.6 — classify whether a medication is a sedation-class IV drip. Matches the seeded catalog first, then a
 * name-substring scan against {@link SEDATION_CLASS_MED_NAMES} so an unseeded product name still classifies.
 */
export function isSedationClassMedication(displayName: string): boolean {
  const norm = normalizeMedName(displayName);
  const seeded = seededWindowFor(norm);
  if (seeded) return seeded.isSedationClass;
  return SEDATION_CLASS_MED_NAMES.some((name) => norm.includes(name));
}

/**
 * The seeded window for a normalized name: an exact key, else a catalog drug named as a whole word inside a
 * longer product name (M12 stores `Midazolam 100 mg in 0.9% NaCl`, not the bare ingredient).
 */
function seededWindowFor(norm: string): TitrationWindow | undefined {
  const exact = TITRATION_CATALOG[norm];
  if (exact) return exact;
  const key = Object.keys(TITRATION_CATALOG).find((k) => new RegExp(`\\b${k}\\b`).test(norm));
  return key ? TITRATION_CATALOG[key] : undefined;
}

/** Is this medication in the seeded platform-floor catalog (as opposed to the unseeded wide default)? */
export function isSeededMedication(displayName: string): boolean {
  return seededWindowFor(normalizeMedName(displayName)) !== undefined;
}

/** Resolve the titration window for a medication by normalized name, falling back to the default. */
export function resolveTitrationWindow(displayName: string): TitrationWindow {
  const seeded = seededWindowFor(normalizeMedName(displayName));
  if (seeded) return seeded;
  // Unseeded: default bounds, but preserve the name-based sedation classification.
  return { ...DEFAULT_TITRATION_WINDOW, isSedationClass: isSedationClassMedication(displayName) };
}
