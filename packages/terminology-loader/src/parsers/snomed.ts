// @chartwarden/terminology-loader — SNOMED CT US Edition parser (tier 2: UMLS/SNOMED affiliate licence).
//
// Input: the RF2 SNAPSHOT release files (a zip, or the three files raw):
//   sct2_Concept_Snapshot*.txt       required — active concepts (header + tab-delimited rows)
//   sct2_Description_Snapshot*.txt   required — the active Fully Specified Name per concept
//   sct2_Relationship_Snapshot*.txt  optional — `Is a` (116680003) edges → `hierarchyPath` (root → parent)
//   der2_cRefset_Language*Snapshot*.txt  optional — the language reference set: with it, display is the concept's
//                                        PREFERRED SYNONYM (what clinicians actually type and read), US English
//                                        (900000000000509007) when that refset is present, else any English refset.
// Without the language refset (or for a concept it gives no preferred synonym) display falls back to the FSN with its
// trailing "(semantic tag)" removed; the tag is always kept as `semanticTag` and the FSN as `fullySpecifiedName`.
// Inactive concepts are not loaded: the diff against the prior version retires them with a deprecation mapping.
import { findEntry, iterLines, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ParsedSource, SourceBundle } from "../types";
import { assertCodeShape, concept, finish, parseDate } from "./shared";

const SCTID = /^\d{6,18}$/;
const FSN_TYPE = "900000000000003001";
const IS_A = "116680003";
const MAX_PATH_DEPTH = 64;
const FSN_TAG = /^(.*)\s+\(([^()]+)\)\s*$/;

function* rows(bytes: Uint8Array, minFields: number, what: string): Generator<string[]> {
  let first = true;
  let n = 0;
  for (const line of iterLines(bytes)) {
    n++;
    if (first) {
      first = false;
      continue; // header
    }
    if (line.trim() === "") continue;
    const f = line.split("\t");
    if (f.length < minFields)
      throw new LoaderDataError(
        "RECORD_INVALID",
        `${what} line ${n}: fewer than ${minFields} fields`,
      );
    yield f;
  }
}

function readParents(bytes: Uint8Array): Map<string, string> {
  const parents = new Map<string, string>();
  for (const f of rows(bytes, 10, "Relationship")) {
    if (f[2] !== "1" || f[7] !== IS_A) continue;
    const src = f[4] as string;
    const dst = f[5] as string;
    const cur = parents.get(src);
    if (cur === undefined || dst < cur) parents.set(src, dst); // deterministic first parent
  }
  return parents;
}

const SYNONYM_TYPE = "900000000000013009";
const PREFERRED = "900000000000548007";
const US_ENGLISH_REFSET = "900000000000509007";

/** Active description ids the language refset marks PREFERRED, grouped by refset id. */
function readPreferredDescriptionIds(bundle: SourceBundle): Map<string, Set<string>> {
  const byRefset = new Map<string, Set<string>>();
  for (const name of bundle.names.filter((n) =>
    /der2_cRefset_Language.*Snapshot.*\.txt$/i.test(n),
  )) {
    for (const f of rows(bundle.read(name), 7, "Language refset")) {
      if (f[2] !== "1" || f[6] !== PREFERRED) continue;
      const set = byRefset.get(f[4] as string) ?? new Set<string>();
      set.add(f[5] as string);
      byRefset.set(f[4] as string, set);
    }
  }
  return byRefset;
}

/** conceptId → latest active English synonym whose description id is in `preferredIds`. */
function readPreferredTerms(
  descFile: Uint8Array,
  preferredIds: ReadonlySet<string>,
): Map<string, string> {
  const best = new Map<string, { term: string; at: string }>();
  for (const f of rows(descFile, 9, "Description")) {
    if (f[2] !== "1" || f[6] !== SYNONYM_TYPE || f[5] !== "en") continue;
    if (!preferredIds.has(f[0] as string)) continue;
    const id = f[4] as string;
    const prior = best.get(id);
    if (!prior || (f[1] as string) > prior.at)
      best.set(id, { term: f[7] as string, at: f[1] as string });
  }
  return new Map([...best].map(([id, v]) => [id, v.term]));
}

/** The preferred-synonym map for the bundle, or an empty map (and a warning) when no language refset is present. */
function preferredSynonyms(
  bundle: SourceBundle,
  descFile: Uint8Array,
  warnings: string[],
): Map<string, string> {
  const byRefset = readPreferredDescriptionIds(bundle);
  if (byRefset.size === 0) {
    warnings.push("Language refset absent: display falls back to the FSN without its semantic tag");
    return new Map();
  }
  const us = byRefset.get(US_ENGLISH_REFSET);
  const ids = us ?? new Set([...byRefset.values()].flatMap((s) => [...s]));
  return readPreferredTerms(descFile, ids);
}

function pathOf(
  id: string,
  parents: ReadonlyMap<string, string>,
  memo: Map<string, string[]>,
): string[] {
  const cached = memo.get(id);
  if (cached) return cached;
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let cur = parents.get(id);
  while (cur !== undefined) {
    if (seen.has(cur) || chain.length >= MAX_PATH_DEPTH) {
      throw new LoaderDataError("HIERARCHY_INVALID", "snomed: cyclic or over-deep is-a chain");
    }
    seen.add(cur);
    chain.push(cur);
    cur = parents.get(cur);
  }
  const path = chain.reverse();
  memo.set(id, path);
  return path;
}

/** Parse a SNOMED CT RF2 snapshot bundle. */
export function parseSnomed(bundle: SourceBundle): ParsedSource {
  const conceptsFile = bundle.read(
    requireEntry(bundle, /sct2_Concept_Snapshot.*\.txt$/i, "sct2_Concept_Snapshot"),
  );
  const descFile = bundle.read(
    requireEntry(bundle, /sct2_Description_Snapshot.*\.txt$/i, "sct2_Description_Snapshot"),
  );
  const relName = findEntry(bundle, /sct2_Relationship_Snapshot.*\.txt$/i);
  const parents = relName ? readParents(bundle.read(relName)) : new Map<string, string>();

  const fsn = new Map<string, { term: string; at: string }>();
  for (const f of rows(descFile, 9, "Description")) {
    if (f[2] !== "1" || f[6] !== FSN_TYPE) continue;
    const id = f[4] as string;
    const prior = fsn.get(id);
    if (!prior || (f[1] as string) > prior.at)
      fsn.set(id, { term: f[7] as string, at: f[1] as string });
  }

  const warnings: string[] = relName
    ? []
    : ["Relationship snapshot absent: hierarchy paths not derived"];
  const preferred = preferredSynonyms(bundle, descFile, warnings);
  const memo = new Map<string, string[]>();
  const out = [];
  for (const f of rows(conceptsFile, 5, "Concept")) {
    if (f[2] !== "1") continue;
    const id = f[0] as string;
    assertCodeShape("snomed", id, SCTID, `concept ${id.slice(0, 20)}`);
    const name = fsn.get(id);
    if (!name)
      throw new LoaderDataError(
        "REFERENCE_INVALID",
        `snomed: active concept ${id} has no active FSN`,
      );
    const m = FSN_TAG.exec(name.term);
    out.push(
      concept(id, (preferred.get(id) ?? m?.[1] ?? name.term).trim(), "active", {
        effectiveDate: parseDate(f[1], `concept ${id} effectiveTime`),
        properties: {
          fullySpecifiedName: name.term,
          semanticTag: m?.[2] ?? null,
          hierarchyPath: pathOf(id, parents, memo),
        },
      }),
    );
  }
  return finish("snomed", out, warnings);
}
