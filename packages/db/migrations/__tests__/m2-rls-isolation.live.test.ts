/**
 * M2 Identity & Org — RLS cross-tenant denial: the LIVE Postgres proof (§3.8 / ADR-0010 D2).
 *
 * Identity is a MIXED-scoping module: of its four owned tables (0005), only two carry an
 * `organization_id` and a tenant `_org` policy — the other two are USER-owned, cross-org auth
 * credentials that are deliberately left un-RLS'd (a user legitimately spans orgs, so org-keyed RLS
 * cannot express user ownership — 0006's authority note, matching M1's user/session/account/verification).
 * So the two RLS'd tables are exactly the ones this suite drives, as the unprivileged `wardenx_app`
 * role (no BYPASSRLS), against the real migrations on a real Postgres:
 *   • `organization_invitation` — a pending invite carries the token_hash that lets its bearer JOIN an
 *     org; a cross-tenant read/write would leak or forge the credential that grants org membership.
 *   • `tenant_step_up_policy_override` — the per-tenant step-up (re-auth) policy; a cross-tenant write
 *     would let one org WEAKEN another's step-up requirements for sensitive operations.
 *   • `device_attestation` (ADR-0023 D2) — the platform's verdict on a workforce member's handset. A
 *     cross-tenant WRITE would let one org attest a device into another's fleet, which is the direct
 *     route to satisfying that org's §12.4 gate on `report.drilldown.bulk_export`; a cross-tenant READ
 *     leaks the fleet inventory (who carries what, on which OS) an attacker would target first.
 *
 * EXCLUDED (owned by M2 but out of scope for tenant RLS — see 0006):
 *   • `two_factor`  — USER-owned, cross-org 2FA enrolment; NON_ORG_SCOPED, no org policy (no org_id).
 *   • `passkey`     — USER-owned, cross-org WebAuthn credential; NON_ORG_SCOPED, no org policy.
 *   • `organization`/`user` — M1-owned, not M2; `organization` IS the tenant, `user` is global.
 *
 * Gated on a live DB so the default `bun run test` (no Postgres) stays green:
 *   - Local: `WARDENX_TEST_DATABASE_URL=postgres://… bun run test:rls:live:m2` (SUPERUSER to a THROWAWAY db;
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
/** A single seeded `user` is enough: it backs `organization_invitation.inviter_id` (FK → user, nullable)
 * and `membership.user_id` (FK → user) for both orgs. */
const USER = "33333333-3333-3333-3333-333333333333";

type SeedIds = {
  membership: string;
  organizationInvitation: string;
  tenantStepUpPolicyOverride: string;
  deviceAttestation: string;
};

const COVERED: { table: string; key: keyof SeedIds }[] = [
  { table: "organization_invitation", key: "organizationInvitation" },
  { table: "tenant_step_up_policy_override", key: "tenantStepUpPolicyOverride" },
  { table: "device_attestation", key: "deviceAttestation" },
];

