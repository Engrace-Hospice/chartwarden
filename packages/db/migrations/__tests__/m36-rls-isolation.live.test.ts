/**
 * M36 Secure Messaging & Alerts — RLS cross-tenant denial: the LIVE Postgres proof (§3.7 / ADR-0010).
 *
 * M36's pure suites exercise the channel/alert routing machinery but never touch a database, so they cannot
 * catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This
 * applies the real migrations to a real Postgres and drives the policies as the unprivileged `wardenx_app`
 * role (no BYPASSRLS), covering all SEVEN org-scoped M36 tenant tables (the loop-generated `_org_isolation`
 * policy in 0017 §2).
 *
 * Two of the seven carry the risk that makes this worth more than a checkbox:
 *   • `message` is the secure clinical conversation itself (body_cipher is PHI). A cross-tenant write would
 *     let one tenant post into — or forge — another tenant's care-team thread.
 *   • `channel` is the conversation container keyed to a patient/care-team subject; a cross-tenant read is a
 *     disclosure of who is discussing which of another org's patients.
 *
 * EXCLUDED from the sweep (M36 owns 15 tables; the other 8 are NOT org_id + tenant `_org` policy):
 *   • alert_rule, notification_template — organization_id is NULLABLE by design; platform-default/floor rows
 *     (organization_id IS NULL) are read-only to EVERY tenant, so the read policy is `… IS NULL OR org = …`,
 *     not a pure org-isolation policy (would trip the "no IS NULL escape" assertion).
 *   • user_notification_preferences — keyed on app.user_id (the user's own rows), not app.org_id.
 *   • presence, delivery_endpoint — user-owned / cross-org (the human, not the tenant); no organization_id.
 *   • message_attachment, notification_delivery — pure children of message/alert; no organization_id column,
 *     org-isolated through the parent join.
 *   • alert_payload_catalog — platform-floor registry (§3.12); no organization_id, readable by all tenants.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m36` (SUPERUSER to a THROWAWAY db;
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
/** channel_member.user_id / message.author_user_id / message_receipt.user_id carry real FKs to `user`,
 * so a single seeded user is enough for every user reference in the chain. */
const USER = "33333333-3333-3333-3333-333333333333";
/** The shared platform-floor payload_type FK target for tenant_alert_routing_override (seeded once). */
const PAYLOAD_TYPE = "m36.test.payload";

type SeedIds = {
  membership: string;
  providerEntity: string;
  location: string;
  channel: string;
  channelMember: string;
  message: string;
  messageReceipt: string;
  alert: string;
  tenantAlertRoutingOverride: string;
  tenantNotificationTemplateOverlay: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "channel", key: "channel" },
  { table: "channel_member", key: "channelMember" },
  { table: "message", key: "message" },
  { table: "message_receipt", key: "messageReceipt" },
  { table: "alert", key: "alert" },
  { table: "tenant_alert_routing_override", key: "tenantAlertRoutingOverride" },
  { table: "tenant_notification_template_overlay", key: "tenantNotificationTemplateOverlay" },
];

