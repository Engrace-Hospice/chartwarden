/**
 * WardenX — M38 terminology reference data (local dev). NOT a production loader.
 *
 * WHY THIS EXISTS. `concept_rxnorm` (and its `code_system` / `code_system_version` parents) is
 * platform-shared reference data whose header says "writes only via `terminology_loader`" — an
 * external per-system loader that is not in this repository. Nothing in `db:seed:all` wrote a single
 * row, so every local and CI stack ran with an EMPTY terminology, and M12's prescribe modal takes drug
 * identity from `GET /terminology/rxnorm/search` and deliberately refuses to let a prescriber type an
 * RxCUI ("identity codes: a prescriber typing them is a transcription error waiting to be dispensed").
 * An empty search meant no concept could be selected, so no NDC could be resolved, so the modal's
 * submit stayed disabled: M12's flagship write — the one #91's own header calls "PRESCRIBING WORKS
 * NOW" — could not be exercised by a developer or by CI at all. The screen was honest about it (it
 * renders "If this deployment's terminology has not been loaded…"), which is exactly why nobody looked:
 * the failure read as a deployment fact rather than a missing seed.
 *
 * WHAT THIS IS NOT. It is not the loader, and it does not pretend to be a release of RxNorm. It seeds
 * the hospice comfort-kit drugs the demo scenarios actually prescribe, at ONE version, so the search
 * control has something real to find. The codes and NDCs below are genuine RxNorm/NDC values so that a
 * developer comparing a screen against a public RxNav page sees the same drug; the VERSION metadata is
 * synthetic and says so (`sourceFileRef: 'seed://…'`), because a fabricated checksum over a file that
 * does not exist would be a worse lie than an obviously local ref.
 *
 * Idempotent: fixed ids + ON CONFLICT DO NOTHING, and inserted under `session_replication_role =
 * replica` (skip audit triggers + RI) — the same pattern as the other scripts/db seeds.
 *
 * Run: bun run db:seed:terminology   (DATABASE_ADMIN_URL or DATABASE_URL from .env)
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

/** One fixed version id, so a re-run is idempotent rather than accumulating versions. */
const RXNORM_VERSION_ID = "38000000-0000-4000-8000-000000000001";

/**
 * Hospice comfort-kit drugs, as RxNorm SCD (semantic clinical drug) concepts — the term type a
 * prescriber actually writes against. `197696` is the morphine oral solution
 * `seed-scenario-orders-meds-idg.ts` already hard-codes, so the seeded scenario order and a drug
 * chosen through the UI now resolve to the SAME concept instead of one existing only as a bare code.
 *
 * Each carries at least one real NDC, because the order requires a packaged form and the modal blocks
 * on a concept that publishes none — a concept with an empty `ndcs` would reproduce the dead end this
 * seed exists to remove.
 */
const RXNORM_CONCEPTS: readonly [string, string, string, string, readonly string[]][] = [
  // [rxcui, display, tty, ingredientRxcui, ndcs]
  ["197696", "Morphine Sulfate 20 MG/ML Oral Solution", "SCD", "7052", ["00054-3319-63"]],
  ["1666777", "Lorazepam 2 MG/ML Oral Solution", "SCD", "6470", ["00054-3216-49"]],
  ["1046787", "Haloperidol 2 MG/ML Oral Solution", "SCD", "5093", ["00054-3027-49"]],
  ["1795589", "Glycopyrrolate 1 MG Oral Tablet", "SCD", "4955", ["00121-0768-16"]],
  ["313782", "Acetaminophen 325 MG Oral Tablet", "SCD", "161", ["50580-0449-30"]],
  ["1049221", "Oxycodone Hydrochloride 5 MG Oral Tablet", "SCD", "7804", ["00406-0552-01"]],
  ["197807", "Ondansetron 4 MG Oral Tablet", "SCD", "26225", ["00078-0673-15"]],
  ["991014", "Senna 8.6 MG Oral Tablet", "SCD", "36387", ["00904-5185-60"]],
];

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  await db.query(
    `INSERT INTO code_system (id, name, license_source, source_uri, updated_at)
     VALUES ('rxnorm', 'RxNorm', 'NLM (UMLS licence)', 'https://www.nlm.nih.gov/research/umls/rxnorm/', now())
     ON CONFLICT (id) DO NOTHING`,
  );

  // `effective_to` NULL = the current version, which is what the as-of-date resolver keys on.
  await db.query(
    `INSERT INTO code_system_version
       (id, code_system_id, version, released_on, effective_from, effective_to,
        source_file_ref, checksum, status, loaded_at)
     VALUES ($1, 'rxnorm', 'seed-local', date '2024-01-01', date '2024-01-01', NULL,
             'seed://scripts/db/seed-terminology.ts', 'seed-local-not-a-release', 'active', now())
     ON CONFLICT (id) DO NOTHING`,
    [RXNORM_VERSION_ID],
  );

  for (const [code, display, tty, ingredientRxcui, ndcs] of RXNORM_CONCEPTS) {
    await db.query(
      `INSERT INTO concept_rxnorm
         (code, display, status, effective_date, end_date, version_id, tty, ingredient_rxcui, ndcs,
          properties, created_at)
       VALUES ($1,$2,'active', date '2024-01-01', NULL, $3, $4, $5, $6, '{}'::jsonb, now())
       ON CONFLICT (code, version_id) DO NOTHING`,
      [code, display, RXNORM_VERSION_ID, tty, ingredientRxcui, ndcs],
    );
  }

  await db.end();
  console.log(
    `✓ Terminology seed: 1 code system, 1 version, ${RXNORM_CONCEPTS.length} RxNorm concepts (hospice comfort kit). The M12 prescribe modal's drug search now returns results.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
