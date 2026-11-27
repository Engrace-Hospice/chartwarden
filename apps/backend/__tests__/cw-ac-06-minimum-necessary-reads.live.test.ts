/**
 * CW-AC-06 — minimum-necessary list and audit reads, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Two reads the register row names, proven over the real HTTP routes, the real Drizzle services and the real
 * RLS policies. Authentication (user, org, roles, from `x-test-*` headers) and the permission grants are stubbed,
 * as in every route-level live suite, so the session-to-org binding is proven elsewhere; the M5 caseload seam is
 * the real Drizzle store over `patient_assignment`:
 *
 *   1. `GET /api/v1/admissions` (the census) returns a COMPUTED whole-year age — never a date of birth — and only
 *      for patients the caller may see: the caller's own org (RLS alone holds when the SQL predicate names the
 *      other org), and, for a non-org-wide role, the open caseload. Wrong permission, no org context and
 *      another tenant's session read nothing. The read lands its `admission.list_viewed` audit row (count, no
 *      DOB, no age); a census narrowed to one patient is also accounted against that patient.
 *   2. `GET /api/v1/audit/events` resolves `actorName` ONLY through a membership in the caller's org: an actor
 *      who belongs to the other tenant, to no tenant, or who is the system is never named. A caller without
 *      `audit.read` is refused, another tenant's events and ids are invisible in both directions, and an
 *      elevated (platform-role) read leaves the `audit.elevated_access` meta-event while a routine one does not.
 *
 * The census is mounted with the catalog-validating M6 outbox (never NOOP_OUTBOX); neither read emits an outbox
 * event, so the publisher is exercised only as wiring.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:ac-06:minimum-necessary-reads:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { mountAuditRoutes } from "../src/modules/04-audit/index";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  patientAdmissionIdentitiesInTx,
  patientAgeYearsInTx,
} from "../src/modules/05-patient/patient-admission-identity";
import { createDrizzleCaseloadStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { mountAdmissionRoutes } from "../src/modules/06-admission/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_A = "11111111-1111-4111-8111-1111111ac060";
const ORG_B = "22222222-2222-4222-8222-2222222ac060";

// Synthetic staff, actors and patients only (no real identifiers).
const U_ORG_WIDE_A = "a0000000-0000-4000-8000-0000000ac061"; // compliance officer: org-wide scope, both grants
const U_RN_A = "a0000000-0000-4000-8000-0000000ac062"; // RN with one patient on the open caseload
const U_RN_EMPTY_A = "a0000000-0000-4000-8000-0000000ac063"; // RN with nobody on the caseload
const U_NO_GRANT_A = "a0000000-0000-4000-8000-0000000ac064"; // org-wide role but no permission grant
const U_PLATFORM_A = "a0000000-0000-4000-8000-0000000ac065"; // platform role holding audit.read
const U_ORG_WIDE_B = "a0000000-0000-4000-8000-0000000ac066";

const ACT_A_ONLY = "b0000000-0000-4000-8000-0000000ac061"; // named user, member of A only
const ACT_A_USERNAME = "b0000000-0000-4000-8000-0000000ac062"; // no display name, only a username; member of A
const ACT_BOTH = "b0000000-0000-4000-8000-0000000ac063"; // named user, member of A and B
const ACT_B_ONLY = "b0000000-0000-4000-8000-0000000ac064"; // named user, member of B only
const ACT_NO_MEMBER = "b0000000-0000-4000-8000-0000000ac065"; // named user, member of nothing
const ACT_NAMELESS = "b0000000-0000-4000-8000-0000000ac066"; // member of A with neither a name nor a username

const PROBE_KIND = "ac06_probe";
const PROBE_EVENT = "ac06.probe.touched";
const CENSUS_EVENT = "admission.list_viewed";
const ELEVATED_EVENT = "audit.elevated_access";

/** The whole-year ages the seeded dates of birth encode. */
const AGE_A1 = 83; // the birthday passed 100 days ago
const AGE_A2 = 71; // the 72nd birthday is a week away: still 71, never rounded up
const AGE_B1 = 58; // the birthday passed 30 days ago

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

