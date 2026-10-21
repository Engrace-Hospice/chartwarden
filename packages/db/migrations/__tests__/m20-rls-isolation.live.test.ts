/**
 * M20 Field Safety — RLS cross-tenant denial: the LIVE Postgres proof (§3.5 / §9.3 / ADR-0010).
 *
 * The pure suites (apps/backend/__tests__/field-safety-*.test.ts) exercise the §2.2.2 SOS machine, the D4
 * overdue ladder, the D5 cancel gate, the §4.5 composed resolver and the §4.1 authz composition, but they
 * never touch a database — so they cannot catch a wrong RLS predicate, a missing WITH CHECK, an UPDATE
 * grant on an append-only ledger, or a stream guard that lets a sampler keep running. This test applies
 * the real migrations to a real Postgres and exercises the policies as the unprivileged `chartwarden_app` role.
 *
 * `chartwarden_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies
 * every assertion below vacuously. That is asserted FIRST, before a single isolation case runs (the
 * M15-T07 lesson).
 *
 * M20 IS ONE POLICY SHAPE, NOT TWO, AND THAT IS THE FIRST THING WORTH PROVING. Unlike M19 — whose
 * `triage_protocol` pair is a platform-floor-plus-overlay needing three command-split policies — every M20
 * table gets the canonical `organization_id = current_setting('app.org_id')` policy, because M20 owns NO
 * org-NULL row anywhere: M20-F03 struck the platform `safety_policy` row (the floor is a code constant,
 * `SAFETY_POLICY_FLOOR`). So the "is any row visible to both tenants?" case here expects ZERO, where the
 * M19 equivalent expects the 28-protocol floor. A future org-NULL row would be a silent tenancy leak that
 * nothing else in the suite would notice.
 *
 * THREE M20-SPECIFIC INVARIANTS GET THEIR OWN CASES, because each encodes a rule that is otherwise only a
 * code-review convention:
 *
 *   1. **FOUR append-only ledgers, not two.** `safety_policy_version`, `safety_sos_location_stream`,
 *      `safety_sos_alert_state_history` and `safety_incident_state_history` carry SELECT + INSERT and no
 *      UPDATE. The policy-version one is the load-bearing case: an UPDATE grant there would let a tenant
 *      retroactively rewrite the cadence that was in force during a past incident, which is the exact
 *      thing the version table exists to make impossible.
 *   2. **The §2.3 active-SOS stream guard.** `safety_sos_location_stream` is continuous location tracking
 *      of a named worker, and the D6 consent authorizing it is scoped to an ACTIVE alert. A row written
 *      after the alert resolved is surveillance nobody consented to, arriving through exactly the path
 *      §8.7 exists to close — a sampler that kept running because nothing told it to stop. The guard is a
 *      BEFORE INSERT trigger rather than a CHECK because a CHECK cannot read another table, and it must
 *      admit `emergency_terminus`: per M20-F05 that state loops rather than ending, and it is precisely
 *      when knowing where she is matters most.
 *   3. **`NULLS NOT DISTINCT` on the subscription pair.** Three of the four key columns are nullable, so
 *      an ordinary UNIQUE index would treat every (supervisor, NULL, location, NULL) row as distinct and
 *      the §2.2.5 one-active-pair rule would not be a rule at all.
 *
 * NOTHING IN M20 IS PARTITIONED, deliberately: `safety_sos_location_stream` is the only table with the
 * volume to suggest it, and a partition key on `sampled_at` would have had to join the stream guard's
 * parent lookup and the §3.7 eraser's per-alert sweep for no gain at Phase-1 volumes.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m20` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector**: the chain declares COLUMNS of type `vector`, so stripping the
 *     extension DDL cannot make a plain image work. Use `pgvector/pgvector:pgNN`.
 *   - Raise `max_locks_per_transaction` (512 is ample) — `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and the chain's partitioned tables (other modules') put the default 64 well out of reach.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

type SeedIds = {
  pe: string;
  location: string;
  user: string;
  membership: string;
  supervisorUser: string;
  supervisor: string;
  policy: string;
  policyVersion: string;
  schedule: string;
  checkIn: string;
  sos: string;
  stream: string;
  sosHistory: string;
  incident: string;
  incidentHistory: string;
  acknowledgment: string;
  subscription: string;
  area: string;
  consent: string;
};

/** The 13 org-scoped M20 tables, each with the seeded row the isolation case looks for. */
const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "safety_policy", key: "policy" },
  { table: "safety_policy_version", key: "policyVersion" },
  { table: "safety_check_in_schedule", key: "schedule" },
  { table: "safety_check_in", key: "checkIn" },
  { table: "safety_sos_alert", key: "sos" },
  { table: "safety_sos_location_stream", key: "stream" },
  { table: "safety_sos_alert_state_history", key: "sosHistory" },
  { table: "safety_incident", key: "incident" },
  { table: "safety_incident_state_history", key: "incidentHistory" },
  { table: "safety_acknowledgment", key: "acknowledgment" },
  { table: "safety_supervisor_subscription", key: "subscription" },
  { table: "safety_high_risk_area", key: "area" },
  { table: "safety_emergency_contact_consent", key: "consent" },
];

