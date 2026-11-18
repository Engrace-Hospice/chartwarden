/**
 * Read-only M25-671 migration preflight. It never creates a ledger, runs SQL migrations, or changes data.
 *
 * Preconditions it enforces (exit 2, nothing read): a non-local host must be reached with sslmode=verify-full, and the
 * connected role must be a superuser or BYPASSRLS (under RLS the data checks would see no rows and print a clean 0/0).
 *
 * Known limitation: it compares the ledger by exact filename. It does NOT model ledger-alias adoption (a database whose
 * ledger records a migration under an older or alternate name); such a migration is reported as pending/orphaned and an
 * operator decides, as for any other ledger drift.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { analyze } from "./check-migration-numbering";
import { bypassesRls, connectionRefusal, targetMigrationState } from "./lib/m25-preflight-guards";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "packages/db/migrations");
const TARGET = "1508_m25_835_group_identity_dates.sql";
const DB_URL = process.env.M25_PREFLIGHT_DATABASE_URL;
if (!DB_URL) throw new Error("Set M25_PREFLIGHT_DATABASE_URL to the database being inspected.");
const refusal = connectionRefusal(DB_URL, process.env);
if (refusal) {
  console.error(`PREFLIGHT: BLOCKED — ${refusal}`);
  process.exit(2);
}

/** A precondition failure: reported on stdout, exit 2, and nothing further is read. */
class PreflightBlocked extends Error {}

const files = readdirSync(MIGRATIONS)
  .filter((name) => /^\d{4}_[a-z0-9][a-z0-9_]*\.sql$/.test(name))
  .sort();
// The frozen historical pairs (HISTORICAL_DUPLICATE_ORDINALS, applied under those exact names in production) are not
// conflicts; only a duplicate the numbering gate itself would fail counts.
const ordinalConflicts = [...analyze(files).duplicates].map(
  ([ordinal, names]) => [String(ordinal).padStart(4, "0"), names] as const,
);

