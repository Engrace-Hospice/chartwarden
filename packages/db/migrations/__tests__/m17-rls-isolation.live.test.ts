/**
 * M17 Scheduling & Route Optimization — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / ADR-0010).
 *
 * M17's pure suites drive the 8-state visit machine, the RRULE 90-day materializer and the four reader
 * seams, but they never touch a database, so they cannot catch a wrong RLS predicate, a missing WITH CHECK,
 * or a base-table grant that leaks across tenants. This applies the real migrations to a real Postgres and
 * drives the policies as the unprivileged `wardenx_app` role (no BYPASSRLS), covering all SEVEN org-scoped
 * M17-owned tables.
 *
 * `visit` is the highest-risk table here: it is the scheduled contact with a named patient at a named
 * address by a named clinician, and a cross-tenant write would let one tenant plant a visit into another's
 * schedule — the record EVV, encounters and billing all hang off (§3.3). `visit` is the WITH CHECK case.
 *
 * TWO OF THE SEVEN ARE RANGE-PARTITIONED (§3.3/D14): `visit` (by service_date) and `visit_state_history`
 * (by transitioned_at). Row-level policies live on the PARTITIONED PARENT and propagate to every leaf
 * (PG11+), and both parents carry a direct `_org` policy — so both stay in the policy count, and both are
 * seeded with a partition-key value that lands in a created range (current month; a DEFAULT catch-all
 * exists regardless). References TO `visit` carry no SQL FK (a partitioned table cannot be referenced), so
 * `visit_state_history.visit_id` is a plain app-validated uuid.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m17` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - Raise `max_locks_per_transaction` (512 is ample): `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and the corpus's partitioned tables put the default 64 out of reach.
 *   - For a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** patient_id / admission_id are NOT NULL but carry NO FK (M5/M6 own those tables) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = {
  providerEntity: string;
  location: string;
  user: string;
  membership: string;
  visit: string;
  visitStateHistory: string;
  recurringVisit: string;
  visitProposal: string;
  clinicianAvailability: string;
  timeOff: string;
  routeSegment: string;
};

/** The 7 org-scoped M17 tables, each with the seeded row the isolation case looks for.
 * `visit` and `visit_state_history` are RANGE-partitioned parents; their `_org` policy lives on the parent,
 * so they are counted in the policy sweep like the other five (none is excluded). */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "visit", key: "visit" },
  { table: "visit_state_history", key: "visitStateHistory" },
  { table: "recurring_visit", key: "recurringVisit" },
  { table: "visit_proposal", key: "visitProposal" },
  { table: "clinician_availability", key: "clinicianAvailability" },
  { table: "time_off", key: "timeOff" },
  { table: "route_segment", key: "routeSegment" },
];

const ALL_TABLES = COVERED.map((c) => c.table);
const PARTITIONED = ["visit", "visit_state_history"];

