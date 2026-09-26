import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { firstRow, requireAt } from "./lib/query-rows";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_DIR = join(here, "..", "..", "packages", "db", "reference", "hope", "v1.00.1");
const SPEC = {
  code: "1.00.1",
  itemSetVersion: "1.00",
  effectiveFrom: "2025-10-01",
  sourceLabel: "HOPE Data Specifications V1.00.1 FINAL 04-04-2025",
  sourceRelease: "FINAL 04-04-2025",
};
const ISCS = ["HA", "HUV", "HD", "XX"] as const;
type Isc = (typeof ISCS)[number];
/** One parsed CMS CSV row. Keyed by the columns this importer reads (a column absent from a file reads as
 *  `undefined` at runtime exactly as before — the union only states which names are expected). */
type CsvColumn =
  | "fixed_rec_end_byte"
  | "fixed_rec_lngth"
  | "fixed_rec_srt_id"
  | "fixed_rec_strt_byte"
  | "itm_db_id"
  | "itm_grp_cd"
  | "itm_id"
  | "itm_loinc_id"
  | "itm_mstr_key"
  | "itm_sect_label"
  | "itm_sect_srt_id"
  | "itm_shrt_label"
  | "itm_srt_id"
  | "itm_type_cd"
  | "itm_val_key"
  | "itm_vrsn_notes"
  | "val_id"
  | "val_loinc_id"
  | "val_srt_id"
  | "val_txt"
  | "isc"
  | "isc_id"
  | "section_label"
  | `isc_${Lowercase<Isc>}`;
type Row = Readonly<Record<CsvColumn, string>>;

export interface ImportHopeSpecOptions {
  readonly databaseUrl?: string;
  readonly sourceDir?: string;
  readonly dryRun?: boolean;
  readonly replace?: boolean;
}

export interface ImportHopeSpecReport {
  readonly items: number;
  readonly iscRows: number;
  readonly options: number;
  readonly activeAssessmentCounts: Record<Isc, Record<string, number>>;
}

function parseArgs(argv: readonly string[]): ImportHopeSpecOptions {
  const opts: ImportHopeSpecOptions = {};
  const mutable: { databaseUrl?: string; sourceDir?: string; dryRun?: boolean; replace?: boolean } =
    {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") mutable.dryRun = true;
    else if (arg === "--replace") mutable.replace = true;
    else if (arg === "--source") mutable.sourceDir = argv[++i];
    else if (arg === "--version") {
      const version = argv[++i];
      if (version !== SPEC.code) throw new Error(`Unsupported HOPE spec version '${version}'`);
    } else {
      throw new Error(`Unknown argument '${arg}'`);
    }
  }
  return { ...opts, ...mutable };
}

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((v) => v.length > 0));
  if (!header) return [];
  return body.map(
    (values) => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""])) as Row,
  );
}

function sourceFile(sourceDir: string, prefix: string): string {
  const matches = readdirSync(sourceDir).filter((f) => f.startsWith(prefix) && f.endsWith(".csv"));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${prefix}*.csv in ${sourceDir}, found ${matches.length}`);
  }
  return join(sourceDir, requireAt(matches, 0, `${prefix}*.csv`));
}

function intOrNull(value: string): number | null {
  if (!value.trim()) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Expected integer, got '${value}'`);
  return n;
}

function intRequired(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`Expected integer ${label}, got '${value}'`);
  return n;
}

function classifyKind(row: Row): "assessment" | "control" | "calculated" | "filler" {
  const section = row.itm_sect_label.trim().toLowerCase();
  const type = row.itm_type_cd.trim().toLowerCase();
  const item = row.itm_id.trim().toLowerCase();
  if (section === "filler" || type === "filler" || item.startsWith("item_filler")) return "filler";
  if (section === "control") return "control";
  if (type === "calculated" || section === "calculated" || section === "calc") return "calculated";
  if (["code", "text", "date", "number", "checklist", "a", ""].includes(type)) return "assessment";
  throw new Error(
    `Unknown HOPE item category for ${row.itm_id}: section='${section}' type='${type}'`,
  );
}

function activeFor(row: Row, isc: Isc): boolean {
  const value = row[`isc_${isc.toLowerCase() as Lowercase<Isc>}`]?.trim().toLowerCase();
  if (value === "x") return true;
  if (value === "") return false;
  throw new Error(`Unknown ISC marker '${value}' for ${row.itm_id}/${isc}`);
}

function normalizeSection(row: Row): string {
  const label = row.itm_sect_label.trim();
  if (/^[AFIJMNZ]$/.test(label)) return label;
  if (label === "Control" || label === "Filler" || label === "Calc") return label;
  throw new Error(`Unknown HOPE section label '${label}' for ${row.itm_id}`);
}

