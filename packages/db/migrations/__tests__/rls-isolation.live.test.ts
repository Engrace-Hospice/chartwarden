/**
 * RLS cross-tenant isolation — LIVE Postgres proof (M1 §7.2 / M2 spec §9.3; slice-acceptance #3).
 *
 * This is the REAL proof the slice was missing. Its in-memory sibling
 * (cross-tenant-isolation.test.ts) runs a hand-written model of RLS and never touches a
 * database — so it cannot catch anything Postgres does at runtime (a wrong policy
 * predicate, a missing WITH CHECK, or a recursing trigger). This test applies the actual
 * migrations to a real Postgres and exercises the policies as the unprivileged
 * `wardenx_app` role (no BYPASSRLS), proving cross-tenant denial for real.
 *
 * It also pins the regression that the simulation missed: audit_event is RANGE-partitioned
 * by month, so an audited write routes to a dated child and the audit trigger fires with
 * TG_TABLE_NAME = that partition; if the trigger's recursion guard only matches the parent
 * name, every audited write recurses to "stack depth limit exceeded". See 0004's guard.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - CI: the `rls-live` job provides a postgres service + WARDENX_TEST_DATABASE_URL.
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live`
 * The URL must be a SUPERUSER connection to a THROWAWAY database (the suite drops and
 * recreates the public schema + roles).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
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
      // drop owned objects + default privileges, then the role — only if it lingers
      await db.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    // The CI `rls-live` job runs pgvector/pgvector:pg16, so the REAL `CREATE EXTENSION vector`
    // applies — M38 (Terminology) ships a pgvector `concept_embedding` table. For a local PG that
    // lacks pgvector, set WARDENX_TEST_NO_PGVECTOR=1 to strip the extension line (valid only while
    // no table uses the `vector` type; once one does, pgvector is required).
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(
          /^.*EXTENSION IF NOT EXISTS "vector".*$/m,
          "-- (vector extension stripped: WARDENX_TEST_NO_PGVECTOR set; local PG without pgvector)",
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

  it("audit_event is append-only to the app role (UPDATE + DELETE both denied)", async () => {
    await expect(
      withOrg(ORG_A, () => db.query("UPDATE audit_event SET created_at = now()")),
    ).rejects.toThrow();
    await expect(withOrg(ORG_A, () => db.query("DELETE FROM audit_event"))).rejects.toThrow();
  });

  // ── M38 Terminology — platform-shared RLS + canonical lockdown (§9.2 / §9.4) ─────────────
  // The migrations applied above already include 0014/0015 (M38). This proves on REAL Postgres
  // the two halves of the M38 access model that the pure unit suites cannot reach:
  //   • the 12 platform tables are public-read (USING (true)) but locked to wardenx_app for
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
      // the `terminology_loader` SECURITY DEFINER load path; wardenx_app must never reach it.
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

    it("§7.4 wardenx_app CANNOT write canonical terminology (code_system + concept table)", async () => {
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

    /** Run `fn` as wardenx_app with both app.org_id and app.user_id set (user-scoped policies). */
    async function withOrgUser<T>(org: string, user: string, fn: () => Promise<T>): Promise<T> {
      await db.query("SET ROLE wardenx_app");
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
          `INSERT INTO message_attachment (message_id,document_ref,mime_type,byte_size,filename)
           VALUES ($1,$2,'application/pdf',10,'f.pdf')`,
          [messageId, SUBJECT],
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

    it("§3.7 children with no org column are org-isolated through the parent join", async () => {
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
  //     to every tenant, and wardenx_app can NEVER write it (§7.4: only mdm_canonical_writer can);
  //   • external_physician_tenant_overlay is org-scoped — Org A sees its overlay, Org B sees none,
  //     and Org B cannot write an Org-A overlay row (§7.3 two-tenant overlay isolation, WITH CHECK);
  //   • merge_request is the platform-ops surface — no wardenx_app grant at all;
  //   • the M4 write-audit trigger fires on the overlay write and scrubs `contract_terms` (§3.7).
  describe("M40 MDM — canonical lockdown, overlay isolation, audit (§3.6–3.7 / §7.3–7.4)", () => {
    let physicianId: string;
    let canonicalFacilities: number; // baseline count seeded as superuser

    beforeAll(async () => {
      // Seed canonical MDM as superuser (RLS + table grants bypassed). This stands in for the
      // mdm_canonical_writer SECURITY DEFINER load path (NPPES sync / admin merge); wardenx_app
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

    it("§7.4 wardenx_app CANNOT write canonical MDM (external_physician + facility + payer)", async () => {
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

    it("§3.6 merge_request is platform-ops only — wardenx_app has no grant", async () => {
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

    it("§7.4 wardenx_app CANNOT write the platform consent-type floor (dual-grant: writer-role only)", async () => {
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
  // app.org_id even with app authorization stubbed open (§9.3 layer-independence); wardenx_app has
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

    it("§3.6 no M6 table has a DELETE grant for wardenx_app (supersession via status, not deletes)", async () => {
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
  // app.org_id even with app authorization stubbed open (§9.3 layer-independence); wardenx_app has NO
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

    it("§3.6 no M8 table has a DELETE grant for wardenx_app (encounters are voided, never deleted)", async () => {
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
  // wardenx_app has NO DELETE (append-only — a correction supersedes, never deletes, §3.6); scale_license
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

    it("§3.6 clinical_assessment has NO DELETE grant for wardenx_app (corrections supersede, never delete)", async () => {
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
  // wardenx_app has NO DELETE (append-only — a correction supersedes, never deletes, §3.6); the
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

    it("§3.6 hope_assessment has NO DELETE grant for wardenx_app (corrections supersede, never delete)", async () => {
      await expect(
        withOrg(ORG_A, () => db.query("DELETE FROM hope_assessment WHERE id=$1", [ASMT_A10])),
      ).rejects.toThrow();
    });

    it("§3.4 the correction-supersede trigger flips the prior Org-A row to superseded (under RLS)", async () => {
      // Insert a correction that reuses the target's patient/admission/target_date (composite self-FK) under
      // Org A's RLS context; the AFTER-INSERT trigger flips the target row to 'superseded' in the same TX.
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO hope_assessment
             (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,data,target_date,created_by_membership_id,status,corrects_assessment_id)
           SELECT gen_random_uuid(),organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,
                  '{"note":"corrected"}'::jsonb,target_date,$2,'signed',id
             FROM hope_assessment WHERE id=$1`,
          [ASMT_A10, MEM_A10],
        ),
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
      await withOrg(ORG_A, () =>
        db.query(
          `INSERT INTO hope_assessment
             (id,organization_id,provider_entity_id,location_id,patient_id,admission_id,rfa_kind,data,target_date,created_by_membership_id,status,corrects_assessment_id)
           VALUES (gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),'01_admission','{}'::jsonb,${TGT},$4,'signed',$5)`,
          [ORG_A, PE_A10, LOC_A10, MEM_A10, ASMT_B10],
        ),
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
  // write; wardenx_app has NO DELETE (orders supersede via correction / discontinue, never delete — §3.6);
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

    it("§3.6 order_record has NO DELETE grant for wardenx_app (orders supersede/discontinue, never delete)", async () => {
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
  // write; wardenx_app has NO DELETE (orders are append + status-transition, never deleted — §3.6); the
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

    it("§3.6 medication_order has NO DELETE grant for wardenx_app (orders supersede/discontinue, never delete)", async () => {
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
  // cross-tenant write; wardenx_app has NO DELETE (administrations supersede via correction / void, never delete
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

    it("§3.6 administration_record has NO DELETE grant for wardenx_app (administrations supersede/void, never delete)", async () => {
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
});
