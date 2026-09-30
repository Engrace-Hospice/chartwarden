/**
 * M14 IDG (Interdisciplinary Group) — RLS cross-tenant denial: the LIVE Postgres proof (§3.3 / ADR-0010).
 *
 * M14's pure suites exercise the meeting/decision/minutes machines but never touch a database, so they cannot
 * catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This
 * applies the real migrations (0042 tables + 0043 RLS/audit triggers) to a real Postgres and drives the
 * policies as the unprivileged `wardenx_app` role (no BYPASSRLS), covering all NINE org-scoped M14 tables.
 *
 * The one that makes this worth more than a checkbox is `idg_decision`: the recorded IDG determination whose
 * per-kind `payload` drives the outbox emit that mutates M7/M11/M12 (care-plan updates, order requests,
 * medication recommendations). A cross-tenant write would let one tenant manufacture another's clinical
 * decisions — the WITH CHECK on it is the barrier proven below.
 *
 * `idg_patient_packet` is PARTITIONED BY RANGE (built_at) (§3.3 / D12): the RLS policy lives on the
 * partitioned PARENT (0043), which every leaf inherits, so it stays in the read/write sweep AND the policy
 * count. The monthly-child leaves are protected by grants, not their own policies (comment on the count test).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m14` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set WARDENX_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** membership_id / patient_id / admission_id are NOT NULL but carry NO SQL FK (§3.3 — cross/intra-module
 * refs stay plain uuid); literals are fine for every such reference in the chain. */
const MEMBERSHIP = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type SeedIds = {
  providerEntity: string;
  location: string;
  recurringPolicy: string;
  meeting: string;
  attendance: string;
  agendaItem: string;
  disciplineNote: string;
  decision: string;
  decisionAck: string;
  actionItem: string;
  minutes: string;
  minutesAmendment: string;
  patientPacket: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "idg_recurring_policy", key: "recurringPolicy" },
  { table: "idg_meeting", key: "meeting" },
  { table: "idg_attendance", key: "attendance" },
  { table: "idg_agenda_item", key: "agendaItem" },
  { table: "idg_discipline_note", key: "disciplineNote" },
  { table: "idg_decision", key: "decision" },
  // F-232 (0305) — downstream "decision applied" acknowledgements.
  { table: "idg_decision_application_ack", key: "decisionAck" },
  { table: "idg_action_item", key: "actionItem" },
  { table: "idg_minutes", key: "minutes" },
  { table: "idg_minutes_amendment", key: "minutesAmendment" },
  // Partitioned parent (§3.3 / D12): policy is on the parent, inherited by every leaf — counted below.
  { table: "idg_patient_packet", key: "patientPacket" },
];

