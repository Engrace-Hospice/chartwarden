/**
 * M28 FHIR Gateway — §3.5/§3.6 cross-tenant isolation: the LIVE Postgres proof (ADR-0010 D2).
 *
 * M28 shipped 🟢 with every gate green but with its Live column reading `0/8 ⚠️` — the eight owned
 * tables were named in NO `*.live.test.ts`, so the per-tenant RLS the migration DECLARES had never been
 * OBSERVED against a real server. Reading 0137 tells you a policy exists; it cannot tell you the policy
 * is correct, that `chartwarden_app` is NOBYPASSRLS, that the two partitioned tables are actually sealed at
 * the leaf, or that the §3.6 denylist really scrubs `secret_cipher`/`payload` out of the audit trail.
 * This file connects as `chartwarden_app`, sets `app.org_id` to each of two tenants in turn, and asserts
 * no leakage — the same shape as every other module's suite (the M32 AI-Platform precedent).
 *
 * `chartwarden_app` MUST be NOBYPASSRLS for any of this to mean anything: a role with BYPASSRLS satisfies
 * every assertion below vacuously. That is asserted FIRST, before a single isolation case runs (the
 * M15-T07 lesson).
 *
 * M28 IS TWO POLICY SHAPES (0137):
 *
 *   1. **SEVEN TENANT-SCOPED tables** on the canonical `app.org_id` policy — `tenant_fhir_config`
 *      (organization_id IS its PK), `fhir_client`, `fhir_client_credential`, `fhir_bulk_export_job`,
 *      `fhir_bulk_export_artifact`, and the TWO PARTITIONED ones (`fhir_client_session` on issued_at,
 *      `fhir_inbound_resource` on proposed_at) whose policy + grants are declared on the parent only.
 *      What partitioning actually buys is a PostgreSQL behaviour the migration cannot state and reading
 *      the SQL cannot tell you: the parent's policy governs every query ROUTED THROUGH THE PARENT, while
 *      each partition leaf carries `relrowsecurity`/`relforcerowsecurity = true` (from the 0118
 *      `wardenx_secure_new_partition` event trigger, which fires when 0135/0136 create the leaves) AND
 *      HOLDS NO GRANT — so a stray `GRANT SELECT ON ALL TABLES IN SCHEMA public` cannot expose a leaf.
 *      Both halves are asserted.
 *   2. **ONE PLATFORM-SHARED table**, `fhir_capability_snapshot`, no organization_id: `FOR SELECT
 *      USING (true)` so a client can read the conformance contract from inside any tenant, and NO write
 *      grant to `chartwarden_app` at all (writes are `chartwarden_admin` at boot). "Both tenants see the same
 *      row" is the CORRECT answer here and a leak everywhere else, so the sweep is not uniform.
 *
 * TWO FURTHER INVARIANTS GET THEIR OWN CASES because each is a rule the migration states and only a
 * database can hold:
 *
 *   · **`chartwarden_app` has DELETE on NOTHING in M28.** The §3.7 eraser SHREDS in place (zero the cipher,
 *     replace the payload with the destroyed sentinel, soft-delete the client) rather than deleting rows
 *     — the rows ARE the §164.528 disclosure-accounting evidence. The privilege is withheld so an
 *     attempted delete is a permission error, not a code-review convention.
 *   · **The partition/audit interaction.** M1's baseline trigger stamps `TG_TABLE_NAME`, which on a
 *     partitioned write is the dated PARTITION; 0137 gives both partitioned tables a generated function
 *     that hard-codes the parent's name. This asserts the resulting `audit_event.resource_kind` is
 *     `fhir_client_session` / `fhir_inbound_resource`, not `fhir_client_session_2026_08` — and that the
 *     §3.6 denylist scrubs `secret_cipher` and `payload` to the `"<changed>"` sentinel while the
 *     sha256/fingerprint survive (the M32 ai_invocation lesson: found by RUNNING the migration).
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m28` (SUPERUSER to a THROWAWAY
 *     db — this DROPs and recreates `public`, so never point it at a database you care about).
 *   - The target needs **pgvector** (earlier modules in the chain declare `vector` columns). Use
 *     `pgvector/pgvector:pgNN`, or set `CHARTWARDEN_TEST_NO_PGVECTOR=1` to strip the extension DDL.
 *   - Raise `max_locks_per_transaction` (4096 is ample) — `DROP SCHEMA public CASCADE` takes one lock per
 *     relation and the full chain now carries hundreds of partitions (M28 adds ~28 of its own).
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
  client: string;
  credential: string;
  session: string; // jti
  job: string;
  artifact: string;
  inbound: string;
  secret: string; // the plaintext-ish secret we look for (must NOT reach the audit row)
};

/**
 * The seven org-scoped M28 tables, each with the column the isolation case keys on and the seeded value.
 * `tenant_fhir_config` is keyed on organization_id (its PK); the two partitioned tables on their own id.
 */
