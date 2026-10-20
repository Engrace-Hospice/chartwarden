/**
 * WardenX — M38 ICD-10-CM loader (F-238). Loads the REAL CDC/NCHS ICD-10-CM releases into
 * `concept_icd10cm`, dated by fiscal year, so "is this code valid on the date it was written?" has an
 * answer. Parsing rules live (and are unit-tested) in `scripts/db/lib/icd10cm-release.ts`.
 *
 * WHAT IT LOADS. Two fiscal-year releases as two `code_system_version` rows, so an older referral record is
 * judged by the code set in force when it was written:
 *   FY2026  effective 2025-10-01 … 2026-09-30  (status superseded)
 *   FY2027  effective 2026-10-01 … open        (status active — the current set)
 * Each concept row carries billability, chapter, parent, and the Tabular List's instructional-note flags
 * (`properties.hasCodeFirstNote`, `useAdditionalCode`, `manifestation`) that DocLens's coding checks read.
 * Codes billable in FY2026 but not in FY2027 get a `deprecation_mapping` to their FY2027 successors
 * (e.g. I42.0 → I42.00/I42.01/I42.09), so a stale code on an old fax maps forward instead of just failing.
 *
 * STARTER SUBSET. `db:seed:terminology` seeds ~16 ICD-10-CM codes under these same FY2026/FY2027 version ids
 * (checksum `seed-local-subset`). The checksum differs from the release's, so this loader deletes that
 * subset and loads the full set in place — no duplicate codes.
 *
 * SOURCES are pinned: each file is fetched from the NCHS publication directory and its SHA-256 checked
 * before anything is parsed; a mismatch aborts. Files are cached under `.cache/terminology/icd10cm/`
 * (gitignored). Pass `--source <dir>` to use already-downloaded zips (same file names) instead.
 *
 * WRITES. One transaction: code_system → versions (status `loading`) → concepts → deprecations →
 * `terminology_update_log` (`loaded` per version, `deprecated` for the mapping set) → versions `active` /
 * `superseded`. Per-row audit triggers on the concept tables are skipped (`session_replication_role =
 * replica`, as the other loaders/seeds do) because ~200k reference-data rows are not user writes; the
 * update log row per version — with the source URL and checksum — is the audit record. Idempotent: a
 * version already loaded with the same checksum is skipped; `--force` reloads it.
 *
 * Run:  bun run db:load:icd10cm                 (DATABASE_ADMIN_URL or DATABASE_URL)
 *       bun run db:load:icd10cm -- --source ~/Downloads/icd10cm --force
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import {
  type Deprecation,
  type Icd10cmConceptRow,
  buildConceptRows,
  deprecationsBetween,
  midYearAdditions,
  parseOrderAddenda,
  parseOrderFile,
  parseTabular,
} from "./lib/icd10cm-release";
import { ICD10CM_FY2026, ICD10CM_FY2027, type Icd10cmVersion } from "./lib/icd10cm-versions";

const NCHS = "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM";

interface ReleaseFile {
  readonly zip: string;
  readonly url: string;
  readonly sha256: string;
  /** Entry inside the zip, matched by suffix (NCHS nests some entries in a folder). */
  readonly entry: string;
}

/** Version ids and dates live in `lib/icd10cm-versions.ts`, shared with the starter-subset seed. */
interface Release extends Icd10cmVersion {
  readonly order: ReleaseFile;
  readonly addenda: ReleaseFile;
  readonly tabular: ReleaseFile;
}

const RELEASES: readonly Release[] = [
  {
    ...ICD10CM_FY2026,
    order: {
      zip: "icd10cm-code-descriptions-2026.zip",
      url: `${NCHS}/2026/icd10cm-Code%20Descriptions-2026.zip`,
      sha256: "a852eb91b3344ae38476e63816976ee1eeb94dcced7151118324f060e8499f88",
      entry: "icd10cm-order-2026.txt",
    },
    addenda: {
      zip: "icd10cm-code-descriptions-2026.zip",
      url: `${NCHS}/2026/icd10cm-Code%20Descriptions-2026.zip`,
      sha256: "a852eb91b3344ae38476e63816976ee1eeb94dcced7151118324f060e8499f88",
      entry: "icd10cm-order-addenda-2026.txt",
    },
    tabular: {
      zip: "icd10cm-table-and-index-2026.zip",
      url: `${NCHS}/2026/icd10cm-table%20and%20index-2026.zip`,
      sha256: "de80c60de23fef47105caffa7e7b3f72d813373c791794748e291b812eebd925",
      entry: "icd10cm-tabular-2026.xml",
    },
  },
  {
    ...ICD10CM_FY2027,
    order: {
      zip: "icd10cm-code-descriptions-2027.zip",
      url: `${NCHS}/2027/icd10cm-code-descriptions-2027.zip`,
      sha256: "93e3ad6004badf470c55bfe679b748ae88fd9b2b421851e409eec382c7713b9a",
      entry: "icd10cm-order-2027.txt",
    },
    addenda: {
      zip: "icd10cm-code-descriptions-2027.zip",
      url: `${NCHS}/2027/icd10cm-code-descriptions-2027.zip`,
      sha256: "93e3ad6004badf470c55bfe679b748ae88fd9b2b421851e409eec382c7713b9a",
      entry: "icd10cm-order-addenda-2027.txt",
    },
    tabular: {
      zip: "icd10cm-table-and-index-2027.zip",
      url: `${NCHS}/2027/icd10cm-table-and-index-2027.zip`,
      sha256: "99b5c2be16ff53eab861cc0be4b1dacba27f687b8ff4bc700679944355037ee0",
      entry: "icd10cm-tabular_-2027.xml",
    },
  },
];

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const sourceIdx = args.indexOf("--source");
const SOURCE = sourceIdx >= 0 ? resolve(args[sourceIdx + 1] as string) : null;
const CACHE = resolve(".cache/terminology/icd10cm");
const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