const ALL_TABLES = COVERED.map((c) => c.table);

/** §8.8.1's "INSERT only" set — SELECT + INSERT, never UPDATE (see invariant 1 in the header). */
const APPEND_ONLY = [
  "safety_policy_version",
  "safety_sos_location_stream",
  "safety_sos_alert_state_history",
  "safety_incident_state_history",
];

/** A square ring around a plausible address, closed, four points — §3.3's polygon shape rules. */
const POLYGON = JSON.stringify([
  [
    [-122.68, 45.51],
    [-122.67, 45.51],
    [-122.67, 45.52],
    [-122.68, 45.51],
  ],
]);

describe.skipIf(!DB_URL)(
  "M20 Field Safety — RLS cross-tenant denial — LIVE Postgres (§3.5)",
  () => {
    let db: Client;
    let a: SeedIds;

    async function withOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_app");
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
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        }
        await db.query(sql);
      }
    }

    /** Seed one full M20 chain for `org` as superuser (RLS + grants bypassed). `n` distinguishes the rows. */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const pe = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'00020${n}','PE','20345678${n}','enc','0930') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Branch','1 Main St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      // REAL memberships: M20's attribution columns carry SQL foreign keys to `membership`, and the
      // subscription pair needs TWO distinct people — `m20_sss_no_self_supervision` refuses a row where the
      // supervisor and the clinician are the same membership.
      const user = (
        await db.query(`INSERT INTO "user" (email) VALUES ('m20-rn-${n}@x.test') RETURNING id`)
      ).rows[0].id as string;
      const membership = (
        await db.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const supervisorUser = (
        await db.query(`INSERT INTO "user" (email) VALUES ('m20-supv-${n}@x.test') RETURNING id`)
      ).rows[0].id as string;
      const supervisor = (
        await db.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [supervisorUser, org],
        )
      ).rows[0].id as string;

      const policy = (
        await db.query(
          `INSERT INTO safety_policy (organization_id, created_by_membership_id)
         VALUES ($1,$2) RETURNING id`,
          [org, supervisor],
        )
      ).rows[0].id as string;
      // Every value inside its `m20_spv_*_band` and satisfying the `m20_spv_overdue_ladder` ordering.
      const policyVersion = (
        await db.query(
          `INSERT INTO safety_policy_version (organization_id, safety_policy_id, mid_visit_cadence_minutes,
           mid_visit_min_visit_duration_minutes, pre_visit_window_minutes, post_visit_window_minutes,
           gentle_reminder_minutes, supervisor_alert_minutes, escalation_minutes, sos_equivalent_minutes,
           sos_cancel_window_seconds, sos_tier_1_sla_seconds, sos_tier_2_sla_seconds,
           sos_tier_3_sla_seconds, effective_from)
         VALUES ($1,$2,60,45,15,5,3,10,20,30,5,30,60,120, now() - interval '30 days') RETURNING id`,
          [org, policy],
        )
      ).rows[0].id as string;
      await db.query("UPDATE safety_policy SET current_version_id=$1 WHERE id=$2", [
        policyVersion,
        policy,
      ]);

      // A visit-bound obligation needs a `visit_id` (`m20_scis_visit_kind`); M20 holds no visit table, so
      // the column is a logical M17 reference and any uuid satisfies the constraint.
      const visitId = (await db.query("SELECT gen_random_uuid() AS id")).rows[0].id as string;
      const schedule = (
        await db.query(
          `INSERT INTO safety_check_in_schedule (organization_id, provider_entity_id, location_id, visit_id,
           clinician_membership_id, kind, expected_at, window_minutes, safety_policy_version_id)
         VALUES ($1,$2,$3,$4,$5,'pre_visit', now() + interval '15 minutes', 15, $6) RETURNING id`,
          [org, pe, location, visitId, membership, policyVersion],
        )
      ).rows[0].id as string;
      const checkIn = (
        await db.query(
          `INSERT INTO safety_check_in (organization_id, provider_entity_id, location_id, visit_id,
           schedule_id, posted_by_membership_id, kind, status, safety_policy_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,'pre_visit','ok',$7) RETURNING id`,
          [org, pe, location, visitId, schedule, membership, policyVersion],
        )
      ).rows[0].id as string;
      // `m20_scis_recorded_fulfilled`: a `recorded` obligation must name the check-in that fulfilled it.
      await db.query(
        "UPDATE safety_check_in_schedule SET state='recorded', fulfilled_by_check_in_id=$1 WHERE id=$2",
        [checkIn, schedule],
      );

      // An OPEN alert: the stream guard admits only these states, and the seeded stream row below needs one.
      const sos = (
        await db.query(
          `INSERT INTO safety_sos_alert (organization_id, provider_entity_id, location_id,
           posted_by_membership_id, posted_coordinates_cipher, posted_coordinates_accuracy_m,
           coordinates_consent_at, cancel_window_expired_at, lifecycle_state, safety_policy_version_id)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea,12, now(), now() + interval '5 seconds','acknowledging',$5)
         RETURNING id`,
          [org, pe, location, membership, policyVersion],
        )
      ).rows[0].id as string;
      const stream = (
        await db.query(
          `INSERT INTO safety_sos_location_stream (organization_id, provider_entity_id, location_id,
           sos_alert_id, coordinates_cipher, accuracy_m)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea, 12) RETURNING id`,
          [org, pe, location, sos],
        )
      ).rows[0].id as string;
      const sosHistory = (
        await db.query(
          `INSERT INTO safety_sos_alert_state_history (organization_id, provider_entity_id, location_id,
           sos_alert_id, from_state, to_state)
         VALUES ($1,$2,$3,$4,'raised','acknowledging') RETURNING id`,
          [org, pe, location, sos],
        )
      ).rows[0].id as string;

      // A DRAFT incident: `m20_si_narrative_floor` only demands ≥200 cipher bytes once it leaves draft.
      const incident = (
        await db.query(
          `INSERT INTO safety_incident (organization_id, provider_entity_id, location_id,
           affected_clinician_membership_id, reported_by_membership_id, category, severity, occurred_at,
           narrative_cipher, safety_policy_version_id)
         VALUES ($1,$2,$3,$4,$5,'dog_bite','moderate', now() - interval '1 hour','\\x00'::bytea,$6)
         RETURNING id`,
          [org, pe, location, membership, membership, policyVersion],
        )
      ).rows[0].id as string;
      const incidentHistory = (
        await db.query(
          `INSERT INTO safety_incident_state_history (organization_id, provider_entity_id, location_id,
           incident_id, from_state, to_state)
         VALUES ($1,$2,$3,$4,'draft','submitted') RETURNING id`,
          [org, pe, location, incident],
        )
      ).rows[0].id as string;
      // `m20_sack_action_taken` wants ≥20 characters and `m20_sack_one_target` exactly one target FK.
      const acknowledgment = (
        await db.query(
          `INSERT INTO safety_acknowledgment (organization_id, provider_entity_id, location_id, target_kind,
           sos_alert_id, acknowledged_by_membership_id, action_taken)
         VALUES ($1,$2,$3,'sos_alert',$4,$5,'Called her mobile and she answered safe') RETURNING id`,
          [org, pe, location, sos, supervisor],
        )
      ).rows[0].id as string;

      const subscription = (
        await db.query(
          `INSERT INTO safety_supervisor_subscription (organization_id, supervisor_membership_id,
           clinician_membership_id, scope_kind, alert_kinds)
         VALUES ($1,$2,$3,'explicit', ARRAY['sos','overdue']::text[]) RETURNING id`,
          [org, supervisor, membership],
        )
      ).rows[0].id as string;
      const area = (
        await db.query(
          `INSERT INTO safety_high_risk_area (organization_id, risk_category, advisory_message, polygon,
           created_by_membership_id)
         VALUES ($1,'documented_prior_incident','Ring the bell and wait at the gate',$2::jsonb,$3)
         RETURNING id`,
          [org, POLYGON, supervisor],
        )
      ).rows[0].id as string;
      const consent = (
        await db.query(
          `INSERT INTO safety_emergency_contact_consent (organization_id, clinician_membership_id,
           consent_purpose, consent_scope_detail, acknowledgment_text_snapshot)
         VALUES ($1,$2,'sos_coordinates','{}'::jsonb,'I agree my location may be shared with an SOS.')
         RETURNING id`,
          [org, membership],
        )
      ).rows[0].id as string;

      return {
        pe,
        location,
        user,
        membership,
        supervisorUser,
        supervisor,
        policy,
        policyVersion,
        schedule,
        checkIn,
        sos,
        stream,
        sosHistory,
        incident,
        incidentHistory,
        acknowledgment,
        subscription,
        area,
        consent,
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

    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolbypassrls).toBe(false);
    });

    it("every M20 policy keys ONLY on app.org_id (no subqueries / pg_has_role / second pivot)", () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0111_field_safety_m20_rls_audit_triggers.sql"),
        "utf8",
      );
      const policyBlocks =
        rls.match(/CREATE POLICY[\s\S]*?(?:WITH CHECK \([^;]*\)|USING \([^;]*\));/g) ?? [];
      // ONE canonical policy per owned table — no floor-plus-overlay anywhere in M20 (header, para 3).
      expect(policyBlocks.length).toBe(ALL_TABLES.length);
      for (const block of policyBlocks) {
        const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((mm) => mm[1]);
        expect(vars.length).toBeGreaterThan(0);
        for (const v of vars) expect(v).toBe("app.org_id");
        expect(block).not.toMatch(/pg_has_role/i);
        // No EXISTS-subquery tenancy: tenancy is a column, never a join (ADR-0010 D2). A parent-join policy
        // on `safety_sos_location_stream` would have been the obvious shape and is exactly what the
        // denormalized organization_id on every child row exists to avoid.
        expect(block).not.toMatch(/EXISTS\s*\(/i);
        // The PE / Location narrowing is M3 ABAC at the handler (`safety_supervisor_or_above`,
        // `active_sos_responder`, `clinician_self`), never a second pivot that would OR rather than AND.
        expect(block).not.toMatch(/provider_entity_id\s*=/i);
        expect(block).not.toMatch(/location_id\s*=/i);
      }
    });

    it("RLS is ENABLED on every one of the 13 owned tables", async () => {
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relkind IN ('r','p')`,
        [ALL_TABLES],
      );
      expect(rows).toHaveLength(ALL_TABLES.length);
      for (const r of rows) expect(r.relrowsecurity).toBe(true);
    });

    it("NOTHING in M20 is partitioned", async () => {
      const { rows } = await db.query<{ relname: string; relkind: string }>(
        "SELECT relname, relkind FROM pg_class WHERE relname = ANY($1)",
        [ALL_TABLES],
      );
      expect(rows).toHaveLength(ALL_TABLES.length);
      for (const r of rows) expect(r.relkind).toBe("r");
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

    it.each(ALL_TABLES)(
      "%s holds NO org-NULL row — M20 has no platform floor in the database (M20-F03)",
      async (table) => {
        // The M19 analogue of this case expects 28 rows (the protocol floor). Here zero is the assertion:
        // `SAFETY_POLICY_FLOOR` is a code constant, and an org-NULL row appearing later would be visible to
        // no tenant under these policies while still existing — a silent leak nothing else here would catch.
        const { rows } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE organization_id IS NULL`,
        );
        expect(rows[0].n).toBe(0);
      },
    );

    it.each(APPEND_ONLY)(
      "%s is APPEND-ONLY: chartwarden_app holds SELECT + INSERT and no UPDATE",
      async (table) => {
        const { rows } = await db.query<{ privilege_type: string }>(
          `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee='chartwarden_app' AND table_name=$1`,
          [table],
        );
        expect([...new Set(rows.map((r) => r.privilege_type))].sort()).toEqual([
          "INSERT",
          "SELECT",
        ]);
      },
    );

    it("a tenant cannot rewrite the policy version a past incident was judged under", async () => {
      // The load-bearing half of the append-only rule: withholding UPDATE is what makes retroactively
      // loosening a cadence a PERMISSION error rather than a code-review convention.
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE safety_policy_version SET mid_visit_cadence_minutes=120 WHERE id=$1", [
            a.policyVersion,
          ]),
        ),
      ).rejects.toThrow();
      const after = await db.query<{ mid_visit_cadence_minutes: number }>(
        "SELECT mid_visit_cadence_minutes FROM safety_policy_version WHERE id=$1",
        [a.policyVersion],
      );
      expect(after.rows[0].mid_visit_cadence_minutes).toBe(60);
    });

    it("chartwarden_app may DELETE only a check-in schedule — every other M20 table goes through the M4 eraser", async () => {
      // Migration 0238: retiring a `proposed` check-in obligation is a DELETE (schedule-plan.ts), audited by
      // 0111's write-audit trigger. That one grant is the exception; no TRUNCATE anywhere, no DELETE elsewhere.
      const { rows } = await db.query<{ table_name: string; privilege_type: string }>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
       WHERE grantee='chartwarden_app' AND table_name = ANY($1) AND privilege_type IN ('DELETE','TRUNCATE')`,
        [ALL_TABLES],
      );
      expect(rows).toEqual([{ table_name: "safety_check_in_schedule", privilege_type: "DELETE" }]);
    });

    it("a tenant cannot INSERT a row carrying ANOTHER org's id (the WITH CHECK half)", async () => {
      // A USING-only policy would let org A write a row stamped org B and then be unable to see it — the row
      // would still exist in org B's tenant. The WITH CHECK is what makes that impossible.
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO safety_check_in (organization_id, provider_entity_id, posted_by_membership_id,
             kind, status, safety_policy_version_id)
           VALUES ($1,$2,$3,'ad_hoc','ok',$4)`,
            [ORG_B, a.pe, a.membership, a.policyVersion],
          ),
        ),
      ).rejects.toThrow();
    });

    it("an UPDATE cannot move a row from org A into org B", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE safety_sos_alert SET organization_id=$1 WHERE id=$2", [ORG_B, a.sos]),
        ),
      ).rejects.toThrow();
      const still = await db.query<{ organization_id: string }>(
        "SELECT organization_id FROM safety_sos_alert WHERE id=$1",
        [a.sos],
      );
      expect(still.rows[0].organization_id).toBe(ORG_A);
    });

    it("the §2.3 stream guard REFUSES a sample once the alert is no longer open (§8.7 / D6)", async () => {
      // Resolve the alert as superuser, then try to keep sampling. This is the sampler-that-kept-running
      // path: a stream row written after the alert closed is surveillance the clinician did not consent to.
      const closed = (
        await db.query<{ id: string }>(
          `INSERT INTO safety_sos_alert (organization_id, provider_entity_id, location_id,
           posted_by_membership_id, posted_coordinates_cipher, posted_coordinates_accuracy_m,
           coordinates_consent_at, cancel_window_expired_at, lifecycle_state, acknowledged_at,
           acknowledged_by_membership_id, resolved_at, resolved_by_membership_id, outcome,
           safety_policy_version_id)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea,12, now(), now() + interval '5 seconds','resolved', now(),
                 $5, now(), $5, 'clinician_safe_continued', $6)
         RETURNING id`,
          [ORG_A, a.pe, a.location, a.membership, a.supervisor, a.policyVersion],
        )
      ).rows[0].id;

      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO safety_sos_location_stream (organization_id, provider_entity_id, location_id,
             sos_alert_id, coordinates_cipher, accuracy_m)
           VALUES ($1,$2,$3,$4,'\\x00'::bytea, 9)`,
            [ORG_A, a.pe, a.location, closed],
          ),
        ),
      ).rejects.toThrow(/M20_SOS_STREAM_NOT_ACTIVE/);

      // …and the OPEN alert still accepts one, so the guard is a gate rather than a wall.
      const ok = await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO safety_sos_location_stream (organization_id, provider_entity_id, location_id,
           sos_alert_id, coordinates_cipher, accuracy_m)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea, 9) RETURNING id`,
          [ORG_A, a.pe, a.location, a.sos],
        ),
      );
      expect(ok.rows).toHaveLength(1);
    });

    it("the stream guard admits emergency_terminus — M20-F05 makes it OPEN, not terminal", async () => {
      // The state during which knowing where she is matters MOST. Excluding it would cut the feed at the
      // worst possible moment, and it is the one open-set member a later reader is most likely to "tidy up".
      const terminus = (
        await db.query<{ id: string }>(
          `INSERT INTO safety_sos_alert (organization_id, provider_entity_id, location_id,
           posted_by_membership_id, posted_coordinates_cipher, posted_coordinates_accuracy_m,
           coordinates_consent_at, cancel_window_expired_at, lifecycle_state, safety_policy_version_id)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea,12, now(), now() + interval '5 seconds','emergency_terminus',$5)
         RETURNING id`,
          [ORG_A, a.pe, a.location, a.membership, a.policyVersion],
        )
      ).rows[0].id;
      const res = await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO safety_sos_location_stream (organization_id, provider_entity_id, location_id,
           sos_alert_id, coordinates_cipher, accuracy_m)
         VALUES ($1,$2,$3,$4,'\\x00'::bytea, 9) RETURNING id`,
          [ORG_A, a.pe, a.location, terminus],
        ),
      );
      expect(res.rows).toHaveLength(1);
    });

    it("the stream guard fails CLOSED on a parent the caller cannot see", async () => {
      // Org B's alert is invisible to org A under RLS, so the guard's lookup finds nothing. "Unknown parent"
      // must raise rather than insert — an open-by-default lookup would be a cross-tenant write path.
      const bAlert = (
        await db.query<{ id: string }>(
          "SELECT id FROM safety_sos_alert WHERE organization_id=$1 LIMIT 1",
          [ORG_B],
        )
      ).rows[0].id;
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO safety_sos_location_stream (organization_id, provider_entity_id, location_id,
             sos_alert_id, coordinates_cipher, accuracy_m)
           VALUES ($1,$2,$3,$4,'\\x00'::bytea, 9)`,
            [ORG_A, a.pe, a.location, bAlert],
          ),
        ),
      ).rejects.toThrow();
    });

    it("the §2.2.5 one-active-pair rule holds through NULLs (NULLS NOT DISTINCT)", async () => {
      // Three of the four key columns are nullable. Under ordinary UNIQUE semantics every
      // (supervisor, clinician, NULL, NULL) row would be "distinct" and the rule would not exist.
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO safety_supervisor_subscription (organization_id, supervisor_membership_id,
             clinician_membership_id, scope_kind, alert_kinds)
           VALUES ($1,$2,$3,'explicit', ARRAY['incident']::text[])`,
            [ORG_A, a.supervisor, a.membership],
          ),
        ),
      ).rejects.toThrow();
    });

    it("a supervisor cannot subscribe to herself (m20_sss_no_self_supervision)", async () => {
      // The route's `clinician_self ∨ supervises_clinician` disjunction assumes the two are different
      // people; a self-row would make a clinician her own oversight and satisfy the predicate trivially.
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO safety_supervisor_subscription (organization_id, supervisor_membership_id,
             clinician_membership_id, scope_kind, alert_kinds)
           VALUES ($1,$2,$2,'explicit', ARRAY['sos']::text[])`,
            [ORG_A, a.supervisor],
          ),
        ),
      ).rejects.toThrow();
    });

    it("the §3.6 write-audit trigger exists on every owned table", async () => {
      const { rows } = await db.query<{ relname: string }>(
        `SELECT DISTINCT c.relname FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
       WHERE NOT tg.tgisinternal AND c.relname = ANY($1) AND tg.tgname LIKE '%audit%'`,
        [ALL_TABLES],
      );
      expect(rows.map((r) => r.relname).sort()).toEqual([...ALL_TABLES].sort());
    });

    it("the lifecycle enums are NOT audit-denylisted — they are what a deposition reads", () => {
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0111_field_safety_m20_rls_audit_triggers.sql"),
        "utf8",
      );
      const fn = rls.match(
        /FUNCTION audit_phi_write_safety_sos_alert\(\)[\s\S]*?LANGUAGE plpgsql[\s\S]*?\$\$;/,
      );
      expect(fn).not.toBeNull();
      const body = fn?.[0] ?? "";
      // The ciphers are scrubbed…
      expect(body).toMatch(/resolution_narrative_cipher/);
      expect(body).toMatch(/acknowledger_dispatch_payload_cipher/);
      // …and the state vocabulary is not. A denylisted `lifecycle_state` or `cancel_status` would make the
      // trail useless for the one purpose §8.8.1 gives it: proving what happened, and when, and to whom.
      expect(body).not.toMatch(/'lifecycle_state'/);
      expect(body).not.toMatch(/'cancel_status'/);
    });
  },
);
