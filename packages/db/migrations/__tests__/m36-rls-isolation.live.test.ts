/**
 * M36 Secure Messaging & Alerts — RLS cross-tenant denial: the LIVE Postgres proof (§3.7 / ADR-0010).
 *
 * M36's pure suites exercise the channel/alert routing machinery but never touch a database, so they cannot
 * catch a wrong RLS predicate, a missing WITH CHECK, or a base-table grant that leaks across tenants. This
 * applies the real migrations to a real Postgres and drives the policies as the unprivileged `chartwarden_app`
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
 *   • user_notification_preferences — NOT excluded any more. It was, justified as "keyed on app.user_id
 *     (the user's own rows), not app.org_id" — and that justification was the bug: the table carries
 *     organization_id and is not in NON_ORG_SCOPED, so it IS org-scoped, and its only chartwarden_app policy
 *     scoped nothing by the org at all (F-005, #21). It is covered by its own describe block below
 *     rather than by the COVERED sweep, because the sweep's `withOrg` helper sets no app.user_id and so
 *     cannot even reach this policy.
 *   • presence, delivery_endpoint — user-owned / cross-org (the human, not the tenant); no organization_id.
 *   • message_attachment, notification_delivery — pure children of message/alert; no organization_id column,
 *     org-isolated through the parent join.
 *   • alert_payload_catalog — platform-floor registry (§3.12); no organization_id, readable by all tenants.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m36` (SUPERUSER to a THROWAWAY db;
 *     for a local PG without pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODULES } from "../../../../architecture/module-manifest";
import { dropLiveRoles } from "../../../../apps/backend/__tests__/_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
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
  alertReceipt: string;
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
      await dropLiveRoles(db);
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
          `INSERT INTO channel (organization_id, channel_kind, dm_participant_key, title, retention_class)
         VALUES ($1,'dm',$2,'DM Thread','care_related') RETURNING id`,
          [org, `${USER}:fixture-peer`],
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

      const alertReceipt = (
        await db.query(
          `INSERT INTO alert_receipt (alert_id, recipient_user_id) VALUES ($1,$2) RETURNING id`,
          [alert, USER],
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
        alertReceipt,
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
    // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable.
    it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
      const { rows } = await db.query<{ rolbypassrls: boolean }>(
        "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
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

    // ── GAP-167 — alert_receipt (0243) shipped with NO grant and NO RLS: live 42501 on every alert-inbox
    // request until 0247. It is a pure child of `alert` (no organization_id), so it is NOT in the loop-driven
    // COVERED sweep above; its parent-join policy gets its own proof here, as `chartwarden_app`.
    it("alert_receipt: org A sees its receipt, org B cannot (parent-join RLS, 0247)", async () => {
      const seenByA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM alert_receipt WHERE id=$1", [a.alertReceipt]),
      );
      expect(seenByA.rows[0].n).toBe(1);
      const seenByB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM alert_receipt WHERE id=$1", [a.alertReceipt]),
      );
      expect(seenByB.rows[0].n).toBe(0);
    });

    it("alert_receipt: chartwarden_app holds the grant (markAlertRead UPDATE reaches the row, no 42501)", async () => {
      const res = await withOrg(ORG_A, () =>
        db.query("UPDATE alert_receipt SET read_at = now() WHERE id=$1", [a.alertReceipt]),
      );
      expect(res.rowCount).toBe(1);
    });

    it("alert_receipt: the write-audit trigger (1081) records the read-state UPDATE in org A's trail", async () => {
      const before = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='alert_receipt' AND event_type='alert_receipt.update' AND resource_id=$1",
        [a.alertReceipt],
      );
      await withOrg(ORG_A, () =>
        db.query("UPDATE alert_receipt SET read_at = now() WHERE id=$1", [a.alertReceipt]),
      );
      const r = await db.query(
        "SELECT organization_id::text AS org FROM audit_event WHERE resource_kind='alert_receipt' AND event_type='alert_receipt.update' AND resource_id=$1",
        [a.alertReceipt],
      );
      expect(r.rows.length).toBe(before.rows[0].n + 1);
      expect(r.rows.every((x) => x.org === ORG_A)).toBe(true);
    });

    it("WP 1.8 catalog parity: every M36 table has RLS enabled + FORCEd and a write-audit trigger", async () => {
      const owned = (MODULES.find((m) => m.id === 36)?.ownedTables ?? []) as string[];
      const r = await db.query(
        `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS frc,
                EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc p ON p.oid = g.tgfoid
                         WHERE g.tgrelid = c.oid AND NOT g.tgisinternal AND g.tgenabled <> 'D'
                           AND (p.proname IN ('wardenx_audit_trigger', 'chartwarden_audit_trigger') OR p.proname LIKE 'audit_phi_write_%')) AS audited
           FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
        [owned],
      );
      expect(r.rows.map((x) => x.t).sort()).toEqual([...owned].sort());
      const bad = r.rows.filter((x) => !(x.rls && x.frc && x.audited)).map((x) => x.t);
      expect(bad).toEqual([]);
    });

    it("alert_receipt: org B cannot UPDATE org A's receipt, nor forge one against org A's alert", async () => {
      const upd = await withOrg(ORG_B, () =>
        db.query("UPDATE alert_receipt SET read_at = now() WHERE id=$1", [a.alertReceipt]),
      );
      expect(upd.rowCount).toBe(0);
      await expect(
        withOrg(ORG_B, () =>
          db.query("INSERT INTO alert_receipt (alert_id, recipient_user_id) VALUES ($1,$2)", [
            a.alert,
            USER,
          ]),
        ),
      ).rejects.toThrow();
    });

    it("alert_receipt: an empty-string app.org_id matches nothing instead of throwing 22P02 (NULLIF guard)", async () => {
      const res = await withOrg("", () => db.query("SELECT count(*)::int AS n FROM alert_receipt"));
      expect(res.rows[0].n).toBe(0);
    });

    it("the M4 write-audit trigger fired for the message writes (§3.9)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'message'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });

    // ── F-005 (#21) — user_notification_preferences must be scoped by the ORG, not only the user ──
    //
    // This table sits in the EXCLUDED list at the top of this file, justified as "keyed on app.user_id
    // (the user's own rows), not app.org_id". That justification is the finding: the table carries
    // `organization_id` (FK -> organization) and a unique index on (user_id, organization_id), so it IS
    // org-scoped — it is not in check-tenancy.ts's NON_ORG_SCOPED list, unlike `presence` and
    // `delivery_endpoint` beside it. Its only chartwarden_app policy (migration 0017) constrained neither
    // USING nor WITH CHECK by the org, and a PERMISSIVE policy is the WHOLE of what the role may reach,
    // so there was no tenant moat on this table at all.
    //
    // Every case below ran as an ORG-B session in the envelope withOrgContext() actually creates —
    // app.org_id AND app.user_id both set — because `withOrg` alone sets no app.user_id and so cannot
    // reach the policy. Migration 0216 adds the org predicate as a conjunct on both sides.
    describe("F-005 (#21) — notification preferences are tenant-scoped", () => {
      /** The real request envelope: withOrgContext sets BOTH GUCs (app.user_id for M4 attribution). */
      async function withOrgAndUser<T>(
        org: string,
        user: string,
        fn: () => Promise<T>,
      ): Promise<T> {
        await db.query("SET ROLE chartwarden_app");
        await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
        await db.query("SELECT set_config('app.user_id', $1, false)", [user]);
        try {
          return await fn();
        } finally {
          await db.query("RESET ROLE");
          await db.query("SELECT set_config('app.user_id', '', false)");
        }
      }

      /** A tenant the seeded USER has no membership in — the unbounded-write case. */
      const ORG_FOREIGN = "44444444-4444-4444-4444-444444444444";

      beforeAll(async () => {
        await db.query(
          `INSERT INTO organization (id,slug,legal_name,display_name,status)
             VALUES ($1,'f005-foreign','Foreign Hospice LLC','Foreign Hospice','active')
           ON CONFLICT (id) DO NOTHING`,
          [ORG_FOREIGN],
        );
        await db.query(
          `INSERT INTO user_notification_preferences (user_id, organization_id, routing_map)
             VALUES ($1,$2,'{"secret":"org-A-private-routing"}'::jsonb)
           ON CONFLICT (user_id, organization_id) DO UPDATE SET routing_map = EXCLUDED.routing_map`,
          [USER, ORG_A],
        );
      });

      it("an org-B session cannot READ the caller's own org-A row", async () => {
        const seen = await withOrgAndUser(ORG_B, USER, () =>
          db.query(
            "SELECT count(*)::int AS n FROM user_notification_preferences WHERE organization_id=$1",
            [ORG_A],
          ),
        );
        expect(seen.rows[0].n).toBe(0);
      });

      it("an org-B session cannot UPDATE the org-A row", async () => {
        const res = await withOrgAndUser(ORG_B, USER, () =>
          db.query(
            "UPDATE user_notification_preferences SET routing_map='{\"tampered\":true}'::jsonb WHERE organization_id=$1",
            [ORG_A],
          ),
        );
        expect(res.rowCount).toBe(0);
        // ...and the row is genuinely untouched, not merely invisible to the UPDATE's RETURNING.
        const still = await db.query(
          "SELECT routing_map FROM user_notification_preferences WHERE user_id=$1 AND organization_id=$2",
          [USER, ORG_A],
        );
        expect(still.rows[0].routing_map).toEqual({ secret: "org-A-private-routing" });
      });

      it("an org-B session cannot INSERT into a tenant it is not scoped to", async () => {
        await expect(
          withOrgAndUser(ORG_B, USER, () =>
            db.query(
              `INSERT INTO user_notification_preferences (user_id, organization_id, routing_map)
                 VALUES ($1,$2,'{"forged":true}'::jsonb)`,
              [USER, ORG_FOREIGN],
            ),
          ),
        ).rejects.toThrow();
        const planted = await db.query(
          "SELECT count(*)::int AS n FROM user_notification_preferences WHERE organization_id=$1",
          [ORG_FOREIGN],
        );
        expect(planted.rows[0].n).toBe(0);
      });

      it("the caller CAN still read and update their own row in the CURRENT org", async () => {
        // The constraint the fix must preserve: scoping by org must not break the feature. A fix that
        // denies the three cases above and this one too has just made the table unreachable.
        await db.query(
          `INSERT INTO user_notification_preferences (user_id, organization_id, routing_map)
             VALUES ($1,$2,'{"channel":"sms"}'::jsonb)
           ON CONFLICT (user_id, organization_id) DO UPDATE SET routing_map = EXCLUDED.routing_map`,
          [USER, ORG_B],
        );
        const read = await withOrgAndUser(ORG_B, USER, () =>
          db.query(
            "SELECT routing_map FROM user_notification_preferences WHERE organization_id=$1",
            [ORG_B],
          ),
        );
        expect(read.rows[0].routing_map).toEqual({ channel: "sms" });

        const upd = await withOrgAndUser(ORG_B, USER, () =>
          db.query(
            'UPDATE user_notification_preferences SET routing_map=\'{"channel":"push"}\'::jsonb WHERE organization_id=$1',
            [ORG_B],
          ),
        );
        expect(upd.rowCount).toBe(1);
      });

      it("the policy is constrained by app.org_id in the CATALOG, not just in the migration text", async () => {
        // Asserted against pg_policies because the defect was invisible to every text-scanning check:
        // check-tenancy.ts exempts this whole migration file (it contains audit triggers), and this
        // suite's own EXCLUDED list took the policy's intent at its word. See #22.
        const { rows } = await db.query<{ policyname: string; qual: string; with_check: string }>(
          `SELECT policyname, qual, with_check FROM pg_policies
            WHERE schemaname='public' AND tablename='user_notification_preferences'
              AND permissive='PERMISSIVE' AND roles::text LIKE '%chartwarden_app%'`,
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.qual ?? "", `${r.policyname}.USING must be org-scoped`).toMatch(/app\.org_id/);
          expect(r.with_check ?? "", `${r.policyname}.WITH CHECK must be org-scoped`).toMatch(
            /app\.org_id/,
          );
        }
      });
    });
  },
);