async function fetchVerified(f: ReleaseFile): Promise<string> {
  const dir = SOURCE ?? CACHE;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, f.zip);
  if (!existsSync(path)) {
    if (SOURCE) throw new Error(`${f.zip} not found in --source ${SOURCE}`);
    console.log(`  ↓ ${f.url}`);
    const r = await fetch(f.url);
    if (!r.ok) throw new Error(`download failed ${r.status}: ${f.url}`);
    writeFileSync(path, new Uint8Array(await r.arrayBuffer()));
  }
  const sum = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (sum !== f.sha256) {
    throw new Error(
      `${f.zip}: SHA-256 ${sum} does not match the pinned ${f.sha256} — refusing to load an unverified release`,
    );
  }
  return path;
}

function readEntry(zipPath: string, suffix: string): string {
  const names = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n");
  const name = names.find(
    (n) =>
      n.endsWith(suffix) &&
      !n.endsWith(".pdf") &&
      (!suffix.endsWith(".xml") || n.includes("tabular")),
  );
  if (!name) throw new Error(`${zipPath} has no entry ending in ${suffix}`);
  return execFileSync("unzip", ["-p", zipPath, name], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

interface Prepared {
  readonly release: Release;
  readonly rows: Icd10cmConceptRow[];
  /** Undotted codes added mid-year (dated by the April update, not October 1). */
  readonly midYear: ReadonlySet<string>;
  readonly checksum: string;
  readonly order: ReturnType<typeof parseOrderFile>;
  readonly addenda: ReturnType<typeof parseOrderAddenda>;
}

async function prepare(release: Release): Promise<Prepared> {
  const orderZip = await fetchVerified(release.order);
  const tabZip = await fetchVerified(release.tabular);
  const order = parseOrderFile(readEntry(orderZip, release.order.entry));
  const addenda = parseOrderAddenda(readEntry(orderZip, release.addenda.entry));
  const tabular = parseTabular(readEntry(tabZip, release.tabular.entry));
  return {
    release,
    rows: buildConceptRows(order, tabular),
    midYear: new Set(),
    checksum: `${release.order.sha256}+${release.tabular.sha256}`,
    order,
    addenda,
  };
}

async function insertConcepts(db: Client, p: Prepared, midYearFrom: string | null): Promise<void> {
  const CHUNK = 5000;
  for (let i = 0; i < p.rows.length; i += CHUNK) {
    const chunk = p.rows.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO concept_icd10cm
         (code, display, status, effective_date, end_date, version_id, is_billable_leaf, chapter,
          parent_code, properties, created_at)
       SELECT c, d, 'active', e::date, $5::date, $6, b, ch, pc, pr::jsonb, now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::bool[], $7::text[], $8::text[], $9::text[])
              AS t(c, d, e, b, ch, pc, pr)`,
      [
        chunk.map((r) => r.code),
        chunk.map((r) => r.display),
        chunk.map((r) =>
          midYearFrom && p.midYear.has(r.code.replace(".", ""))
            ? midYearFrom
            : p.release.effectiveFrom,
        ),
        chunk.map((r) => r.isBillableLeaf),
        p.release.effectiveTo,
        p.release.id,
        chunk.map((r) => r.chapter),
        chunk.map((r) => r.parentCode),
        chunk.map((r) => JSON.stringify(r.properties)),
      ],
    );
  }
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
  for (const r of RELEASES)
    if (r.tabular.sha256.startsWith("__"))
      throw new Error(`${r.version} tabular checksum is not pinned`);

  console.log("Preparing ICD-10-CM releases (verify → parse)…");
  const [fy26, fy27] = (await Promise.all(RELEASES.map(prepare))) as [Prepared, Prepared];
  const midYear = midYearAdditions(fy26.order, fy27.order, fy27.addenda);
  // Mid-year additions belong to FY2026's April update: add them to the FY2026 rows, dated April 1.
  const fy26Codes = new Set(fy26.rows.map((r) => r.code));
  const lateRows = fy27.rows.filter(
    (r) => midYear.has(r.code.replace(".", "")) && !fy26Codes.has(r.code),
  );
  const fy26Prepared: Prepared = { ...fy26, rows: [...fy26.rows, ...lateRows], midYear };
  const deprecations: Deprecation[] = deprecationsBetween(fy26.order, fy27.order);

  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query("SET LOCAL session_replication_role = replica");
    await db.query(
      `INSERT INTO code_system (id, name, license_source, source_uri, updated_at)
       VALUES ('icd10cm', 'ICD-10-CM', 'CDC/NCHS (public domain)', $1, now())
       ON CONFLICT (id) DO UPDATE SET source_uri = EXCLUDED.source_uri, updated_at = now()`,
      [NCHS],
    );
    for (const p of [fy26Prepared, fy27]) {
      const { release } = p;
      const prior = await db.query<{ checksum: string }>(
        "SELECT checksum FROM code_system_version WHERE id = $1",
        [release.id],
      );
      if (prior.rows[0]?.checksum === p.checksum && !FORCE) {
        console.log(`  = ${release.version} already loaded (same checksum) — skipped`);
        continue;
      }
      await db.query("DELETE FROM deprecation_mapping WHERE created_in_version_id = $1", [
        release.id,
      ]);
      await db.query("DELETE FROM concept_icd10cm WHERE version_id = $1", [release.id]);
      await db.query(
        `INSERT INTO code_system_version
           (id, code_system_id, version, released_on, effective_from, effective_to, source_file_ref,
            checksum, status, loaded_at)
         VALUES ($1, 'icd10cm', $2, $3, $4, $5, $6, $7, 'loading', now())
         ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum, status = 'loading', loaded_at = now(),
           source_file_ref = EXCLUDED.source_file_ref`,
        [
          release.id,
          release.version,
          release.releasedOn,
          release.effectiveFrom,
          release.effectiveTo,
          `${release.order.url} ; ${release.tabular.url}`,
          p.checksum,
        ],
      );
      await insertConcepts(db, p, p === fy26Prepared ? "2026-04-01" : null);
      const billable = p.rows.filter((r) => r.isBillableLeaf).length;
      await db.query(
        `INSERT INTO terminology_update_log (system_id, version_id, action, concept_count, new_codes,
           retired_codes, summary)
         VALUES ('icd10cm', $1, 'loaded', $2, $3, $4, $5::jsonb)`,
        [
          release.id,
          p.rows.length,
          p.addenda.filter((a) => a.action === "add").length,
          p.addenda.filter((a) => a.action === "delete").length,
          JSON.stringify({
            version: release.version,
            billable,
            midYearAdditions: p === fy26Prepared ? midYear.size : 0,
            sources: [release.order.url, release.tabular.url],
            checksum: p.checksum,
          }),
        ],
      );
      console.log(`  ✓ ${release.version}: ${p.rows.length} codes (${billable} billable)`);
    }

    // FY2026 → FY2027 deprecations, owned by the FY2027 version.
    await db.query("DELETE FROM deprecation_mapping WHERE created_in_version_id = $1", [
      fy27.release.id,
    ]);
    for (const d of deprecations) {
      await db.query(
        `INSERT INTO deprecation_mapping (system_id, deprecated_code, deprecation_effective, successor_codes,
           mapping_kind, guidance, created_in_version_id)
         VALUES ('icd10cm', $1, $2, $3, $4, $5, $6)`,
        [d.code, fy27.release.effectiveFrom, d.successors, d.kind, d.guidance, fy27.release.id],
      );
    }
    await db.query(
      `INSERT INTO terminology_update_log (system_id, version_id, action, retired_codes, summary)
       VALUES ('icd10cm', $1, 'deprecated', $2, $3::jsonb)`,
      [
        fy27.release.id,
        deprecations.length,
        JSON.stringify({ codes: deprecations.map((d) => d.code) }),
      ],
    );
    await db.query("UPDATE code_system_version SET status = 'superseded' WHERE id = $1", [
      fy26.release.id,
    ]);
    await db.query("UPDATE code_system_version SET status = 'active' WHERE id = $1", [
      fy27.release.id,
    ]);
    await db.query("COMMIT");
    console.log(
      `✓ ICD-10-CM loaded: FY2026 + FY2027, ${deprecations.length} FY2027 deprecations mapped, ${midYear.size} mid-year additions dated 2026-04-01.`,
    );
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