const db = new Client({ connectionString: DB_URL, options: "-c default_transaction_read_only=on" });
try {
  await db.connect();
  await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const identity = (
    await db.query<{ database_name: string; server_version_num: string }>(
      "SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num",
    )
  ).rows[0];
  console.log(
    `Read-only target: database=${identity?.database_name ?? "unknown"}, PostgreSQL=${identity?.server_version_num ?? "unknown"}`,
  );
  const role = (
    await db.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
  ).rows[0];
  if (!role || !bypassesRls(role))
    throw new PreflightBlocked(
      `PREFLIGHT: BLOCKED — connected as role ${role?.rolname ?? "unknown"}, which is neither a superuser nor BYPASSRLS. Row-level security hides every tenant row from it (app.org_id is unset), so the data checks would report 0 and look clean. Re-run as a role that bypasses RLS; this tool still makes no changes.`,
    );
  const ledger = await db.query<{ exists: boolean }>(
    "SELECT to_regclass('_chartwarden_migration') IS NOT NULL AS exists",
  );
  if (!ledger.rows[0]?.exists) {
    console.log(
      "LEDGER: BLOCKED — _chartwarden_migration is absent; operator must establish the verified historical ledger before migration.",
    );
    process.exitCode = 2;
  } else {
    const appliedRows = (
      await db.query<{ filename: string; checksum: string }>(
        "SELECT filename, checksum FROM _chartwarden_migration ORDER BY filename",
      )
    ).rows;
    const applied = new Map(appliedRows.map((row) => [row.filename, row.checksum]));
    const checksums = new Map(
      files.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(MIGRATIONS, file)))
          .digest("hex"),
      ]),
    );
    const pending = files.filter((file) => !applied.has(file));
    const historicalPending = pending.filter((file) => Number(file.slice(0, 4)) < 1508);
    const orphaned = [...applied.keys()].filter((file) => !files.includes(file));
    const drifted = files.filter(
      (file) => applied.has(file) && applied.get(file) !== checksums.get(file),
    );
    console.log(
      `LEDGER applied=${applied.size}; pending=${pending.length}; historical_pending=${historicalPending.length}; orphaned=${orphaned.length}; checksum_drift=${drifted.length}`,
    );
    if (pending.length) console.log(`Pending: ${pending.join(", ")}`);
    if (historicalPending.length)
      console.log(`Missing historical migrations: ${historicalPending.join(", ")}`);
    if (orphaned.length) console.log(`Applied ledger entries with no file: ${orphaned.join(", ")}`);
    if (drifted.length) console.log(`Checksum drift: ${drifted.join(", ")}`);

    const columns = (table: string) =>
      db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1`,
        [table],
      );
    const [adviceColumns, stageColumns] = await Promise.all([
      columns("remittance_advice"),
      columns("claimmd_era_m25_stage"),
    ]);
    const adviceSet = new Set(adviceColumns.rows.map((row) => row.column_name));
    const stageSet = new Set(stageColumns.rows.map((row) => row.column_name));
    const targetColumns = [
      "interchange_sender_code",
      "interchange_receiver_code",
      "functional_group_control_number",
      "functional_group_metadata",
      "transaction_set_position",
      "payment_effective_date",
      "adjudication_cutoff_date",
      "functional_group_creation_date",
      "payee_identity_evidence",
    ];
    const stageIdentityColumns = [
      "interchange_sender_code",
      "interchange_receiver_code",
      "functional_group_control_number",
    ];
    const columnShapes = await db.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | null;
    }>(
      "SELECT table_name, column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_schema=current_schema() AND ((table_name='remittance_advice' AND column_name IN ('production_date','interchange_sender_code','interchange_receiver_code','functional_group_control_number','functional_group_metadata','transaction_set_position','payment_effective_date','adjudication_cutoff_date','functional_group_creation_date','payee_identity_evidence')) OR (table_name='claimmd_era_m25_stage' AND column_name IN ('interchange_sender_code','interchange_receiver_code','functional_group_control_number'))) ORDER BY table_name, column_name",
    );
    const currentIndexes = await db.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname=current_schema() AND indexname IN ('ux_remittance_envelope_dedupe','claimmd_era_m25_stage_component_uq') ORDER BY indexname",
    );
    const schemaMissing = [
      ...targetColumns
        .filter((column) => !adviceSet.has(column))
        .map((column) => `remittance_advice.${column}`),
      ...stageIdentityColumns
        .filter((column) => !stageSet.has(column))
        .map((column) => `claimmd_era_m25_stage.${column}`),
    ];
    const shape = new Map(
      columnShapes.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
    );
    const expectedShapes: ReadonlyArray<readonly [string, string, number | null]> = [
      ["remittance_advice.interchange_sender_code", "character varying", 15],
      ["remittance_advice.interchange_receiver_code", "character varying", 15],
      ["remittance_advice.functional_group_control_number", "character varying", 9],
      ["remittance_advice.functional_group_metadata", "jsonb", null],
      ["remittance_advice.transaction_set_position", "integer", null],
      ["remittance_advice.payment_effective_date", "date", null],
      ["remittance_advice.adjudication_cutoff_date", "date", null],
      ["remittance_advice.functional_group_creation_date", "date", null],
      ["remittance_advice.payee_identity_evidence", "jsonb", null],
      ["claimmd_era_m25_stage.interchange_sender_code", "character varying", 15],
      ["claimmd_era_m25_stage.interchange_receiver_code", "character varying", 15],
      ["claimmd_era_m25_stage.functional_group_control_number", "character varying", 9],
    ];
    const shapeDrift = expectedShapes
      .filter(([key, dataType, maxLength]) => {
        const actual = shape.get(key);
        return (
          !actual ||
          actual.data_type !== dataType ||
          actual.character_maximum_length !== maxLength ||
          actual.is_nullable !== "YES"
        );
      })
      .map(([key]) => key);
    const productionDate = shape.get("remittance_advice.production_date");
    if (applied.has(TARGET) && (!productionDate || productionDate.is_nullable !== "YES"))
      shapeDrift.push("remittance_advice.production_date(nullable)");
    const identityChecks = await db.query<{ conname: string }>(
      "SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND c.conname IN ('remittance_advice_group_identity_complete','claimmd_era_m25_stage_group_identity_complete') ORDER BY c.conname",
    );
    const requiredChecks = [
      "remittance_advice_group_identity_complete",
      "claimmd_era_m25_stage_group_identity_complete",
    ];
    const missingChecks = applied.has(TARGET)
      ? requiredChecks.filter((name) => !identityChecks.rows.some((row) => row.conname === name))
      : [];
    console.log(
      `SCHEMA M25-671 columns_missing=${schemaMissing.length}${schemaMissing.length ? ` (${schemaMissing.join(", ")})` : ""}; shape_drift=${shapeDrift.length}${shapeDrift.length ? ` (${shapeDrift.join(", ")})` : ""}; identity_checks_missing=${missingChecks.length}${missingChecks.length ? ` (${missingChecks.join(", ")})` : ""}`,
    );
    console.log(
      `CURRENT INDEXES: ${currentIndexes.rows.length ? currentIndexes.rows.map((row) => `${row.indexname}: ${row.indexdef}`).join(" | ") : "M25 identity indexes missing"}`,
    );
    const indexByName = new Map(
      currentIndexes.rows.map((row) => [
        row.indexname,
        row.indexdef.toLowerCase().replaceAll('"', ""),
      ]),
    );
    const hasExpectedIndex = (
      name: string,
      columns: readonly string[],
      nullsNotDistinct: boolean,
    ) => {
      const definition = indexByName.get(name);
      if (!definition?.startsWith("create unique index ")) return false;
      const actualColumns = definition
        .match(/\(([^()]*)\)/)?.[1]
        ?.split(",")
        .map((column) => column.trim());
      if (!actualColumns || JSON.stringify(actualColumns) !== JSON.stringify(columns)) return false;
      return definition.includes("nulls not distinct") === nullsNotDistinct;
    };
    const expectedIndexesMatch = applied.has(TARGET)
      ? hasExpectedIndex(
          "ux_remittance_envelope_dedupe",
          [
            "organization_id",
            "provider_entity_id",
            "interchange_control_number",
            "interchange_sender_code",
            "interchange_receiver_code",
            "functional_group_control_number",
            "transaction_set_control_number",
          ],
          true,
        ) &&
        hasExpectedIndex(
          "claimmd_era_m25_stage_component_uq",
          [
            "source_inbox_id",
            "file_index",
            "interchange_sender_code",
            "interchange_receiver_code",
            "functional_group_control_number",
            "transaction_set_control_number",
          ],
          true,
        )
      : hasExpectedIndex(
          "ux_remittance_envelope_dedupe",
          ["interchange_control_number", "transaction_set_control_number", "provider_entity_id"],
          false,
        ) &&
        hasExpectedIndex(
          "claimmd_era_m25_stage_component_uq",
          ["source_inbox_id", "file_index", "transaction_set_control_number"],
          false,
        );
    console.log(
      `INDEX COMPATIBILITY: ${expectedIndexesMatch ? "expected current target" : `MISMATCH — expected ${applied.has(TARGET) ? "1508 scoped NULLS NOT DISTINCT indexes" : "pre-1508 writer indexes"}`}`,
    );
    if (!expectedIndexesMatch) {
      console.log(
        "CONSTRAINT/INDEX DRIFT: stop deployment and inspect the exact index definitions; this preflight makes no changes.",
      );
      process.exitCode = 2;
    }
    if (
      applied.has(TARGET) &&
      (schemaMissing.length > 0 || shapeDrift.length > 0 || missingChecks.length > 0)
    ) {
      console.log(
        "SCHEMA DRIFT: migration 1508 is recorded but expected provenance columns, types, nullability, or identity checks are missing.",
      );
      process.exitCode = 2;
    }
    if (!applied.has(TARGET) && currentIndexes.rows.length === 0) {
      console.log(
        "CONSTRAINT DRIFT: migration 1508 is pending but neither existing nor replacement identity indexes are present.",
      );
      process.exitCode = 2;
    }

    // Claim.MD stages still in flight (not yet posted) when 1508 lands. Their delivery idempotency key was derived before
    // it carried GS06, so a redelivery after the deploy will not match them and is staged afresh (or held as a duplicate of
    // a posted legacy advice); an operator should know how many are open and finish or reconcile them first.
    const stagePresent = (
      await db.query<{ stage: boolean; event: boolean }>(
        "SELECT to_regclass('claimmd_era_m25_stage') IS NOT NULL AS stage, to_regclass('claimmd_era_posting_event') IS NOT NULL AS event",
      )
    ).rows[0];
    if (stagePresent?.stage) {
      const unposted = stagePresent.event
        ? " AND NOT EXISTS (SELECT 1 FROM claimmd_era_posting_event e WHERE e.stage_id = s.id AND e.event_type = 'posted')"
        : "";
      const groupless = stageSet.has("functional_group_control_number")
        ? "s.functional_group_control_number IS NULL"
        : "true";
      const inFlight = (
        await db.query<{ total: number; pre_group: number }>(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE ${groupless})::int AS pre_group FROM claimmd_era_m25_stage s WHERE s.state IN ('staged','held','possible_duplicate')${unposted}`,
        )
      ).rows[0];
      console.log(
        `IN-FLIGHT CLAIM.MD STAGES non_terminal=${inFlight?.total ?? "?"}; without_group_identity=${inFlight?.pre_group ?? "?"} (a redelivery after 1508 will not match their idempotency key)`,
      );
    } else {
      console.log("IN-FLIGHT CLAIM.MD STAGES: table claimmd_era_m25_stage is absent.");
    }

    if (adviceSet.has("interchange_sender_code") && stageSet.has("interchange_sender_code")) {
      const [partialAdvice, partialStage, adviceDuplicates, stageDuplicates] = await Promise.all([
        db.query(
          "SELECT count(*)::int AS n FROM remittance_advice WHERE num_nonnulls(interchange_sender_code, interchange_receiver_code, functional_group_control_number) NOT IN (0,3)",
        ),
        db.query(
          "SELECT count(*)::int AS n FROM claimmd_era_m25_stage WHERE num_nonnulls(interchange_sender_code, interchange_receiver_code, functional_group_control_number) NOT IN (0,3)",
        ),
        db.query(
          "SELECT count(*)::int AS n FROM (SELECT organization_id, provider_entity_id, interchange_control_number, interchange_sender_code, interchange_receiver_code, functional_group_control_number, transaction_set_control_number FROM remittance_advice GROUP BY 1,2,3,4,5,6,7 HAVING count(*) > 1) d",
        ),
        db.query(
          "SELECT count(*)::int AS n FROM (SELECT source_inbox_id, file_index, interchange_sender_code, interchange_receiver_code, functional_group_control_number, transaction_set_control_number FROM claimmd_era_m25_stage GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1) d",
        ),
      ]);
      console.log(
        `DATA partial_identity=${partialAdvice.rows[0]?.n ?? "?"}/${partialStage.rows[0]?.n ?? "?"}; duplicate_scoped_keys=${adviceDuplicates.rows[0]?.n ?? "?"}/${stageDuplicates.rows[0]?.n ?? "?"}`,
      );
      const badData =
        Number(partialAdvice.rows[0]?.n ?? 1) > 0 ||
        Number(partialStage.rows[0]?.n ?? 1) > 0 ||
        Number(adviceDuplicates.rows[0]?.n ?? 1) > 0 ||
        Number(stageDuplicates.rows[0]?.n ?? 1) > 0;
      if (badData) {
        console.log(
          "PREFLIGHT: BLOCKED — inspect identity rows and repair only through an approved forward migration; this tool makes no changes.",
        );
        process.exitCode = 2;
      }
    } else {
      console.log(
        "DATA: NOT RUN — provenance columns do not exist yet; old scoped uniqueness remains in force until migration 1508.",
      );
    }

    if (ordinalConflicts.length) {
      console.log(
        `ORDINAL CONFLICTS: ${ordinalConflicts.map(([n, names]) => `${n}: ${names.join(" / ")}`).join("; ")}`,
      );
      process.exitCode = 2;
    }
    if (historicalPending.length || orphaned.length || drifted.length) process.exitCode = 2;
    // MISSING (neither applied nor a file on disk) means there is nothing to apply: never a clean pass.
    const target = targetMigrationState(TARGET, new Set(applied.keys()), pending);
    console.log(`TARGET ${TARGET}: ${target}`);
    if (target === "MISSING") process.exitCode = 2;
  }
} catch (err) {
  if (!(err instanceof PreflightBlocked)) throw err;
  console.log(err.message);
  process.exitCode = 2;
} finally {
  await db.end().catch(() => {});
}
