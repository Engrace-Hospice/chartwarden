/**
 * M19 EscalationRouter (ADR-0057 item 12), tier 1 only - LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Proves what the in-memory unit suite cannot: the real `on_call_shift` read, the real PatientReader / site reader / policy reads,
 * RLS isolation between two orgs, the repeated wall-clock hour of 2026-11-01 America/New_York read against ABSOLUTE shift instants,
 * back-to-back shifts, and that the router writes nothing.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m19:escalation-router:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1. Use a PRIVATE container, never the shared cluster.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { EscalationRouteAnswer, EscalationRouter } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildOrgProviderEntityLister } from "../src/bootstrap/provider-entity-resolver";
import { createDrizzlePatientReaderStore } from "../src/modules/05-patient/index";
import { createPatientReader } from "../src/modules/05-patient/seams/patient-reader";
import { createEscalationRouter } from "../src/modules/19-oncall/seams/escalation-router";
import { buildDrizzleEscalationRouterReads } from "../src/modules/19-oncall/seams/escalation-router-binding";
import { buildDrizzleOncallSeamStore } from "../src/modules/19-oncall/seams/store-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-4111-8111-1111e5ca1a19";
const ORG_B = "22222222-2222-4222-8222-2222e5ca1b19";
const NY = "America/New_York";

interface OrgSeed {
  userId: string;
  members: { primary: string; backup: string; other: string };
  users: { primary: string; backup: string; other: string };
  pe: string;
  patient: string;
}

describe.skipIf(!DB_URL)("M19 EscalationRouter tier 1 - LIVE Postgres as wardenx_app", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let router: EscalationRouter;
  const seeded: Record<string, OrgSeed> = {};
  // Org A only: a PE with no policy, a PE with two location zones, a patient with no PE (org A has several PEs).
  let peNoPolicy = "";
  let peTwoZones = "";
  const patients = { noPolicy: "", twoZones: "", noPe: "" };

  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  const one = async (sql: string, params: unknown[] = []) =>
    ((await admin.query(sql, params)).rows[0] as { id: string }).id;

  /** Run a router call in `org`'s ambient request scope, the way a production caller does. */
  const resolve = (
    org: string,
    callOrg: string,
    patientId: string,
    asOf: string,
    tier = 1,
  ): Promise<EscalationRouteAnswer> =>
    runWithRequestContext(
      { organizationId: org, userId: (seeded[org] as OrgSeed).userId } as never,
      () => router.resolveTier(callOrg, { patientId, requiredRole: "rn", tier, asOf }),
    );

  async function seedShift(
    org: string,
    start: string,
    end: string,
    primary: string,
    over: { backup?: string | null; status?: string; discipline?: string; pe?: string } = {},
  ) {
    const status = over.status ?? "active";
    const openedAt = status === "scheduled" || status === "cancelled" ? null : start;
    const closedAt = status === "completed" ? end : null;
    await admin.query(
      `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
         primary_on_call_membership_id, backup_membership_id, policy_snapshot, status, opened_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,$8::oncall_shift_status,$9,$10)`,
      [
        org,
        over.pe ?? (seeded[org] as OrgSeed).pe,
        start,
        end,
        over.discipline ?? "clinical_rn",
        primary,
        over.backup ?? null,
        status,
        openedAt,
        closedAt,
      ],
    );
  }

  async function seedOrg(org: string, tag: string): Promise<OrgSeed> {
    const mkUser = async (n: string) =>
      one(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [`${tag}-${n}@x.test`]);
    const mkMember = async (userId: string) =>
      one(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, org],
      );
    const users = {
      primary: await mkUser("p"),
      backup: await mkUser("b"),
      other: await mkUser("o"),
    };
    const members = {
      primary: await mkMember(users.primary),
      backup: await mkMember(users.backup),
      other: await mkMember(users.other),
    };
    const mkPe = async (n: string) =>
      one(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-${tag}-${n}`, `PE ${tag} ${n}`, `NPI-${tag}-${n}`],
      );
    const mkLocation = (pe: string, name: string, tz: string) =>
      admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','NY','10001',$3)`,
        [pe, name, tz],
      );
    const mkPolicy = (pe: string) =>
      admin.query(
        `INSERT INTO tenant_oncall_policy (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
         VALUES ($1,$2,'direct','{}'::jsonb,'{}'::jsonb)`,
        [org, pe],
      );
    const mkPatient = (pe: string | null, n: string) =>
      one(
        `INSERT INTO patient (organization_id, provider_entity_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,'Es','Cal','1990-01-01','M','active') RETURNING id`,
        [org, pe, `MRN-${tag}-${n}`],
      );
    const pe = await mkPe("main");
    await mkLocation(pe, "NY", NY);
    await mkPolicy(pe);
    const patient = await mkPatient(pe, "main");
    if (org === ORG_A) {
      peNoPolicy = await mkPe("nopolicy");
      await mkLocation(peNoPolicy, "NY", NY);
      peTwoZones = await mkPe("twozones");
      await mkLocation(peTwoZones, "NY", NY);
      await mkLocation(peTwoZones, "LA", "America/Los_Angeles");
      await mkPolicy(peTwoZones);
      patients.noPolicy = await mkPatient(peNoPolicy, "nopolicy");
      patients.twoZones = await mkPatient(peTwoZones, "twozones");
      patients.noPe = await mkPatient(null, "nope");
    }
    return { userId: users.primary, members, users, pe, patient };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'m19er-a','A','A','active'),($2,'m19er-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    seeded[ORG_A] = await seedOrg(ORG_A, "m19era");
    seeded[ORG_B] = await seedOrg(ORG_B, "m19erb");

    // The suite proves tenancy only if it really is the NOBYPASSRLS role (the helper asserts it).
    const url = await appRoleConnectionString(admin, DB_URL as string);
    void LIVE_APP_ROLE_PASSWORD;
    handle = createDbClient({ connectionString: url });
    router = createEscalationRouter(
      buildDrizzleOncallSeamStore(handle.db),
      buildDrizzleEscalationRouterReads({
        db: handle.db,
        patientReader: () => createPatientReader(createDrizzlePatientReaderStore(handle.db)),
        siteReader: buildFoundationSiteReader(),
        listProviderEntityIds: buildOrgProviderEntityLister(handle.db),
      }),
    );
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("reads the real covering shift: primary then backup user ids, the location zone, source m19", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    await seedShift(ORG_A, "2026-06-01T07:00:00Z", "2026-06-01T19:00:00Z", a.members.primary, {
      backup: a.members.backup,
    });
    const answer = await resolve(ORG_A, ORG_A, a.patient, "2026-06-01T12:00:00Z");
    expect(answer).toMatchObject({
      kind: "resolved",
      userIds: [a.users.primary, a.users.backup],
      ranks: ["primary", "backup"],
      nextTier: null,
      timeZone: NY,
      source: "m19",
    });
    // The same instant spelled with an offset is the same answer.
    expect(await resolve(ORG_A, ORG_A, a.patient, "2026-06-01T08:00:00-04:00")).toMatchObject({
      kind: "resolved",
      userIds: [a.users.primary, a.users.backup],
    });
  });

  it("ranks from the shift seats over the real tables: overlapping shifts keep each person's own rank, primary wins", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    await seedShift(ORG_A, "2027-03-01T07:00:00Z", "2027-03-01T19:00:00Z", a.members.primary, {
      backup: a.members.backup,
    });
    await seedShift(ORG_A, "2027-03-01T10:00:00Z", "2027-03-01T22:00:00Z", a.members.other, {
      backup: a.members.primary,
    });
    // primary(s1)+backup(s1)+other(s2 primary); `primary` is also s2's backup but stays primary
    expect(await resolve(ORG_A, ORG_A, a.patient, "2027-03-01T12:00:00Z")).toMatchObject({
      kind: "resolved",
      userIds: [a.users.primary, a.users.backup, a.users.other],
      ranks: ["primary", "backup", "primary"],
    });
  });

  it("answers tier 2 with tier_not_configured and an offset-less asOf by throwing", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    expect(await resolve(ORG_A, ORG_A, a.patient, "2026-06-01T12:00:00Z", 2)).toMatchObject({
      kind: "unavailable",
      reason: "tier_not_configured",
    });
    await expect(resolve(ORG_A, ORG_A, a.patient, "2026-06-01T12:00:00")).rejects.toThrow();
  });

  it("ignores completed, cancelled and other-discipline shifts (a gap, not a stale answer)", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    await seedShift(ORG_A, "2026-07-01T07:00:00Z", "2026-07-01T19:00:00Z", a.members.other, {
      status: "completed",
    });
    await seedShift(ORG_A, "2026-07-01T07:00:00Z", "2026-07-01T19:00:00Z", a.members.other, {
      status: "cancelled",
    });
    await seedShift(ORG_A, "2026-07-01T07:00:00Z", "2026-07-01T19:00:00Z", a.members.other, {
      discipline: "msw",
    });
    expect(await resolve(ORG_A, ORG_A, a.patient, "2026-07-01T12:00:00Z")).toMatchObject({
      kind: "coverage_gap",
      timeZone: NY,
    });
  });

  it("back-to-back shifts: start inclusive, end exclusive, no gap and no overlap", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    await seedShift(ORG_A, "2026-08-01T07:00:00Z", "2026-08-01T19:00:00Z", a.members.primary);
    await seedShift(ORG_A, "2026-08-01T19:00:00Z", "2026-08-02T07:00:00Z", a.members.other, {
      status: "scheduled",
    });
    const at = (iso: string) => resolve(ORG_A, ORG_A, a.patient, iso);
    expect(await at("2026-08-01T18:59:59Z")).toMatchObject({ userIds: [a.users.primary] });
    expect(await at("2026-08-01T19:00:00Z")).toMatchObject({ userIds: [a.users.other] });
    expect(await at("2026-08-02T07:00:00Z")).toMatchObject({ kind: "coverage_gap" });
  });

  it("2026-11-01 America/New_York: absolute-instant shifts across the repeated 01:30 hour", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    // 20:00 EDT Oct 31 -> 02:00 EDT (= 01:00 EST wall clock, 06:00Z), then 06:00Z -> 12:00Z.
    await seedShift(ORG_A, "2026-11-01T00:00:00Z", "2026-11-01T06:00:00Z", a.members.primary);
    await seedShift(ORG_A, "2026-11-01T06:00:00Z", "2026-11-01T12:00:00Z", a.members.other);
    const at = (iso: string) => resolve(ORG_A, ORG_A, a.patient, iso);
    // 01:30 EDT and 01:30 EST are the same wall clock and different instants: different shifts, deterministically.
    expect(await at("2026-11-01T01:30:00-04:00")).toMatchObject({
      userIds: [a.users.primary],
      timeZone: NY,
    });
    expect(await at("2026-11-01T01:30:00-05:00")).toMatchObject({
      userIds: [a.users.other],
      timeZone: NY,
    });
    expect(await at("2026-11-01T05:59:59Z")).toMatchObject({ userIds: [a.users.primary] });
    expect(await at("2026-11-01T06:00:00Z")).toMatchObject({ userIds: [a.users.other] });
  });

  it("fails closed without a policy, with two location zones, or with a patient who has no unambiguous provider entity", async () => {
    for (const patientId of [patients.noPolicy, patients.twoZones, patients.noPe]) {
      expect(await resolve(ORG_A, ORG_A, patientId, "2026-06-01T12:00:00Z")).toMatchObject({
        kind: "unavailable",
        reason: "no_route_configured",
      });
    }
  });

  it("a departed (revoked or suspended) user's future shift yields no recipient", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    await seedShift(ORG_A, "2027-01-01T07:00:00Z", "2027-01-01T19:00:00Z", a.members.primary, {
      backup: a.members.backup,
    });
    const at = () => resolve(ORG_A, ORG_A, a.patient, "2027-01-01T12:00:00Z");
    expect(await at()).toMatchObject({
      userIds: [a.users.primary, a.users.backup],
      ranks: ["primary", "backup"],
    });
    await admin.query("UPDATE membership SET status = 'suspended' WHERE id = $1", [
      a.members.primary,
    ]);
    // The primary seat no longer resolves: the backup stays a backup (nobody is promoted).
    expect(await at()).toMatchObject({
      kind: "resolved",
      userIds: [a.users.backup],
      ranks: ["backup"],
    });
    await admin.query("UPDATE membership SET status = 'active', revoked_at = now() WHERE id = $1", [
      a.members.backup,
    ]);
    await admin.query(
      "UPDATE membership SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [a.members.primary],
    );
    expect(await at()).toMatchObject({ kind: "coverage_gap" });
    await admin.query(
      "UPDATE membership SET status = 'active', revoked_at = NULL WHERE id = ANY($1)",
      [[a.members.primary, a.members.backup]],
    );
  });

  it("tenant isolation as wardenx_app: org B cannot reach org A's patients or shifts, and a foreign org id is refused", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    const b = seeded[ORG_B] as OrgSeed;
    // Org A's patient asked from org B's scope: identical to an unknown patient.
    expect(await resolve(ORG_B, ORG_B, a.patient, "2026-06-01T12:00:00Z")).toMatchObject({
      kind: "unavailable",
      reason: "no_route_configured",
    });
    // Org B's own patient while only org A has shifts: a real gap, never org A's people.
    expect(await resolve(ORG_B, ORG_B, b.patient, "2026-06-01T12:00:00Z")).toMatchObject({
      kind: "coverage_gap",
    });
    // Org A named as the caller while org B's scope is ambient: refused outright.
    await expect(resolve(ORG_B, ORG_A, a.patient, "2026-06-01T12:00:00Z")).rejects.toMatchObject({
      code: "TRIAGE_SEAM_ORG_MISMATCH",
    });
    // No ambient scope at all: refused, never an unscoped read.
    await expect(
      router.resolveTier(ORG_A, {
        patientId: a.patient,
        requiredRole: "rn",
        tier: 1,
        asOf: "2026-06-01T12:00:00Z",
      }),
    ).rejects.toThrow();
  });

  it("is a pure read: no shift, outbox or audit row is written", async () => {
    const a = seeded[ORG_A] as OrgSeed;
    const count = async () =>
      (
        await q<{ s: string; o: string }>(
          "SELECT (SELECT count(*) FROM on_call_shift)::text s, (SELECT count(*) FROM outbox_event)::text o",
        )
      )[0];
    const before = await count();
    await resolve(ORG_A, ORG_A, a.patient, "2026-06-01T12:00:00Z");
    await resolve(ORG_A, ORG_A, a.patient, "2026-06-01T12:00:00Z", 2);
    expect(await count()).toEqual(before);
  });
});