describe.skipIf(!DB_URL)(
  "CW-AC-06 minimum-necessary list and audit reads — LIVE Postgres, NOBYPASSRLS app role",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const patientOf: Record<string, string> = {};
    const dobOf: Record<string, string> = {};
    const eventOf: Record<string, string> = {};

    async function user(id: string, name: string | null, displayUsername: string | null = null) {
      await admin.query(
        `INSERT INTO "user" (id, email, name, display_username, status) VALUES ($1,$2,$3,$4,'active')`,
        [id, `${id}@ac06.test`, name, displayUsername],
      );
    }
    async function member(userId: string, org: string) {
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [userId, org],
      );
    }
    async function patient(key: string, org: string, dobSql: string) {
      const { rows } = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,'Census',${dobSql},'F','active') RETURNING id, to_char(dob,'YYYY-MM-DD') AS dob`,
        [org, `MRN-AC06-${key}`, `Pat${key}`],
      );
      patientOf[key] = rows[0].id as string;
      dobOf[key] = rows[0].dob as string;
    }
    async function admission(key: string, org: string, pe: string, loc: string) {
      await admin.query(
        `INSERT INTO admission (organization_id, provider_entity_id, location_id, patient_id,
           admitted_by_physician_id, status, admission_at, activated_at)
         VALUES ($1,$2,$3,$4,gen_random_uuid(),'active', now() - interval '1 day', now() - interval '1 day')`,
        [org, pe, loc, patientOf[key]],
      );
    }
    async function probeEvent(key: string, org: string, actor: string | null) {
      const { rows } = await admin.query(
        `INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind,
           resource_id, outcome, severity, context, correlation_id, retention_class)
         VALUES ($1,$2,$3,$4,$5,gen_random_uuid(),'success','info','{}'::jsonb,$6,'operational')
         RETURNING id`,
        [org, actor, actor ? "user" : "system", PROBE_EVENT, PROBE_KIND, `corr-ac06-${key}`],
      );
      eventOf[key] = rows[0].id as string;
    }
    async function orgFixtures(org: string, n: number) {
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-AC06${n}`, `AC06 ${n}`, `NPI-AC06${n}`],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe, `Loc AC06 ${n}`],
        )
      ).rows[0].id as string;
      return { pe, loc };
    }

    type Opts = { org?: string | null; roles?: readonly string[] };
    /** One GET as `asUser` (null: no session at all). `org: null` is a session with no organization context. */
    const get = (url: string, asUser: string | null, opts: Opts = {}) => {
      const headers: Record<string, string> = {};
      if (asUser) headers["x-test-user"] = asUser;
      if (opts.org !== null) headers["x-test-org"] = opts.org ?? ORG_A;
      if (opts.roles) headers["x-test-roles"] = opts.roles.join(",");
      return app.inject({ method: "GET", url, headers });
    };
    const census = (asUser: string | null, opts: Opts = {}) =>
      get("/api/v1/admissions", asUser, opts);
    const auditSearch = (asUser: string | null, opts: Opts & { query?: string } = {}) =>
      get(
        `/api/v1/audit/events?resourceKind=${PROBE_KIND}${opts.query ? `&${opts.query}` : ""}`,
        asUser,
        opts,
      );

    type CensusItem = {
      patientId?: string | null;
      patient: { id: string; firstName: string; lastName: string; mrn: string } | null;
      patientAgeYears?: number | null;
    };
    type AuditItem = {
      id: string;
      organizationId: string | null;
      actorUserId: string | null;
      actorName?: string | null;
    };

    /** Audit rows of one event type in one org, as the superuser sees them (the proof the row landed). */
    async function auditRows(org: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT actor_user_id::text AS actor, resource_kind, outcome, severity, context
           FROM audit_event WHERE organization_id = $1 AND event_type = $2 ORDER BY created_at`,
        [org, eventType],
      );
      return rows as Array<{
        actor: string | null;
        resource_kind: string;
        outcome: string;
        severity: string;
        context: Record<string, unknown>;
      }>;
    }

    const orgWide = { roles: ["compliance_officer"] } as const;

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'ac06-a','A','A'),($2,'ac06-b','B','B')",
        [ORG_A, ORG_B],
      );
      const a = await orgFixtures(ORG_A, 1);
      const b = await orgFixtures(ORG_B, 2);

      for (const [id, name] of [
        [U_ORG_WIDE_A, "Olga Orgwide"],
        [U_RN_A, "Rae Nurse"],
        [U_RN_EMPTY_A, "Ned Nocase"],
        [U_NO_GRANT_A, "Gus Nogrant"],
        [U_PLATFORM_A, "Pia Platform"],
        [U_ORG_WIDE_B, "Bree Orgwide"],
      ] as const)
        await user(id, name);
      await user(ACT_A_ONLY, "Ada Actor");
      await user(ACT_A_USERNAME, null, "actor-two");
      await user(ACT_BOTH, "Bo Both");
      await user(ACT_B_ONLY, "Bea Otherorg");
      await user(ACT_NO_MEMBER, "Nia Nomember");
      await user(ACT_NAMELESS, null);
      for (const u of [
        U_ORG_WIDE_A,
        U_RN_A,
        U_RN_EMPTY_A,
        U_NO_GRANT_A,
        U_PLATFORM_A,
        ACT_A_ONLY,
        ACT_A_USERNAME,
        ACT_BOTH,
        ACT_NAMELESS,
      ])
        await member(u, ORG_A);
      for (const u of [U_ORG_WIDE_B, ACT_BOTH, ACT_B_ONLY]) await member(u, ORG_B);

      // Dates of birth relative to the database clock, so the whole-year ages hold on any day the suite runs.
      // The 72-year step lands the leap-day case on a leap year.
      await patient(
        "A1",
        ORG_A,
        `(current_date - interval '${AGE_A1} years' - interval '100 days')::date`,
      );
      await patient("A2", ORG_A, `(current_date + 7 - interval '${AGE_A2 + 1} years')::date`);
      await patient(
        "B1",
        ORG_B,
        `(current_date - interval '${AGE_B1} years' - interval '30 days')::date`,
      );
      await admission("A1", ORG_A, a.pe, a.loc);
      await admission("A2", ORG_A, a.pe, a.loc);
      await admission("B1", ORG_B, b.pe, b.loc);

      // The RN's caseload: A1 is an open assignment, A2 an ended one (it must not widen the caseload).
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
        [patientOf.A1, ORG_A, U_RN_A],
      );
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at, unassigned_at)
         VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE - 30, CURRENT_DATE - 1)`,
        [patientOf.A2, ORG_A, U_RN_A],
      );

      // Audit probes. Tenant A's log carries events whose actor is a member of A, of both, of B only, of nothing,
      // and no actor at all; tenant B's log carries one of an A-only actor, one of a shared actor, one of its own.
      await probeEvent("a-member", ORG_A, ACT_A_ONLY);
      await probeEvent("a-username", ORG_A, ACT_A_USERNAME);
      await probeEvent("a-both", ORG_A, ACT_BOTH);
      await probeEvent("a-other-tenant-actor", ORG_A, ACT_B_ONLY);
      await probeEvent("a-no-member-actor", ORG_A, ACT_NO_MEMBER);
      await probeEvent("a-system", ORG_A, null);
      await probeEvent("a-nameless", ORG_A, ACT_NAMELESS);
      await probeEvent("b-a-only-actor", ORG_B, ACT_A_ONLY);
      await probeEvent("b-both", ORG_B, ACT_BOTH);
      await probeEvent("b-member", ORG_B, ACT_B_ONLY);

      // Throws unless the url really logs in as NOBYPASSRLS `chartwarden_app` (a superuser would make every
      // cross-tenant assertion below vacuous).
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });

      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      registerAbacRegistry();
      const grant = (orgId: string, userId: string, permissionKeys: string[]) => ({
        orgId,
        userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      });
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          grant(ORG_A, U_ORG_WIDE_A, ["admission.read", "audit.read"]),
          grant(ORG_A, U_RN_A, ["admission.read"]),
          grant(ORG_A, U_RN_EMPTY_A, ["admission.read"]),
          grant(ORG_A, U_NO_GRANT_A, []),
          grant(ORG_A, U_PLATFORM_A, ["audit.read"]),
          grant(ORG_B, U_ORG_WIDE_B, ["admission.read", "audit.read"]),
        ]).store,
      );
      // The REAL M5 CaseloadProvider over `patient_assignment`: the census narrows non-org-wide roles to it.
      registerPatientSeams({
        db: handle.db,
        caseload: { store: createDrizzleCaseloadStore(handle.db) },
      });
      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountAdmissionRoutes(app, handle.db, validatingM6Outbox());
      mountAuditRoutes(app, handle.db);
      await app.ready();
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(async () => {
      await admin.query("DELETE FROM audit_event WHERE event_type IN ($1,$2)", [
        CENSUS_EVENT,
        ELEVATED_EVENT,
      ]);
    });

    it("runs as the NOBYPASSRLS app role, and the other tenant's rows exist for a role that bypasses RLS", async () => {
      const who = (await handle.db.execute(
        sql`SELECT current_user AS who, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
      )) as unknown as { rows: Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }> };
      expect(who.rows[0]).toEqual({ who: "chartwarden_app", rolsuper: false, rolbypassrls: false });
      // Without RLS the other tenant's patient is there: the isolation below is the policy's doing.
      const seen = await admin.query("SELECT organization_id FROM patient WHERE id = $1", [
        patientOf.B1,
      ]);
      expect(seen.rows[0].organization_id).toBe(ORG_B);
    });

    describe("admission census — computed age, never a date of birth", () => {
      it("ALLOW: an org-wide role with admission.read lists its own org's census with whole-year ages", async () => {
        const res = await census(U_ORG_WIDE_A, orgWide);
        expect(res.statusCode).toBe(200);
        const items = res.json().items as CensusItem[];
        const byPatient = new Map(items.map((i) => [i.patientId, i]));
        expect([...byPatient.keys()].sort()).toEqual([patientOf.A1, patientOf.A2].sort());
        expect(byPatient.get(patientOf.A1)?.patientAgeYears).toBe(AGE_A1);
        expect(byPatient.get(patientOf.A2)?.patientAgeYears).toBe(AGE_A2);
        expect(byPatient.get(patientOf.A1)?.patient).toEqual({
          id: patientOf.A1,
          firstName: "PatA1",
          lastName: "Census",
          mrn: "MRN-AC06-A1",
        });
      });

      it("MINIMUM-NECESSARY: no date of birth leaves the census, as a key or as a value", async () => {
        const res = await census(U_ORG_WIDE_A, orgWide);
        expect(res.statusCode).toBe(200);
        for (const key of ["A1", "A2", "B1"]) expect(res.body).not.toContain(dobOf[key] as string);
        const keys: string[] = [];
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) {
            for (const element of node) walk(element);
            return;
          }
          if (node && typeof node === "object")
            for (const [k, v] of Object.entries(node)) {
              keys.push(k);
              walk(v);
            }
        };
        walk(res.json());
        expect(keys.filter((k) => /dob|birth/i.test(k))).toEqual([]);
        expect(keys).toContain("patientAgeYears");
      });

      it("CASELOAD: a non-org-wide role sees only its open caseload, with that patient's age", async () => {
        const res = await census(U_RN_A, { roles: ["rn"] });
        expect(res.statusCode).toBe(200);
        const items = res.json().items as CensusItem[];
        // A2's assignment ended: the patient and the age stay out.
        expect(items.map((i) => i.patientId)).toEqual([patientOf.A1]);
        expect(items[0]?.patientAgeYears).toBe(AGE_A1);
        expect(res.body).not.toContain(patientOf.A2 as string);
      });

      it("CASELOAD: a non-org-wide role with nobody on its caseload reads an empty census", async () => {
        const res = await census(U_RN_EMPTY_A, { roles: ["rn"] });
        expect(res.statusCode).toBe(200);
        expect(res.json().items).toEqual([]);
      });

      it("DENY wrong role: an org-wide role without the admission.read grant is 403 and reads nothing", async () => {
        const res = await census(U_NO_GRANT_A, orgWide);
        expect(res.statusCode).toBe(403);
        expect(await auditRows(ORG_A, CENSUS_EVENT)).toHaveLength(0);
      });

      it("DENY missing attribute: no organization context and no session at all are 401 and read nothing", async () => {
        const noOrg = await census(U_ORG_WIDE_A, { org: null, ...orgWide });
        const noSession = await census(null);
        expect(noOrg.statusCode).toBe(401);
        expect(noSession.statusCode).toBe(401);
        expect(await auditRows(ORG_A, CENSUS_EVENT)).toHaveLength(0);
        expect(await auditRows(ORG_B, CENSUS_EVENT)).toHaveLength(0);
      });

      it("DENY wrong tenant: a grant held in one org does not carry to another (the per-org grant store; the ISOLATION cases carry the tenant proof)", async () => {
        const res = await census(U_ORG_WIDE_A, { org: ORG_B, ...orgWide });
        expect(res.statusCode).toBe(403);
        for (const org of [ORG_A, ORG_B])
          expect(await auditRows(org, CENSUS_EVENT)).toHaveLength(0);
      });

      it("ISOLATION: each tenant's census holds only its own patients, in both directions", async () => {
        const fromB = await census(U_ORG_WIDE_B, { org: ORG_B, ...orgWide });
        expect(fromB.statusCode).toBe(200);
        const itemsB = fromB.json().items as CensusItem[];
        expect(itemsB.map((i) => i.patientId)).toEqual([patientOf.B1]);
        expect(itemsB[0]?.patientAgeYears).toBe(AGE_B1);
        for (const key of ["A1", "A2"]) expect(fromB.body).not.toContain(patientOf[key] as string);

        const fromA = await census(U_ORG_WIDE_A, orgWide);
        expect(fromA.body).not.toContain(patientOf.B1 as string);
      });

      it("PREDICATE AND RLS: the age and identity reads return nothing across tenants; with the predicate naming the other org, the policy alone empties the result, and with the right org, the predicate alone does", async () => {
        const ids = [patientOf.A1, patientOf.A2, patientOf.B1] as string[];
        const ages = (txOrg: string, literalOrg: string) =>
          withOrgContext(handle.db, { organizationId: txOrg, userId: "" }, (tx) =>
            patientAgeYearsInTx(tx, literalOrg, ids),
          );
        const identities = (txOrg: string, literalOrg: string) =>
          withOrgContext(handle.db, { organizationId: txOrg, userId: "" }, (tx) =>
            patientAdmissionIdentitiesInTx(tx, literalOrg, ids),
          );

        expect(Object.fromEntries(await ages(ORG_A, ORG_A))).toEqual({
          [patientOf.A1 as string]: AGE_A1,
          [patientOf.A2 as string]: AGE_A2,
        });
        expect(Object.fromEntries(await ages(ORG_B, ORG_B))).toEqual({
          [patientOf.B1 as string]: AGE_B1,
        });
        // The SQL predicate names one org, the transaction is the other's: the policy alone empties the result.
        expect((await ages(ORG_A, ORG_B)).size).toBe(0);
        expect((await ages(ORG_B, ORG_A)).size).toBe(0);
        expect([...(await identities(ORG_A, ORG_A)).keys()].sort()).toEqual(
          [patientOf.A1, patientOf.A2].sort(),
        );
        expect((await identities(ORG_A, ORG_B)).size).toBe(0);
        expect((await identities(ORG_B, ORG_A)).size).toBe(0);
      });

      it("AUDIT: the census read lands one admission.list_viewed row in the caller's org, with the count and no DOB or age", async () => {
        const res = await census(U_ORG_WIDE_A, orgWide);
        expect(res.statusCode).toBe(200);

        const rows = await auditRows(ORG_A, CENSUS_EVENT);
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.actor).toBe(U_ORG_WIDE_A);
        expect(row?.resource_kind).toBe("admission");
        expect(row?.outcome).toBe("success");
        expect(row?.context.count).toBe(2);
        // The unfiltered census names no single patient: the row is a count, not an attribution.
        expect(row?.context.patientId).toBeUndefined();
        const serialized = JSON.stringify(row?.context);
        for (const key of ["A1", "A2"]) expect(serialized).not.toContain(dobOf[key] as string);
        expect(serialized).not.toMatch(/dob|birth|ageYears/i);
        // The read is accounted in the caller's tenant only…
        expect(await auditRows(ORG_B, CENSUS_EVENT)).toHaveLength(0);

        // …and the other tenant's own read lands in its own log, never in A's.
        const fromB = await census(U_ORG_WIDE_B, { org: ORG_B, ...orgWide });
        expect(fromB.statusCode).toBe(200);
        expect(await auditRows(ORG_B, CENSUS_EVENT)).toHaveLength(1);
        expect(await auditRows(ORG_A, CENSUS_EVENT)).toHaveLength(1);
      });

      it("AUDIT: a census narrowed to one patient discloses that patient, so the read is accounted against them (who-touched-this-chart)", async () => {
        const res = await get(
          `/api/v1/admissions?patientId=${patientOf.A1}`,
          U_ORG_WIDE_A,
          orgWide,
        );
        expect(res.statusCode).toBe(200);
        expect((res.json().items as CensusItem[]).map((i) => i.patientId)).toEqual([patientOf.A1]);

        const rows = await auditRows(ORG_A, CENSUS_EVENT);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.context.patientId).toBe(patientOf.A1);
        expect(rows[0]?.context.count).toBe(1);

        // The per-patient access history (the accounting join on context.patientId) lists the census view…
        const access = await get(`/api/v1/audit/patients/${patientOf.A1}/access`, U_ORG_WIDE_A);
        expect(access.statusCode).toBe(200);
        const seen = (
          access.json().items as Array<{ eventType: string; actorUserId: string | null }>
        ).filter((e) => e.eventType === CENSUS_EVENT);
        expect(seen).toEqual([expect.objectContaining({ actorUserId: U_ORG_WIDE_A })]);
        // …and the other patient's history shows nothing of it.
        const other = await get(`/api/v1/audit/patients/${patientOf.A2}/access`, U_ORG_WIDE_A);
        expect(
          (other.json().items as Array<{ eventType: string }>).filter(
            (e) => e.eventType === CENSUS_EVENT,
          ),
        ).toEqual([]);
      });

      it("AUDIT: the patient id is accounted in one spelling, so a capitalised ?patientId= cannot hide the read from the patient's history", async () => {
        const res = await get(
          `/api/v1/admissions?patientId=${(patientOf.A1 as string).toUpperCase()}`,
          U_ORG_WIDE_A,
          orgWide,
        );
        expect(res.statusCode).toBe(200);
        expect((res.json().items as CensusItem[]).map((i) => i.patientId)).toEqual([patientOf.A1]);

        const rows = await auditRows(ORG_A, CENSUS_EVENT);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.context.patientId).toBe(patientOf.A1);
        const access = await get(`/api/v1/audit/patients/${patientOf.A1}/access`, U_ORG_WIDE_A);
        expect(
          (access.json().items as Array<{ eventType: string }>).filter(
            (e) => e.eventType === CENSUS_EVENT,
          ),
        ).toHaveLength(1);
      });

      it("CASELOAD: a non-org-wide role asking for a patient outside its caseload gets an empty census, whatever the filter", async () => {
        const res = await get(`/api/v1/admissions?patientId=${patientOf.A2}`, U_RN_A, {
          roles: ["rn"],
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().items).toEqual([]);
      });
    });

    describe("audit search — actorName resolves only inside the caller's org", () => {
      const nameOf = (items: AuditItem[], key: string) =>
        items.find((i) => i.id === eventOf[key])?.actorName;
      const idsWithPrefix = (prefix: string) =>
        Object.entries(eventOf)
          .filter(([key]) => key.startsWith(prefix))
          .map(([, id]) => id)
          .sort();

      it("ALLOW: audit.read lists the org's events, naming each actor with a membership in that org", async () => {
        const res = await auditSearch(U_ORG_WIDE_A);
        expect(res.statusCode).toBe(200);
        const items = res.json().items as AuditItem[];
        expect(items.map((i) => i.id).sort()).toEqual(idsWithPrefix("a-"));
        expect(nameOf(items, "a-member")).toBe("Ada Actor");
        // No display name on file: the username stands in, never the email.
        expect(nameOf(items, "a-username")).toBe("actor-two");
        expect(nameOf(items, "a-both")).toBe("Bo Both");
        expect(res.body).not.toContain("@ac06.test");
      });

      it("MINIMUM-NECESSARY: an actor of another tenant, of no tenant, or the system is never named", async () => {
        const res = await auditSearch(U_ORG_WIDE_A);
        const items = res.json().items as AuditItem[];
        expect(nameOf(items, "a-other-tenant-actor")).toBeNull();
        expect(nameOf(items, "a-no-member-actor")).toBeNull();
        expect(nameOf(items, "a-system")).toBeNull();
        // A member with neither a name nor a username has nothing to show: no name, and never the email in its place.
        expect(nameOf(items, "a-nameless")).toBeNull();
        // The row is still listed (the id is the org's own fact); only the name is withheld.
        expect(items.find((i) => i.id === eventOf["a-other-tenant-actor"])?.actorUserId).toBe(
          ACT_B_ONLY,
        );
        for (const leaked of ["Bea Otherorg", "Nia Nomember"])
          expect(res.body).not.toContain(leaked);
      });

      it("MINIMUM-NECESSARY: a patient write's before/after image never returns the date of birth, in the list or by id", async () => {
        // The patient write-audit trigger's raw image holds the date of birth at rest: it is there to be hidden.
        const raw = await admin.query(
          `SELECT id::text AS id, after->>'dob' AS dob, after->>'mrn' AS mrn FROM audit_event
            WHERE organization_id = $1 AND resource_kind = 'patient' AND event_type = 'patient.insert' AND resource_id = $2`,
          [ORG_A, patientOf.A1],
        );
        expect(raw.rows).toHaveLength(1);
        expect(raw.rows[0].dob).toBe(dobOf.A1);
        // The gap on the register row: the MRN is in the image at rest too, and the denylist does not censor it.
        expect(raw.rows[0].mrn).toBe("MRN-AC06-A1");

        const list = await get(
          "/api/v1/audit/events?resourceKind=patient&eventType=patient.insert",
          U_ORG_WIDE_A,
        );
        expect(list.statusCode).toBe(200);
        const items = list.json().items as Array<{
          id: string;
          after: Record<string, unknown> | null;
        }>;
        expect(items.map((i) => i.id)).toContain(raw.rows[0].id);
        for (const key of ["A1", "A2"]) expect(list.body).not.toContain(dobOf[key] as string);
        expect(items.find((i) => i.id === raw.rows[0].id)?.after?.dob).toBe("[REDACTED]");

        const detail = await get(`/api/v1/audit/events/${raw.rows[0].id}`, U_ORG_WIDE_A);
        expect(detail.statusCode).toBe(200);
        expect(detail.body).not.toContain(dobOf.A1 as string);
        expect(detail.json().after.dob).toBe("[REDACTED]");

        // An update carries the image on BOTH sides (the trigger writes the old and the new row).
        await admin.query("UPDATE patient SET updated_at = now() WHERE id = $1", [patientOf.A1]);
        const updates = await get(
          "/api/v1/audit/events?resourceKind=patient&eventType=patient.update",
          U_ORG_WIDE_A,
        );
        expect(updates.statusCode).toBe(200);
        const changed = (
          updates.json().items as Array<{
            resourceId: string;
            before: Record<string, unknown> | null;
            after: Record<string, unknown> | null;
          }>
        ).find((i) => i.resourceId === patientOf.A1);
        expect(changed?.before?.dob).toBe("[REDACTED]");
        expect(changed?.after?.dob).toBe("[REDACTED]");
        expect(updates.body).not.toContain(dobOf.A1 as string);
      });

      it("ISOLATION: the other tenant's log names its own members and withholds A-only actors, in both directions", async () => {
        const res = await auditSearch(U_ORG_WIDE_B, { org: ORG_B });
        expect(res.statusCode).toBe(200);
        const items = res.json().items as AuditItem[];
        expect(items.map((i) => i.id).sort()).toEqual(idsWithPrefix("b-"));
        expect(items.every((i) => i.organizationId === ORG_B)).toBe(true);
        expect(nameOf(items, "b-member")).toBe("Bea Otherorg");
        expect(nameOf(items, "b-both")).toBe("Bo Both");
        // A member of A is no member of B: B reads no name for an A-only actor.
        expect(nameOf(items, "b-a-only-actor")).toBeNull();
        expect(res.body).not.toContain("Ada Actor");
      });

      it("ISOLATION: a filter on another tenant's actor or event id surfaces none of that tenant's rows", async () => {
        const byActor = await auditSearch(U_ORG_WIDE_A, { query: `actorUserId=${ACT_B_ONLY}` });
        expect((byActor.json().items as AuditItem[]).map((i) => i.id)).toEqual([
          eventOf["a-other-tenant-actor"],
        ]);

        const own = await get(`/api/v1/audit/events/${eventOf["a-member"]}`, U_ORG_WIDE_A);
        expect(own.statusCode).toBe(200);
        const crossFromA = await get(`/api/v1/audit/events/${eventOf["b-member"]}`, U_ORG_WIDE_A);
        expect(crossFromA.statusCode).toBe(404);
        const crossFromB = await get(`/api/v1/audit/events/${eventOf["a-member"]}`, U_ORG_WIDE_B, {
          org: ORG_B,
        });
        expect(crossFromB.statusCode).toBe(404);
      });

      it("DENY wrong role: a member without audit.read is 403", async () => {
        for (const asUser of [U_NO_GRANT_A, U_RN_A])
          expect((await auditSearch(asUser, orgWide)).statusCode).toBe(403);
      });

      it("DENY missing attribute: no organization context and no session are 401", async () => {
        expect((await auditSearch(U_ORG_WIDE_A, { org: null })).statusCode).toBe(401);
        expect((await auditSearch(null)).statusCode).toBe(401);
      });

      it("DENY wrong tenant: a grant held in one org does not carry to another (the per-org grant store; the ISOLATION cases carry the tenant proof)", async () => {
        expect((await auditSearch(U_ORG_WIDE_A, { org: ORG_B })).statusCode).toBe(403);
      });

      it("AUDIT: a routine read leaves no meta-event; an elevated (platform-role) read lands audit.elevated_access", async () => {
        const routine = await auditSearch(U_ORG_WIDE_A, orgWide);
        expect(routine.statusCode).toBe(200);
        expect(await auditRows(ORG_A, ELEVATED_EVENT)).toHaveLength(0);

        const elevated = await auditSearch(U_PLATFORM_A, { roles: ["platform_support"] });
        expect(elevated.statusCode).toBe(200);
        const rows = await auditRows(ORG_A, ELEVATED_EVENT);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.actor).toBe(U_PLATFORM_A);
        expect(rows[0]?.resource_kind).toBe("audit_event");
        expect(rows[0]?.severity).toBe("warn");
        expect(rows[0]?.context.query).toBe("GET /api/v1/audit/events");
        // The meta-event is in the reader's tenant only.
        expect(await auditRows(ORG_B, ELEVATED_EVENT)).toHaveLength(0);
      });
    });
  },
);