describe.skipIf(!DB_URL)(
  "M2 Identity & Org — RLS cross-tenant denial — LIVE Postgres (§3.8)",
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

    /** Seed one full M2 org-scoped chain for `org` as superuser (RLS + grants bypassed). */
    async function seedOrg(org: string, n: number): Promise<SeedIds> {
      // membership (M1-owned) is the FK target for tenant_step_up_policy_override.configured_by_membership_id.
      const membership = (
        await db.query(
          `INSERT INTO membership (user_id, organization_id, status)
         VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;

      const organizationInvitation = (
        await db.query(
          `INSERT INTO organization_invitation (organization_id, email, token_hash, inviter_id, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '7 days') RETURNING id`,
          [org, `invitee-m2${n}@x.test`, `token-hash-m2${n}`, USER],
        )
      ).rows[0].id as string;

      const tenantStepUpPolicyOverride = (
        await db.query(
          `INSERT INTO tenant_step_up_policy_override (organization_id, operation_key, qualifying_factors,
           max_age_sec, rationale, configured_by_membership_id)
         VALUES ($1,$2, ARRAY['totp','webauthn']::step_up_factor[], 300, 'org policy', $3) RETURNING id`,
          [org, `op.sensitive.m2${n}`, membership],
        )
      ).rows[0].id as string;

      const deviceAttestation = (
        await db.query(
          `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
           platform, provider, verdict, verified_at, expires_at)
         VALUES ($1,$2,$3,'ios','managed_enrollment','attested', now(), now() + interval '30 days')
         RETURNING id`,
          [org, membership, `fp-m2${n}`],
        )
      ).rows[0].id as string;

      return { membership, organizationInvitation, tenantStepUpPolicyOverride, deviceAttestation };
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
      await db.query(`INSERT INTO "user" (id,email) VALUES ($1,'m2-actor@x.test')`, [USER]);
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

    it("every M2 tenant RLS policy keys ONLY on app.org_id (no subqueries / pg_has_role / nullable escape)", async () => {
      // Scans EVERY migration, not just M2's original 0006. The repo's convention puts a table's
      // policy in the migration that creates it, so an M2 table added later (0204's
      // `membership_elevated_approval`, 0222's `device_attestation`) has its policy somewhere else
      // entirely — and a scanner pinned to one filename would simply not see it, reporting a table
      // with no policy identically to a table it never looked for.
      const rls = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
        .join("\n");
      // Matched to the statement TERMINATOR, not to the next `WITH CHECK`. A policy without a
      // `WITH CHECK` (a read-only `FOR SELECT` one) has no such clause to stop at, so the old pattern
      // ran on until it found somebody else's — harmless while it read one file, wrong the moment it
      // reads the corpus. A policy predicate cannot contain a semicolon, so `;` bounds it exactly.
      const policyBlocks = (rls.match(/CREATE POLICY[^;]*;/g) ?? []).filter((b) =>
        COVERED.some((t) => b.includes(`"${t.table}"`)),
      );
      // Per-table, not an exact block COUNT. Scanning every migration means a policy DROPped and
      // re-CREATEd by a later migration contributes more than one block for the same table, so an
      // equality check would fail for a remediation that is entirely correct. What must hold is that
      // each covered table HAS a policy and that every block found obeys the rule.
      for (const { table } of COVERED) {
        expect(
          policyBlocks.filter((b) => b.includes(`"${table}"`)).length,
          `${table} has no CREATE POLICY block in any migration`,
        ).toBeGreaterThan(0);
      }
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

    it("a WITH CHECK refuses an invitation forged into another tenant", async () => {
      // organization_invitation carries the token_hash that lets its bearer join an org — a cross-tenant
      // write would let org B mint an invite attributed to org A (or read A's pending invite tokens).
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO organization_invitation (organization_id, email, token_hash, expires_at)
           VALUES ($1,$2,$3, now() + interval '7 days')`,
            [ORG_A, "forged@x.test", "forged-token-hash"],
          ),
        ),
      ).rejects.toThrow();
    });

    it("a WITH CHECK refuses a device attested into another tenant's fleet", async () => {
      // The attack this closes: attest a handset into org A while holding only org B, then use that
      // device to satisfy A's §12.4 gate on `report.drilldown.bulk_export` — a CSV of A's
      // patient-identifiable navigation links.
      await expect(
        withOrg(ORG_B, () =>
          db.query(
            `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
             platform, provider, verdict, verified_at, expires_at)
           VALUES ($1,$2,'forged-fp','ios','managed_enrollment','attested', now(), now() + interval '30 days')`,
            [ORG_A, a.membership],
          ),
        ),
      ).rejects.toThrow();
    });

    it("org B cannot REVOKE org A's device attestation (the USING clause covers writes too)", async () => {
      // The mirror-image attack: not forging trust into another tenant but DESTROYING it — revoking a
      // rival org's attested handsets would lock their field staff out of every §12.4-gated surface.
      const res = await withOrg(ORG_B, () =>
        db.query(
          `UPDATE device_attestation SET verdict='revoked', revoked_at=now(),
             revoked_by_membership_id=$2, revoked_reason='cross-tenant revocation attempt'
           WHERE id=$1`,
          [a.deviceAttestation, b.membership],
        ),
      );
      expect(res.rowCount).toBe(0);
    });

    it("the attestation window CHECK refuses a proof with no horizon", async () => {
      // Not an RLS case — the constraint that keeps an attestation from becoming a permanent trust
      // decision made once. Asserted here because this file is the only place the real DDL runs.
      await expect(
        db.query(
          `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
           platform, provider, verdict, verified_at, expires_at)
         VALUES ($1,$2,'no-horizon-fp','ios','managed_enrollment','attested', now(), now() - interval '1 day')`,
          [ORG_A, a.membership],
        ),
      ).rejects.toThrow(/device_attestation_window_ordered/);
    });

    it("the failure-reason CHECK refuses an `attested` row that also carries a failure", async () => {
      // A row a reviewer cannot interpret is worse than no row. Both directions are refused.
      await expect(
        db.query(
          `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
           platform, provider, verdict, failure_reason, verified_at, expires_at)
         VALUES ($1,$2,'contradiction-fp','ios','managed_enrollment','attested','device_compromised',
                 now(), now() + interval '30 days')`,
          [ORG_A, a.membership],
        ),
      ).rejects.toThrow(/device_attestation_failure_reason_consistent/);
      await expect(
        db.query(
          `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
           platform, provider, verdict, verified_at, expires_at)
         VALUES ($1,$2,'silent-failure-fp','ios','managed_enrollment','failed', now(), now() + interval '30 days')`,
          [ORG_A, a.membership],
        ),
      ).rejects.toThrow(/device_attestation_failure_reason_consistent/);
    });

    it("only ONE live attestation per device — re-attesting must supersede, not accumulate", async () => {
      // The partial unique index is what makes the resolver's single-row join correct. Without it a
      // device could hold two live attestations and which one answered would be arbitrary.
      await expect(
        db.query(
          `INSERT INTO device_attestation (organization_id, membership_id, device_key_fingerprint,
           platform, provider, verdict, verified_at, expires_at)
         VALUES ($1,$2,'fp-m21','ios','managed_enrollment','attested', now(), now() + interval '30 days')`,
          [ORG_A, a.membership],
        ),
      ).rejects.toThrow(/device_attestation_live_uq/);
    });

    it("org B cannot UPDATE org A's step-up policy override (the USING clause covers writes too)", async () => {
      const res = await withOrg(ORG_B, () =>
        db.query("UPDATE tenant_step_up_policy_override SET max_age_sec=1 WHERE id=$1", [
          a.tenantStepUpPolicyOverride,
        ]),
      );
      expect(res.rowCount).toBe(0);
      const still = await db.query(
        "SELECT max_age_sec FROM tenant_step_up_policy_override WHERE id=$1",
        [a.tenantStepUpPolicyOverride],
      );
      expect(still.rows[0].max_age_sec).toBe(300);
    });

    it("the M4 write-audit trigger fired for the invitation writes (§3.8)", async () => {
      const r = await db.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'organization_invitation'",
      );
      expect(r.rows[0].n).toBeGreaterThan(0);
    });
  },
);
