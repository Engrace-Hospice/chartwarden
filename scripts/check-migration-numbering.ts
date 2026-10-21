/**
 * WardenX — migration ORDINAL uniqueness gate  (F-026)
 * ---------------------------------------------------------------------------
 * `packages/db/migrations/NNNN_name.sql` — the four-digit prefix is the migration's position in a
 * total order, and `scripts/db/migrate.ts` applies files in plain lexicographic `.sort()` order.
 * Nothing anywhere enforces that two files do not claim the SAME number.
 *
 * WHY THAT MATTERS. With a duplicate, the applied order is decided by the rest of the filename —
 * `0216_admission_location_backfill.sql` runs before `0216_m36_notification_preferences_org_scope.sql`
 * because "a" < "m", which is a coin flip nobody chose. Two migrations that are independent survive
 * it. Two that are not — a backfill and the migration that adds the column it backfills, a policy and
 * the function it calls — fail at deploy time, on whichever database applies them first, with an
 * error that points at the second file rather than at the numbering.
 *
 * It is a WHEN, not an IF, on any branch-per-change workflow: every open branch picks "the next
 * number" against `main`, so two branches opened the same afternoon pick the same one. Four of the
 * audit branches open at the time this gate was written had already collided in pairs, on 0215 and
 * 0216, and every gate in the repo was green on all four.
 *
 * WHAT IT ENFORCES
 *   · every `.sql` in the migrations directory is `NNNN_snake_name.sql` (four digits, then a name);
 *   · no two files share a prefix — a hard error, because a duplicate ordinal is never correct;
 *   · gaps are REPORTED, never fatal. A branch that leaves 0215 for a sibling PR and takes 0216 is
 *     doing the right thing, and its gap closes on merge. Failing it would punish the coordination
 *     this gate exists to support. `main` has been gapless for 215 migrations; if that stops being
 *     true the note says so without blocking anyone.
 *
 * Deliberately NOT a checksum/ordering check: `migrate.ts` already tracks filename+checksum in
 * `_wardenx_migration` and `--strict` fails the pipeline on drift. This gate answers the one
 * question that is decidable from the filenames alone, at review time, before a deploy discovers it.
 *
 * Run:  bun run arch:migration-numbering   (in `arch:fitness`)
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Rooted off the script's own file location (not process.cwd()) so it always validates the real
// migrations directory regardless of the caller's working directory. `import.meta.dir` is a Bun
// extension and is undefined under vitest's node runner, which imports this module directly;
// `import.meta.url` is standard and resolves the same path in both. `CHARTWARDEN_FITNESS_ROOT` is the
// test-only escape hatch this repo's other self-rooting gate already uses
// (check-design-tokens.ts / fitness-gates.test.ts) — unset in every real invocation.
const FITNESS_ROOT_OVERRIDE = process.env.CHARTWARDEN_FITNESS_ROOT;
const ROOT = FITNESS_ROOT_OVERRIDE ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join("packages", "db", "migrations");

/** `0216_admission_location_backfill.sql` → ordinal 216, slug `admission_location_backfill`. */
const MIGRATION_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

/**
 * The ONE sanctioned exception: ordinals 0215–0235, each claimed by exactly the two files listed.
 *
 * On 2026-09-17 `main` was force-pushed back to an Aug 25 base, dropping PRs #14–#222 (see
 * `audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md`). Both lines of history numbered their migrations from
 * 0215, and production applied BOTH sets — the dropped files on Aug 26–30, the others after Sep 17 —
 * under these exact filenames. `migrate.ts` tracks applied migrations by filename, so renumbering either
 * file would make production run it a second time. Each pair is therefore frozen as-is; the fresh-database
 * order (lexicographic within the ordinal) was proven to apply cleanly when the history was restored.
 *
 * Pinned by exact filename: a THIRD file on one of these ordinals, or any other duplicate, still fails.
 */
