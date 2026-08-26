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
// `import.meta.url` is standard and resolves the same path in both. `WARDENX_FITNESS_ROOT` is the
// test-only escape hatch this repo's other self-rooting gate already uses
// (check-design-tokens.ts / fitness-gates.test.ts) — unset in every real invocation.
const FITNESS_ROOT_OVERRIDE = process.env.WARDENX_FITNESS_ROOT;
const ROOT = FITNESS_ROOT_OVERRIDE ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join("packages", "db", "migrations");

/** `0216_admission_location_backfill.sql` → ordinal 216, slug `admission_location_backfill`. */
const MIGRATION_NAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;

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
  /** Ordinals with no file below the maximum. Advisory — see the header. */
  readonly gaps: readonly number[];
}

export function analyze(files: readonly string[]): NumberingReport {
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
  for (const [ordinal, claimants] of byOrdinal)
    if (claimants.length > 1) duplicates.set(ordinal, claimants);

  const gaps: number[] = [];
  if (migrations.length > 0) {
    const max = Math.max(...byOrdinal.keys());
    for (let n = 0; n <= max; n += 1) if (!byOrdinal.has(n)) gaps.push(n);
  }

  return { migrations, malformed, duplicates, gaps };
}

export function readMigrations(root = ROOT): string[] {
  return readdirSync(join(root, MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function main(): void {
  const files = readMigrations();
  const { migrations, malformed, duplicates, gaps } = analyze(files);

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
  console.log(
    `OK migration-numbering: ${migrations.length} migration(s), every ordinal claimed exactly once${gapNote}`,
  );
}

if (import.meta.main) main();