function metadata(row: Row, sourceName: string): Record<string, string> {
  return { ...row, source_file: sourceName };
}

export function loadHopeSpec(sourceDir = DEFAULT_SOURCE_DIR) {
  const dir = resolve(sourceDir);
  if (!existsSync(dir)) throw new Error(`HOPE source directory not found: ${dir}`);
  const itmMstrFile = sourceFile(dir, "itm_mstr");
  const itmValFile = sourceFile(dir, "itm_val");
  const iscMstrFile = sourceFile(dir, "isc_mstr");
  const iscValFile = sourceFile(dir, "isc_val");
  const items = parseCsv(readFileSync(itmMstrFile, "utf8"));
  const values = parseCsv(readFileSync(itmValFile, "utf8"));
  const iscMstr = parseCsv(readFileSync(iscMstrFile, "utf8"));
  const iscVal = parseCsv(readFileSync(iscValFile, "utf8"));
  return {
    dir,
    sourceNames: {
      itmMstr: itmMstrFile.split("/").at(-1) ?? "itm_mstr.csv",
      itmVal: itmValFile.split("/").at(-1) ?? "itm_val.csv",
    },
    items,
    values,
    iscMstr,
    iscVal,
  };
}

export function buildHopeSpecImport(sourceDir = DEFAULT_SOURCE_DIR) {
  const source = loadHopeSpec(sourceDir);
  const officialIscs = new Set(source.iscMstr.map((r) => r.isc_id));
  for (const isc of ISCS) {
    if (!officialIscs.has(isc)) throw new Error(`Official ISC file does not contain ${isc}`);
  }
  const iscValIscs = new Set(source.iscVal.map((r) => r.isc_id));
  for (const isc of ISCS) {
    if (!iscValIscs.has(isc)) throw new Error(`Official ISC value file does not contain ${isc}`);
  }

  const seenKeys = new Set<string>();
  const seenCodes = new Set<string>();
  const itemRows = source.items.map((row) => {
    if (seenKeys.has(row.itm_mstr_key))
      throw new Error(`Duplicate itm_mstr_key ${row.itm_mstr_key}`);
    if (seenCodes.has(row.itm_id)) throw new Error(`Duplicate itm_id ${row.itm_id}`);
    seenKeys.add(row.itm_mstr_key);
    seenCodes.add(row.itm_id);
    return {
      sourceKey: row.itm_mstr_key,
      itemCode: row.itm_id,
      databaseItemCode: row.itm_db_id || null,
      shortLabel: row.itm_shrt_label,
      sectionLabel: normalizeSection(row),
      itemSortOrder: intRequired(row.itm_srt_id, `itm_srt_id for ${row.itm_id}`),
      sectionSortOrder: intRequired(row.itm_sect_srt_id, `itm_sect_srt_id for ${row.itm_id}`),
      groupCode: row.itm_grp_cd || null,
      loincId: row.itm_loinc_id || null,
      cmsItemTypeCode: row.itm_type_cd,
      kind: classifyKind(row),
      fixedRecordSortOrder: intOrNull(row.fixed_rec_srt_id),
      fixedRecordStartByte: intOrNull(row.fixed_rec_strt_byte),
      fixedRecordEndByte: intOrNull(row.fixed_rec_end_byte),
      fixedRecordLength: intOrNull(row.fixed_rec_lngth),
      versionNotes: row.itm_vrsn_notes || null,
      sourceMetadata: metadata(row, source.sourceNames.itmMstr),
      isc: Object.fromEntries(ISCS.map((isc) => [isc, activeFor(row, isc)])) as Record<
        Isc,
        boolean
      >,
    };
  });

  const itemByKey = new Map(itemRows.map((item) => [item.sourceKey, item]));
  const seenValueKeys = new Set<string>();
  const seenItemValueCodes = new Set<string>();
  const optionRows = source.values.map((row) => {
    if (seenValueKeys.has(row.itm_val_key))
      throw new Error(`Duplicate itm_val_key ${row.itm_val_key}`);
    seenValueKeys.add(row.itm_val_key);
    const item = itemByKey.get(row.itm_mstr_key);
    if (!item)
      throw new Error(`itm_val ${row.itm_val_key} references unknown item ${row.itm_mstr_key}`);
    const itemValueKey = `${item.itemCode}\0${row.val_id}`;
    if (seenItemValueCodes.has(itemValueKey)) {
      throw new Error(`Duplicate value '${row.val_id}' for item ${item.itemCode}`);
    }
    seenItemValueCodes.add(itemValueKey);
    return {
      itemCode: item.itemCode,
      cmsItemValueKey: row.itm_val_key,
      sortOrder: intRequired(row.val_srt_id, `val_srt_id for ${row.itm_id}/${row.val_id}`),
      valueCode: row.val_id,
      label: row.val_txt,
      loincId: row.val_loinc_id || null,
    };
  });

  const activeAssessmentCounts = Object.fromEntries(
    ISCS.map((isc) => [
      isc,
      itemRows
        .filter((item) => item.kind === "assessment" && item.isc[isc])
        .reduce<Record<string, number>>((acc, item) => {
          acc[item.sectionLabel] = (acc[item.sectionLabel] ?? 0) + 1;
          return acc;
        }, {}),
    ]),
  ) as Record<Isc, Record<string, number>>;

  return {
    sourceDir: source.dir,
    items: itemRows,
    options: optionRows,
    iscRows: itemRows.length * ISCS.length,
    activeAssessmentCounts,
    sourceHash: createHash("sha256").update(JSON.stringify({ itemRows, optionRows })).digest("hex"),
  };
}