export const HISTORICAL_DUPLICATE_ORDINALS: ReadonlyMap<number, readonly [string, string]> =
  new Map([
    [215, ["0215_admission_m6_referral_phase1.sql", "0215_pre_org_membership_picker_definer.sql"]],
    [
      216,
      ["0216_m36_alert_correlation_dedup.sql", "0216_m36_notification_preferences_org_scope.sql"],
    ],
    [217, ["0217_m10_hope_patient_id_repair.sql", "0217_m7_care_plan_version_integrity.sql"]],
    [218, ["0218_admission_location_backfill.sql", "0218_m7_idg_proposal_governance.sql"]],
    [
      219,
      ["0219_m22_referral_documents_verified_upload.sql", "0219_session_class_portal_vendor.sql"],
    ],
    [220, ["0220_m6_admission_evidence_phase1.sql", "0220_session_scope_chk_portal_vendor.sql"]],
    [221, ["0221_credential_discipline_pa.sql", "0221_m6_admission_service_address_snapshot.sql"]],
    [222, ["0222_hope_m10_phase_1a_spec_foundation.sql", "0222_m2_device_attestation.sql"]],
    [223, ["0223_hope_m10_phase_2b_answer_engine.sql", "0223_session_scope_chk_vendor_actor.sql"]],
    [224, ["0224_hope_m10_phase_3b_sfv_withdrawn.sql", "0224_partition_rotation.sql"]],
    [
      225,
      ["0225_hearthnote_selection_write_path.sql", "0225_hope_correction_supersede_on_sign.sql"],
    ],
    [
      226,
      [
        "0226_hearthnote_assembled_output_write_path.sql",
        "0226_hope_phase_7_manual_iqies_submission.sql",
      ],
    ],
    [227, ["0227_m33_base_scope_columns.sql", "0227_org_indexes_result_and_referral_note.sql"]],
    [
      228,
      ["0228_m11_standing_order_signer_discipline.sql", "0228_portal_m31_status_change_reason.sql"],
    ],
    [229, ["0229_code_system_cms_hope.sql", "0229_m11_standing_order_scheduled_occurrence.sql"]],
    [230, ["0230_hope_m10_answer_delete_grant.sql", "0230_m37_rn_break_glass.sql"]],
    [231, ["0231_m2_membership_picker_definer.sql", "0231_m8_care_plan_link_persistence.sql"]],
    [
      232,
      [
        "0232_foundation_feature_flag_evaluation_audit.sql",
        "0232_foundation_idempotency_bodiless_response.sql",
      ],
    ],
    [233, ["0233_fhir_read_disclosure.sql", "0233_rls_force_and_hope_result_event_rls.sql"]],
    [234, ["0234_hope_submission_result_event_audit.sql", "0234_passkey_name_nullable.sql"]],
    [
      235,
      ["0235_m28_fhir_read_disclosure_force_rls.sql", "0235_provider_entity_iqies_facility_id.sql"],
    ],
  ]);

export interface Migration {
  readonly file: string;
  readonly ordinal: number;
}

export interface NumberingReport {
  readonly migrations: readonly Migration[];
  /** Files in the migrations dir that do not match `NNNN_name.sql`. */
  readonly malformed: readonly string[];
  /** Ordinals claimed by more than one file, with every claimant. Always an error. */
  readonly duplicates: ReadonlyMap<number, readonly string[]>;
  /** Ordinals whose claimants are exactly a {@link HISTORICAL_DUPLICATE_ORDINALS} pair. Not an error. */
  readonly historical: readonly number[];
  /** Ordinals with no file below the maximum. Advisory — see the header. */
  readonly gaps: readonly number[];
}

