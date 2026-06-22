/**
 * WardenX — active-census demo (local dev). Makes the M5 patient census "look active".
 *
 * The demo patients (db:seed:patients) are all `prospective`. The real path to `active` is M6
 * admission activation — but the M6 routes aren't mounted in the composition root yet (Wave D landed
 * the module; live-wiring its routes is a follow-up), and a full admission chain needs reference data
 * (provider_entity / location) that isn't seeded. The M5 census reads `patient.status` directly, so we
 * set a realistic status mix here. When M6 routes are mounted, swap this for a real admission seed.
 *
 * Idempotent + deterministic: orders patients by (created_at, id) and assigns the first four `active`,
 * the fifth `on_hold`, leaving the rest `prospective`. Re-running is stable. Written under
 * `session_replication_role = replica` (skip audit triggers + RI), same pattern as the other seeds.
 *
 * Run: bun run db:seed:census   (after db:seed:patients)
 */
import { Client } from "pg";

const ADMIN_URL = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
const ORG_SLUG = "wardenx-demo";
const ACTIVE_COUNT = 4; // first N (by created_at) → active; the next one → on_hold; rest stay prospective

async function main(): Promise<void> {
  if (!ADMIN_URL) throw new Error("DATABASE_ADMIN_URL (or DATABASE_URL) is required");
  const db = new Client({ connectionString: ADMIN_URL });
  await db.connect();
  await db.query("SET session_replication_role = replica"); // skip audit triggers + RI for the seed

  const orgRes = await db.query<{ id: string }>("SELECT id FROM organization WHERE slug = $1", [
    ORG_SLUG,
  ]);
  const org = orgRes.rows[0]?.id;
  if (!org) throw new Error(`demo org '${ORG_SLUG}' not found — run db:seed first`);

  // Deterministic status assignment by rank — idempotent across re-runs.
  const res = await db.query<{ status: string; n: string }>(
    `WITH ranked AS (
       SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
       FROM patient WHERE organization_id = $1
     )
     UPDATE patient p
        SET status = CASE
              WHEN r.rn <= $2 THEN 'active'::patient_status
              WHEN r.rn = $2 + 1 THEN 'on_hold'::patient_status
              ELSE 'prospective'::patient_status
            END,
            updated_at = now()
       FROM ranked r
      WHERE p.id = r.id
      RETURNING p.status::text AS status, '1' AS n`,
    [org, ACTIVE_COUNT],
  );

  await db.end();
  const counts = res.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([s, c]) => `${c} ${s}`)
    .join(", ");
  console.log(`✓ census seed: ${summary}. Open /patients — the census now shows an active roster.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