describe.skipIf(!DB_URL)("M14 IDG — RLS cross-tenant denial — LIVE Postgres (§3.3)", () => {
  let db: Client;
  let a: SeedIds;
  let b: SeedIds;

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set)",
        );
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await db.query(sql);
    }
  }

  /** Seed one full M14 IDG chain for `org` as superuser (RLS + grants bypassed), in FK order. */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const providerEntity = (
      await db.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M14${n}`, `M14 Provider ${n}`, `NPI-M14${n}`],
      )
    ).rows[0].id as string;

    const location = (
      await db.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M14${n}`],
      )
    ).rows[0].id as string;

    const recurringPolicy = (
      await db.query(
        `INSERT INTO idg_recurring_policy (organization_id, location_id, day_of_week_anchor,
           default_coordinator_membership_id)
         VALUES ($1,$2,'monday',$3) RETURNING id`,
        [org, location, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const meeting = (
      await db.query(
        `INSERT INTO idg_meeting (organization_id, location_id, recurring_policy_id, scheduled_start,
           scheduled_end, status, coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2,$3, now(), now() + interval '2 hours', 'scheduled', $4, '{}'::jsonb) RETURNING id`,
        [org, location, recurringPolicy, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const attendance = (
      await db.query(
        `INSERT INTO idg_attendance (organization_id, idg_meeting_id, membership_id, discipline, status)
         VALUES ($1,$2,$3,'rn','present') RETURNING id`,
        [org, meeting, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const agendaItem = (
      await db.query(
        `INSERT INTO idg_agenda_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, title, kind, added_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'Review','patient_review',$6) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const disciplineNote = (
      await db.query(
        `INSERT INTO idg_discipline_note (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, discipline, body_text, author_membership_id)
         VALUES ($1,$2,$3,$4,$5,'rn','isolation probe',$6) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const decision = (
      await db.query(
        `INSERT INTO idg_decision (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, agenda_item_id, decision_kind, payload, was_quorate, quorum_snapshot,
           recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,'care_plan_update','{}'::jsonb, true, '{}'::jsonb, $7) RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, agendaItem, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const decisionAck = (
      await db.query(
        `INSERT INTO idg_decision_application_ack (organization_id, provider_entity_id, location_id,
           idg_decision_id, idg_meeting_id, patient_id, target_module, plan_id, version_id, mutations_applied,
           source_outbox_event_id)
         VALUES ($1,$2,$3,$4,$5,$6,'m15',gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid()) RETURNING id`,
        [org, providerEntity, location, decision, meeting, PATIENT],
      )
    ).rows[0].id as string;

    const actionItem = (
      await db.query(
        `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id,
           idg_decision_id, patient_id, assigned_to_membership_id, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Follow up') RETURNING id`,
        [org, providerEntity, location, meeting, decision, PATIENT, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const minutes = (
      await db.query(
        `INSERT INTO idg_minutes (organization_id, idg_meeting_id, status)
         VALUES ($1,$2,'in_progress') RETURNING id`,
        [org, meeting],
      )
    ).rows[0].id as string;

    const minutesAmendment = (
      await db.query(
        `INSERT INTO idg_minutes_amendment (organization_id, idg_minutes_id, amendment_reason,
           amendment_diff, requested_by_membership_id)
         VALUES ($1,$2,'typo','{}'::jsonb,$3) RETURNING id`,
        [org, minutes, MEMBERSHIP],
      )
    ).rows[0].id as string;

    const patientPacket = (
      await db.query(
        `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id,
           patient_id, admission_id, since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1)
         VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01T00:00:00Z','{}'::jsonb,'{}'::jsonb,'summary') RETURNING id`,
        [org, providerEntity, location, meeting, PATIENT, ADMISSION],
      )
    ).rows[0].id as string;

    return {
      providerEntity,
      location,
      recurringPolicy,
      meeting,
      attendance,
      agendaItem,
      disciplineNote,
      decision,
      decisionAck,
      actionItem,
      minutes,
      minutesAmendment,
      patientPacket,
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
    b = await seedOrg(ORG_B, 2);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind WARDENX_DEV_BYPASSRLS=1, so this is reachable.
  it("wardenx_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'wardenx_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("every M14 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
    // 0043 holds the original nine; 0282 adds idg_discipline_note (its wardenx_destruction policy is a
    // different role's and is excluded — only the wardenx_app tenant policy is judged here).
    const rls =
      readFileSync(join(MIGRATIONS_DIR, "0043_idg_m14_rls_audit_triggers.sql"), "utf8") +
      readFileSync(join(MIGRATIONS_DIR, "0282_m14_idg_discipline_note.sql"), "utf8") +
      // 0305 adds idg_decision_application_ack (F-232); its wardenx_destruction policy is excluded as above.
      readFileSync(join(MIGRATIONS_DIR, "0305_m14_idg_decision_application_ack.sql"), "utf8");
    // (0283 adds columns + a CHECK + a trigger-function replacement to the same table: no new policy.)
    const policyBlocks = (rls.match(/CREATE POLICY[\s\S]*?WITH CHECK \([^;]*\)/g) ?? []).filter(
      (b) => b.includes("TO wardenx_app") && COVERED.some((t) => b.includes(`"${t.table}"`)),
    );
    // All ten M14 tables carry a direct app.org_id policy — the partitioned idg_patient_packet's policy
    // lives on the parent (0043) and is inherited by every leaf, so it counts here too.
    expect(policyBlocks.length).toBe(COVERED.length);
    for (const block of policyBlocks) {
      const vars = [...block.matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(block).not.toMatch(/pg_has_role/i);
      expect(block).not.toMatch(/IS NULL/i);
    }
  });

  it.each(COVERED)(
    "$table: org A sees its row, org B cannot (cross-tenant denial)",
    async ({ table, key }) => {
      const id = a[key];
      const seenByA = await withOrg(ORG_A, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByA.rows[0].n).toBe(1); // isolation is not "deny everything"
      const seenByB = await withOrg(ORG_B, () =>
        db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    },
  );

  it("a WITH CHECK refuses an IDG decision forged into another tenant's meeting", async () => {
    // idg_decision is the recorded IDG determination whose payload drives the outbox emit that mutates
    // M7/M11/M12 — a cross-tenant write would let one tenant manufacture another's clinical decisions.
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          `INSERT INTO idg_decision (organization_id, idg_meeting_id, decision_kind, payload, was_quorate,
             quorum_snapshot, recorded_by_membership_id)
           VALUES ($1,$2,'care_plan_update','{}'::jsonb, true, '{}'::jsonb, $3)`,
          [ORG_A, a.meeting, MEMBERSHIP],
        ),
      ),
    ).rejects.toThrow();
  });

  it("org B cannot UPDATE org A's meeting (the USING clause covers writes too)", async () => {
    const res = await withOrg(ORG_B, () =>
      db.query("UPDATE idg_meeting SET status='cancelled' WHERE id=$1", [a.meeting]),
    );
    expect(res.rowCount).toBe(0);
    const still = await db.query("SELECT status FROM idg_meeting WHERE id=$1", [a.meeting]);
    expect(still.rows[0].status).toBe("scheduled");
  });

  it("the M4 write-audit trigger fired for the idg_decision writes (§3.3)", async () => {
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'idg_decision'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  // 0283/0284 — late addenda + optional `reason` on idg_discipline_note, judged as the real NOBYPASSRLS wardenx_app role.
  describe("idg_discipline_note late addenda + reason (0283/0284)", () => {
    const insertAddendum = (org: string, ids: SeedIds, reason: string | null, flag = true) =>
      db.query(
        `INSERT INTO idg_discipline_note (organization_id, idg_meeting_id, discipline, body_text,
           author_membership_id, is_addendum, addendum_recorded_at, reason)
         VALUES ($1,$2,'rn','late text',$3,$4,$5,$6) RETURNING id`,
        [org, ids.meeting, MEMBERSHIP, flag, flag ? new Date() : null, reason],
      );

    it("the app role can INSERT an addendum in its own org, the tenant B context cannot see or forge one", async () => {
      const ins = await withOrg(ORG_A, () => insertAddendum(ORG_A, a, "missed vitals"));
      const id = ins.rows[0].id as string;
      const seenByB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM idg_discipline_note WHERE id=$1", [id]),
      );
      expect(seenByB.rows[0].n).toBe(0);
      await expect(withOrg(ORG_B, () => insertAddendum(ORG_A, a, "forged"))).rejects.toThrow();
    });

    it("0284 renamed addendum_reason to reason (one column; existing values kept)", async () => {
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name='idg_discipline_note' AND column_name IN ('reason','addendum_reason')`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["reason"]);
    });

    it("the addendum CHECK refuses an addendum without a (non-blank, <=500) reason and an original with a blank/oversized one", async () => {
      await expect(withOrg(ORG_A, () => insertAddendum(ORG_A, a, null))).rejects.toThrow(
        /idg_discipline_note_addendum_chk/,
      );
      await expect(withOrg(ORG_A, () => insertAddendum(ORG_A, a, "   "))).rejects.toThrow(
        /idg_discipline_note_addendum_chk/,
      );
      await expect(withOrg(ORG_A, () => insertAddendum(ORG_A, a, "x".repeat(501)))).rejects.toThrow(
        /idg_discipline_note_addendum_chk/,
      );
      // an ORIGINAL note (flag false, no recorded-at) may carry a non-blank reason, or none...
      await withOrg(ORG_A, () => insertAddendum(ORG_A, a, "context on an original", false));
      await withOrg(ORG_A, () => insertAddendum(ORG_A, a, null, false));
      // ...but not a blank/oversized one, and never a recorded-at without the flag
      await expect(withOrg(ORG_A, () => insertAddendum(ORG_A, a, "   ", false))).rejects.toThrow(
        /idg_discipline_note_addendum_chk/,
      );
      await expect(
        withOrg(ORG_A, () => insertAddendum(ORG_A, a, "x".repeat(501), false)),
      ).rejects.toThrow(/idg_discipline_note_addendum_chk/);
    });

    it("the app role still has no DELETE on the table; the audit trigger scrubs reason (addendum AND original)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query("DELETE FROM idg_discipline_note WHERE id=$1", [a.disciplineNote]),
        ),
      ).rejects.toThrow(/permission denied/i);
      const ins = await withOrg(ORG_A, () => insertAddendum(ORG_A, a, "REASON-PHI-PROBE"));
      const audit = await db.query(
        "SELECT after::text AS after FROM audit_event WHERE resource_kind='idg_discipline_note' AND resource_id=$1",
        [ins.rows[0].id],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      for (const r of audit.rows) {
        expect(r.after).not.toContain("REASON-PHI-PROBE");
        expect(r.after).not.toContain("late text");
      }
      const orig = await withOrg(ORG_A, () =>
        insertAddendum(ORG_A, a, "ORIGINAL-REASON-PHI-PROBE", false),
      );
      const audit2 = await db.query(
        "SELECT after::text AS after FROM audit_event WHERE resource_kind='idg_discipline_note' AND resource_id=$1",
        [orig.rows[0].id],
      );
      expect(audit2.rows.length).toBeGreaterThan(0);
      for (const r of audit2.rows) expect(r.after).not.toContain("ORIGINAL-REASON-PHI-PROBE");
    });
  });
});