describe.skipIf(!DB_URL)(
  "M36 Secure Messaging — RLS cross-tenant denial — LIVE Postgres (§3.7)",
  () => {
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

    /** Seed one full M36 messaging chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      const membership = (
        await db.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;

      const providerEntity = (
        await db.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M36${n}`, `M36 Provider ${n}`, `NPI-M36${n}`],
        )
      ).rows[0].id as string;

      const location = (
        await db.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity, `Loc-M36${n}`],
        )
      ).rows[0].id as string;

      // channel_kind='dm' keeps the channel_kind_subject_shape CHECK simple: subject_id NULL, care_related.
      const channel = (
        await db.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'dm','DM Thread','care_related') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const channelMember = (
        await db.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual') RETURNING id`,
          [org, channel, USER],
        )
      ).rows[0].id as string;

      const message = (
        await db.query(
          `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher,
           body_sha256, body_kind)
         VALUES ($1,$2,$3,'user',$4,$5,'plain') RETURNING id`,
          [channel, org, USER, Buffer.from([0]), "a".repeat(64)],
        )
      ).rows[0].id as string;

      const messageReceipt = (
        await db.query(
          `INSERT INTO message_receipt (organization_id, message_id, user_id, status)
         VALUES ($1,$2,$3,'delivered') RETURNING id`,
          [org, message, USER],
        )
      ).rows[0].id as string;

      const alert = (
        await db.query(
          `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id)
         VALUES ($1,'m36.test.event','warn','{}'::jsonb,$2) RETURNING id`,
          [org, `corr-${n}`],
        )
      ).rows[0].id as string;

      const tenantAlertRoutingOverride = (
        await db.query(
          `INSERT INTO tenant_alert_routing_override (organization_id, payload_type, rationale,
           configured_by_membership_id)
         VALUES ($1,$2,'test override',$3) RETURNING id`,
          [org, PAYLOAD_TYPE, membership],
        )
      ).rows[0].id as string;

      const tenantNotificationTemplateOverlay = (
        await db.query(
          `INSERT INTO tenant_notification_template_overlay (organization_id, template_key, title_template,
           configured_by_membership_id)
         VALUES ($1,'m36.template','Overlay Title',$2) RETURNING id`,
          [org, membership],
        )
      ).rows[0].id as string;

      return {
        membership,
        providerEntity,
        location,
        channel,
        channelMember,
        message,
        messageReceipt,
        alert,
        tenantAlertRoutingOverride,
        tenantNotificationTemplateOverlay,
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
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m36-actor@x.test')`, [USER]);
      // Shared platform-floor payload catalog row (§3.12) — the tenant override FK target.
      await db.query(
        `INSERT INTO alert_payload_catalog (payload_type, module_owner, severity, default_channels,
         default_recipient_resolver, payload_schema, description)
       VALUES ($1,'m36','INFO','{in_app}','care_team','{}'::jsonb,'test payload')`,
        [PAYLOAD_TYPE],
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

    it("every M36 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      // The seven org-scoped tenant tables share ONE loop-generated `%I_org_isolation` policy (0017 §2),
      // not seven literal CREATE POLICY blocks — so assert the loop's table ARRAY == COVERED and that the
      // template body keys only on app.org_id.
      const rls = readFileSync(
        join(MIGRATIONS_DIR, "0017_messaging_m36_rls_audit_triggers.sql"),
        "utf8",
      );
      const loop = rls.match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*LOOP/);
      expect(loop).not.toBeNull();
      const loopTables = [...loop![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(loopTables)).toEqual(new Set(COVERED.map((c) => c.table)));
      expect(loopTables.length).toBe(COVERED.length);

      const tmpl = rls.match(/CREATE POLICY %I_org_isolation[\s\S]*?WITH CHECK \([^$]*\)/);
      expect(tmpl).not.toBeNull();
      const vars = [...tmpl![0].matchAll(/current_setting\(\s*'([^']+)'/g)].map((m) => m[1]);
      expect(new Set(vars)).toEqual(new Set(["app.org_id"]));
      expect(tmpl![0]).not.toMatch(/pg_has_role/i);
      expect(tmpl![0]).not.toMatch(/IS NULL/i);
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

    it("a WITH CHECK refuses a message forged into another tenant's channel", async () => {
      // message is the secure clinical conversation itself (body_cipher is PHI) — a cross-tenant write would
      // let one tenant post into or forge another tenant's care-team thread.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher,
             body_sha256, body_kind)
           VALUES ($1,$2,$3,'user',$4,$5,'plain')`,
            [a.channel, ORG_A, USER, Buffer.from([1]), "b".repeat(64)],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot UPDATE org A's message (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE message SET body_kind='markdown' WHERE id=$1", [a.message]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query("SELECT body_kind FROM message WHERE id=$1", [a.message]);
      expect(still.rows[0].body_kind).toBe("plain");
    });

    it("the M4 write-audit trigger fired for the message writes (§3.9)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'message'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  },
);