async function assertVersion(db: Client): Promise<string> {
  const existing = await db.query<{
    id: string;
    item_set_version: string;
    effective_from: string;
    effective_to: string | null;
    source_label: string;
    source_release: string | null;
  }>(
    // Dates as text: node-pg parses a `date` column into a JS Date, whose String() never equals yyyy-mm-dd.
    `SELECT id, item_set_version, effective_from::text AS effective_from, effective_to::text AS effective_to,
            source_label, source_release
       FROM hope_spec_version WHERE code=$1`,
    [SPEC.code],
  );
  if (existing.rowCount) {
    const row = firstRow(existing, "hope_spec_version");
    const same =
      row.item_set_version === SPEC.itemSetVersion &&
      row.effective_from === SPEC.effectiveFrom &&
      row.effective_to === null &&
      row.source_label === SPEC.sourceLabel &&
      row.source_release === SPEC.sourceRelease;
    if (!same) throw new Error(`Existing HOPE spec version ${SPEC.code} metadata differs`);
    return row.id;
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO hope_spec_version
       (code, item_set_version, effective_from, effective_to, source_label, source_release)
     VALUES ($1,$2,$3,NULL,$4,$5) RETURNING id`,
    [SPEC.code, SPEC.itemSetVersion, SPEC.effectiveFrom, SPEC.sourceLabel, SPEC.sourceRelease],
  );
  return firstRow(inserted, "inserted hope_spec_version").id;
}

async function versionHasReferences(db: Client, versionId: string): Promise<boolean> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM hope_assessment WHERE spec_version_id=$1) +
       (SELECT count(*) FROM hope_assessment_answer WHERE spec_version_id=$1) +
       (SELECT count(*) FROM hope_validation_finding WHERE spec_version_id=$1)
     )::text AS n`,
    [versionId],
  );
  return Number(requireAt(rows, 0, "reference count").n) > 0;
}

export async function importHopeSpec(opts: ImportHopeSpecOptions): Promise<ImportHopeSpecReport> {
  const built = buildHopeSpecImport(opts.sourceDir);
  if (opts.dryRun) return reportFromBuilt(built);
  const databaseUrl =
    opts.databaseUrl ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL is required");
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query("BEGIN");
    const versionId = await assertVersion(db);
    const existingItems = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM hope_spec_item WHERE spec_version_id=$1",
      [versionId],
    );
    if (Number(firstRow(existingItems, "hope_spec_item count").n) > 0) {
      if (!opts.replace) {
        const report = await reportFromDb(db, versionId);
        if (
          report.items !== built.items.length ||
          report.options !== built.options.length ||
          report.iscRows !== built.iscRows
        ) {
          throw new Error(
            `Existing HOPE spec ${SPEC.code} import is incomplete or differs from source counts; use --replace only if no runtime rows reference it`,
          );
        }
        await db.query("ROLLBACK");
        return report;
      }
      if (await versionHasReferences(db, versionId)) {
        throw new Error(
          `Cannot --replace HOPE spec ${SPEC.code}; it is referenced by runtime rows`,
        );
      }
      await db.query(
        "DELETE FROM hope_spec_item_option WHERE spec_item_id IN (SELECT id FROM hope_spec_item WHERE spec_version_id=$1)",
        [versionId],
      );
      await db.query(
        "DELETE FROM hope_spec_item_isc WHERE spec_item_id IN (SELECT id FROM hope_spec_item WHERE spec_version_id=$1)",
        [versionId],
      );
      await db.query("DELETE FROM hope_spec_item WHERE spec_version_id=$1", [versionId]);
    }

    const itemIdByCode = new Map<string, string>();
    for (const item of built.items) {
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO hope_spec_item (
          spec_version_id, cms_item_master_key, item_code, database_item_code, short_label,
          section_label, item_sort_order, section_sort_order, group_code, loinc_id, cms_item_type_code,
          kind, fixed_record_sort_order, fixed_record_start_byte, fixed_record_end_byte,
          fixed_record_length, version_notes, source_metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
        RETURNING id`,
        [
          versionId,
          item.sourceKey,
          item.itemCode,
          item.databaseItemCode,
          item.shortLabel,
          item.sectionLabel,
          item.itemSortOrder,
          item.sectionSortOrder,
          item.groupCode,
          item.loincId,
          item.cmsItemTypeCode,
          item.kind,
          item.fixedRecordSortOrder,
          item.fixedRecordStartByte,
          item.fixedRecordEndByte,
          item.fixedRecordLength,
          item.versionNotes,
          JSON.stringify(item.sourceMetadata),
        ],
      );
      const id = firstRow(inserted, `inserted hope_spec_item ${item.itemCode}`).id;
      itemIdByCode.set(item.itemCode, id);
      for (const isc of ISCS) {
        await db.query(
          "INSERT INTO hope_spec_item_isc (spec_item_id, isc, active) VALUES ($1,$2,$3)",
          [id, isc, item.isc[isc]],
        );
      }
    }

    for (const option of built.options) {
      const specItemId = itemIdByCode.get(option.itemCode);
      if (!specItemId)
        throw new Error(`Option references missing imported item ${option.itemCode}`);
      await db.query(
        `INSERT INTO hope_spec_item_option
          (spec_item_id, cms_item_value_key, sort_order, value_code, label, loinc_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          specItemId,
          option.cmsItemValueKey,
          option.sortOrder,
          option.valueCode,
          option.label,
          option.loincId,
        ],
      );
    }

    const report = await reportFromDb(db, versionId);
    if (
      report.items !== built.items.length ||
      report.options !== built.options.length ||
      report.iscRows !== built.iscRows
    ) {
      throw new Error("Post-import counts do not match parsed CMS source counts");
    }
    await db.query("COMMIT");
    return report;
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await db.end();
  }
}

