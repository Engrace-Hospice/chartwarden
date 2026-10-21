// @chartwarden/terminology-loader — RxNorm parser (NLM; tier 2: the full release needs a UMLS licence).
//
// Input: the RxNorm Full release's RRF files (a zip whose `rrf/` folder holds them, or the files raw):
//   RXNCONSO.RRF   required — concept atoms. Only SAB=RXNORM atoms with SUPPRESS=N become concepts; one concept
//                  per RXCUI, labelled by its best term type (SCD, SBD, GPCK, BPCK, IN, MIN, PIN, BN, …).
//   RXNSAT.RRF     optional — `ATN=NDC` attributes give the associated NDCs.
//   RXNREL.RRF     optional — `has_ingredient` / `ingredient_of` relations give `ingredient_rxcui` (set only
//                  when a drug has exactly ONE ingredient; the full list stays in `properties`).
// ⚠ Layout provenance: column positions follow the NLM RRF documentation as given to the author; the reader is
// strict and fixture-pinned, and no licensed release file is in the repository.
import { findEntry, iterLines, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ParsedSource, SourceBundle } from "../types";
import { concept, finish } from "./shared";

/**
 * The term types that become concepts, in best-label order: dispensable clinical/branded drugs and packs first, then
 * ingredients (IN/MIN/PIN), brand names (BN) and the component/form levels a prescriber search needs.
 * Dose forms (DF/DFG), dose-form groups (SCDG/SBDG), entry terms (ET), prescribable names (PSN) and synonyms
 * (SY/TMSY) are NOT concepts of their own for a drug picker: an RXCUI whose only atoms are of those types is skipped.
 */
export const RXNORM_LOADED_TTYS = [
  "SCD",
  "SBD",
  "GPCK",
  "BPCK",
  "IN",
  "MIN",
  "PIN",
  "BN",
  "SCDC",
  "SBDC",
  "SCDF",
  "SBDF",
] as const;
const TTY_RANK: readonly string[] = RXNORM_LOADED_TTYS;
const RXCUI = /^\d{1,9}$/;

interface Best {
  rank: number;
  tty: string;
  display: string;
}

function readConso(bytes: Uint8Array): Map<string, Best> {
  const best = new Map<string, Best>();
  let n = 0;
  for (const line of iterLines(bytes)) {
    n++;
    if (line.trim() === "") continue;
    const f = line.split("|");
    if (f.length < 17)
      throw new LoaderDataError("RECORD_INVALID", `RXNCONSO line ${n}: fewer than 17 fields`);
    if (f[11] !== "RXNORM" || f[16] !== "N") continue;
    const rxcui = f[0] as string;
    if (!RXCUI.test(rxcui))
      throw new LoaderDataError("CODE_INVALID", `RXNCONSO line ${n}: RXCUI is not numeric`);
    const rank = TTY_RANK.indexOf(f[12] as string);
    if (rank < 0) continue;
    const cur = best.get(rxcui);
    if (!cur || rank < cur.rank)
      best.set(rxcui, { rank, tty: f[12] as string, display: f[14] as string });
  }
  return best;
}

function readNdcs(bytes: Uint8Array): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of iterLines(bytes)) {
    const f = line.split("|");
    if (f[8] !== "NDC" || f[9] !== "RXNORM" || !f[10]) continue;
    const list = out.get(f[0] as string) ?? [];
    list.push(f[10] as string);
    out.set(f[0] as string, list);
  }
  return out;
}

function readIngredients(bytes: Uint8Array): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (drug: string, ing: string): void => {
    const set = out.get(drug) ?? new Set<string>();
    set.add(ing);
    out.set(drug, set);
  };
  for (const line of iterLines(bytes)) {
    const f = line.split("|");
    if (f[7] === "has_ingredient") add(f[4] as string, f[0] as string);
    else if (f[7] === "ingredient_of") add(f[0] as string, f[4] as string);
  }
  return out;
}

/** Parse an RxNorm RRF bundle. */
export function parseRxnorm(bundle: SourceBundle): ParsedSource {
  const best = readConso(bundle.read(requireEntry(bundle, /RXNCONSO\.RRF$/i, "RXNCONSO.RRF")));
  const satName = findEntry(bundle, /RXNSAT\.RRF$/i);
  const relName = findEntry(bundle, /RXNREL\.RRF$/i);
  const ndcs = satName ? readNdcs(bundle.read(satName)) : new Map<string, string[]>();
  const ingredients = relName
    ? readIngredients(bundle.read(relName))
    : new Map<string, Set<string>>();
  const warnings: string[] = [];
  if (!satName) warnings.push("RXNSAT.RRF absent: NDC associations not loaded");
  if (!relName) warnings.push("RXNREL.RRF absent: ingredient links not loaded");
  const concepts = [...best.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([rxcui, b]) => {
      const ings = [...(ingredients.get(rxcui) ?? [])].sort();
      return concept(rxcui, b.display, "active", {
        properties: {
          tty: b.tty,
          ingredientRxcui: ings.length === 1 ? ings[0] : null,
          ...(ings.length > 1 ? { ingredientRxcuis: ings } : {}),
          ndcs: [...new Set(ndcs.get(rxcui) ?? [])].sort(),
        },
      });
    });
  return finish("rxnorm", concepts, warnings);
}
