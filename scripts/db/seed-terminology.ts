/**
 * ChartWarden — M38 terminology reference data (local dev). NOT a production loader.
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
 * ICD-10-CM and LOINC get a small STARTER SUBSET too (`lib/terminology-starter-set.ts`) so the diagnosis and
 * lab-order pickers work offline. The ICD rows sit under the loader's own FY2026/FY2027 version ids and
 * dates with checksum `seed-local-subset`, so `bun run db:load:icd10cm` replaces them in place (a subset
 * under any other id would show every code twice: search filters by concept dates, not version).
 * Because this makes "an ICD-10-CM version exists", DocLens coding checks run against the subset until the
 * full release is loaded. SNOMED is not seeded (affiliate licence).
 *
 * Idempotent: fixed ids + ON CONFLICT DO NOTHING, and inserted under `session_replication_role =
 * replica` (skip audit triggers + RI) — the same pattern as the other scripts/db seeds.
 *
 * Run: bun run db:seed:terminology   (DATABASE_ADMIN_URL or DATABASE_URL from .env)
 */
import { Client } from "pg";
import { ICD10CM_FY2026, ICD10CM_FY2027, type Icd10cmVersion } from "./lib/icd10cm-versions";
import {
  ICD10CM_STARTER_CODES,
  ICD10CM_STARTER_LICENSE,
  LOINC_STARTER_CODES,
  LOINC_STARTER_LICENSE,
} from "./lib/terminology-starter-set";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;

/** One fixed version id, so a re-run is idempotent rather than accumulating versions. */
const RXNORM_VERSION_ID = "38000000-0000-4000-8000-000000000001";
const LOINC_VERSION_ID = "38000000-0000-4000-8000-000000000002";
const SUBSET_CHECKSUM = "seed-local-subset";
const SEED_SOURCE_REF = "seed://scripts/db/seed-terminology.ts";
const STARTER_EFFECTIVE = "2024-01-01";

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

async function seedIcd10cm(db: Client): Promise<void> {
  await db.query(
    `INSERT INTO code_system (id, name, license_source, source_uri, updated_at)
     VALUES ('icd10cm', 'ICD-10-CM', $1, 'https://www.cms.gov/medicare/coding/icd10', now())
     ON CONFLICT (id) DO NOTHING`,
    [ICD10CM_STARTER_LICENSE],
  );
  const versions: readonly [Icd10cmVersion, "superseded" | "active"][] = [
    [ICD10CM_FY2026, "superseded"],
    [ICD10CM_FY2027, "active"],
  ];
  for (const [v, status] of versions) {
    await db.query(
      `INSERT INTO code_system_version
         (id, code_system_id, version, released_on, effective_from, effective_to,
          source_file_ref, checksum, status, loaded_at)
       VALUES ($1, 'icd10cm', $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (id) DO NOTHING`,
      [
        v.id,
        v.version,
        v.releasedOn,
        v.effectiveFrom,
        v.effectiveTo,
        SEED_SOURCE_REF,
        SUBSET_CHECKSUM,
        status,
      ],
    );
    for (const c of ICD10CM_STARTER_CODES) {
      await db.query(
        `INSERT INTO concept_icd10cm
           (code, display, status, effective_date, end_date, version_id, is_billable_leaf, chapter,
            properties, created_at)
         VALUES ($1,$2,'active',$3,$4,$5,true,$6,$7::jsonb,now())
         ON CONFLICT (code, version_id) DO NOTHING`,
        [
          c.code,
          c.display,
          v.effectiveFrom,
          v.effectiveTo,
          v.id,
          c.chapter,
          JSON.stringify({
            shortTitle: c.display,
            hasCodeFirstNote: false,
            useAdditionalCode: false,
            manifestation: false,
          }),
        ],
      );
    }
  }
}

async function seedLoinc(db: Client): Promise<void> {
  await db.query(
    `INSERT INTO code_system (id, name, license_source, source_uri, updated_at)
     VALUES ('loinc', 'LOINC', $1, 'https://loinc.org', now())
     ON CONFLICT (id) DO NOTHING`,
    [LOINC_STARTER_LICENSE],
  );
  await db.query(
    `INSERT INTO code_system_version
       (id, code_system_id, version, released_on, effective_from, effective_to,
        source_file_ref, checksum, status, loaded_at)
     VALUES ($1, 'loinc', 'seed-local', date '${STARTER_EFFECTIVE}', date '${STARTER_EFFECTIVE}', NULL,
             $2, $3, 'active', now())
     ON CONFLICT (id) DO NOTHING`,
    [LOINC_VERSION_ID, SEED_SOURCE_REF, SUBSET_CHECKSUM],
  );
  for (const c of LOINC_STARTER_CODES) {
    await db.query(
      `INSERT INTO concept_loinc
         (code, display, status, effective_date, end_date, version_id, properties, created_at)
       VALUES ($1,$2,'active', date '${STARTER_EFFECTIVE}', NULL, $3, '{}'::jsonb, now())
       ON CONFLICT (code, version_id) DO NOTHING`,
      [c.code, c.display, LOINC_VERSION_ID],
    );
  }
}

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL or DATABASE_URL must be set");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  await db.query(
    `INSERT INTO code_system (id, name, license_source, source_uri, updated_at)
     VALUES ('rxnorm', 'RxNorm', 'umls', 'https://www.nlm.nih.gov/research/umls/rxnorm/', now())
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

  await seedIcd10cm(db);
  await seedLoinc(db);

  await db.end();
  console.log(
    `✓ Terminology seed: ${RXNORM_CONCEPTS.length} RxNorm concepts (hospice comfort kit), ${ICD10CM_STARTER_CODES.length} ICD-10-CM codes (FY2026 + FY2027 subset; db:load:icd10cm replaces it), ${LOINC_STARTER_CODES.length} LOINC concepts. The drug, diagnosis and lab pickers now return results.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