function reportFromBuilt(built: ReturnType<typeof buildHopeSpecImport>): ImportHopeSpecReport {
  return {
    items: built.items.length,
    iscRows: built.iscRows,
    options: built.options.length,
    activeAssessmentCounts: built.activeAssessmentCounts,
  };
}

async function reportFromDb(db: Client, versionId: string): Promise<ImportHopeSpecReport> {
  const counts = await db.query<{ items: string; isc_rows: string; options: string }>(
    `SELECT
       (SELECT count(*) FROM hope_spec_item WHERE spec_version_id=$1)::text AS items,
       (SELECT count(*) FROM hope_spec_item_isc isi JOIN hope_spec_item i ON i.id=isi.spec_item_id WHERE i.spec_version_id=$1)::text AS isc_rows,
       (SELECT count(*) FROM hope_spec_item_option o JOIN hope_spec_item i ON i.id=o.spec_item_id WHERE i.spec_version_id=$1)::text AS options`,
    [versionId],
  );
  const sections = await db.query<{ isc: Isc; section_label: string; n: string }>(
    `SELECT isi.isc, i.section_label, count(*)::text AS n
     FROM hope_spec_item i
     JOIN hope_spec_item_isc isi ON isi.spec_item_id = i.id
     WHERE i.spec_version_id=$1 AND i.kind='assessment' AND isi.active = true
     GROUP BY isi.isc, i.section_label`,
    [versionId],
  );
  const activeAssessmentCounts = Object.fromEntries(ISCS.map((isc) => [isc, {}])) as Record<
    Isc,
    Record<string, number>
  >;
  for (const row of sections.rows)
    activeAssessmentCounts[row.isc][row.section_label] = Number(row.n);
  const count = firstRow(counts, "hope spec counts");
  return {
    items: Number(count.items),
    iscRows: Number(count.isc_rows),
    options: Number(count.options),
    activeAssessmentCounts,
  };
}

function printReport(report: ImportHopeSpecReport) {
  console.log(`HOPE Data Spec ${SPEC.code}`);
  console.log("");
  console.log("Spec versions: 1");
  console.log(`Items: ${report.items}`);
  console.log(`ISC rows: ${report.iscRows}`);
  console.log(`Options: ${report.options}`);
  console.log("");
  console.log("Active assessment items:");
  for (const isc of ISCS) {
    const total = Object.values(report.activeAssessmentCounts[isc]).reduce((a, b) => a + b, 0);
    console.log(`${isc} ${total}`);
  }
  console.log("");
  console.log("Section counts:");
  for (const isc of ISCS) {
    console.log(`${isc}:`);
    for (const [section, n] of Object.entries(report.activeAssessmentCounts[isc]).sort()) {
      console.log(`${section} ${n}`);
    }
  }
}

if (import.meta.main) {
  importHopeSpec(parseArgs(process.argv.slice(2)))
    .then(printReport)
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
