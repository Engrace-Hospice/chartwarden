/**
 * F-222 (#248) — LIVE Postgres proof of M31's daily post-discharge-grace sweep (`m31.post-discharge-grace.cron`,
 * spec §4.8 / §7.6) over M6's org-explicit published read `portalDischargedPastGraceForOrg`, connected as the
 * real NOBYPASSRLS `chartwarden_app` role. Real `portal_account` / `portal_access_grant` / `admission` /
 * `discharge_event` rows are inserted by the test (production has none until M31 provisioning is built).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m31:post-discharge-grace:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { portalDischargedPastGraceForOrg } from "../src/modules/06-admission/seams/portal-discharge-grace-for-org";
import {
  type M31DischargeGracePort,
  type PostDischargeGraceSweepDeps,
  graceCutoffDate,
  runPostDischargeGraceSweepOnce,
} from "../src/modules/31-portal/jobs/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-222 — M31 post-discharge-grace sweep — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const pe: Record<string, string> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  async function seedOrg(orgId: string, slug: string) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [orgId, `org-${slug}`, slug],
    );
    const row = await admin.query(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
      [orgId, `CCN-${slug}`, `NPI-${slug}`],
    );
    pe[orgId] = row.rows[0].id as string;
  }
  async function seedAccount(orgId: string): Promise<string> {
    const user = await admin.query('INSERT INTO "user" (email) VALUES ($1) RETURNING id', [
      `grace-${crypto.randomUUID()}@x.test`,
    ]);
    const row = await admin.query(
      `INSERT INTO portal_account (organization_id, user_id, relationship, status, display_name_cipher, email_cipher)
       VALUES ($1,$2,'family_caregiver','active','cipher:name','cipher:email') RETURNING id`,
      [orgId, user.rows[0].id],
    );
    return row.rows[0].id as string;
  }
  async function seedGrant(
    orgId: string,
    patientId: string,
    kind = "family_caregiver",
  ): Promise<string> {
    const account = await seedAccount(orgId);
    const row = await admin.query(
      `INSERT INTO portal_access_grant
         (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
          source_consent_record_id, source_consent_version, granted_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,'{"categories":{},"floorVersion":"v0"}'::jsonb,$6,'0',$7) RETURNING id`,
      [orgId, pe[orgId], account, patientId, kind, crypto.randomUUID(), crypto.randomUUID()],
    );
    return row.rows[0].id as string;
  }
  /** An admission for `patientId`; `status` 'discharged' (with a completed discharge_event `daysAgo` old) or open. */
  async function seedAdmission(opts: {
    orgId: string;
    patientId: string;
    status: "discharged" | "active" | "referred";
    dischargedDaysAgo?: number;
    dischargeType?: string;
    dischargeStatus?: string;
  }): Promise<string> {
    const adm = await admin.query(
      `INSERT INTO admission (organization_id, provider_entity_id, patient_id, status)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [opts.orgId, pe[opts.orgId], opts.patientId, opts.status],
    );
    const admissionId = adm.rows[0].id as string;
    if (opts.dischargedDaysAgo !== undefined) {
      await admin.query(
        `INSERT INTO discharge_event (organization_id, admission_id, discharge_type, status, effective_at)
         VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'utc')::date - $5::int)`,
        [
          opts.orgId,
          admissionId,
          opts.dischargeType ?? "transfer",
          opts.dischargeStatus ?? "completed",
          opts.dischargedDaysAgo,
        ],
      );
    }
    return admissionId;
  }
  async function grantRow(id: string) {
    const { rows } = await admin.query(
      "SELECT revoked_at, revoke_cascade_source, version FROM portal_access_grant WHERE id = $1",
      [id],
    );
    return rows[0] as {
      revoked_at: Date | null;
      revoke_cascade_source: string | null;
      version: number;
    };
  }

  function m6Port(): M31DischargeGracePort {
    return {
      portalDischargedPastGraceForOrg: (organizationId, patientIds, cutoff) =>
        portalDischargedPastGraceForOrg(handle.db, organizationId, patientIds, cutoff),
    };
  }
  function deps(
    orgs: readonly string[],
    over: Partial<PostDischargeGraceSweepDeps> = {},
  ): PostDischargeGraceSweepDeps {
    return {
      db: handle.db,
      activeOrgs: {
        listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
      },
      m6: m6Port(),
      ...over,
    };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await seedOrg(ORG_A, "a");
    await seedOrg(ORG_B, "b");
    await seedOrg(ORG_C, "c");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("revokes care-time grants past the 30-day floor and respects the floor boundary", async () => {
    const past = crypto.randomUUID(); // discharged 31d ago => revoked
    const boundary = crypto.randomUUID(); // discharged exactly 30d ago => still inside the floor
    const recent = crypto.randomUUID(); // 10d ago
    const gPast = await seedGrant(ORG_A, past);
    const gBoundary = await seedGrant(ORG_A, boundary);
    const gRecent = await seedGrant(ORG_A, recent);
    await seedAdmission({
      orgId: ORG_A,
      patientId: past,
      status: "discharged",
      dischargedDaysAgo: 31,
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: boundary,
      status: "discharged",
      dischargedDaysAgo: 30,
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: recent,
      status: "discharged",
      dischargedDaysAgo: 10,
    });

    const results = await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    expect(results[0]?.graceDays).toBe(30);

    const r = await grantRow(gPast);
    expect(r.revoked_at).not.toBeNull();
    expect(r.revoke_cascade_source).toBe("admission_discharged");
    expect(r.version).toBe(1);
    expect((await grantRow(gBoundary)).revoked_at).toBeNull();
    expect((await grantRow(gRecent)).revoked_at).toBeNull();
  });

  it("is idempotent: a rerun revokes nothing and leaves versions untouched", async () => {
    const p = crypto.randomUUID();
    const g = await seedGrant(ORG_A, p);
    await seedAdmission({
      orgId: ORG_A,
      patientId: p,
      status: "discharged",
      dischargedDaysAgo: 90,
    });
    await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    const first = await grantRow(g);
    expect(first.revoked_at).not.toBeNull();
    const second = await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    expect(second[0]?.revokedGrants).toBe(0);
    const after = await grantRow(g);
    expect(after.version).toBe(first.version);
    expect(after.revoked_at?.getTime()).toBe(first.revoked_at?.getTime());
  });

  it("re-admission keeps access: an open admission, or a newer recent discharge, is never a candidate", async () => {
    const readmitted = crypto.randomUUID();
    const redischarged = crypto.randomUUID();
    const gReadmitted = await seedGrant(ORG_A, readmitted);
    const gRedischarged = await seedGrant(ORG_A, redischarged);
    // discharged 60d ago, then re-admitted (open admission) — no cancel logic, just not a candidate.
    await seedAdmission({
      orgId: ORG_A,
      patientId: readmitted,
      status: "discharged",
      dischargedDaysAgo: 60,
    });
    await seedAdmission({ orgId: ORG_A, patientId: readmitted, status: "active" });
    // discharged 60d ago, re-admitted, discharged AGAIN 5d ago — the clock restarts from the newest discharge.
    await seedAdmission({
      orgId: ORG_A,
      patientId: redischarged,
      status: "discharged",
      dischargedDaysAgo: 60,
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: redischarged,
      status: "discharged",
      dischargedDaysAgo: 5,
    });

    await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    expect((await grantRow(gReadmitted)).revoked_at).toBeNull();
    expect((await grantRow(gRedischarged)).revoked_at).toBeNull();
  });

  it("never touches bereaved grants, death discharges, or unresolved (pending_cosign) discharges", async () => {
    const bereaved = crypto.randomUUID();
    const died = crypto.randomUUID();
    const forCause = crypto.randomUUID();
    const gBereaved = await seedGrant(ORG_A, bereaved, "bereaved_family");
    const gDied = await seedGrant(ORG_A, died);
    const gForCause = await seedGrant(ORG_A, forCause);
    await seedAdmission({
      orgId: ORG_A,
      patientId: bereaved,
      status: "discharged",
      dischargedDaysAgo: 90,
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: died,
      status: "discharged",
      dischargedDaysAgo: 90,
      dischargeType: "death",
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: forCause,
      status: "active",
      dischargedDaysAgo: 90,
      dischargeType: "for_cause",
      dischargeStatus: "pending_cosign",
    });

    await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    expect((await grantRow(gBereaved)).revoked_at).toBeNull();
    expect((await grantRow(gDied)).revoked_at).toBeNull();
    expect((await grantRow(gForCause)).revoked_at).toBeNull();
  });

  it("only completed discharges count, and a bereaved grant co-held on the patient survives the revoke", async () => {
    const voided = crypto.randomUUID();
    const pending = crypto.randomUUID();
    const mixed = crypto.randomUUID();
    const gVoided = await seedGrant(ORG_A, voided);
    const gPending = await seedGrant(ORG_A, pending);
    const gMixedCare = await seedGrant(ORG_A, mixed);
    const gMixedBereaved = await seedGrant(ORG_A, mixed, "bereaved_family");
    // No open admission, but the only discharge row is voided / still pending co-sign => not a real discharge.
    await seedAdmission({
      orgId: ORG_A,
      patientId: voided,
      status: "discharged",
      dischargedDaysAgo: 90,
      dischargeStatus: "voided",
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: pending,
      status: "discharged",
      dischargedDaysAgo: 90,
      dischargeType: "for_cause",
      dischargeStatus: "pending_cosign",
    });
    await seedAdmission({
      orgId: ORG_A,
      patientId: mixed,
      status: "discharged",
      dischargedDaysAgo: 90,
    });

    await runPostDischargeGraceSweepOnce(deps([ORG_A]));
    expect((await grantRow(gVoided)).revoked_at).toBeNull();
    expect((await grantRow(gPending)).revoked_at).toBeNull();
    expect((await grantRow(gMixedCare)).revoked_at).not.toBeNull();
    expect((await grantRow(gMixedBereaved)).revoked_at).toBeNull();
  });

  it("honours a tenant grace LONGER than the floor and ignores one SHORTER than it", async () => {
    const p45 = crypto.randomUUID();
    const p15 = crypto.randomUUID();
    const g45 = await seedGrant(ORG_B, p45);
    const g15 = await seedGrant(ORG_B, p15);
    await seedAdmission({
      orgId: ORG_B,
      patientId: p45,
      status: "discharged",
      dischargedDaysAgo: 45,
    });
    await seedAdmission({
      orgId: ORG_B,
      patientId: p15,
      status: "discharged",
      dischargedDaysAgo: 15,
    });

    // configured 60 => 45d-old discharge retained. Configured 10 (< floor) => clamped up to 30 => 15d retained.
    let r = await runPostDischargeGraceSweepOnce(
      deps([ORG_B], { graceDaysForOrg: async () => 60 }),
    );
    expect(r[0]?.graceDays).toBe(60);
    expect((await grantRow(g45)).revoked_at).toBeNull();
    r = await runPostDischargeGraceSweepOnce(deps([ORG_B], { graceDaysForOrg: async () => 10 }));
    expect(r[0]?.graceDays).toBe(30);
    expect((await grantRow(g15)).revoked_at).toBeNull();
    // the 45d discharge IS past the (clamped) 30-day floor => revoked now.
    expect((await grantRow(g45)).revoked_at).not.toBeNull();
  });

  it("cross-tenant: M6's read and the sweep are tenant-scoped (as the real NOBYPASSRLS role)", async () => {
    const shared = crypto.randomUUID(); // same patient id appears in both orgs
    // Org A: discharged 90d ago. Org B: holds a grant for the SAME patient id but has no admission at all.
    await seedAdmission({
      orgId: ORG_A,
      patientId: shared,
      status: "discharged",
      dischargedDaysAgo: 90,
    });
    const gB = await seedGrant(ORG_B, shared);
    const cutoff = graceCutoffDate(new Date(), 30);

    const inA = await portalDischargedPastGraceForOrg(handle.db, ORG_A, [shared], cutoff);
    const inB = await portalDischargedPastGraceForOrg(handle.db, ORG_B, [shared], cutoff);
    expect(inA.has(shared)).toBe(true);
    expect(inB.size).toBe(0);

    await runPostDischargeGraceSweepOnce(deps([ORG_B]));
    expect((await grantRow(gB)).revoked_at).toBeNull();
  });

  it("bounds a large backlog: a capped tick revokes at most the budget and the rest drains next tick", async () => {
    const patients = Array.from({ length: 12 }, () => crypto.randomUUID());
    const grants: string[] = [];
    for (const p of patients) {
      grants.push(await seedGrant(ORG_C, p));
      await seedAdmission({
        orgId: ORG_C,
        patientId: p,
        status: "discharged",
        dischargedDaysAgo: 60,
      });
    }
    const small = { maxRevocationsPerOrgPerRun: 5, scanPageSize: 4 } as const;
    const revokedCount = async () =>
      (await Promise.all(grants.map(grantRow))).filter((g) => g.revoked_at !== null).length;

    let r = await runPostDischargeGraceSweepOnce(deps([ORG_C], small));
    expect(r[0]?.revokedPatients).toBe(5);
    expect(r[0]?.capped).toBe(true);
    expect(await revokedCount()).toBe(5);

    r = await runPostDischargeGraceSweepOnce(deps([ORG_C], small));
    expect(r[0]?.revokedPatients).toBe(5);
    expect(await revokedCount()).toBe(10);

    r = await runPostDischargeGraceSweepOnce(deps([ORG_C], small));
    expect(r[0]?.revokedPatients).toBe(2);
    expect(r[0]?.capped).toBe(false);
    expect(await revokedCount()).toBe(12);
  });

  it("one org's failure does not block the orgs after it, and the job still fails loudly", async () => {
    const p = crypto.randomUUID();
    const g = await seedGrant(ORG_B, p);
    await seedAdmission({
      orgId: ORG_B,
      patientId: p,
      status: "discharged",
      dischargedDaysAgo: 120,
    });
    const flaky: M31DischargeGracePort = {
      portalDischargedPastGraceForOrg: (organizationId, patientIds, cutoff) => {
        if (organizationId === ORG_A) return Promise.reject(new Error("boom"));
        return m6Port().portalDischargedPastGraceForOrg(organizationId, patientIds, cutoff);
      },
    };
    // ORG_A must have an active grant so the port is reached.
    await seedGrant(ORG_A, crypto.randomUUID());
    await expect(
      runPostDischargeGraceSweepOnce(deps([ORG_A, ORG_B], { m6: flaky })),
    ).rejects.toThrow(/1 of 2 org\(s\) failed/);
    expect((await grantRow(g)).revoked_at).not.toBeNull();
  });
});