describe.skipIf(!DB_URL)("M17 Scheduling — RLS cross-tenant denial — LIVE Postgres (§3.5)", () => {
  let db: Client;
  let a: SeedIds;

  async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await db.query("SET ROLE wardenx_app");
    await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
    try {
      return await fn();
    } finally {
      await db.query("RESET ROLE");
    }
  }

  async function resetSchema() {
    await db.query("DROP SCHEMA IF EXISTS public CASCADE");
    await db.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M17 schedule chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes rows. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M17${n}`, `M17 Provider ${n}`, `NPI-M17${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M17${n}`],
      )
    ).rows[0].id as string;

    // REAL membership: visit.assigned_membership_id, clinician_availability/time_off/route_segment.membership_id
    // all carry SQL foreign keys to `membership`. Each org gets its own so the rows never collide on the
    // per-membership unique/exclusion backstops.
    const user = (
      await db.query(`INSERT INTO "user" (email) VALUES ('m17-rn-${n}@x.test') RETURNING id`)
    ).rows[0].id as string;
    const membership = (
      await db.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;

    // `visit` is partitioned by service_date; now()::date lands in the current-month partition (a DEFAULT
    // catch-all exists regardless). Default status 'proposed' keeps it clear of the D6 overlap EXCLUDE,
    // which only covers ('published','en_route','in_visit').
    const visit = (
      await db.query(
        `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
           now(), now() + interval '1 hour', now()::date) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership],
      )
    ).rows[0].id as string;

    // `visit_state_history` is partitioned by transitioned_at; default now() lands in the current partition.
    // visit_id is a plain uuid (no FK to the partitioned `visit`).
    const visitStateHistory = (
      await db.query(
        `INSERT INTO visit_state_history (organization_id, provider_entity_id, location_id, visit_id, to_state)
         VALUES ($1,$2,$3,$4,'proposed') RETURNING id`,
        [org, providerEntity, location, visit],
      )
    ).rows[0].id as string;

    const recurringVisit = (
      await db.query(
        `INSERT INTO recurring_visit (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, assigned_membership_id, visit_purpose, visit_setting, rrule, time_of_day_start,
           time_of_day_end, time_zone, start_date)
         VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','patient_home','FREQ=WEEKLY;BYDAY=MO','09:00','10:00',
           'America/Los_Angeles', now()::date) RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, membership],
      )
    ).rows[0].id as string;

    const visitProposal = (
      await db.query(
        `INSERT INTO visit_proposal (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, source, source_payload, source_idempotency_key, proposed_for_date,
           proposed_visit_purpose, proposed_discipline, proposed_duration_minutes)
         VALUES ($1,$2,$3,$4,$5,'frequency_driven_m7','{}'::jsonb,$6, now()::date,'routine_visit','rn',60)
         RETURNING id`,
        [org, providerEntity, location, PATIENT, ADMISSION, `idem-m17-${n}`],
      )
    ).rows[0].id as string;

    const clinicianAvailability = (
      await db.query(
        `INSERT INTO clinician_availability (organization_id, provider_entity_id, location_id, membership_id,
           day_of_week, start_time, end_time)
         VALUES ($1,$2,$3,$4,1,'08:00','17:00') RETURNING id`,
        [org, providerEntity, location, membership],
      )
    ).rows[0].id as string;

    // Default approval_state 'requested' keeps this clear of the D7 PTO-overlap EXCLUDE (approved-only).
    const timeOff = (
      await db.query(
        `INSERT INTO time_off (organization_id, provider_entity_id, location_id, membership_id,
           starts_at, ends_at, kind)
         VALUES ($1,$2,$3,$4, now(), now() + interval '1 day','pto') RETURNING id`,
        [org, providerEntity, location, membership],
      )
    ).rows[0].id as string;

    const routeSegment = (
      await db.query(
        `INSERT INTO route_segment (organization_id, provider_entity_id, location_id, membership_id,
           service_date, sequence_index, from_kind, to_kind, proposed_drive_minutes, proposed_miles,
           optimizer_version)
         VALUES ($1,$2,$3,$4, now()::date, 0,'anchor_start','visit', 15, 8,'osrm-v1') RETURNING id`,
        [org, providerEntity, location, membership],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      user,
      membership,
      visit,
      visitStateHistory,
      recurringVisit,
      visitProposal,
      clinicianAvailability,
      timeOff,
      routeSegment,
    };
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    a = await seedOrg(ORG_A, 1);
    await seedOrg(ORG_B, 2);
  }, 180_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M17 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", () => {
    const rls = readFileSync(
      join(MIGRATIONS_DIR, "0045_scheduling_m17_rls_audit_triggers.sql"),
      "utf8",
    );
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    // One canonical `_org` policy per owned table — the two partitioned parents carry theirs on the parent.
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it("RLS is ENABLED on every one of the 7 owned tables (partitioned parents included)", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
      [ALL_TABLES],
    );
    expect(rows).toHaveLength(ALL_TABLES.length);
    for (const r of rows) expect(r.relrowsecurity).toBe(true);
  });

  it("`visit` and `visit_state_history` are RANGE-partitioned; the other five are plain tables", async () => {
    const { rows } = await db.query<{ relname: string; relkind: string }>(
      "SELECT relname, relkind FROM pg_class WHERE relname = ANY($1)",
      [ALL_TABLES],
    );
    const kind = new Map(rows.map((r) => [r.relname, r.relkind]));
    for (const t of ALL_TABLES) {
      expect(kind.get(t)).toBe(PARTITIONED.includes(t) ? "p" : "r");
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0); // org B cannot read org A's row
    },
  );

  it("no M17 table grants DELETE to wardenx_app — destruction runs through the M17-T07 eraser", async () => {
    const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='wardenx_app' AND table_name = ANY($1) AND privilege_type IN ('DELETE','TRUNCATE')`,
      [ALL_TABLES],
    );
    expect(rows).toEqual([]);
  });

  it("visit_state_history is APPEND-ONLY: wardenx_app holds SELECT + INSERT and no UPDATE", async () => {
    const { rows } = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee='wardenx_app' AND table_name='visit_state_history'`,
    );
    expect([...new Set(rows.map((r) => r.privilege_type))].sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("a WITH CHECK refuses a visit forged into another tenant (the highest-risk M17 write)", async () => {
    // `visit` is the scheduled patient contact EVV/encounter/billing all hang off. A cross-tenant write
    // would let org B plant a visit into org A's schedule; the WITH CHECK on the partitioned parent (which
    // propagates to every leaf) is what makes that a permission error rather than a convention.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
             assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
             scheduled_started_at, scheduled_ended_at, service_date)
           VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
             now(), now() + interval '1 hour', now()::date)`,
          [ORG_A, a.providerEntity, a.location, PATIENT, ADMISSION, a.membership],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's recurring_visit (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE recurring_visit SET status='discontinued' WHERE id=$1", [a.recurringVisit]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query<{ status: string }>(
      "SELECT status FROM recurring_visit WHERE id=$1",
      [a.recurringVisit],
    );
    expect(still.rows[0].status).toBe("active");
  });

  it("the M4 write-audit trigger fired for the recurring_visit writes (§3.6)", async () => {
    // resource_kind is hardcoded to the parent name by audit_phi_write_recurring_visit() (0045), so a
    // non-partitioned seeded table gives an unambiguous count.
    const r = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'recurring_visit'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });
});