const TENANT_SCOPED: { table: string; keyCol: string; key: keyof SeedIds | "org" }[] = [
  { table: "tenant_fhir_config", keyCol: "organization_id", key: "org" },
  { table: "fhir_client", keyCol: "id", key: "client" },
  { table: "fhir_client_credential", keyCol: "id", key: "credential" },
  { table: "fhir_client_session", keyCol: "jti", key: "session" },
  { table: "fhir_bulk_export_job", keyCol: "id", key: "job" },
  { table: "fhir_bulk_export_artifact", keyCol: "id", key: "artifact" },
  { table: "fhir_inbound_resource", keyCol: "id", key: "inbound" },
];

const PARTITIONED = ["fhir_client_session", "fhir_inbound_resource"];
const PLATFORM_SHARED = "fhir_capability_snapshot";
const ALL_TABLES = [...TENANT_SCOPED.map((t) => t.table), PLATFORM_SHARED];

describe.skipIf(!DB_URL)(
  "M28 FHIR Gateway — cross-tenant isolation — LIVE Postgres (§3.5/§3.6)",
  () => {
    let db: Client;
    let a: SeedIds;
    let b: SeedIds;
    let snapshotId: string;

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

    /** The platform-singleton CapabilityStatement — one row for the whole platform, no organization_id. */
    async function seedPlatform(): Promise<void> {
      snapshotId = (
        await db.query(
          `INSERT INTO fhir_capability_snapshot (fhir_version, release_tag, capability_statement,
           checksum_sha256, signature)
         VALUES ('4.0.1','r4-2026-08','{"resourceType":"CapabilityStatement"}'::jsonb, $1,'\\x01'::bytea)
         RETURNING id`,
          ["c".repeat(64)],
        )
      ).rows[0].id as string;
    }

    /** One full tenant-scoped M28 chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      await db.query(
        `INSERT INTO tenant_fhir_config (organization_id, tenant_fhir_host, identifier_uri_base,
         cursor_signing_key_cipher)
       VALUES ($1, 'tenant-${n}.fhir.example', 'https://fhir.example/${n}', '\\x0${n}'::bytea)`,
        [org],
      );

      const client = (
        await db.query(
          `INSERT INTO fhir_client (organization_id, name, type, allowed_scopes, tier, rate_limit_rps,
           baa_contract_reference)
         VALUES ($1, 'consumer-${n}', 'smart_backend_services', '["system/*.read"]'::jsonb, 'tier-2', 10,
           'BAA-2026-0${n}') RETURNING id`,
          [org],
        )
      ).rows[0].id as string;

      const secret = `super-secret-key-${n}-${org}`;
      const credential = (
        await db.query(
          `INSERT INTO fhir_client_credential (organization_id, client_id, kind, secret_cipher,
           secret_digest_sha256, fingerprint)
         VALUES ($1, $2, 'api_key', $3::bytea, $4, 'fp-${n}') RETURNING id`,
          [org, client, Buffer.from(secret), "d".repeat(64)],
        )
      ).rows[0].id as string;

      // jti has NO default (the PK is the composite (jti, issued_at)); the write boundary mints it.
      const session = (
        await db.query(
          `INSERT INTO fhir_client_session (jti, organization_id, client_id, scopes_granted, expires_at,
           token_key_fingerprint)
         VALUES (gen_random_uuid(), $1, $2, '["system/Patient.read"]'::jsonb, now() + interval '1 hour',
           'tkf-${n}')
         RETURNING jti`,
          [org, client],
        )
      ).rows[0].jti as string;

      const job = (
        await db.query(
          `INSERT INTO fhir_bulk_export_job (organization_id, client_id, request_kind, resource_types,
           request_envelope_sha256)
         VALUES ($1, $2, 'system', '["Patient"]'::jsonb, '${"e".repeat(63)}${n}') RETURNING id`,
          [org, client],
        )
      ).rows[0].id as string;

      const artifact = (
        await db.query(
          `INSERT INTO fhir_bulk_export_artifact (organization_id, job_id, resource_type, minio_object_key,
           byte_size, row_count, checksum_sha256)
         VALUES ($1, $2, 'Patient', 'exports/${n}/patient.ndjson', 2048, 12, '${"f".repeat(63)}${n}')
         RETURNING id`,
          [org, job],
        )
      ).rows[0].id as string;

      const inbound = (
        await db.query(
          `INSERT INTO fhir_inbound_resource (organization_id, source_client_id, resource_type, payload,
           payload_sha256, owner_module)
         VALUES ($1, $2, 'Patient', '{"resourceType":"Patient","name":[{"family":"Doe-${n}"}]}'::jsonb,
           '${"a".repeat(63)}${n}', 'm5') RETURNING id`,
          [org, client],
        )
      ).rows[0].id as string;

      return { client, credential, session, job, artifact, inbound, secret };
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
      await seedPlatform();
      a = await seedOrg(ORG_A, 1);
      b = await seedOrg(ORG_B, 2);
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

    it("enables RLS on all eight owned tables", async () => {
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1::text[]) AND relnamespace = 'public'::regnamespace`,
        [ALL_TABLES],
      );
      expect(rows).toHaveLength(ALL_TABLES.length);
      for (const row of rows) expect(row.relrowsecurity, `${row.relname} has RLS off`).toBe(true);
    });

    // ── shape 1: the tenant-scoped seven ──────────────────────────────────────────────────────────────

    it("shows each tenant ONLY its own rows across every org-scoped table", async () => {
      for (const { table, keyCol, key } of TENANT_SCOPED) {
        const aVal = key === "org" ? ORG_A : a[key];
        const bVal = key === "org" ? ORG_B : b[key];

        const mine = await withOrg(ORG_A, () =>
          db.query(`SELECT ${keyCol} FROM ${table} WHERE ${keyCol} = $1`, [aVal]),
        );
        expect(mine.rowCount, `${table}: org A cannot see its own row`).toBe(1);

        const theirs = await withOrg(ORG_A, () =>
          db.query(`SELECT ${keyCol} FROM ${table} WHERE ${keyCol} = $1`, [bVal]),
        );
        expect(theirs.rowCount, `${table}: org A can see org B's row`).toBe(0);
      }
    });

    it("scopes every org-scoped table's FULL scan to the caller's tenant (no stray cross-tenant row)", async () => {
      for (const { table } of TENANT_SCOPED) {
        const seen = await withOrg(ORG_A, () =>
          db.query<{ organization_id: string }>(`SELECT organization_id FROM ${table}`),
        );
        expect(
          seen.rowCount,
          `${table}: org A sees none of its own rows on a full scan`,
        ).toBeGreaterThan(0);
        for (const row of seen.rows) {
          expect(row.organization_id, `${table} leaked a cross-tenant row on a full scan`).toBe(
            ORG_A,
          );
        }
      }
    });

    it("isolates the PARTITIONED pair through the parent, and leaves the leaves reachable only by GRANT", async () => {
      // Read through the PARENT, which is how every M28 query reaches these tables: the parent's policy
      // applies and only the caller's rows come back. (Covered by the full-scan case above too, kept here
      // to anchor the leaf assertions that follow.)
      for (const parent of PARTITIONED) {
        const visible = await withOrg(ORG_A, () =>
          db.query<{ organization_id: string }>(`SELECT organization_id FROM ${parent}`),
        );
        expect(visible.rowCount, `${parent}: org A sees none of its own rows`).toBeGreaterThan(0);
        for (const row of visible.rows) {
          expect(row.organization_id, `${parent} leaked a cross-tenant row`).toBe(ORG_A);
        }
      }

      // RLS on a partitioned table does NOT become RLS on its partitions: the parent's policy is applied
      // only to queries routed through the parent, and reading a leaf DIRECTLY applies that leaf's own
      // policies. 0118's `wardenx_secure_new_partition` event trigger fires as 0135/0136 create each leaf,
      // so every leaf has RLS ENABLED and FORCED, carries NO policy of its own, and DEFAULT-DENIES direct
      // access even if someone runs `GRANT SELECT ON ALL TABLES IN SCHEMA public`. The missing grant is the
      // first line of defence, FORCE RLS is the second.
      const leaves = await db.query<{
        table_name: string;
        rls: boolean;
        forced: boolean;
        sel: boolean;
      }>(
        `SELECT c.relname AS table_name,
              c.relrowsecurity AS rls,
              c.relforcerowsecurity AS forced,
              has_table_privilege('chartwarden_app', c.oid, 'SELECT') AS sel
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ANY($1::text[])`,
        [PARTITIONED],
      );
      expect(leaves.rowCount).toBeGreaterThan(0);
      for (const leaf of leaves.rows) {
        expect(
          leaf.rls,
          `${leaf.table_name} has NO row-level security of its own (0118 regression)`,
        ).toBe(true);
        expect(
          leaf.forced,
          `${leaf.table_name} has RLS but not FORCE — the table owner still bypasses it`,
        ).toBe(true);
        expect(leaf.sel, `${leaf.table_name} is directly readable by chartwarden_app`).toBe(false);
      }

      // A leaf must carry NO policies: parent policies govern parent-routed access, and a leaf policy would
      // be a second, drifting copy of the tenancy rule. No policies + RLS on = default-deny.
      const leafPolicies = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM pg_policy pol
         JOIN pg_inherits i ON i.inhrelid = pol.polrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ANY($1::text[])`,
        [PARTITIONED],
      );
      expect(leafPolicies.rows[0]?.count, "a partition leaf grew its own policy").toBe("0");
    });

    it("refuses a write that carries another tenant's organization_id (the WITH CHECK half)", async () => {
      await expect(
        withOrg(ORG_A, () =>
          db.query(
            `INSERT INTO fhir_client (organization_id, name, type, allowed_scopes, tier, rate_limit_rps,
             baa_contract_reference)
           VALUES ($1, 'smuggled', 'api_key', '[]'::jsonb, 'tier-3', 5, 'BAA-X')`,
            [ORG_B],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    // ── shape 2: the platform-shared CapabilityStatement ─────────────────────────────────────────────

    it("serves the platform-shared CapabilityStatement to BOTH tenants — read-all is the design", async () => {
      const fromA = await withOrg(ORG_A, () =>
        db.query(`SELECT id FROM ${PLATFORM_SHARED} WHERE id = $1`, [snapshotId]),
      );
      const fromB = await withOrg(ORG_B, () =>
        db.query(`SELECT id FROM ${PLATFORM_SHARED} WHERE id = $1`, [snapshotId]),
      );
      // A client cannot speak to the gateway without reading its conformance statement, and a per-tenant
      // copy would let two tenants disagree about what the gateway supports.
      expect(fromA.rowCount).toBe(1);
      expect(fromB.rowCount).toBe(1);
    });

    it("gives chartwarden_app NO write on the platform-shared CapabilityStatement", async () => {
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        const { rows } = await db.query<{ has: boolean }>(
          "SELECT has_table_privilege('chartwarden_app', $1, $2) AS has",
          [PLATFORM_SHARED, privilege],
        );
        expect(rows[0].has, `chartwarden_app may ${privilege} ${PLATFORM_SHARED}`).toBe(false);
      }
    });

    // ── privileges: no DELETE anywhere (§3.7 shreds in place) ─────────────────────────────────────────

    // The single deliberate exception is the operational 90-day session sweeper (migration 0354, GAP-084):
    // DELETE on `fhir_client_session` only — no PHI, RLS-scoped, audited. Every other M28 table stays
    // DELETE-free; widening this list is a security decision, not a test fix.
    const DELETE_GRANTED_BY_DESIGN = new Set(["fhir_client_session"]);

    it("grants chartwarden_app DELETE on nothing in M28 except the 0354 session sweeper — the eraser shreds in place", async () => {
      for (const table of ALL_TABLES) {
        const { rows } = await db.query<{ has: boolean }>(
          "SELECT has_table_privilege('chartwarden_app', $1, 'DELETE') AS has",
          [table],
        );
        expect(rows[0].has, `chartwarden_app DELETE on ${table}`).toBe(
          DELETE_GRANTED_BY_DESIGN.has(table),
        );
      }
    });

    // ── the partition/audit interaction + the §3.6 denylist (found by RUNNING the migration) ─────────

    it("audits a partitioned write under the PARENT's name, not the partition's", async () => {
      const { rows } = await db.query<{ resource_kind: string; event_type: string }>(
        `SELECT resource_kind, event_type FROM audit_event
        WHERE resource_kind LIKE 'fhir_client_session%' OR resource_kind LIKE 'fhir_inbound_resource%'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // `fhir_client_session_2026_08` would make every audit query for the ledger return nothing, and the
        // resource kind would rename itself every month.
        expect(PARTITIONED).toContain(row.resource_kind);
        expect(row.event_type).toMatch(
          /^(fhir_client_session|fhir_inbound_resource)\.(insert|update|delete)$/,
        );
      }
    });

    it("scrubs the §3.6 denylisted columns out of the audit row while keeping the digests verbatim", async () => {
      // fhir_inbound_resource.payload → "<changed>", payload_sha256 stays. Anchor to org A's own row.
      const inbound = await db.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_event
        WHERE resource_kind = 'fhir_inbound_resource' AND event_type = 'fhir_inbound_resource.insert'
          AND resource_id = $1`,
        [a.inbound],
      );
      expect(inbound.rows).toHaveLength(1);
      const inb = inbound.rows[0].after;
      expect(inb.payload, "payload reached the audit row unscrubbed").toBe("<changed>");
      expect(
        String(inb.payload_sha256),
        "payload_sha256 (not PHI) should survive verbatim",
      ).toHaveLength(64);

      // fhir_client_credential.secret_cipher + secret_digest_sha256 → "<changed>"; fingerprint stays.
      const cred = await db.query<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_event
        WHERE resource_kind = 'fhir_client_credential' AND event_type = 'fhir_client_credential.insert'
          AND resource_id = $1`,
        [a.credential],
      );
      expect(cred.rows).toHaveLength(1);
      const c = cred.rows[0].after;
      expect(c.secret_cipher, "secret_cipher reached the audit row unscrubbed").toBe("<changed>");
      expect(c.secret_digest_sha256, "secret_digest_sha256 reached the audit row unscrubbed").toBe(
        "<changed>",
      );
      // And the plaintext secret is nowhere in the serialized audit row.
      expect(JSON.stringify(c)).not.toContain("super-secret-key");
      expect(c.fingerprint, "the non-secret fingerprint should survive").toBe("fp-1");
    });
  },
);