export function analyze(
  files: readonly string[],
  historicalDuplicates: ReadonlyMap<number, readonly string[]> = HISTORICAL_DUPLICATE_ORDINALS,
): NumberingReport {
  const migrations: Migration[] = [];
  const malformed: string[] = [];
  for (const file of files) {
    const match = MIGRATION_NAME.exec(file);
    if (match) migrations.push({ file, ordinal: Number(match[1]) });
    else malformed.push(file);
  }
  migrations.sort((a, b) => a.file.localeCompare(b.file));

  const byOrdinal = new Map<number, string[]>();
  for (const { file, ordinal } of migrations) {
    const claimants = byOrdinal.get(ordinal);
    if (claimants) claimants.push(file);
    else byOrdinal.set(ordinal, [file]);
  }

  const duplicates = new Map<number, readonly string[]>();
  const historical: number[] = [];
  for (const [ordinal, claimants] of byOrdinal) {
    if (claimants.length < 2) continue;
    const sanctioned = historicalDuplicates.get(ordinal);
    const isSanctionedPair =
      sanctioned !== undefined &&
      claimants.length === sanctioned.length &&
      sanctioned.every((f) => claimants.includes(f));
    if (isSanctionedPair) historical.push(ordinal);
    else duplicates.set(ordinal, claimants);
  }

  const gaps: number[] = [];
  if (migrations.length > 0) {
    const max = Math.max(...byOrdinal.keys());
    for (let n = 0; n <= max; n += 1) if (!byOrdinal.has(n)) gaps.push(n);
  }

  return { migrations, malformed, duplicates, historical, gaps };
}

export function readMigrations(root = ROOT): string[] {
  return readdirSync(join(root, MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function main(): void {
  const files = readMigrations();
  const { migrations, malformed, duplicates, historical, gaps } = analyze(files);

  // Guard on the guard: an empty read would make every check below pass over nothing. It asserts a
  // property of the REAL corpus, so it is skipped under the fixture override — a planted-violation
  // tree is two files by design, and tripping this instead of the duplicate rule would make the
  // fixture pass for the wrong reason, which is its own small version of a vacuous gate.
  if (!FITNESS_ROOT_OVERRIDE && migrations.length < 100) {
    console.error(
      `FAIL check-migration-numbering: only ${migrations.length} migration(s) found in ${MIGRATIONS_DIR}.
That is far below the known corpus (200+) — the directory read or MIGRATION_NAME has broken.
Refusing to report success on a set this small.`,
    );
    process.exit(1);
  }

  if (malformed.length > 0) {
    console.error(
      `FAIL check-migration-numbering: ${malformed.length} file(s) are not \`NNNN_snake_name.sql\`.
The four-digit prefix IS the migration's position in the apply order, so a file without one has no
defined place in it:\n${malformed.map((f) => `  - ${f}`).join("\n")}`,
    );
    process.exit(1);
  }

  if (duplicates.size > 0) {
    const detail = [...duplicates.entries()]
      .sort(([a], [b]) => a - b)
      .map(([ordinal, claimants]) =>
        [
          `  ${String(ordinal).padStart(4, "0")} is claimed by ${claimants.length} files:`,
          ...claimants.map((f) => `      - ${f}`),
        ].join("\n"),
      )
      .join("\n");
    console.error(
      `FAIL check-migration-numbering: ${duplicates.size} migration ordinal(s) are claimed twice.
\`migrate.ts\` applies files in lexicographic order, so which one runs first is decided by the rest of
the filename — not by anyone's intent. Renumber the one that landed second to the next free ordinal:
${detail}`,
    );
    process.exit(1);
  }

  // Advisory only, and deliberately so — a branch may legitimately leave a number for a sibling PR.
  const gapNote =
    gaps.length > 0
      ? `; ${gaps.length} gap(s) below the maximum (${gaps.map((n) => String(n).padStart(4, "0")).join(", ")}) — not an error, see the header`
      : "";
  const historicalNote =
    historical.length > 0
      ? ` (except the ${historical.length} frozen historical pair(s) in HISTORICAL_DUPLICATE_ORDINALS)`
      : "";
  console.log(
    `OK migration-numbering: ${migrations.length} migration(s), every ordinal claimed exactly once${historicalNote}${gapNote}`,
  );
}

if (import.meta.main) main();
