// @wardenx/terminology-loader — SNOMED CT US Edition parser (tier 2: UMLS/SNOMED affiliate licence).
//
// Input: the RF2 SNAPSHOT release files (a zip, or the three files raw):
//   sct2_Concept_Snapshot*.txt       required — active concepts (header + tab-delimited rows)
//   sct2_Description_Snapshot*.txt   required — the active Fully Specified Name per concept
//   sct2_Relationship_Snapshot*.txt  optional — `Is a` (116680003) edges → `hierarchyPath` (root → parent)
// Display is the FSN with its trailing "(semantic tag)" removed; the tag is kept as `semanticTag`. The preferred
// synonym needs the language reference set, which this loader does not read — a stated limitation, not a guess.
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
      concept(id, (m?.[1] ?? name.term).trim(), "active", {
        effectiveDate: parseDate(f[1], `concept ${id} effectiveTime`),
        properties: {
          fullySpecifiedName: name.term,
          semanticTag: m?.[2] ?? null,
          hierarchyPath: pathOf(id, parents, memo),
        },
      }),
    );
  }
  return finish(
    "snomed",
    out,
    relName ? [] : ["Relationship snapshot absent: hierarchy paths not derived"],
  );
}
