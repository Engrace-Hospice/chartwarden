/**
 * RLS cross-tenant isolation — LIVE Postgres proof (M1 §7.2 / M2 spec §9.3; slice-acceptance #3).
 *
 * This is the REAL proof the slice was missing. Its in-memory sibling
 * (cross-tenant-isolation.test.ts) runs a hand-written model of RLS and never touches a
 * database — so it cannot catch anything Postgres does at runtime (a wrong policy
 * predicate, a missing WITH CHECK, or a recursing trigger). This test applies the actual
 * migrations to a real Postgres and exercises the policies as the unprivileged
 * `chartwarden_app` role (no BYPASSRLS), proving cross-tenant denial for real.
 *
 * It also pins the regression that the simulation missed: audit_event is RANGE-partitioned
 * by month, so an audited write routes to a dated child and the audit trigger fires with
 * TG_TABLE_NAME = that partition; if the trigger's recursion guard only matches the parent
 * name, every audited write recurses to "stack depth limit exceeded". See 0004's guard.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + CHARTWARDEN_TEST_DATABASE_URL.
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and
 * recreates the public schema + roles).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "mdm_canonical_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const PE_COLS = "(organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)";
const PE_VALS = "($1,'CCN','Legal','NPI','enc','12-31')";

describe.skipIf(!DB_URL)("RLS cross-tenant isolation — LIVE Postgres (§7.2/§9.3)", () => {
  let db: Client;
  let peA: string; // an org-A provider_entity, created under org A's context

  /** Run `fn` as the unprivileged app role with app.org_id = `org` (RLS enforced). */
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
      // drop owned objects + default privileges, then the role — only if it lingers
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    // The CI `rls-live` job runs pgvector/pgvector:pg18, so the REAL `CREATE EXTENSION vector`
    // applies — M38 (Terminology) ships a pgvector `concept_embedding` table. For a local PG that
    // lacks pgvector, set CHARTWARDEN_TEST_NO_PGVECTOR=1 to strip the extension line (valid only while
    // no table uses the `vector` type; once one does, pgvector is required).
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
          "-- (vector extension stripped: CHARTWARDEN_TEST_NO_PGVECTOR set; local PG without pgvector)",
        );
      }
      await db.query(sql);
    }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL });
    await db.connect();
    await resetSchema();
    await applyMigrations();

    // Seed two orgs + a global and an org-A feature flag (as superuser — RLS bypassed).
    await db.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await db.query(
      `INSERT INTO feature_flag (organization_id,flag_key,flag_kind,value_type,value,targeting,kill_switch_active,created_at,updated_at)
       VALUES (NULL,'global_flag','product','bool','true'::jsonb,'{}'::jsonb,false,now(),now()),
              ($1,'org_a_flag','product','bool','true'::jsonb,'{}'::jsonb,false,now(),now())`,
      [ORG_A],
    );

    // Org A writes a provider_entity (+ a location under it). If the audit trigger recurses
    // through audit_event's monthly partition, THIS throws "stack depth limit exceeded" and
    // the whole suite fails — which is exactly the regression we want pinned.
    peA = await withOrg(ORG_A, async () => {
      const r = await db.query(
        `INSERT INTO provider_entity ${PE_COLS} VALUES ${PE_VALS} RETURNING id`,
        [ORG_A],
      );
      const id = r.rows[0].id as string;
      await db.query(
        `INSERT INTO location (provider_entity_id,name,address_line1,city,state,postal_code,timezone)
         VALUES ($1,'Loc-A','1 St','Town','OR','97000','America/Los_Angeles')`,
        [id],
      );
      return id;
    });
  }, 120_000);

  afterAll(async () => {
    await db?.end();
  });

  // GUARD FOR EVERY CASE BELOW. RLS is not enforced for a role holding BYPASSRLS, so if the runtime
  // role ever gains it, every isolation assertion in this file passes VACUOUSLY and CI stays green.
  // scripts/db/migrate.ts grants exactly that behind CHARTWARDEN_DEV_BYPASSRLS=1, so this is reachable,
  // not theoretical. Six of fifteen suites asserted this and NONE of the four suites CI runs did.
  it("chartwarden_app is NOBYPASSRLS — otherwise every case below passes vacuously", async () => {
    const { rows } = await db.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_app'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolbypassrls).toBe(false);
  });

  it("audited writes do NOT recurse through audit_event partitions (regression: 0004 guard)", async () => {
    expect(peA).toBeTruthy(); // the seed insert above succeeded → no stack-overflow
    // and the AFTER trigger actually wrote an audit row for it (read as superuser)
    const r = await db.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='provider_entity'",
    );
    expect(r.rows[0].n).toBeGreaterThan(0);
  });

  it("org B sees NONE of org A's rows (org-column policy: provider_entity)", async () => {
    const r = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM provider_entity WHERE id=$1", [peA]),
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("org B sees NONE of org A's rows (join-scoped policy: location)", async () => {
    const r = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM location WHERE provider_entity_id=$1", [peA]),
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("rejects a cross-tenant write — org B cannot insert an org-A row (WITH CHECK)", async () => {
    await expect(
      withOrg(ORG_B, () =>
        db.query(`INSERT INTO provider_entity ${PE_COLS} VALUES ${PE_VALS}`, [ORG_A]),
      ),
    ).rejects.toThrow();
  });

  it("feature_flag: org B reads the global (NULL) flag but NOT org A's flag", async () => {
    const r = await withOrg(ORG_B, () =>
      db.query("SELECT flag_key FROM feature_flag ORDER BY flag_key"),
    );
    const keys = r.rows.map((x) => x.flag_key);
    expect(keys).toContain("global_flag");
    expect(keys).not.toContain("org_a_flag");
  });

  it("org A still sees its OWN row (isolation is not just 'deny everything')", async () => {
    const r = await withOrg(ORG_A, () =>
      db.query("SELECT count(*)::int AS n FROM provider_entity WHERE id=$1", [peA]),
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("break_glass_event: org B sees none of org A's glass; cross-tenant write rejected (M3 §3.5)", async () => {
    // Break-glass persistence (audit #M3): the durable store writes break_glass_event under
    // withOrgContext; prove the `break_glass_event_org` policy isolates it like every org-scoped table.
    const bgUser = "33333333-3333-3333-3333-333333333333";
    await db.query(
      "INSERT INTO \"user\" (id,email) VALUES ($1,'bg@x.test') ON CONFLICT DO NOTHING",
      [bgUser],
    );
    const ins = await withOrg(ORG_A, () =>
      db.query(
        "INSERT INTO break_glass_event (organization_id,actor_user_id,reason,expires_at) " +
          "VALUES ($1,$2,'emergency',now()+interval '4 hours') RETURNING id",
        [ORG_A, bgUser],
      ),
    );
    const eventId = ins.rows[0].id as string;
    // org A sees its own open glass…
    const a = await withOrg(ORG_A, () =>
      db.query("SELECT count(*)::int AS n FROM break_glass_event WHERE id=$1", [eventId]),
    );
    expect(a.rows[0].n).toBe(1);
    // …org B sees none of it…
    const b = await withOrg(ORG_B, () =>
      db.query("SELECT count(*)::int AS n FROM break_glass_event WHERE id=$1", [eventId]),
    );
    expect(b.rows[0].n).toBe(0);
    // …and org B cannot open glass in org A's name (WITH CHECK).
    await expect(
      withOrg(ORG_B, () =>
        db.query(
          "INSERT INTO break_glass_event (organization_id,actor_user_id,reason,expires_at) " +
            "VALUES ($1,$2,'x',now()+interval '1 hour')",
          [ORG_A, bgUser],
        ),
      ),
    ).rejects.toThrow();
  });

  it("audit_event is append-only to the app role (UPDATE + DELETE both denied)", async () => {
    await expect(
      withOrg(ORG_A, () => db.query("UPDATE audit_event SET created_at = now()")),
    ).rejects.toThrow();
    await expect(withOrg(ORG_A, () => db.query("DELETE FROM audit_event"))).rejects.toThrow();
  });

  // ── M38 Terminology — platform-shared RLS + canonical lockdown (§9.2 / §9.4) ─────────────
  // The migrations applied above already include 0014/0015 (M38). This proves on REAL Postgres
  // the two halves of the M38 access model that the pure unit suites cannot reach:
  //   • the 12 platform tables are public-read (USING (true)) but locked to chartwarden_app for
  //     writes — only `terminology_loader` writes canonical (§7.4) — and return identical rows
  //     under any tenant context (§9.4 public-read positive test);
  //   • value_set_tenant_extension is the one org-scoped table — standard app.org_id RLS, an
  //     M4 write-audit trigger fires on the tenant write (§3.8), and Org A's row is invisible to
  //     Org B (§9.4);
  //   • two versions of a code coexist; the as-of filter resolves the active row at the old
  //     service date and the retired row today, with the deprecation successor populated (§9.2).
  describe("M38 Terminology — platform RLS, canonical lockdown, as-of coexistence (§9.2/§9.4)", () => {
    let v1: string; // 2023 code_system_version
    let v2: string; // 2024 code_system_version
    let platformCodeSystems: number; // baseline count seeded as superuser

    beforeAll(async () => {
      // Seed canonical terminology as superuser (RLS + table grants bypassed). This stands in for
      // the `terminology_loader` SECURITY DEFINER load path; chartwarden_app must never reach it.
      await db.query(
        "INSERT INTO code_system (id,name,license_source) VALUES ('icd10cm','ICD-10-CM','CMS/NCHS public domain')",
      );
      const ins = async (version: string, from: string, to: string | null) =>
        (
          await db.query(
            `INSERT INTO code_system_version (code_system_id,version,released_on,effective_from,effective_to,source_file_ref,checksum,status)
             VALUES ('icd10cm',$1,$2,$2,$3,'ref','sum','active') RETURNING id`,
            [version, from, to],
          )
        ).rows[0].id as string;
      v1 = await ins("FY2023", "2022-10-01", "2023-09-30");
      v2 = await ins("FY2024", "2023-10-01", null);

      // X-RETIRED: active in FY2023 (ends 2023-09-30), then retired in FY2024 — two coexisting rows.
      await db.query(
        `INSERT INTO concept_icd10cm (code,display,status,effective_date,end_date,version_id) VALUES
           ('X-RETIRED','Active until 2023','active','2022-10-01','2023-09-30',$1),
           ('X-RETIRED','Retired in 2024','retired','2023-10-01','2024-09-30',$2),
           ('A00','Cholera','active','2015-10-01',NULL,$2)`,
        [v1, v2],
      );
      await db.query(
        `INSERT INTO deprecation_mapping (system_id,deprecated_code,deprecation_effective,successor_codes,mapping_kind,created_in_version_id)
         VALUES ('icd10cm','X-RETIRED','2024-10-01',ARRAY['X-NEW'],'equivalent',$1)`,
        [v2],
      );
      await db.query(
        "INSERT INTO value_set (id,name,scope) VALUES ('hospice_terminal_dx','Hospice terminal dx','platform')",
      );
      await db.query(
        "INSERT INTO value_set_member (value_set_id,system_id,code,member_effective) VALUES ('hospice_terminal_dx','icd10cm','A00','2015-10-01')",
      );
      platformCodeSystems = (await db.query("SELECT count(*)::int AS n FROM code_system")).rows[0]
        .n;

      // Org A adds a tenant extension AS the app role — exercises the org-scoped WITH CHECK policy
      // and fires the M4 write-audit trigger (§3.8).
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO value_set_tenant_extension (value_set_id,organization_id,system_id,code,reason)
           VALUES ('hospice_terminal_dx',$1,'icd10cm','A00','Org-A local terminal-dx addition for test')`,
          [ORG_A],
        ),
      );
    }, 60_000);

    it("§7.4 chartwarden_app CANNOT write canonical terminology (code_system + concept table)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query("INSERT INTO code_system (id,name,license_source) VALUES ('snomed','x','y')"),
        ),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "INSERT INTO concept_icd10cm (code,display,status,effective_date,version_id) VALUES ('B00','x','active','2024-01-01',$1)",
            [v2],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§9.4 platform tables are public-read — identical rows under either tenant context", async () => {
      const a = await withOrg(ORG_A, () => db.query("SELECT count(*)::int AS n FROM code_system"));
      const b = await withOrg(ORG_B, () => db.query("SELECT count(*)::int AS n FROM code_system"));
      expect(a.rows[0].n).toBe(platformCodeSystems);
      expect(b.rows[0].n).toBe(platformCodeSystems);
      // and value_set members read identically across tenants
      const ma = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM value_set_member"),
      );
      const mb = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM value_set_member"),
      );
      expect(ma.rows[0].n).toBe(mb.rows[0].n);
    });

    it("§9.2 two versions coexist — as-of resolves active at the old date, retired today", async () => {
      const at = (asOf: string) =>
        withOrg(ORG_A, () =>
          db.query(
            `SELECT display,status FROM concept_icd10cm
             WHERE code='X-RETIRED' AND effective_date <= $1 AND (end_date IS NULL OR end_date >= $1)`,
            [asOf],
          ),
        );
      const old = await at("2023-06-15");
      expect(old.rows).toHaveLength(1);
      expect(old.rows[0].status).toBe("active");
      const now = await at("2024-06-15");
      expect(now.rows).toHaveLength(1);
      expect(now.rows[0].status).toBe("retired");
      // the deprecation successor is populated for the retired code
      const dep = await withOrg(ORG_A, () =>
        db.query(
          "SELECT successor_codes FROM deprecation_mapping WHERE deprecated_code='X-RETIRED'",
        ),
      );
      expect(dep.rows[0].successor_codes).toEqual(["X-NEW"]);
    });

    it("§9.4 value_set_tenant_extension is org-scoped — Org A sees its row, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM value_set_tenant_extension WHERE organization_id=$1",
          [ORG_A],
        ),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM value_set_tenant_extension"),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0); // Org B's context sees none of Org A's extensions
    });

    it("§9.4 Org B cannot write an Org-A tenant extension (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO value_set_tenant_extension (value_set_id,organization_id,system_id,code,reason)
             VALUES ('hospice_terminal_dx',$1,'icd10cm','A00','cross-tenant write attempt — must fail')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.8 the M4 write-audit trigger fired for the tenant extension write", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='term_value_set_extension' AND organization_id=$1",
        [ORG_A],
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  });

  // ── M36 Secure Messaging & Alerts — RLS, parent-join children, user-scoped, audit (§3.7–3.9) ─
  // The migrations applied above include 0016/0017 (M36). This proves on REAL Postgres the M36
  // access model the pure unit suites cannot reach:
  //   • org-scoped tables (channel/message) isolate Org A from Org B and reject cross-tenant writes;
  //   • the children with NO organization_id (message_attachment, notification_delivery) are
  //     org-isolated THROUGH the parent join, not a direct org column (§3.7);
  //   • alert_rule platform-default rows (organization_id IS NULL) are read by every tenant, and a
  //     system_locked rule cannot be updated by a tenant (§7.4 system_locked);
  //   • alert_payload_catalog is platform-floor public-read (§3.12);
  //   • the M4 write-audit trigger fires on the channel/message writes and scrubs message.body_cipher
  //     to the `<changed>` marker (§3.9 denylist).
  describe("M36 Messaging — org isolation, parent-join children, audit scrub (§3.7–3.9)", () => {
    const U_A = "11111111-1111-1111-1111-1111111111aa";
    const U_B = "11111111-1111-1111-1111-1111111111bb";
    const SUBJECT = "22222222-2222-2222-2222-222222222222";
    let channelId: string;
    let messageId: string;
    let alertId: string;

    /** Run `fn` as chartwarden_app with both app.org_id and app.user_id set (user-scoped policies). */
    async function withOrgUser<T>(org: string, user: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE chartwarden_app");
      await db.query("SELECT set_config('app.org_id', $1, false)", [org]);
      await db.query("SELECT set_config('app.user_id', $1, false)", [user]);
      try {
        return await fn();
      } finally {
        await db.query("RESET ROLE");
      }
    }

    beforeAll(async () => {
      // Users + active memberships (superuser; RLS bypassed) so presence co-worker visibility and
      // channel_member FKs resolve.
      await db.query("INSERT INTO \"user\" (id,email) VALUES ($1,'a@x.test'),($2,'b@x.test')", [
        U_A,
        U_B,
      ]);
      await db.query(
        `INSERT INTO membership (user_id,organization_id,status) VALUES ($1,$3,'active'),($2,$4,'active')`,
        [U_A, U_B, ORG_A, ORG_B],
      );
      // Platform-floor payload catalog + a platform-default + a system_locked alert_rule (superuser).
      await db.query(
        `INSERT INTO alert_payload_catalog (payload_type,module_owner,severity,default_channels,default_recipient_resolver,payload_schema,description)
         VALUES ('m36.test.ping','m36','INFO',ARRAY['in_app'],'broadcast','{}'::jsonb,'test payload')`,
      );
      await db.query(
        `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,system_locked)
         VALUES (NULL,'m36.test.ping','system','info','broadcast',true)`,
      );

      // Org A creates a care-team channel + member + message AS the app role (exercises WITH CHECK).
      channelId = await withOrgUser(ORG_A, U_A, async () => {
        const c = await db.query(
          `INSERT INTO channel (organization_id,channel_kind,subject_id,title,retention_class)
           VALUES ($1,'care_team',$2,'Care team','care_related') RETURNING id`,
          [ORG_A, SUBJECT],
        );
        const cid = c.rows[0].id as string;
        await db.query(
          `INSERT INTO channel_member (organization_id,channel_id,user_id,source) VALUES ($1,$2,$3,'manual')`,
          [ORG_A, cid, U_A],
        );
        const m = await db.query(
          `INSERT INTO message (channel_id,organization_id,author_user_id,author_kind,body_cipher,body_sha256)
           VALUES ($1,$2,$3,'user',decode('00','hex'),repeat('a',64)) RETURNING id`,
          [cid, ORG_A, U_A],
        );
        messageId = m.rows[0].id as string;
        await db.query(
          `INSERT INTO message_attachment (organization_id,channel_id,uploaded_by,message_id,document_ref,mime_type,byte_size,filename)
           VALUES ($1,$2,$3,$4,$5,'application/pdf',10,'f.pdf')`,
          [ORG_A, cid, U_A, messageId, SUBJECT],
        );
        // FB-T05 write path: the send → read-receipt fan-out writes a per-recipient message_receipt
        // (org-scoped). Seed one so the two-tenant isolation of the receipt surface is exercised.
        await db.query(
          `INSERT INTO message_receipt (organization_id,message_id,user_id,status) VALUES ($1,$2,$3,'delivered')`,
          [ORG_A, messageId, U_A],
        );
        // presence + delivery_endpoint are user-scoped
        await db.query("INSERT INTO presence (user_id,status) VALUES ($1,'online')", [U_A]);
        await db.query(
          `INSERT INTO delivery_endpoint (user_id,channel,endpoint_value) VALUES ($1,'email','a@x.test')`,
          [U_A],
        );
        // an alert + a child notification_delivery (in_app — voice is SOS-gated)
        const al = await db.query(
          `INSERT INTO alert (organization_id,event_type,severity,payload,correlation_id)
           VALUES ($1,'m36.test.ping','info','{"k":"v"}'::jsonb,'corr-1') RETURNING id`,
          [ORG_A],
        );
        alertId = al.rows[0].id as string;
        await db.query(
          `INSERT INTO notification_delivery (alert_id,recipient_user_id,alert_category,alert_severity,channel)
           VALUES ($1,$2,'system','info','in_app')`,
          [alertId, U_A],
        );
        return cid;
      });
    }, 60_000);

    it("§3.7 Org B sees NONE of Org A's channels or messages", async () => {
      const ch = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM channel WHERE id=$1", [channelId]),
      );
      const ms = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM message WHERE id=$1", [messageId]),
      );
      expect(ch.rows[0].n).toBe(0);
      expect(ms.rows[0].n).toBe(0);
    });

    it("§3.7 Org A still reads its own channel + message (isolation is not deny-all)", async () => {
      const ch = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM channel WHERE id=$1", [channelId]),
      );
      expect(ch.rows[0].n).toBe(1);
    });

    it("§3.7 cross-tenant write rejected — Org B cannot insert an Org-A channel (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO channel (organization_id,channel_kind,subject_id,title,retention_class)
             VALUES ($1,'care_team',$2,'x','care_related')`,
            [ORG_A, SUBJECT],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.7 message_attachment (org column since 1075) and notification_delivery (parent join) are org-isolated", async () => {
      const att = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM message_attachment WHERE message_id=$1", [
          messageId,
        ]),
      );
      const nd = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM notification_delivery WHERE alert_id=$1", [
          alertId,
        ]),
      );
      expect(att.rows[0].n).toBe(0);
      expect(nd.rows[0].n).toBe(0);
      // Org A still sees them through its own parent rows
      const attA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM message_attachment WHERE message_id=$1", [
          messageId,
        ]),
      );
      expect(attA.rows[0].n).toBe(1);
    });

    it("§3.7 FB-T05 write path: Org B sees NONE of Org A's message_receipt fan-out rows", async () => {
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM message_receipt WHERE message_id=$1", [messageId]),
      );
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM message_receipt WHERE message_id=$1", [messageId]),
      );
      expect(b.rows[0].n).toBe(0);
      expect(a.rows[0].n).toBe(1); // Org A still reads its own receipt
    });

    it("§3.7 FB-T05 write path: a cross-tenant message_receipt write is rejected (WITH CHECK)", async () => {
      await expect(
        withOrgUser(ORG_B, U_B, () =>
          db.query(
            `INSERT INTO message_receipt (organization_id,message_id,user_id,status) VALUES ($1,$2,$3,'delivered')`,
            [ORG_A, messageId, U_B],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.7 alert_rule platform-default (NULL org) is read by every tenant", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM alert_rule WHERE organization_id IS NULL"),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM alert_rule WHERE organization_id IS NULL"),
      );
      expect(a.rows[0].n).toBeGreaterThan(0);
      expect(b.rows[0].n).toBe(a.rows[0].n);
    });

    it("§7.4 a system_locked alert_rule cannot be updated or deleted by a tenant", async () => {
      // The platform-default rule has NULL org → not own-org, so UPDATE/DELETE match no row (0 rows),
      // never the locked row. Assert the row survives.
      await withOrg(ORG_A, () =>
        db.query("UPDATE alert_rule SET enabled=false WHERE event_type='m36.test.ping'"),
      );
      const r = await db.query(
        "SELECT enabled FROM alert_rule WHERE event_type='m36.test.ping' AND organization_id IS NULL",
      );
      expect(r.rows[0].enabled).toBe(true);
    });

    it("§3.12 alert_payload_catalog is platform-floor public-read across tenants", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM alert_payload_catalog"),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM alert_payload_catalog"),
      );
      expect(a.rows[0].n).toBeGreaterThan(0);
      expect(a.rows[0].n).toBe(b.rows[0].n);
    });

    it("§3.7 presence: a co-worker in the same tenant context can read it; an outsider cannot", async () => {
      const coworker = await withOrgUser(ORG_A, U_B, () =>
        db.query("SELECT count(*)::int AS n FROM presence WHERE user_id=$1", [U_A]),
      );
      const outsider = await withOrgUser(ORG_B, U_B, () =>
        db.query("SELECT count(*)::int AS n FROM presence WHERE user_id=$1", [U_A]),
      );
      expect(coworker.rows[0].n).toBe(1); // U_B is an active Org-A member in Org-A context
      expect(outsider.rows[0].n).toBe(0); // Org-B context: U_A is not a co-worker there
    });

    it("§3.9 the M4 write-audit trigger fired for channel + message and scrubbed body_cipher", async () => {
      const ch = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind='channel' AND organization_id=$1",
        [ORG_A],
      );
      expect(ch.rows[0].n).toBeGreaterThan(0);
      const msg = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='message' AND event_type='message.insert' ORDER BY created_at DESC LIMIT 1",
      );
      expect(msg.rows[0].after.body_cipher).toBe("<changed>"); // §3.9 denylist scrub
    });
  });

  // ── M40 Master Data Management — two-table canonical/overlay RLS, audit (§3.6–3.7 / §7.3–7.4) ─
  // The migrations applied above include 0018/0019 (M40). This proves on REAL Postgres the M40
  // access model the pure unit suites cannot reach:
  //   • canonical (external_physician/facility/payer) is org-less platform master data — public-read
  //     to every tenant, and chartwarden_app can NEVER write it (§7.4: only mdm_canonical_writer can);
  //   • external_physician_tenant_overlay is org-scoped — Org A sees its overlay, Org B sees none,
  //     and Org B cannot write an Org-A overlay row (§7.3 two-tenant overlay isolation, WITH CHECK);
  //   • merge_request is the platform-ops surface — no chartwarden_app grant at all;
  //   • the M4 write-audit trigger fires on the overlay write and scrubs `contract_terms` (§3.7).
  describe("M40 MDM — canonical lockdown, overlay isolation, audit (§3.6–3.7 / §7.3–7.4)", () => {
    let physicianId: string;
    let canonicalFacilities: number; // baseline count seeded as superuser

    beforeAll(async () => {
      // Seed canonical MDM as superuser (RLS + table grants bypassed). This stands in for the
      // mdm_canonical_writer SECURITY DEFINER load path (NPPES sync / admin merge); chartwarden_app
      // must never reach it (§7.4).
      const phy = await db.query(
        `INSERT INTO external_physician (npi,first_name,last_name,status)
         VALUES ('1234567890','Ada','Lovelace','active') RETURNING id`,
      );
      physicianId = phy.rows[0].id as string;
      await db.query(
        `INSERT INTO facility (ccn,kind,name,status) VALUES ('123456','hospital','Mercy General','active')`,
      );
      await db.query(
        `INSERT INTO payer (kind,name,status) VALUES ('medicare','Medicare','active')`,
      );
      canonicalFacilities = (await db.query("SELECT count(*)::int AS n FROM facility")).rows[0].n;

      // Org A writes its overlay for the canonical physician AS the app role — exercises the
      // org-scoped WITH CHECK policy and fires the M4 write-audit trigger (§3.7).
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO external_physician_tenant_overlay
             (external_physician_id,organization_id,do_not_refer,relationship_notes,contract_terms)
           VALUES ($1,$2,true,'Org-A prefers this physician','{"rate":"confidential"}'::jsonb)`,
          [physicianId, ORG_A],
        ),
      );
    }, 60_000);

    it("§7.4 chartwarden_app CANNOT write canonical MDM (external_physician + facility + payer)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "INSERT INTO external_physician (npi,first_name,last_name) VALUES ('9999999999','x','y')",
          ),
        ),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("INSERT INTO facility (kind,name) VALUES ('clinic','x')")),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("INSERT INTO payer (kind,name) VALUES ('commercial','x')")),
      ).rejects.toThrow();
    });

    it("§3.6 canonical is public-read — identical rows under either tenant context", async () => {
      const a = await withOrg(ORG_A, () => db.query("SELECT count(*)::int AS n FROM facility"));
      const b = await withOrg(ORG_B, () => db.query("SELECT count(*)::int AS n FROM facility"));
      expect(a.rows[0].n).toBe(canonicalFacilities);
      expect(b.rows[0].n).toBe(canonicalFacilities);
      const pa = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM external_physician WHERE id=$1", [physicianId]),
      );
      expect(pa.rows[0].n).toBe(1); // canonical is the same answer for every tenant (§2.3)
    });

    it("§7.3 external_physician_tenant_overlay is org-scoped — Org A sees its row, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query(
          "SELECT count(*)::int AS n FROM external_physician_tenant_overlay WHERE organization_id=$1",
          [ORG_A],
        ),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM external_physician_tenant_overlay"),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0); // Org B's context sees none of Org A's overlays
    });

    it("§7.3 Org B cannot write an Org-A overlay row (WITH CHECK)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO external_physician_tenant_overlay (external_physician_id,organization_id,do_not_refer)
             VALUES ($1,$2,true)`,
            [physicianId, ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 merge_request is platform-ops only — chartwarden_app has no grant", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("SELECT count(*) FROM merge_request")),
      ).rejects.toThrow();
    });

    it("§3.7 the M4 write-audit trigger fired for the overlay write and scrubbed contract_terms", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='physician_overlay' AND event_type='physician_overlay.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.contract_terms).toBe("<changed>"); // §3.7 denylist scrub
    });
  });

  // ── M5 Patient & Demographics — org-scoped RLS, no-DELETE spine, audit scrub (§3.6–3.7 / §9.4) ─
  // 0020/0021 (M5) applied above. Proves on REAL Postgres: cross-tenant patient reads are blocked
  // by RLS even with app authorization stubbed open (§9.4 layer-independence); the patient spine has
  // no DELETE grant (§3.6); the M4 write-audit trigger scrubs the name denylist (§3.7).
  describe("M5 Patient — cross-tenant isolation, no-DELETE spine, audit scrub (§3.6–3.7 / §9.4)", () => {
    const PATIENT_A = "aaaa1111-1111-1111-1111-111111111111";
    const PATIENT_B = "bbbb2222-2222-2222-2222-222222222222";
    const PCOLS =
      "(id,organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth)";

    beforeAll(async () => {
      // Seed one patient per org as superuser (RLS bypassed) — the §9.4 fixture.
      await db.query(
        `INSERT INTO patient ${PCOLS} VALUES
           ($1,$2,'MRN-A','Ada','Lovelace','1990-01-01','F'),
           ($3,$4,'MRN-B','Bob','Brown','1985-05-05','M')`,
        [PATIENT_A, ORG_A, PATIENT_B, ORG_B],
      );
    });

    it("§9.4 Org A sees ONLY its own patient (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const rows = await withOrg(ORG_A, () => db.query("SELECT id FROM patient"));
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].id).toBe(PATIENT_A);
    });

    it("§3.6 Org B cannot INSERT a patient into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO patient ${PCOLS} VALUES (gen_random_uuid(),$1,'MRN-X','E','V','2000-01-01','U')`,
            [ORG_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 the patient spine has NO DELETE grant (deaths/merges are state changes, not deletes)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM patient WHERE id=$1", [PATIENT_A])),
      ).rejects.toThrow();
    });

    it("§3.7 the M4 write-audit trigger fired for the patient write and scrubbed the name denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='patient' AND event_type='patient.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.legal_first_name).toBe("<changed>"); // §3.7 name denylist scrub
      expect(r.rows[0].after.mrn).toBe("MRN-A"); // non-sensitive column passes through
    });
  });

  describe("M39 Consent — dual-grant catalog, org-scoped records, audit scrub, eval immutability (§3.5–3.7)", () => {
    const PAT_A = "cccc1111-1111-1111-1111-111111111111";
    const REC_A = "dddd1111-1111-1111-1111-111111111111";
    const REC_B = "dddd2222-2222-2222-2222-222222222222";
    const CCOLS =
      "(id,organization_id,patient_id,type_key,scope_descriptor,grantor_kind,effective_at,capture_method,capture_evidence_jsonb,internal_notes_cipher,created_by_id)";
    const CVALS =
      "'42_cfr_part_2_release','{\"recipients\":[]}'::jsonb,'patient_self',now(),'typed_signature_in_app','{}'::jsonb,'CIPHERTEXT',gen_random_uuid()";

    beforeAll(async () => {
      // Seed the platform-shared catalog floor + one consent_record per org as superuser (RLS
      // bypassed) — the §3.5 fixture. The M4 write-audit trigger still fires on these inserts.
      await db.query(
        `INSERT INTO consent_type_catalog
           (type_key, display_name_en, scope_discriminator, capture_method_floor, reminder_cadence_floor,
            revocation_cascade_kind, is_per_recipient, is_per_named_agent, is_post_mortem_eligible,
            requires_jurisdiction_code, cfr_42_part_2_compliant, hipaa_164_508_compliant,
            body_text_template_key, m22_template_version)
         VALUES ('42_cfr_part_2_release','42 CFR Part 2 Release','per_recipient',
            ARRAY['typed_signature_in_app']::text[], ARRAY['30_days']::text[],
            'sud_release', true, false, false, false, true, true, 'consent_record', 'v1')
         ON CONFLICT (type_key) DO NOTHING`,
      );
      await db.query(
        `INSERT INTO consent_record ${CCOLS} VALUES
           ($1,$2,$3,${CVALS}),
           ($4,$5,$3,${CVALS})`,
        [REC_A, ORG_A, PAT_A, REC_B, ORG_B],
      );
    });

    it("§3.5 consent_type_catalog is platform-shared — Org A and Org B read the same floor", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM consent_type_catalog"),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM consent_type_catalog"),
      );
      expect(a.rows[0].n).toBeGreaterThan(0);
      expect(a.rows[0].n).toBe(b.rows[0].n);
    });

    it("§7.4 chartwarden_app CANNOT write the platform consent-type floor (dual-grant: writer-role only)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            "INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator, capture_method_floor, reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant, hipaa_164_508_compliant, body_text_template_key, m22_template_version) VALUES ('custom','x','categorical',ARRAY[]::text[],ARRAY[]::text[],'none',false,false,false,false,false,false,'x','v1')",
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.5 consent_record is org-scoped — Org A sees its record, Org B sees none of it", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM consent_record WHERE id=$1", [REC_A]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM consent_record WHERE id=$1", [REC_A]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT a consent_record into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO consent_record ${CCOLS} VALUES (gen_random_uuid(),$1,$2,${CVALS})`,
            [ORG_A, PAT_A],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.7 the M4 write-audit trigger fired for the consent write and scrubbed the PHI denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='consent_record' AND event_type='consent_record.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.internal_notes_cipher).toBe("<changed>"); // §3.7 ciphertext scrub
      expect(r.rows[0].after.scope_descriptor).toBe("<changed>"); // §3.7 jsonb scope scrub
      expect(r.rows[0].after.type_key).toBe("42_cfr_part_2_release"); // non-sensitive passes through
    });

    it("§3.6/D12 consent_eval_audit is INSERT-only — the immutability trigger denies UPDATE + DELETE", async () => {
      const evalId = "eeee1111-1111-1111-1111-111111111111";
      await withOrg(ORG_A, () =>
        db.query(
          "INSERT INTO consent_eval_audit (id, organization_id, patient_id, type_key, allowed, as_of, caller_module) VALUES ($1,$2,$3,'42_cfr_part_2_release',true,now(),'m28')",
          [evalId, ORG_A, PAT_A],
        ),
      );
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE consent_eval_audit SET allowed=false WHERE id=$1", [evalId]),
        ),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM consent_eval_audit WHERE id=$1", [evalId])),
      ).rejects.toThrow();
    });
  });

  // ── M6 Admission, Election & Certification — org-scoped RLS, no-DELETE, audit scrub (§3.6–3.7 / §9.3) ─
  // 0026/0027 (M6) applied above. Proves on REAL Postgres: every M6 row is tenant-isolated on
  // app.org_id even with app authorization stubbed open (§9.3 layer-independence); chartwarden_app has
  // NO DELETE on any M6 table (§3.6 supersession-via-status); the M4 write-audit trigger scrubs the
  // §3.7 intake-PII denylist (referral.patient_name_at_receipt) while non-sensitive columns pass through.
  describe("M6 Admission — cross-tenant isolation, no-DELETE, audit scrub (§3.6–3.7 / §9.3)", () => {
    const REF_A = "f6a11111-1111-1111-1111-111111111111";
    const REF_B = "f6b22222-2222-2222-2222-222222222222";
    const RCOLS = "(id,organization_id,patient_name_at_receipt,source_channel)";

    beforeAll(async () => {
      // Seed one referral per org as superuser (RLS bypassed) — the §9.3 fixture. The M4 write-audit
      // trigger still fires on these inserts (proven below).
      await db.query(
        `INSERT INTO referral ${RCOLS} VALUES
           ($1,$2,'Carol Carer','phone'),
           ($3,$4,'Dan Dueller','fax')`,
        [REF_A, ORG_A, REF_B, ORG_B],
      );
    });

    it("§9.3 Org A sees ONLY its own referral (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM referral WHERE id=$1", [REF_A]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM referral WHERE id=$1", [REF_A]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.6 Org B cannot INSERT a referral into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(`INSERT INTO referral ${RCOLS} VALUES (gen_random_uuid(),$1,'X','portal')`, [
            ORG_A,
          ]),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 no M6 table has a DELETE grant for chartwarden_app (supersession via status, not deletes)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM referral WHERE id=$1", [REF_A])),
      ).rejects.toThrow();
    });

    it("§3.7 the M4 write-audit trigger fired for the referral write and scrubbed the intake-PII denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='referral' AND event_type='referral.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.patient_name_at_receipt).toBe("<changed>"); // §3.7 intake-PII scrub
      expect(r.rows[0].after.source_channel).toBe("phone"); // non-sensitive column passes through
    });
  });

  // ── M8 Encounters & Visit Notes — org-scoped RLS, no-DELETE, audit scrub (§3.3–3.4 / §9.3) ──────────
  // 0030/0031 (M8) applied above. Proves on REAL Postgres: every M8 encounter is tenant-isolated on
  // app.org_id even with app authorization stubbed open (§9.3 layer-independence); chartwarden_app has NO
  // DELETE on any M8 table (§3.6 — an encounter is voided, never deleted); the M4 write-audit trigger
  // scrubs the §8.1 free-text PHI denylist (encounter.late_entry_reason) while structured columns
  // (encounter_type) pass through.
  describe("M8 Encounters — cross-tenant isolation, no-DELETE, audit scrub (§3.3–3.4 / §9.3)", () => {
    const PE_A8 = "e8a00000-0000-0000-0000-0000000000a1";
    const PE_B8 = "e8b00000-0000-0000-0000-0000000000b1";
    const LOC_A8 = "e8a00000-0000-0000-0000-0000000000a2";
    const LOC_B8 = "e8b00000-0000-0000-0000-0000000000b2";
    const USER_A8 = "e8a00000-0000-0000-0000-0000000000a3";
    const USER_B8 = "e8b00000-0000-0000-0000-0000000000b3";
    const MEM_A8 = "e8a00000-0000-0000-0000-0000000000a4";
    const MEM_B8 = "e8b00000-0000-0000-0000-0000000000b4";
    const ENC_A8 = "e8a00000-0000-0000-0000-0000000000a5";
    const ENC_B8 = "e8b00000-0000-0000-0000-0000000000b5";
    const LATE_REASON =
      "Documented late entry: visit charted after the same-day cutoff per policy.";
    const ECOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,encounter_type,discipline,authored_by_membership_id,service_date,late_entry_reason)";

    beforeAll(async () => {
      // Seed FK parents + one encounter per org as superuser (RLS bypassed) — the §9.3 fixture. CCN/NPI
      // are globally unique, so use M8-specific values that don't collide with the top-level peA seed.
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M8A','M8 A','NPI-M8A','enc','12-31'),
                  ($3,$4,'CCN-M8B','M8 B','NPI-M8B','enc','12-31')`,
        [PE_A8, ORG_A, PE_B8, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L8A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L8B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A8, PE_A8, LOC_B8, PE_B8],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m8a@x.test'),($2,'m8b@x.test')`, [
        USER_A8,
        USER_B8,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A8, USER_A8, ORG_A, MEM_B8, USER_B8, ORG_B],
      );
      // late_entry_tier defaults to 'normal' (the check's first disjunct holds), so a populated
      // late_entry_reason is legal here and lets us prove the audit-trigger scrub.
      await db.query(
        `INSERT INTO encounter ${ECOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'routine_visit','rn',$5,current_date,$6),
           ($7,$8,$9,$10,gen_random_uuid(),gen_random_uuid(),'routine_visit','rn',$11,current_date,$6)`,
        [ENC_A8, ORG_A, PE_A8, LOC_A8, MEM_A8, LATE_REASON, ENC_B8, ORG_B, PE_B8, LOC_B8, MEM_B8],
      );
    });

    it("§9.3 Org A sees ONLY its own encounter (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM encounter WHERE id=$1", [ENC_A8]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM encounter WHERE id=$1", [ENC_A8]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.3 Org B cannot INSERT an encounter into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO encounter ${ECOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'routine_visit','rn',$4,current_date,NULL)`,
            [ORG_A, PE_A8, LOC_A8, MEM_A8],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 no M8 table has a DELETE grant for chartwarden_app (encounters are voided, never deleted)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM encounter WHERE id=$1", [ENC_A8])),
      ).rejects.toThrow();
    });

    it("§8.1 the M4 write-audit trigger fired for the encounter write and scrubbed the free-text PHI denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='encounter' AND event_type='encounter.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.late_entry_reason).toBe("<changed>"); // §8.1 free-text PHI scrub
      expect(r.rows[0].after.encounter_type).toBe("routine_visit"); // structured column passes through
    });
  });

  // ── M9 Clinical Assessments — org-scoped RLS, partition+correction trigger, audit scrub (§9.4 / §3.4–3.6)
  // 0032/0033 (M9) applied above. Proves on REAL Postgres: clinical_assessment is tenant-isolated on
  // app.org_id even with app authorization stubbed open (§9.3 layer-independence); the RANGE-partitioned
  // parent's correction-supersede trigger fires under RLS and CANNOT reach across tenants (§9.4 bullet 3);
  // chartwarden_app has NO DELETE (append-only — a correction supersedes, never deletes, §3.6); scale_license
  // is org-scoped config (§9.4 bullet 4); the M4 write-audit trigger scrubs the `data`/`correction_reason`
  // denylist (§3.1/§8.1) while the structured `scale_type` passes through.
  describe("M9 Clinical Assessments — cross-tenant isolation, correction trigger, audit scrub (§9.4 / §3.4–3.6)", () => {
    const PE_A9 = "e9a00000-0000-0000-0000-0000000000a1";
    const PE_B9 = "e9b00000-0000-0000-0000-0000000000b1";
    const LOC_A9 = "e9a00000-0000-0000-0000-0000000000a2";
    const LOC_B9 = "e9b00000-0000-0000-0000-0000000000b2";
    const USER_A9 = "e9a00000-0000-0000-0000-0000000000a3";
    const USER_B9 = "e9b00000-0000-0000-0000-0000000000b3";
    const MEM_A9 = "e9a00000-0000-0000-0000-0000000000a4";
    const MEM_B9 = "e9b00000-0000-0000-0000-0000000000b4";
    const ASMT_A9 = "e9a00000-0000-0000-0000-0000000000a5";
    const ASMT_B9 = "e9b00000-0000-0000-0000-0000000000b5";
    const LIC_A9 = "e9a00000-0000-0000-0000-0000000000a6";
    // captured_at: a stable instant inside the current month (a partition guaranteed to exist post-migration);
    // the DEFERRABLE composite self-FK pairs (corrects_assessment_id, captured_at) so a correction must reuse
    // its target's captured_at — both rows therefore share this value.
    const CAP = "(date_trunc('month', now()) + interval '10 days')";
    const ACOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,scale_type,scale_version,data,score,captured_at,captured_by_membership_id,captured_by_discipline,status,version)";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M9A','M9 A','NPI-M9A','enc','12-31'),
                  ($3,$4,'CCN-M9B','M9 B','NPI-M9B','enc','12-31')`,
        [PE_A9, ORG_A, PE_B9, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L9A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L9B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A9, PE_A9, LOC_B9, PE_B9],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m9a@x.test'),($2,'m9b@x.test')`, [
        USER_A9,
        USER_B9,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A9, USER_A9, ORG_A, MEM_B9, USER_B9, ORG_B],
      );
      // One active PPS capture per org (superuser → RLS bypassed). data jsonb carries a free-text note so
      // the audit scrub is observable; both rows share CAP so an in-org correction's composite FK resolves.
      await db.query(
        `INSERT INTO clinical_assessment ${ACOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'pps','pps_v2_2001','{"note":"free text PHI"}'::jsonb,60,${CAP},$5,'rn','active',1),
           ($6,$7,$8,$9,gen_random_uuid(),gen_random_uuid(),'pps','pps_v2_2001','{"note":"free text PHI"}'::jsonb,60,${CAP},$10,'rn','active',1)`,
        [ASMT_A9, ORG_A, PE_A9, LOC_A9, MEM_A9, ASMT_B9, ORG_B, PE_B9, LOC_B9, MEM_B9],
      );
      // One active scale_license per org (PPS is a licensed scale, D3).
      await db.query(
        `INSERT INTO scale_license (id,organization_id,scale_type,license_holder,effective_date,expires_at,status,recorded_by_membership_id)
           VALUES ($1,$2,'pps','Victoria Hospice',current_date,current_date + 365,'active',$3)`,
        [LIC_A9, ORG_A, MEM_A9],
      );
    });

    it("§9.4 Org A sees ONLY its own clinical_assessment (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM clinical_assessment WHERE id=$1", [ASMT_A9]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM clinical_assessment WHERE id=$1", [ASMT_A9]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT a clinical_assessment into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO clinical_assessment ${ACOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'pps','pps_v2_2001','{}'::jsonb,60,${CAP},$4,'rn','active',1)`,
            [ORG_A, PE_A9, LOC_A9, MEM_A9],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 clinical_assessment has NO DELETE grant for chartwarden_app (corrections supersede, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM clinical_assessment WHERE id=$1", [ASMT_A9])),
      ).rejects.toThrow();
    });

    it("§3.4 the correction-supersede trigger flips the prior Org-A row to superseded (D9, under RLS)", async () => {
      // Insert a correction that reuses the target's patient/admission/captured_at (composite self-FK) under
      // Org A's RLS context; the AFTER-INSERT trigger flips the target row to 'superseded' in the same TX (D9).
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO clinical_assessment
             (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,scale_type,scale_version,data,score,captured_at,captured_by_membership_id,captured_by_discipline,status,version,corrects_assessment_id,correction_reason)
           SELECT gen_random_uuid(),organization_id,provider_entity_id,location_id,patient_id,admission_id,scale_type,scale_version,
                  '{"note":"corrected"}'::jsonb,70,captured_at,$2,'rn','active',1,id,'transcription correction of the PPS score'
             FROM clinical_assessment WHERE id=$1`,
          [ASMT_A9, MEM_A9],
        ),
      );
      const r = await withOrg(ORG_A, () =>
        db.query("SELECT status FROM clinical_assessment WHERE id=$1", [ASMT_A9]),
      );
      expect(r.rows[0].status).toBe("superseded");
    });

    it("§9.4 a correction from Org A cannot supersede an Org B row (never reaches across tenants)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO clinical_assessment
               (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,scale_type,scale_version,data,score,captured_at,captured_by_membership_id,captured_by_discipline,status,version,corrects_assessment_id,correction_reason)
             VALUES (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'pps','pps_v2_2001','{}'::jsonb,70,${CAP},$4,'rn','active',1,$5,'attempted cross-tenant correction')`,
            [ORG_A, PE_A9, LOC_A9, MEM_A9, ASMT_B9],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§9.4 scale_license is org-scoped — Org A sees its PPS license, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM scale_license WHERE id=$1", [LIC_A9]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM scale_license WHERE id=$1", [LIC_A9]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§8.1 the M4 write-audit trigger fired for the assessment write and scrubbed the data/free-text denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='clinical_assessment' AND event_type='clinical_assessment.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.data).toBe("<changed>"); // §8.1 free-text PHI (jsonb payload) scrub
      expect(r.rows[0].after.scale_type).toBe("pps"); // structured column passes through
    });
  });

  // ── M10 HOPE Engine — org-scoped RLS, partition+correction trigger, audit scrub (§9.4 / §3.4–3.6)
  // 0034/0035 (M10) applied above. Proves on REAL Postgres: hope_assessment is tenant-isolated on app.org_id
  // even with app authorization stubbed open (§9.3 layer-independence); the RANGE-partitioned (target_date)
  // parent's correction-supersede trigger fires under RLS and CANNOT reach across tenants (§9.4 bullet 4);
  // chartwarden_app has NO DELETE (append-only — a correction supersedes, never deletes, §3.6); the
  // hope_timepoint_schedule child is org-scoped; the M4 write-audit trigger scrubs the
  // data/clinical_context_snapshot/late_completion_reason_code denylist (§3.1/§8.1) while the structured
  // rfa_kind passes through.
  describe("M10 HOPE Engine — cross-tenant isolation, correction trigger, audit scrub (§9.4 / §3.4–3.6)", () => {
    const PE_A10 = "ea000000-0000-0000-0000-0000000000a1";
    const PE_B10 = "eb000000-0000-0000-0000-0000000000b1";
    const LOC_A10 = "ea000000-0000-0000-0000-0000000000a2";
    const LOC_B10 = "eb000000-0000-0000-0000-0000000000b2";
    const USER_A10 = "ea000000-0000-0000-0000-0000000000a3";
    const USER_B10 = "eb000000-0000-0000-0000-0000000000b3";
    const MEM_A10 = "ea000000-0000-0000-0000-0000000000a4";
    const MEM_B10 = "eb000000-0000-0000-0000-0000000000b4";
    const ASMT_A10 = "ea000000-0000-0000-0000-0000000000a5";
    const ASMT_B10 = "eb000000-0000-0000-0000-0000000000b5";
    const SCHED_A10 = "ea000000-0000-0000-0000-0000000000a6";
    // target_date: a stable instant inside the current month (a partition guaranteed to exist post-migration);
    // the DEFERRABLE composite self-FK pairs (corrects_assessment_id, target_date) so a correction must reuse
    // its target's target_date — both rows therefore share this value.
    const TGT = "(date_trunc('month', now()) + interval '10 days')";
    const HCOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,data,target_date,created_by_membership_id,status)";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M10A','M10 A','NPI-M10A','enc','12-31'),
                  ($3,$4,'CCN-M10B','M10 B','NPI-M10B','enc','12-31')`,
        [PE_A10, ORG_A, PE_B10, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L10A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L10B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A10, PE_A10, LOC_B10, PE_B10],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10a@x.test'),($2,'m10b@x.test')`, [
        USER_A10,
        USER_B10,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A10, USER_A10, ORG_A, MEM_B10, USER_B10, ORG_B],
      );
      // One signed Admission RFA per org (superuser → RLS bypassed). data jsonb carries a free-text note so
      // the audit scrub is observable; both rows share TGT so an in-org correction's composite FK resolves.
      await db.query(
        `INSERT INTO hope_assessment ${HCOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'01_admission','{"note":"free text PHI"}'::jsonb,${TGT},$5,'signed'),
           ($6,$7,$8,$9,gen_random_uuid(),gen_random_uuid(),'01_admission','{"note":"free text PHI"}'::jsonb,${TGT},$10,'signed')`,
        [ASMT_A10, ORG_A, PE_A10, LOC_A10, MEM_A10, ASMT_B10, ORG_B, PE_B10, LOC_B10, MEM_B10],
      );
      // One open schedule for Org A (the dashboard hot read).
      await db.query(
        `INSERT INTO hope_timepoint_schedule
           (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,window_opens_at,window_closes_at,late_deadline_at,alert_cadence,status,generated_by)
         VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'02_huv1',now(),now()+interval '9 days',now()+interval '16 days','{}'::jsonb,'open','auto_admission')`,
        [SCHED_A10, ORG_A, PE_A10, LOC_A10],
      );
    });

    it("§9.4 Org A sees ONLY its own hope_assessment (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM hope_assessment WHERE id=$1", [ASMT_A10]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM hope_assessment WHERE id=$1", [ASMT_A10]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT a hope_assessment into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO hope_assessment ${HCOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'01_admission','{}'::jsonb,${TGT},$4,'draft')`,
            [ORG_A, PE_A10, LOC_A10, MEM_A10],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 hope_assessment has NO DELETE grant for chartwarden_app (corrections supersede, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM hope_assessment WHERE id=$1", [ASMT_A10])),
      ).rejects.toThrow();
    });

    it("§3.4 the correction-supersede trigger flips the prior Org-A row to superseded (under RLS)", async () => {
      // Migration 0225 moved the supersede from AFTER INSERT to the draft→signed UPDATE: opening a
      // correction DRAFT must not be destructive — only SIGNING it supersedes the source. So: insert a
      // correction draft that reuses the target's patient/admission/target_date (composite self-FK) under
      // Org A's RLS context, prove the target is still 'signed', then sign the draft and prove the
      // AFTER-UPDATE trigger flipped the target to 'superseded' in the same TX.
      const CORR_A10 = "ea000000-0000-0000-0000-0000000000a7";
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO hope_assessment
             (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,data,target_date,created_by_membership_id,status,corrects_assessment_id)
           SELECT $3,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,
                  '{"note":"corrected"}'::jsonb,target_date,$2,'draft',id
             FROM hope_assessment WHERE id=$1`,
          [ASMT_A10, MEM_A10, CORR_A10],
        ),
      );
      const beforeSign = await withOrg(ORG_A, () =>
        db.query("SELECT status FROM hope_assessment WHERE id=$1", [ASMT_A10]),
      );
      expect(beforeSign.rows[0].status).toBe("signed");
      await withOrg(ORG_A, () =>
        db.query("UPDATE hope_assessment SET status='signed' WHERE id=$1", [CORR_A10]),
      );
      const r = await withOrg(ORG_A, () =>
        db.query("SELECT status FROM hope_assessment WHERE id=$1", [ASMT_A10]),
      );
      expect(r.rows[0].status).toBe("superseded");
    });

    it("§9.4 a correction from Org A cannot supersede an Org B row (defense-in-depth org-match guard)", async () => {
      // The supersede trigger's `AND organization_id = NEW.organization_id` guard means a correction inserted
      // under Org A pointing at Org B's row updates ZERO rows — Org B's row is never reached. (The composite
      // self-FK does not deny the insert: Postgres RI checks bypass RLS, so the cross-tenant FK resolves; the
      // org-match guard is the real defense-in-depth, plus the service-layer org-match, §9.4 bullet 4.)
      // Inserted as a draft and then signed so the 0225 AFTER-UPDATE supersede trigger actually fires —
      // inserting it already 'signed' never reaches the trigger and the assertion would pass vacuously.
      const CORR_X10 = "ea000000-0000-0000-0000-0000000000a8";
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO hope_assessment
             (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,data,target_date,created_by_membership_id,status,corrects_assessment_id)
           VALUES ($6,$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'01_admission','{}'::jsonb,${TGT},$4,'draft',$5)`,
          [ORG_A, PE_A10, LOC_A10, MEM_A10, ASMT_B10, CORR_X10],
        ),
      );
      await withOrg(ORG_A, () =>
        db.query("UPDATE hope_assessment SET status='signed' WHERE id=$1", [CORR_X10]),
      );
      // Org B's row is untouched — still signed, never flipped to superseded by Org A's cross-tenant attempt.
      const r = await db.query("SELECT status FROM hope_assessment WHERE id=$1", [ASMT_B10]);
      expect(r.rows[0].status).toBe("signed");
    });

    it("§9.4 hope_timepoint_schedule is org-scoped — Org A sees its open schedule, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM hope_timepoint_schedule WHERE id=$1", [SCHED_A10]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM hope_timepoint_schedule WHERE id=$1", [SCHED_A10]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§8.1 the M4 write-audit trigger fired for the assessment write and scrubbed the data denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='hope_assessment' AND event_type='hope_assessment.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.data).toBe("<changed>"); // §8.1 free-text PHI (jsonb payload) scrub
      expect(r.rows[0].after.rfa_kind).toBe("01_admission"); // structured column passes through
    });
  });

  // ── M11 Orders — org-scoped RLS, append-only no-DELETE, audit scrub (§7.7 / §3.4–3.7 / §9.3)
  // 0036/0037 (M11) applied above. Proves on REAL Postgres: order_record is tenant-isolated on app.org_id
  // even with app authorization stubbed open (§9.3 layer-independence); the WITH CHECK blocks a cross-tenant
  // write; chartwarden_app has NO DELETE (orders supersede via correction / discontinue, never delete — §3.6);
  // the monthly-partitioned (created_at) parent's M4 write-audit trigger scrubs the data/indication_text
  // denylist (D11 / §8.1) while the structured kind column passes through; the order_signature child is
  // org-scoped.
  describe("M11 Orders — cross-tenant isolation, no-DELETE, audit scrub (§7.7 / §3.4–3.7 / §9.3)", () => {
    const PE_A11 = "ea000000-0000-0000-0000-0000000000c1";
    const PE_B11 = "eb000000-0000-0000-0000-0000000000d1";
    const LOC_A11 = "ea000000-0000-0000-0000-0000000000c2";
    const LOC_B11 = "eb000000-0000-0000-0000-0000000000d2";
    const USER_A11 = "ea000000-0000-0000-0000-0000000000c3";
    const USER_B11 = "eb000000-0000-0000-0000-0000000000d3";
    const MEM_A11 = "ea000000-0000-0000-0000-0000000000c4";
    const MEM_B11 = "eb000000-0000-0000-0000-0000000000d4";
    const ORD_A11 = "ea000000-0000-0000-0000-0000000000c5";
    const ORD_B11 = "eb000000-0000-0000-0000-0000000000d5";
    const SIG_A11 = "ea000000-0000-0000-0000-0000000000c6";
    const OCOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,kind,kind_version,data,drafter_membership_id,drafter_discipline,ordering_physician_mdm_id)";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M11A','M11 A','NPI-M11A','enc','12-31'),
                  ($3,$4,'CCN-M11B','M11 B','NPI-M11B','enc','12-31')`,
        [PE_A11, ORG_A, PE_B11, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L11A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L11B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A11, PE_A11, LOC_B11, PE_B11],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m11a@x.test'),($2,'m11b@x.test')`, [
        USER_A11,
        USER_B11,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A11, USER_A11, ORG_A, MEM_B11, USER_B11, ORG_B],
      );
      // One draft order per org (superuser → RLS bypassed). data jsonb carries a free-text note so the audit
      // scrub is observable; created_at defaults to now() → the current monthly partition (exists post-migration).
      await db.query(
        `INSERT INTO order_record ${OCOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'lab','v1','{"note":"free text PHI"}'::jsonb,$5,'rn_case_manager',gen_random_uuid()),
           ($6,$7,$8,$9,gen_random_uuid(),gen_random_uuid(),'lab','v1','{"note":"free text PHI"}'::jsonb,$10,'rn_case_manager',gen_random_uuid())`,
        [ORD_A11, ORG_A, PE_A11, LOC_A11, MEM_A11, ORD_B11, ORG_B, PE_B11, LOC_B11, MEM_B11],
      );
      // One signature on Org A's order (the polymorphic order_signature child; target_kind='order').
      await db.query(
        `INSERT INTO order_signature
           (id,organization_id,provider_entity_id,location_id,target_kind,target_id,signature_kind,signer_membership_id,signer_discipline)
         VALUES ($1,$2,$3,$4,'order',$5,'signature',$6,'md')`,
        [SIG_A11, ORG_A, PE_A11, LOC_A11, ORD_A11, MEM_A11],
      );
    });

    it("§9.3 Org A sees ONLY its own order_record (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM order_record WHERE id=$1", [ORD_A11]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM order_record WHERE id=$1", [ORD_A11]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT an order_record into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO order_record ${OCOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'lab','v1','{}'::jsonb,$4,'rn_case_manager',gen_random_uuid())`,
            [ORG_A, PE_A11, LOC_A11, MEM_A11],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 order_record has NO DELETE grant for chartwarden_app (orders supersede/discontinue, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM order_record WHERE id=$1", [ORD_A11])),
      ).rejects.toThrow();
    });

    it("§3.4 order_signature is org-scoped — Org A sees its signature, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM order_signature WHERE id=$1", [SIG_A11]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM order_signature WHERE id=$1", [SIG_A11]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§8.1 the M4 write-audit trigger fired for the order write and scrubbed the data denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='order_record' AND event_type='order_record.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.data).toBe("<changed>"); // §8.1 free-text PHI (jsonb payload) scrub
      expect(r.rows[0].after.kind).toBe("lab"); // structured column passes through
    });
  });

  // ── M12 DoseSpot Prescribing — org-scoped RLS, append-only no-DELETE, audit scrub (§3.5 / §3.6 / §7.6 / §9.4)
  // 0038/0039 (M12) applied above. Proves on REAL Postgres: medication_order is tenant-isolated on app.org_id
  // even with app authorization stubbed open (§9.4 layer-independence); the WITH CHECK blocks a cross-tenant
  // write; chartwarden_app has NO DELETE (orders are append + status-transition, never deleted — §3.6); the
  // monthly-partitioned (created_at) parent's M4 write-audit trigger scrubs the whole `data` jsonb (all
  // clinician free-text — sig_free_text / indication / notes — lives inside the per-class payload, §7.6) while
  // the structured med_class column passes through; the refill_request child is org-scoped and scrubs its
  // pharmacy_notes / denial_reason free-text.
  describe("M12 DoseSpot — cross-tenant isolation, no-DELETE, audit scrub (§3.5 / §3.6 / §7.6 / §9.4)", () => {
    const PE_A12 = "ea000000-0000-0000-0000-0000000000e1";
    const PE_B12 = "eb000000-0000-0000-0000-0000000000f1";
    const LOC_A12 = "ea000000-0000-0000-0000-0000000000e2";
    const LOC_B12 = "eb000000-0000-0000-0000-0000000000f2";
    const USER_A12 = "ea000000-0000-0000-0000-0000000000e3";
    const USER_B12 = "eb000000-0000-0000-0000-0000000000f3";
    const MEM_A12 = "ea000000-0000-0000-0000-0000000000e4";
    const MEM_B12 = "eb000000-0000-0000-0000-0000000000f4";
    const MO_A12 = "ea000000-0000-0000-0000-0000000000e5";
    const MO_B12 = "eb000000-0000-0000-0000-0000000000f5";
    const RF_A12 = "ea000000-0000-0000-0000-0000000000e6";
    const MCOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,med_class,drug_name,strength,dose_form,route,data,prescriber_membership_id,prescribing_physician_mdm_id)";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M12A','M12 A','NPI-M12A','enc','12-31'),
                  ($3,$4,'CCN-M12B','M12 B','NPI-M12B','enc','12-31')`,
        [PE_A12, ORG_A, PE_B12, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L12A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L12B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A12, PE_A12, LOC_B12, PE_B12],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m12a@x.test'),($2,'m12b@x.test')`, [
        USER_A12,
        USER_B12,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A12, USER_A12, ORG_A, MEM_B12, USER_B12, ORG_B],
      );
      // One draft medication_order per org (superuser → RLS bypassed). data jsonb carries a free-text sig so
      // the audit scrub is observable; created_at defaults to now() → the current monthly partition (created
      // by create_medication_order_partition for current_month-1..+1 post-migration).
      await db.query(
        `INSERT INTO medication_order ${MCOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),'standard','Aspirin','81 mg','tablet','oral','{"sigFreeText":"1 tablet by mouth daily — free text PHI"}'::jsonb,$5,gen_random_uuid()),
           ($6,$7,$8,$9,gen_random_uuid(),gen_random_uuid(),'standard','Aspirin','81 mg','tablet','oral','{"sigFreeText":"1 tablet by mouth daily — free text PHI"}'::jsonb,$10,gen_random_uuid())`,
        [MO_A12, ORG_A, PE_A12, LOC_A12, MEM_A12, MO_B12, ORG_B, PE_B12, LOC_B12, MEM_B12],
      );
      // One pending refill_request on Org A's order (the §2.7 inbox child). pharmacy_notes is free-text PHI.
      await db.query(
        `INSERT INTO refill_request
           (id,organization_id,provider_entity_id,location_id,source_medication_order_id,patient_id,dosespot_event_id,pharmacy_notes,received_at,status)
         VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),'DS-EVT-A12','call pharmacy re: dose — free text PHI',now(),'pending')`,
        [RF_A12, ORG_A, PE_A12, LOC_A12, MO_A12],
      );
    });

    it("§3.5 Org A sees ONLY its own medication_order (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM medication_order WHERE id=$1", [MO_A12]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM medication_order WHERE id=$1", [MO_A12]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT a medication_order into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO medication_order ${MCOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'standard','X','1 mg','tablet','oral','{}'::jsonb,$4,gen_random_uuid())`,
            [ORG_A, PE_A12, LOC_A12, MEM_A12],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 medication_order has NO DELETE grant for chartwarden_app (orders supersede/discontinue, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM medication_order WHERE id=$1", [MO_A12])),
      ).rejects.toThrow();
    });

    it("§3.5 refill_request is org-scoped — Org A sees its refill, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM refill_request WHERE id=$1", [RF_A12]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM refill_request WHERE id=$1", [RF_A12]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§7.6 the M4 write-audit trigger fired for the medication_order write and scrubbed the data denylist", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='medication_order' AND event_type='medication_order.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.data).toBe("<changed>"); // §7.6 whole `data` jsonb (free-text PHI) scrub
      expect(r.rows[0].after.med_class).toBe("standard"); // structured column passes through
    });

    it("§7.6 the refill_request write-audit trigger scrubbed pharmacy_notes (free-text PHI)", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='refill_request' AND event_type='refill_request.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.pharmacy_notes).toBe("<changed>"); // §7.6 free-text PHI scrub
      expect(r.rows[0].after.status).toBe("pending"); // structured column passes through
    });
  });

  // ── M13 eMAR & Med Administration — org-scoped RLS, append-only no-DELETE, audit scrub (§3.5 / §3.6 / §9.4)
  // 0040/0041 (M13) applied above. Proves on REAL Postgres: administration_record is tenant-isolated on
  // app.org_id even with app authorization stubbed open (§9.4 layer-independence); the WITH CHECK blocks a
  // cross-tenant write; chartwarden_app has NO DELETE (administrations supersede via correction / void, never delete
  // — §3.6); the RANGE-partitioned (administered_at) parent's M4 write-audit trigger scrubs BOTH the top-level
  // free-text columns (notes / refusal_reason / …) AND the nested per-mode `data` json-paths (sig_free_text /
  // titrationReason / …, §3.6 D12) while the structured `mode` column passes through; the scheduled_dose child is
  // org-scoped.
  describe("M13 eMAR — cross-tenant isolation, no-DELETE, nested audit scrub (§3.5 / §3.6 / §9.4)", () => {
    const PE_A13 = "ea000000-0000-0000-0000-000000000091";
    const PE_B13 = "eb000000-0000-0000-0000-0000000000a1";
    const LOC_A13 = "ea000000-0000-0000-0000-000000000092";
    const LOC_B13 = "eb000000-0000-0000-0000-0000000000a2";
    const AR_A13 = "ea000000-0000-0000-0000-000000000095";
    const AR_B13 = "eb000000-0000-0000-0000-0000000000a5";
    const SD_A13 = "ea000000-0000-0000-0000-000000000096";
    const ACOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,medication_order_id,mode,data,drug_name_snapshot,route_snapshot,administered_at,actor_kind,administering_clinician_membership_id,notes)";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M13A','M13 A','NPI-M13A','enc','12-31'),
                  ($3,$4,'CCN-M13B','M13 B','NPI-M13B','enc','12-31')`,
        [PE_A13, ORG_A, PE_B13, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L13A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L13B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A13, PE_A13, LOC_B13, PE_B13],
      );
      // One committed administration per org (superuser → RLS bypassed). The top-level notes column AND the
      // nested data.sig_free_text json-path are both free-text PHI so the §3.6 D12 scrub is observable on each.
      await db.query(
        `INSERT INTO administration_record ${ACOLS} VALUES
           ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'single_dose','{"sig_free_text":"give half — free text PHI"}'::jsonb,'Morphine','PO',now(),'clinician',gen_random_uuid(),'bedside note — free text PHI'),
           ($5,$6,$7,$8,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'single_dose','{"sig_free_text":"give half — free text PHI"}'::jsonb,'Morphine','PO',now(),'clinician',gen_random_uuid(),'bedside note — free text PHI')`,
        [AR_A13, ORG_A, PE_A13, LOC_A13, AR_B13, ORG_B, PE_B13, LOC_B13],
      );
      // One scheduled_dose on Org A (the §2.3 materialized-dose child; org-scoped).
      await db.query(
        `INSERT INTO scheduled_dose
           (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,medication_order_id,due_at,grace_window_minutes,expected_dose_amount,expected_dose_unit,expected_route,materialization_sequence)
         VALUES ($1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),60,5,'mg','PO',1)`,
        [SD_A13, ORG_A, PE_A13, LOC_A13],
      );
    });

    it("§3.5 Org A sees ONLY its own administration_record (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM administration_record WHERE id=$1", [AR_A13]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM administration_record WHERE id=$1", [AR_A13]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT an administration_record into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO administration_record ${ACOLS} VALUES
               (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'single_dose','{}'::jsonb,'X','PO',now(),'clinician',gen_random_uuid(),NULL)`,
            [ORG_A, PE_A13, LOC_A13],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 administration_record has NO DELETE grant for chartwarden_app (administrations supersede/void, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM administration_record WHERE id=$1", [AR_A13])),
      ).rejects.toThrow();
    });

    it("§3.5 scheduled_dose is org-scoped — Org A sees its dose, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM scheduled_dose WHERE id=$1", [SD_A13]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM scheduled_dose WHERE id=$1", [SD_A13]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.6 the M4 write-audit trigger scrubbed BOTH the top-level notes AND the nested data.sig_free_text", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='administration_record' AND event_type='administration_record.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.notes).toBe("<changed>"); // §3.6 top-level free-text PHI scrub
      expect(r.rows[0].after.data.sig_free_text).toBe("<changed>"); // §3.6 D12 nested json-path scrub
      expect(r.rows[0].after.mode).toBe("single_dose"); // structured column passes through
    });
  });

  // ── M14 IDG (Interdisciplinary Group) — org-scoped RLS, append-only no-DELETE, nested audit scrub (§3.3/§9.3)
  // 0042/0043 (M14) applied above. Proves on REAL Postgres: idg_decision (the canonical cross-module decision
  // record) + idg_patient_packet (the RANGE-partitioned-by-built_at survey artifact, D12) are tenant-isolated on
  // app.org_id even with app authorization stubbed open (§9.4 layer-independence); the WITH CHECK blocks a
  // cross-tenant write; chartwarden_app has NO DELETE on either (decisions supersede, packets freeze — never delete);
  // the M4 write-audit trigger scrubs BOTH the top-level free-text columns AND the nested json-paths — for
  // idg_decision the per-kind `payload` narrative keys (rationaleText / …), for idg_patient_packet the top-level
  // cover summaries + discipline_views AND the nested `built_snapshot` keys (discipline_views / sinceLastIdg) —
  // while the structural columns (decision_kind / since_cursor_iso) pass through (§3.3).
  describe("M14 IDG — cross-tenant isolation, no-DELETE, nested audit scrub (§3.3 / §9.3 / §9.4)", () => {
    const PE_A14 = "ea000000-0000-0000-0000-0000000000b1";
    const PE_B14 = "eb000000-0000-0000-0000-0000000000c1";
    const LOC_A14 = "ea000000-0000-0000-0000-0000000000b2";
    const LOC_B14 = "eb000000-0000-0000-0000-0000000000c2";
    const MTG_A14 = "ea000000-0000-0000-0000-0000000000b3";
    const MTG_B14 = "eb000000-0000-0000-0000-0000000000c3";
    const DEC_A14 = "ea000000-0000-0000-0000-0000000000b4";
    const DEC_B14 = "eb000000-0000-0000-0000-0000000000c4";
    const PKT_A14 = "ea000000-0000-0000-0000-0000000000b5";
    const QSNAP = `'{"met":true,"presentDisciplines":[],"missingDisciplines":[]}'::jsonb`;
    // idg_decision narrative free-text lives INSIDE the per-kind payload (rationaleText denylisted, §3.3).
    const DEC_PAYLOAD = `'{"kind":"care_plan_update","rationaleText":"family wants comfort-only — free text PHI"}'::jsonb`;
    // idg_patient_packet snapshot: top-level cover summary + the nested built_snapshot keys are all denylisted.
    const SNAPSHOT = `'{"schemaVersion":"2026-01-v1","discipline_views":{"rn":"free text PHI"},"sinceLastIdg":{"encounters":["free text PHI"]}}'::jsonb`;
    const DVIEWS = `'{"rn":{"highlightedEntries":["free text PHI"]}}'::jsonb`;

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M14A','M14 A','NPI-M14A','enc','12-31'),
                  ($3,$4,'CCN-M14B','M14 B','NPI-M14B','enc','12-31')`,
        [PE_A14, ORG_A, PE_B14, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L14A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L14B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A14, PE_A14, LOC_B14, PE_B14],
      );
      // One meeting per org (superuser → RLS bypassed for the seed).
      await db.query(
        `INSERT INTO idg_meeting (id,organization_id,location_id,scheduled_start,scheduled_end,coordinator_membership_id,tenant_quorum_snapshot)
           VALUES ($1,$2,$3,now(),now()+interval '2 hour',gen_random_uuid(),${QSNAP}),
                  ($4,$5,$6,now(),now()+interval '2 hour',gen_random_uuid(),${QSNAP})`,
        [MTG_A14, ORG_A, LOC_A14, MTG_B14, ORG_B, LOC_B14],
      );
      // One decision per org — the payload carries a denylisted nested narrative key (rationaleText).
      await db.query(
        `INSERT INTO idg_decision (id,organization_id,provider_entity_id,location_id,idg_meeting_id,patient_id,decision_kind,payload,was_quorate,quorum_snapshot,recorded_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),'care_plan_update',${DEC_PAYLOAD},true,${QSNAP},gen_random_uuid()),
                  ($6,$7,$8,$9,$10,gen_random_uuid(),'care_plan_update',${DEC_PAYLOAD},true,${QSNAP},gen_random_uuid())`,
        [DEC_A14, ORG_A, PE_A14, LOC_A14, MTG_A14, DEC_B14, ORG_B, PE_B14, LOC_B14, MTG_B14],
      );
      // One packet on Org A — top-level cover summary + the nested built_snapshot keys are all free-text PHI.
      await db.query(
        `INSERT INTO idg_patient_packet (id,organization_id,provider_entity_id,location_id,idg_meeting_id,patient_id,admission_id,since_cursor_iso,built_snapshot,discipline_views,cover_summary_layer1)
           VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),gen_random_uuid(),'2026-06-01T00:00:00.000Z',${SNAPSHOT},${DVIEWS},'cover narrative — free text PHI')`,
        [PKT_A14, ORG_A, PE_A14, LOC_A14, MTG_A14],
      );
    });

    it("§3.3 Org A sees ONLY its own idg_decision (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM idg_decision WHERE id=$1", [DEC_A14]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM idg_decision WHERE id=$1", [DEC_A14]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.3 Org B cannot INSERT an idg_decision into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO idg_decision (id,organization_id,provider_entity_id,location_id,idg_meeting_id,patient_id,decision_kind,payload,was_quorate,quorum_snapshot,recorded_by_membership_id)
               VALUES (gen_random_uuid(),$1,$2,$3,$4,gen_random_uuid(),'team_note','{}'::jsonb,false,${QSNAP},gen_random_uuid())`,
            [ORG_A, PE_A14, LOC_A14, MTG_A14],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.3 idg_decision + idg_patient_packet have NO DELETE grant for chartwarden_app (decisions supersede / packets freeze, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM idg_decision WHERE id=$1", [DEC_A14])),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM idg_patient_packet WHERE id=$1", [PKT_A14])),
      ).rejects.toThrow();
    });

    it("§3.3 idg_meeting + idg_patient_packet are org-scoped — Org A sees its rows, Org B sees none", async () => {
      const mA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM idg_meeting WHERE id=$1", [MTG_A14]),
      );
      const mB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM idg_meeting WHERE id=$1", [MTG_A14]),
      );
      expect(mA.rows[0].n).toBe(1);
      expect(mB.rows[0].n).toBe(0);
      const pA = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM idg_patient_packet WHERE id=$1", [PKT_A14]),
      );
      const pB = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM idg_patient_packet WHERE id=$1", [PKT_A14]),
      );
      expect(pA.rows[0].n).toBe(1);
      expect(pB.rows[0].n).toBe(0);
    });

    it("§3.3 the M4 write-audit trigger scrubbed the nested idg_decision payload narrative (rationaleText), kind passes through", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='idg_decision' AND event_type='idg_decision.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.payload.rationaleText).toBe("<changed>"); // §3.3 nested payload free-text scrub
      expect(r.rows[0].after.payload.kind).toBe("care_plan_update"); // structured payload field passes through
      expect(r.rows[0].after.decision_kind).toBe("care_plan_update"); // structured column passes through
    });

    it("§3.3 the M4 write-audit trigger scrubbed BOTH the top-level cover summary AND the nested built_snapshot keys", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='idg_patient_packet' AND event_type='idg_patient_packet.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.cover_summary_layer1).toBe("<changed>"); // top-level free-text PHI scrub
      expect(r.rows[0].after.discipline_views).toBe("<changed>"); // top-level discipline_views column scrub
      expect(r.rows[0].after.built_snapshot.discipline_views).toBe("<changed>"); // nested json-path scrub
      expect(r.rows[0].after.built_snapshot.sinceLastIdg).toBe("<changed>"); // nested json-path scrub
      expect(r.rows[0].after.built_snapshot.schemaVersion).toBe("2026-01-v1"); // structural key passes through
      expect(r.rows[0].after.since_cursor_iso).toBe("2026-06-01T00:00:00.000Z"); // structural column passes through
    });
  });

  // ── M17 Scheduling — org-scoped RLS, append-only no-DELETE, PHI-column audit scrub (§3.5 / §3.6 / §9.3/§9.4)
  // 0044/0045 (M17) applied above. Proves on REAL Postgres: `visit` (the central scheduling aggregate,
  // PARTITION BY RANGE service_date, D14) is tenant-isolated on app.org_id even with app authorization stubbed
  // open (§9.4 layer-independence); the WITH CHECK blocks a cross-tenant write; chartwarden_app has NO DELETE on
  // `visit` or `visit_state_history` (visits are cancelled/voided + the history is append-only — destruction is
  // the admin eraseFn, §3.6); the M4 write-audit trigger scrubs the §3.6 free-text denylist on `visit`
  // (scheduler_internal_notes / cancellation_reason / reschedule_reason / no_show_reason / evv_missing_reason)
  // and the `reason` column on `visit_state_history`, while the structural columns (status / visit_purpose /
  // to_state) pass through. `visit.assigned_membership_id` is a real FK to membership, so a user + membership
  // are seeded per org first.
  describe("M17 Scheduling — cross-tenant isolation, no-DELETE, PHI-column audit scrub (§3.5 / §3.6 / §9.3 / §9.4)", () => {
    const PE_A17 = "ea000000-0000-0000-0000-0000000000d1";
    const PE_B17 = "eb000000-0000-0000-0000-0000000000e1";
    const LOC_A17 = "ea000000-0000-0000-0000-0000000000d2";
    const LOC_B17 = "eb000000-0000-0000-0000-0000000000e2";
    const USER_A17 = "ea000000-0000-0000-0000-0000000000d3";
    const USER_B17 = "eb000000-0000-0000-0000-0000000000e3";
    const MEM_A17 = "ea000000-0000-0000-0000-0000000000d4";
    const MEM_B17 = "eb000000-0000-0000-0000-0000000000e4";
    const VIS_A17 = "ea000000-0000-0000-0000-0000000000d5";
    const VIS_B17 = "eb000000-0000-0000-0000-0000000000e5";
    const VSH_A17 = "ea000000-0000-0000-0000-0000000000d6";
    // The visit insert: NOT NULL tenancy spine + the assignment + schedule + the §3.6 free-text PHI columns.
    const VCOLS =
      "(id,organization_id,provider_entity_id,location_id,patient_id,admission_id,assigned_membership_id,assigned_discipline_at_assignment,visit_purpose,visit_setting,scheduled_started_at,scheduled_ended_at,service_date,scheduler_internal_notes,cancellation_reason)";
    // id=$1, org=$2, pe=$3, loc=$4, assigned_membership=$5; patient/admission synthetic; the two free-text
    // columns carry PHI so the §3.6 audit scrub is observable; service_date=today → the current monthly partition.
    const VSEED =
      "$1,$2,$3,$4,gen_random_uuid(),gen_random_uuid(),$5,'rn','routine_visit','patient_home',now(),now()+interval '1 hour',now()::date,'internal note — free text PHI','cancel narrative — free text PHI'";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M17A','M17 A','NPI-M17A','enc','12-31'),
                  ($3,$4,'CCN-M17B','M17 B','NPI-M17B','enc','12-31')`,
        [PE_A17, ORG_A, PE_B17, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L17A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L17B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A17, PE_A17, LOC_B17, PE_B17],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m17a@x.test'),($2,'m17b@x.test')`, [
        USER_A17,
        USER_B17,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A17, USER_A17, ORG_A, MEM_B17, USER_B17, ORG_B],
      );
      // One visit per org (superuser → RLS bypassed).
      await db.query(`INSERT INTO visit ${VCOLS} VALUES (${VSEED})`, [
        VIS_A17,
        ORG_A,
        PE_A17,
        LOC_A17,
        MEM_A17,
      ]);
      await db.query(`INSERT INTO visit ${VCOLS} VALUES (${VSEED})`, [
        VIS_B17,
        ORG_B,
        PE_B17,
        LOC_B17,
        MEM_B17,
      ]);
      // One state-history row on Org A's visit (append-only; reason is denylisted, to_state structural).
      await db.query(
        `INSERT INTO visit_state_history (id,organization_id,provider_entity_id,location_id,visit_id,from_state,to_state,reason)
           VALUES ($1,$2,$3,$4,$5,'proposed','published','transition narrative — free text PHI')`,
        [VSH_A17, ORG_A, PE_A17, LOC_A17, VIS_A17],
      );
    });

    it("§9.3 Org A sees ONLY its own visit (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM visit WHERE id=$1", [VIS_A17]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM visit WHERE id=$1", [VIS_A17]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.5 Org B cannot INSERT a visit into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO visit ${VCOLS} VALUES (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),$4,'rn','routine_visit','patient_home',now(),now()+interval '1 hour',now()::date,NULL,NULL)`,
            [ORG_A, PE_A17, LOC_A17, MEM_A17],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.6 visit + visit_state_history have NO DELETE grant for chartwarden_app (visits void, history is append-only)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM visit WHERE id=$1", [VIS_A17])),
      ).rejects.toThrow();
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM visit_state_history WHERE id=$1", [VSH_A17])),
      ).rejects.toThrow();
    });

    it("§3.4 visit_state_history is org-scoped — Org A sees its transition row, Org B sees none", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT count(*)::int AS n FROM visit_state_history WHERE id=$1", [VSH_A17]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query("SELECT count(*)::int AS n FROM visit_state_history WHERE id=$1", [VSH_A17]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§3.6 the M4 write-audit trigger scrubbed the visit free-text denylist; structural columns pass through", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='visit' AND event_type='visit.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.scheduler_internal_notes).toBe("<changed>"); // §3.6 free-text PHI scrub
      expect(r.rows[0].after.cancellation_reason).toBe("<changed>"); // §3.6 free-text PHI scrub
      expect(r.rows[0].after.status).toBe("proposed"); // structural column passes through
      expect(r.rows[0].after.visit_purpose).toBe("routine_visit"); // structural column passes through
    });

    it("§3.6 the M4 write-audit trigger scrubbed the visit_state_history reason; to_state passes through", async () => {
      const r = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='visit_state_history' AND event_type='visit_state_history.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.reason).toBe("<changed>"); // §3.6 free-text PHI scrub
      expect(r.rows[0].after.to_state).toBe("published"); // structural column passes through
    });
  });

  // 0046/0047 (M18 EVV) applied above. Proves on REAL Postgres the §9.3 RLS isolation + §9.4 layer-independence
  // across ALL SIX owned tables (D14/§3.5): `evv_event` (the only PHI-bearing table — PARTITION BY RANGE
  // event_at, D12; carries patient_id + the provider_entity_id/location_id spine) plus the five org-scoped
  // satellites (`evv_geofence_evaluation`, `evv_geofence_policy`, `evv_device`, `evv_missing_resolution`,
  // `evv_aggregator_submission`). Every table is tenant-isolated on app.org_id even with app authorization
  // stubbed wide open (§9.4 "disable application-layer ABAC; RLS still blocks cross-tenant"); the WITH CHECK
  // blocks a cross-tenant write; a cross-tenant UPDATE affects ZERO rows; chartwarden_app has NO DELETE on any of
  // the six (events append-only via the §3.2 immutability trigger, the rest destruction-by-eraseFn only);
  // `evv_event` UPDATE is narrowed to the two supersede markers by the append-only trigger (correction-of-record
  // is an APPEND, never an in-place edit, D2); and the M4 write-audit trigger scrubs the §3.6 denylist (GPS
  // coordinate ciphers, accuracy, free-text resolution/rejection reasons) while structural columns pass through.
  // The §9.4 IN-tenant cross-caseload half (RLS off, ABAC still blocks) is the in-memory acceptance suite's job
  // (apps/backend/__tests__/evv-workflow-acceptance.test.ts) — the two layers each independently block.
  describe("M18 EVV — cross-tenant isolation, no-DELETE, append-only events, PHI-column audit scrub (§3.5 / §3.6 / §9.3 / §9.4)", () => {
    const PE_A18 = "ec000000-0000-0000-0000-0000000000a1";
    const PE_B18 = "ed000000-0000-0000-0000-0000000000b1";
    const LOC_A18 = "ec000000-0000-0000-0000-0000000000a2";
    const LOC_B18 = "ed000000-0000-0000-0000-0000000000b2";
    const USER_A18 = "ec000000-0000-0000-0000-0000000000a3";
    const USER_B18 = "ed000000-0000-0000-0000-0000000000b3";
    const MEM_A18 = "ec000000-0000-0000-0000-0000000000a4";
    const MEM_B18 = "ed000000-0000-0000-0000-0000000000b4";
    const DEV_A18 = "ec000000-0000-0000-0000-0000000000a5";
    const DEV_B18 = "ed000000-0000-0000-0000-0000000000b5";
    const EVT_A18 = "ec000000-0000-0000-0000-0000000000a6";
    const EVT_B18 = "ed000000-0000-0000-0000-0000000000b6";
    const GEVAL_A18 = "ec000000-0000-0000-0000-0000000000a7";
    const POL_A18 = "ec000000-0000-0000-0000-0000000000a8";
    const MR_A18 = "ec000000-0000-0000-0000-0000000000a9";
    const SUB_A18 = "ec000000-0000-0000-0000-0000000000aa";
    const VIS_A18 = "ec000000-0000-0000-0000-0000000000ab"; // synthetic M17 visit anchor (app-validated; no FK)

    // The six owned tables, used by the parametrized cross-tenant + no-DELETE loops below.
    const OWNED_TABLES = [
      "evv_event",
      "evv_geofence_evaluation",
      "evv_geofence_policy",
      "evv_device",
      "evv_missing_resolution",
      "evv_aggregator_submission",
    ] as const;
    // The Org-A row id per owned table (so the cross-tenant SELECT loop is one query shape per table).
    const A_ROW: Record<(typeof OWNED_TABLES)[number], string> = {
      evv_event: EVT_A18,
      evv_geofence_evaluation: GEVAL_A18,
      evv_geofence_policy: POL_A18,
      evv_device: DEV_A18,
      evv_missing_resolution: MR_A18,
      evv_aggregator_submission: SUB_A18,
    };

    /** Seed a full EVV chain for one org (superuser → RLS bypassed): device → event → geofence-eval, plus the
     * org-scoped policy / missing-resolution / aggregator-submission rows. The free-text + coordinate-cipher
     * columns carry sentinel PHI so the §3.6 audit scrub is observable. */
    async function seedEvvChain(
      org: string,
      pe: string,
      loc: string,
      mem: string,
      dev: string,
      evt: string,
    ) {
      await db.query(
        `INSERT INTO evv_device (id,organization_id,membership_id,platform,device_key_fingerprint,m2_device_attestation_id,status)
           VALUES ($1,$2,$3,'ios','key-fingerprint-secret — denylisted',gen_random_uuid(),'approved')`,
        [dev, org, mem],
      );
      await db.query(
        `INSERT INTO evv_event
           (id,organization_id,provider_entity_id,location_id,visit_id,patient_id,kind,service_type_code,
            posting_membership_id,posting_discipline_at_recording,evv_device_id,captured_at,event_at,
            coords_cipher,coords_dek_version,accuracy_m,gps_quality,device_attestation_id_at_record)
           VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),'check_in','T1019',$6,'rn',$7,now(),now(),
            'COORDS-CIPHER — free-text PHI',1,12.5,'high',gen_random_uuid())`,
        [evt, org, pe, loc, VIS_A18, mem, dev],
      );
      await db.query(
        `INSERT INTO evv_geofence_evaluation
           (id,organization_id,evv_event_id,applied_policy_id,applied_policy_scope,applied_radius_m,
            applied_max_accuracy_m,patient_address_coords_cipher,device_coords_cipher,computed_distance_m,decision)
           VALUES ($1,$2,$3,gen_random_uuid(),'tenant',100,50,
            'BASELINE-CIPHER — free-text PHI','DEVICE-CIPHER — free-text PHI',42.0,'pass')`,
        [org === ORG_A ? GEVAL_A18 : "ed000000-0000-0000-0000-0000000000b7", org, evt],
      );
      await db.query(
        `INSERT INTO evv_geofence_policy
           (id,organization_id,scope,radius_m,max_accuracy_m,effective_from,override_reason,set_by_membership_id)
           VALUES ($1,$2,'tenant',100,40,now()::date,'tenant tighten — narrowed for dense urban routes',$3)`,
        [org === ORG_A ? POL_A18 : "ed000000-0000-0000-0000-0000000000b8", org, mem],
      );
      await db.query(
        `INSERT INTO evv_missing_resolution
           (id,organization_id,visit_id,kind,detected_by_source,status,resolution_reason)
           VALUES ($1,$2,$3,'missing_checkout','cron_late_check_sweep','open','resolution narrative — free-text PHI')`,
        [org === ORG_A ? MR_A18 : "ed000000-0000-0000-0000-0000000000b9", org, VIS_A18],
      );
      await db.query(
        `INSERT INTO evv_aggregator_submission
           (id,organization_id,visit_id,state_code,aggregator_vendor,status,aggregator_rejection_code,aggregator_rejection_reason)
           VALUES ($1,$2,$3,'TX','sandata','rejected','E102','rejection narrative — free-text PHI')`,
        [org === ORG_A ? SUB_A18 : "ed000000-0000-0000-0000-0000000000ba", org, VIS_A18],
      );
    }

    beforeAll(async () => {
      await db.query(
        `INSERT INTO provider_entity (id,organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'CCN-M18A','M18 A','NPI-M18A','enc','12-31'),
                  ($3,$4,'CCN-M18B','M18 B','NPI-M18B','enc','12-31')`,
        [PE_A18, ORG_A, PE_B18, ORG_B],
      );
      await db.query(
        `INSERT INTO location (id,provider_entity_id,name,address_line1,city,state,postal_code,timezone)
           VALUES ($1,$2,'L18A','1 St','Town','OR','97000','America/Los_Angeles'),
                  ($3,$4,'L18B','1 St','Town','OR','97000','America/Los_Angeles')`,
        [LOC_A18, PE_A18, LOC_B18, PE_B18],
      );
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m18a@x.test'),($2,'m18b@x.test')`, [
        USER_A18,
        USER_B18,
      ]);
      await db.query(
        `INSERT INTO membership (id,user_id,organization_id,status)
           VALUES ($1,$2,$3,'active'),($4,$5,$6,'active')`,
        [MEM_A18, USER_A18, ORG_A, MEM_B18, USER_B18, ORG_B],
      );
      await seedEvvChain(ORG_A, PE_A18, LOC_A18, MEM_A18, DEV_A18, EVT_A18);
      await seedEvvChain(ORG_B, PE_B18, LOC_B18, MEM_B18, DEV_B18, EVT_B18);
    });

    it("§9.3 Org A sees its own row but Org B sees ZERO across all six owned tables (RLS, auth stubbed open)", async () => {
      for (const table of OWNED_TABLES) {
        const a = await withOrg(ORG_A, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [A_ROW[table]]),
        );
        const b = await withOrg(ORG_B, () =>
          db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id=$1`, [A_ROW[table]]),
        );
        expect(a.rows[0].n, `Org A reads its own ${table}`).toBe(1);
        expect(b.rows[0].n, `Org B is blocked from ${table}`).toBe(0);
      }
    });

    it("§3.5 Org B cannot INSERT an evv_event into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO evv_event
               (id,organization_id,provider_entity_id,location_id,visit_id,patient_id,kind,service_type_code,
                posting_membership_id,posting_discipline_at_recording,evv_device_id,captured_at,event_at,
                coords_cipher,coords_dek_version,accuracy_m,gps_quality,device_attestation_id_at_record)
               VALUES (gen_random_uuid(),$1,$2,$3,$4,gen_random_uuid(),'check_out','T1019',$5,'rn',$6,now(),now(),
                'x',1,9.0,'high',gen_random_uuid())`,
            [ORG_A, PE_A18, LOC_A18, VIS_A18, MEM_A18, DEV_A18],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§9.3 a cross-tenant UPDATE affects ZERO rows — Org B cannot mutate Org A's aggregator submission", async () => {
      const r = await withOrg(ORG_B, () =>
        db.query("UPDATE evv_aggregator_submission SET status='cancelled' WHERE id=$1", [SUB_A18]),
      );
      expect(r.rowCount).toBe(0);
      // And Org A's row is untouched (still 'rejected').
      const a = await withOrg(ORG_A, () =>
        db.query("SELECT status FROM evv_aggregator_submission WHERE id=$1", [SUB_A18]),
      );
      expect(a.rows[0].status).toBe("rejected");
    });

    it("§3.6 chartwarden_app has NO DELETE grant on any of the six owned tables (eraseFn-only destruction)", async () => {
      for (const table of OWNED_TABLES) {
        await expect(
          withOrg(ORG_A, () => db.query(`DELETE FROM ${table} WHERE id=$1`, [A_ROW[table]])),
          `DELETE on ${table} must be refused`,
        ).rejects.toThrow();
      }
    });

    it("§3.2/D2 evv_event is append-only — a non-supersede UPDATE is refused; the supersede markers may change", async () => {
      // Mutating a substantive column is blocked by the immutability trigger (correction-of-record is an APPEND).
      await expect(
        withOrg(ORG_A, () =>
          db.query("UPDATE evv_event SET coords_cipher='tampered' WHERE id=$1", [EVT_A18]),
        ),
      ).rejects.toThrow(/EVV_EVENT_APPEND_ONLY_IMMUTABLE_COLUMN/);
      // The two supersede markers (the §2.3 correction-of-record stamp) are the only permitted UPDATE.
      const ok = await withOrg(ORG_A, () =>
        db.query("UPDATE evv_event SET superseded_at=now() WHERE id=$1", [EVT_A18]),
      );
      expect(ok.rowCount).toBe(1);
    });

    it("§3.6 the M4 audit trigger scrubbed evv_event coordinate cipher + accuracy; structural columns pass through", async () => {
      const r = await db.query(
        "SELECT after, retention_class FROM audit_event WHERE resource_kind='evv_event' AND event_type='evv_event.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.coords_cipher).toBe("<changed>"); // §3.6 / D10 coordinate-cipher scrub
      expect(r.rows[0].after.accuracy_m).toBe("<changed>"); // §3.6 denylisted
      expect(r.rows[0].after.kind).toBe("check_in"); // structural passes through
      expect(r.rows[0].after.gps_quality).toBe("high"); // structural passes through
      expect(r.rows[0].retention_class).toBe("compliance"); // §3.7 evv_record retention class
    });

    it("§3.6 the M4 audit trigger scrubbed the evv_missing_resolution + aggregator-submission free-text reasons", async () => {
      const mr = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='evv_missing_resolution' AND event_type='evv_missing_resolution.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(mr.rows[0].after.resolution_reason).toBe("<changed>"); // §3.6 free-text scrub
      expect(mr.rows[0].after.status).toBe("open"); // structural passes through
      const sub = await db.query(
        "SELECT after FROM audit_event WHERE resource_kind='evv_aggregator_submission' AND event_type='evv_aggregator_submission.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(sub.rows[0].after.aggregator_rejection_reason).toBe("<changed>"); // §3.6 free-text scrub
      expect(sub.rows[0].after.aggregator_rejection_code).toBe("E102"); // structural passes through
      expect(sub.rows[0].after.status).toBe("rejected"); // structural passes through
    });
  });

  // ── M22 Document Management — org-scoped RLS, no-DELETE, audit scrub (§8.8 / §3.6) ──────────────────
  // 0048/0049 (M22) applied above. Proves on REAL Postgres (M22 spec §8.8 cross-tenant isolation): the
  // `document` aggregate root is tenant-isolated on app.org_id even with app authorization stubbed open
  // — Org A can SELECT only its own document and Org B cannot (no leak through crafted ids); the WITH
  // CHECK blocks a cross-tenant INSERT; chartwarden_app has NO DELETE on `document` (§3.2 — a document is
  // superseded/voided, never row-deleted; only `document_tag` is user-deletable); and the M4 write-audit
  // trigger scrubs the §3.6 free-text PHI denylist (document.title — may carry a patient name) while the
  // structured columns (retention_class, status) pass through.
  describe("M22 Document Management — cross-tenant isolation, no-DELETE, audit scrub (§8.8 / §3.6)", () => {
    const DOC_A22 = "d22a0000-0000-0000-0000-0000000000a1";
    const DOC_B22 = "d22b0000-0000-0000-0000-0000000000b1";
    const MEM_A22 = "d22a0000-0000-0000-0000-0000000000a2";
    const MEM_B22 = "d22b0000-0000-0000-0000-0000000000b2";
    const DCOLS =
      "(id,organization_id,retention_class,source_kind,aggregate_type,title,created_by_membership_id)";

    beforeAll(async () => {
      // Seed one document per org as superuser (RLS bypassed) — the §8.8 fixture. The M4 write-audit
      // trigger still fires on these inserts (proven below). `title` is the denylisted free-text column.
      await db.query(
        `INSERT INTO "document" ${DCOLS} VALUES
           ($1,$2,'clinical_record','form_render','discharge_summary','Erin Example — Discharge Summary',$3),
           ($4,$5,'clinical_record','form_render','discharge_summary','Frank Fixture — Discharge Summary',$6)`,
        [DOC_A22, ORG_A, MEM_A22, DOC_B22, ORG_B, MEM_B22],
      );
    });

    it("§8.8 Org A sees ONLY its own document (RLS blocks cross-tenant reads, auth stubbed open)", async () => {
      const a = await withOrg(ORG_A, () =>
        db.query('SELECT count(*)::int AS n FROM "document" WHERE id=$1', [DOC_A22]),
      );
      const b = await withOrg(ORG_B, () =>
        db.query('SELECT count(*)::int AS n FROM "document" WHERE id=$1', [DOC_A22]),
      );
      expect(a.rows[0].n).toBe(1);
      expect(b.rows[0].n).toBe(0);
    });

    it("§8.8 Org B cannot INSERT a document into Org A (WITH CHECK blocks the cross-tenant write)", async () => {
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO "document" ${DCOLS} VALUES (gen_random_uuid(),$1,'clinical_record','form_render','discharge_summary','X',$2)`,
            [ORG_A, MEM_B22],
          ),
        ),
      ).rejects.toThrow();
    });

    it("§3.2 no DELETE grant on document for chartwarden_app (supersession/void, not deletes)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query('DELETE FROM "document" WHERE id=$1', [DOC_A22])),
      ).rejects.toThrow();
    });

    it("§3.6 the M4 write-audit trigger fired for the document write and scrubbed the title denylist", async () => {
      const r = await db.query(
        "SELECT after, retention_class FROM audit_event WHERE resource_kind='document' AND event_type='document.insert' AND organization_id=$1 ORDER BY created_at DESC LIMIT 1",
        [ORG_A],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].after.title).toBe("<changed>"); // §3.6 free-text PHI scrub (title may carry a name)
      expect(r.rows[0].after.retention_class).toBe("clinical_record"); // structural passes through
      expect(r.rows[0].after.status).toBe("active"); // structural passes through
      expect(r.rows[0].retention_class).toBe("compliance"); // §3.7 document audit-row retention class
    });
  });
  // ── Migration 0118: the two STRUCTURAL RLS holes, asserted schema-wide ────────────────────────────
  //
  // These are not policy tests. Every case above proves a policy does what it says; these two prove
  // there is no way to reach the rows WITHOUT going through a policy at all. Both were found by
  // querying a live catalog rather than by reading migration text, and neither would fail any other
  // test in this repo.
  describe("§3.3 structural RLS coverage (migration 0118)", () => {
    it("EVERY table carrying organization_id has RLS enabled (migration 0120)", async () => {
      // THE GATE THAT DID NOT EXIST. check-tenancy.ts validates the SHAPE of policies that exist —
      // canonical app.org_id, no OR-ing FOR ALL pair, the three-column rule — and never asks whether a
      // policy exists AT ALL. So an org-scoped table could ship with zero RLS and every gate stayed
      // green. `feature_flag_evaluation` did exactly that: created in 0000 with organization_id,
      // granted 4 DML privileges to chartwarden_app in 0001, and never given a policy — a per-tenant,
      // per-user record of which capabilities a named user was served, readable by every tenant.
      //
      // Asserted against pg_class, NOT by grepping the migrations, for two reasons: M36 enables RLS
      // through a `DO` loop (`EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t)`) that no
      // text scan can see, and the catalog is the only thing that knows what actually happened.
      const r = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                              AND NOT a.attisdropped
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r','p')
            AND NOT c.relrowsecurity
            -- partition leaves inherit their parent's governance and are covered by the case below
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
          ORDER BY c.relname`,
      );
      expect(
        r.rows.map((x) => x.relname),
        "org-scoped table(s) with organization_id and NO row-level security",
      ).toEqual([]);
    });

    it("every org-scoped table also has at least one policy (RLS on + no policy = silently deny-all)", async () => {
      // RLS enabled with zero policies is default-deny, which is safe but usually means someone
      // enabled it and forgot the policy — the table then fails closed at runtime in a way that reads
      // like a permissions bug. Partition leaves are the ONE legitimate case (0118 leaves them
      // policy-less on purpose so the parent governs), so they are excluded here.
      const r = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'organization_id'
                              AND NOT a.attisdropped
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r','p')
            AND c.relrowsecurity
            AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
            AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          ORDER BY c.relname`,
      );
      expect(
        r.rows.map((x) => x.relname),
        "org-scoped table(s) with RLS enabled but NO policy — deny-all by accident",
      ).toEqual([]);
    });

    it("every RLS table is FORCEd — ownership is not a bypass", async () => {
      // ENABLE does not apply to the table's OWNER. scripts/db/migrate.ts connects as
      // `DATABASE_ADMIN_URL ?? DATABASE_URL`, so one run with only DATABASE_URL makes `chartwarden_app`
      // the owner of every table and silently exempts it from all 370 policies — and ownership is not
      // BYPASSRLS, so the boot guard in apps/backend/src/index.ts would not catch it either.
      const r = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND c.relrowsecurity AND NOT c.relforcerowsecurity
          ORDER BY c.relname`,
      );
      expect(
        r.rows.map((x) => x.relname),
        "RLS enabled but NOT forced",
      ).toEqual([]);
    });

    it("the 11 platform-only zero-policy tables (migration 0159) each have a reachable policy", async () => {
      // These tables have no organization_id, so the org-scoped "has at least one policy" check above
      // never sees them — they were RLS-enabled with a GRANT to chartwarden_admin/tenant_platform_writer
      // but zero CREATE POLICY, which makes the grant dead: default-deny applies to every non-owner
      // role, including the one that was supposedly granted access.
      const PLATFORM_ZERO_POLICY_TABLES = [
        "tenant_signup_intent",
        "tenant_signup_token",
        "revenue_recognition_snapshot",
        "patient_pseudonym_key",
        "stripe_webhook_event",
        "stripe_api_call_audit",
        "platform_retained_invoice",
        "platform_retained_invoice_line",
        "merge_request",
        "nppes_sync_log",
        "nppes_sync_coordination",
      ];
      const r = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = ANY($1)
            AND c.relrowsecurity
            AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)
          ORDER BY c.relname`,
        [PLATFORM_ZERO_POLICY_TABLES],
      );
      expect(
        r.rows.map((x) => x.relname),
        "platform table(s) still policy-less",
      ).toEqual([]);
    });

    it("every partition LEAF has RLS enabled + forced, and no policies of its own", async () => {
      // Policies live on the parent and govern parent-routed access only; a leaf is reached directly
      // by naming it. Before 0118 all 429 leaves had `relrowsecurity = false`, so the ONLY thing
      // preventing direct access was the absence of a GRANT — and one
      // `GRANT SELECT ON ALL TABLES IN SCHEMA public TO chartwarden_app` would have exposed every
      // partition of audit_event, clinical_assessment, medication_order, administration_record,
      // evv_event, visit and claim cross-tenant. Leaves carry NO policies on purpose: RLS on + zero
      // policies = default-deny for direct access, while the parent keeps governing normal traffic.
      const unprotected = await db.query<{ relname: string }>(
        `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_inherits i ON i.inhrelid = c.oid
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
          ORDER BY c.relname`,
      );
      expect(
        unprotected.rows.map((x) => x.relname),
        "partition leaf without forced RLS",
      ).toEqual([]);

      const withPolicies = await db.query<{ relname: string }>(
        `SELECT DISTINCT c.relname
           FROM pg_policy pol
           JOIN pg_class c ON c.oid = pol.polrelid
           JOIN pg_inherits i ON i.inhrelid = c.oid
          ORDER BY c.relname`,
      );
      expect(
        withPolicies.rows.map((x) => x.relname),
        "leaf grew its own policy",
      ).toEqual([]);
    });

    it("a NEWLY created partition is born protected (the event trigger, not 43 helpers)", async () => {
      // There are 43 `create_*_partition` helpers plus a rotation worker. Rather than trust each to
      // remember, `wardenx_secure_new_partition` secures any leaf at ddl_command_end.
      await db.query(
        "SELECT create_audit_partition((date_trunc('month', NOW()) + INTERVAL '11 month')::date)",
      );
      const r = await db.query<{ rls: boolean; forced: boolean }>(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
           FROM pg_class
          WHERE relname = 'audit_event_' || to_char((date_trunc('month', NOW()) + INTERVAL '11 month')::date, 'YYYY_MM')`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].rls, "a new partition was created WITHOUT row-level security").toBe(true);
      expect(r.rows[0].forced, "a new partition was created without FORCE").toBe(true);
    });
  });
});
