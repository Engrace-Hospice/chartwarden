/**
 * #1136 (CW-CS-01) -- resolving a quarantined (no-order) critical lab result, on real Postgres, as the NOBYPASSRLS
 * `chartwarden_app` role, through the real routes and the real catalog-validating outbox publisher.
 *
 * Covers: the open queue and the by-id read (cross-tenant and off-caseload callers see nothing; the list and the by-id
 * read each land a read-audit event, the by-id one carrying the result's id via `resourceIdParam`); a resolution
 * (reviewed, no action / matched to an order) records who + discipline + a database-stamped instant, appends the
 * `critical_lab_result_resolution.insert` audit event with the reason scrubbed, and emits `m11.order.critical_lab_resolved`
 * with ids only; bad inputs (short reason, mismatched order, another patient's / tenant's / non-lab order) are refused
 * and write nothing; a non-prescriber, a caller without `orders.complete`, an off-caseload clinician and another tenant
 * are refused; a cleared result is resolved ONCE and cannot be re-opened, rewritten or deleted (409, grants, trigger);
 * RLS isolates the table at the database; a failing publish rolls the resolution back; the escalation sweep never pages
 * a resolved result; and the destruction path reaches the new table before its ledger row.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m11:critical-lab-resolution:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildCarePlanAbacPredicates } from "../src/modules/07-care-plan/abac-predicates";
import { resolveCriticalLabResult } from "../src/modules/11-orders/critical-lab-resolution";
import {
  CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS,
  sweepQuarantinedCriticalLabs,
} from "../src/modules/11-orders/critical-lab-result";
import { createDrizzleOrderEraseStore } from "../src/modules/11-orders/erasers/orders-eraser";
import {
  M11_OUTBOX_EVENTS,
  type OrderWriteOutboxPort,
  registerCriticalLabRoutes,
} from "../src/modules/11-orders/index";
import { buildM11LabResultsApplierConsumer } from "../src/modules/11-orders/outbox-consumers/m29-lab-results-applier";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PAT_A = "44444444-4444-4444-4444-444444444441";
const PAT_A2 = "44444444-4444-4444-4444-444444444442";
const PAT_B = "44444444-4444-4444-4444-444444444443";
const PAT_D = "44444444-4444-4444-4444-444444444444";
const PHYSICIAN_MDM = "99999999-9999-4999-8999-999999999999";
const RANDOM_ID = "99999999-0000-4999-8999-000000000000";
const REASON = "Reviewed the result with the attending; patient already admitted to the hospital.";
const obs = (n: number): string => `aaaaaaaa-1136-4000-8000-${String(n).padStart(12, "0")}`;

type Who = "md" | "np" | "off" | "rn" | "reader" | "mdB";
const READ_COMPLETE = ["orders.read", "orders.complete"];
const USERS: Record<Who, { id: string; org: string; roles: string; perms: string[] }> = {
  md: {
    id: "33333333-3333-3333-3333-333333333301",
    org: ORG_A,
    roles: "medical_director",
    perms: READ_COMPLETE,
  },
  np: { id: "33333333-3333-3333-3333-333333333302", org: ORG_A, roles: "np", perms: READ_COMPLETE },
  off: { id: "33333333-3333-3333-3333-333333333303", org: ORG_A, roles: "np", perms: READ_COMPLETE },
  rn: {
    id: "33333333-3333-3333-3333-333333333304",
    org: ORG_A,
    roles: "rn_case_manager",
    perms: READ_COMPLETE,
  },
  reader: {
    id: "33333333-3333-3333-3333-333333333305",
    org: ORG_A,
    roles: "np",
    perms: ["orders.read"],
  },
  mdB: {
    id: "33333333-3333-3333-3333-333333333306",
    org: ORG_B,
    roles: "medical_director",
    perms: READ_COMPLETE,
  },
};
/** userId -> the patients on that user's caseload (`np` covers PAT_A and PAT_D; `off` covers nobody). */
const CASELOAD: Record<string, readonly string[]> = {
  [USERS.np.id]: [PAT_A, PAT_D],
  [USERS.rn.id]: [PAT_A],
  [USERS.reader.id]: [PAT_A],
};

describe.skipIf(!DB_URL)("CW-CS-01 critical lab result resolution — LIVE Postgres", () => {
  let admin: Client;
  let appUrl: string;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let outbox: OrderWriteOutboxPort;
  let applier: ReturnType<typeof buildM11LabResultsApplierConsumer>;
  let providerA: string;
  const membership: Record<string, string> = {};
  let orderA = "";
  let orderA2 = "";
  let orderDme = "";
  let orderB = "";

  function headerAuth(request: FastifyRequest): void {
    const who = request.headers["x-test-who"];
    const u = typeof who === "string" ? USERS[who as Who] : undefined;
    if (!u) return; // unauthenticated
    request.context.userId = u.id;
    request.context.organizationId = u.org;
    request.context.roles = u.roles.split(",");
    request.context.attributes.membershipId = membership[u.id] ?? "";
  }
  const as = (who: Who) => ({ "x-test-who": who });

  const seedPatient = (id: string, org: string, tag: string) =>
    admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,'Pat','Synthetic','1950-01-01','female','active')`,
      [id, org, tag],
    );
  async function seedOrder(org: string, patient: string, kind: string): Promise<string> {
    const provider = org === ORG_A ? providerA : null;
    const drafter = membership[org === ORG_A ? USERS.md.id : USERS.mdB.id];
    const { rows } = await admin.query(
      `INSERT INTO order_record
         (organization_id, provider_entity_id, patient_id, admission_id, kind, kind_version, data,
          status, drafter_membership_id, drafter_discipline, ordering_physician_mdm_id, signed_at, priority)
       VALUES ($1,$2,$3,gen_random_uuid(),$4,'v1','{}'::jsonb,'active',$5,'rn_case_manager',$6,
               now() - interval '2 days', 'routine') RETURNING id`,
      [org, provider, patient, kind, drafter, PHYSICIAN_MDM],
    );
    return rows[0].id as string;
  }

  let seq = 100;
  /** Record a critical result through the REAL applier; with no order bound it is quarantined. Returns the ledger row id. */
  async function quarantine(
    org = ORG_A,
    patient = PAT_A,
    orderRecordId: string | null = null,
  ): Promise<{ id: string; observationId: string }> {
    const observationId = obs(seq++);
    await applier.handle({
      eventType: "m29.lab_observation.attached",
      organizationId: org,
      payload: {
        observationId,
        organizationId: org,
        patientId: patient,
        orderRecordId,
        loincCode: "2345-7",
        abnormalFlag: "HH",
        observationDatetime: new Date().toISOString(),
      },
    } as never);
    const { rows } = await admin.query("SELECT id FROM critical_lab_result WHERE observation_id=$1", [
      observationId,
    ]);
    return { id: rows[0].id as string, observationId };
  }
  const resolve = (who: Who, id: string, body: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/v1/orders/critical-lab-results/${id}/resolve`,
      headers: as(who),
      payload: body,
    });
  const noAction = (reason = REASON) => ({ resolution: "reviewed_no_action", reason });
  const resolutionRows = async (id: string) =>
    (
      await admin.query(
        "SELECT * FROM critical_lab_result_resolution WHERE critical_lab_result_id=$1",
        [id],
      )
    ).rows;
  const resolvedEvents = async (id: string) =>
    (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m11.order.critical_lab_resolved' AND aggregate_id=$1",
        [id],
      )
    ).rows;
  const queueIds = async (who: Who): Promise<string[]> => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders/critical-lab-results?limit=100",
      headers: as(who),
    });
    expect(res.statusCode).toBe(200);
    return (res.json().items as { id: string }[]).map((i) => i.id);
  };

  /** Run SQL as the real `chartwarden_app` role with `app.org_id` pinned for one transaction (rolled back). */
  async function asApp<T>(org: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query("BEGIN");
      if (org) await c.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const r = await c.query(sql, params);
      await c.query("ROLLBACK");
      return r.rows as T[];
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [ORG_A, "cs01-a"],
      [ORG_B, "cs01-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'CS01','CS01')",
        [id, slug],
      );
    for (const [who, u] of Object.entries(USERS)) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [u.id, `${who}@cs01.test`]);
      membership[u.id] = (
        await admin.query(
          "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
          [u.id, u.org],
        )
      ).rows[0].id as string;
    }
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'CS01-A','Provider A','1300000013','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await seedPatient(PAT_A, ORG_A, "cs01-a");
    await seedPatient(PAT_A2, ORG_A, "cs01-a2");
    await seedPatient(PAT_D, ORG_A, "cs01-d");
    await seedPatient(PAT_B, ORG_B, "cs01-b");
    orderA = await seedOrder(ORG_A, PAT_A, "lab");
    orderA2 = await seedOrder(ORG_A, PAT_A2, "lab");
    orderDme = await seedOrder(ORG_A, PAT_A, "dme");
    orderB = await seedOrder(ORG_B, PAT_B, "lab");

    // The REAL path: the NOBYPASSRLS app role, the real catalog-validating publisher (never NOOP_OUTBOX).
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    outbox = { publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }) };
    applier = buildM11LabResultsApplierConsumer({ db: handle.db, outbox });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        Object.values(USERS).map((u) => ({
          orgId: u.org,
          userId: u.id,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: u.perms }],
        })),
      ).store,
    );
    const registry = createPredicateRegistry();
    const m7 = buildCarePlanAbacPredicates({
      resolver: {
        loadPlan: async () => null,
        loadProblem: async () => null,
        loadVersion: async () => null,
      },
      isInCaseload: async (q: { userId: string; patientId: string }) =>
        (CASELOAD[q.userId] ?? []).includes(q.patientId),
    });
    registry.register("caseload_or_scope", m7.caseload_or_scope);
    registerAbacRegistry(registry);
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerCriticalLabRoutes(app, {
      db: handle.db,
      outbox,
      caseloadPatientIds: async ({ userId }) => CASELOAD[userId] ?? [],
    });
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  it("the queue shows only the caller's own open quarantined results, and each read lands a read-audit event", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    const b = await quarantine(ORG_B, PAT_B);

    const md = await queueIds("md");
    expect(md).toContain(a.id);
    expect(md).not.toContain(b.id); // another tenant
    const mdB = await queueIds("mdB");
    expect(mdB).toContain(b.id);
    expect(mdB).not.toContain(a.id);
    expect(await queueIds("np")).toContain(a.id); // on the caseload
    expect(await queueIds("off")).toEqual([]); // an empty caseload reads nothing

    const { rows } = await admin.query(
      `SELECT event_type, actor_user_id FROM audit_event
        WHERE organization_id=$1 AND resource_kind='critical_lab_result' AND event_type LIKE '%viewed'`,
      [ORG_A],
    );
    expect(rows.some((r) => r.actor_user_id === USERS.md.id)).toBe(true);
    expect(rows.some((r) => r.actor_user_id === USERS.np.id)).toBe(true);
  });

  it("the by-id read returns the row, audits the read WITH the result's id, and 404s an unknown, cross-tenant or off-caseload caller", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    const get = (who: Who, id: string) =>
      app.inject({
        method: "GET",
        url: `/api/v1/orders/critical-lab-results/${id}`,
        headers: as(who),
      });

    const ok = await get("md", a.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: a.id,
      patientId: PAT_A,
      disposition: "quarantined_no_order",
      resolution: null,
    });
    const audit = await admin.query(
      `SELECT resource_id FROM audit_event
        WHERE organization_id=$1 AND resource_kind='critical_lab_result' AND resource_id=$2 AND event_type LIKE '%viewed'`,
      [ORG_A, a.id],
    );
    expect(audit.rows).toHaveLength(1);

    const unknown = await get("md", RANDOM_ID);
    expect(unknown.statusCode).toBe(404);
    for (const denied of [await get("mdB", a.id), await get("off", a.id)]) {
      expect(denied.statusCode).toBe(404);
      expect(denied.json().error.code).toBe(unknown.json().error.code); // no existence oracle
    }
  });

  it("reviewed_no_action records who, which discipline and a DB-stamped instant; audits it with the reason scrubbed; emits the event with ids only", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    const before = Date.now();

    const res = await resolve("md", a.id, noAction());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      criticalLabResultId: a.id,
      resolution: "reviewed_no_action",
      matchedOrderId: null,
      reason: REASON,
      resolverMembershipId: membership[USERS.md.id],
      resolverDiscipline: "medical_director",
    });
    expect(Math.abs(new Date(res.json().resolvedAt).getTime() - before)).toBeLessThan(60_000);
    expect(await queueIds("md")).not.toContain(a.id);
    const ledger = (
      await admin.query("SELECT disposition FROM critical_lab_result WHERE id=$1", [a.id])
    ).rows[0];
    expect(ledger.disposition).toBe("quarantined_no_order"); // the ledger row is never rewritten

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/orders/critical-lab-results/${a.id}`,
      headers: as("md"),
    });
    expect(get.json().resolution).toMatchObject({ resolution: "reviewed_no_action", reason: REASON });

    const audit = (
      await admin.query(
        `SELECT actor_user_id, before, after FROM audit_event
          WHERE resource_kind='critical_lab_result_resolution' AND event_type='critical_lab_result_resolution.insert'
            AND (after->>'critical_lab_result_id')=$1`,
        [a.id],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(USERS.md.id);
    expect(audit[0].after.reason).toBe("<changed>");
    expect(JSON.stringify(audit[0])).not.toContain("attending");

    const events = await resolvedEvents(a.id);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      criticalLabResultId: a.id,
      organizationId: ORG_A,
      observationId: a.observationId,
      patientId: PAT_A,
      resolution: "reviewed_no_action",
    });
    expect(JSON.stringify(events[0].payload)).not.toContain("attending");
  });

  it("matched_to_order stores the order and carries it on the event; a clinician on the caseload may resolve", async () => {
    const a = await quarantine(ORG_A, PAT_A);

    const res = await resolve("np", a.id, {
      resolution: "matched_to_order",
      matchedOrderId: orderA,
      reason: REASON,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      resolution: "matched_to_order",
      matchedOrderId: orderA,
      resolverDiscipline: "np",
    });
    expect((await resolvedEvents(a.id))[0].payload).toMatchObject({
      resolution: "matched_to_order",
      matchedOrderId: orderA,
    });
  });

  it("refuses a short or missing reason, a mismatched order, and another patient's / tenant's / non-lab order, and writes nothing", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    const bad: Record<string, unknown>[] = [
      { resolution: "reviewed_no_action", reason: "too short" },
      { resolution: "reviewed_no_action", reason: `   ${"x".repeat(5)}        ` }, // padding does not count
      { resolution: "reviewed_no_action" },
      { resolution: "reviewed_no_action", reason: REASON, extra: true },
      { resolution: "matched_to_order", reason: REASON }, // no order named
      { resolution: "reviewed_no_action", matchedOrderId: orderA, reason: REASON }, // an order named for "no action"
      { resolution: "matched_to_order", matchedOrderId: orderA2, reason: REASON }, // another patient's order
      { resolution: "matched_to_order", matchedOrderId: orderDme, reason: REASON }, // not a lab order
      { resolution: "matched_to_order", matchedOrderId: orderB, reason: REASON }, // another tenant's order
      { resolution: "matched_to_order", matchedOrderId: RANDOM_ID, reason: REASON }, // unknown
      { resolution: "closed", reason: REASON },
    ];
    for (const body of bad) {
      const res = await resolve("md", a.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(await resolutionRows(a.id)).toHaveLength(0);
    expect(await resolvedEvents(a.id)).toHaveLength(0);
    expect(await queueIds("md")).toContain(a.id);
  });

  it("refuses a non-prescriber, a caller without orders.complete, an off-caseload clinician, another tenant and an anonymous caller", async () => {
    const a = await quarantine(ORG_A, PAT_A);

    expect((await resolve("rn", a.id, noAction())).statusCode).toBe(403); // not a prescriber
    expect((await resolve("reader", a.id, noAction())).statusCode).toBe(403); // no orders.complete
    expect((await resolve("off", a.id, noAction())).statusCode).toBe(404); // off caseload: existence not confirmed
    expect((await resolve("mdB", a.id, noAction())).statusCode).toBe(404); // another tenant
    const anon = await app.inject({
      method: "POST",
      url: `/api/v1/orders/critical-lab-results/${a.id}/resolve`,
      payload: noAction(),
    });
    expect(anon.statusCode).toBe(401);

    expect(await resolutionRows(a.id)).toHaveLength(0);
    expect(await resolvedEvents(a.id)).toHaveLength(0);
  });

  it("only a QUARANTINED result can be resolved: a critical bound to an order is refused (409)", async () => {
    const paged = await quarantine(ORG_A, PAT_A, orderA); // bound to an order -> 'paged', not quarantined

    const res = await resolve("md", paged.id, noAction());

    expect(res.statusCode).toBe(409);
    expect(await resolutionRows(paged.id)).toHaveLength(0);
  });

  it("a cleared result is resolved ONCE and cannot be re-opened, rewritten or deleted", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    expect((await resolve("md", a.id, noAction())).statusCode).toBe(200);
    const original = (await resolutionRows(a.id))[0];

    // A second resolve (even a different decision, by a different clinician) is refused and changes nothing.
    const second = await resolve("np", a.id, {
      resolution: "matched_to_order",
      matchedOrderId: orderA,
      reason: REASON,
    });
    expect(second.statusCode).toBe(409);
    expect(await resolutionRows(a.id)).toEqual([original]);
    expect(await resolvedEvents(a.id)).toHaveLength(1);

    // As the application role: no UPDATE / DELETE grant on the resolution, and no grant to flip the ledger row back.
    await expect(
      asApp(
        ORG_A,
        "UPDATE critical_lab_result_resolution SET reason='tampered reason text' WHERE critical_lab_result_id=$1",
        [a.id],
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(ORG_A, "DELETE FROM critical_lab_result_resolution WHERE critical_lab_result_id=$1", [
        a.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(ORG_A, "UPDATE critical_lab_result SET disposition='paged' WHERE id=$1", [a.id]),
    ).rejects.toThrow(/permission denied/);
    // Even a superuser is stopped by the append-only trigger (only the destruction role may delete).
    await expect(
      admin.query(
        "UPDATE critical_lab_result_resolution SET reason='tampered reason text' WHERE critical_lab_result_id=$1",
        [a.id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      admin.query("DELETE FROM critical_lab_result_resolution WHERE critical_lab_result_id=$1", [
        a.id,
      ]),
    ).rejects.toThrow(/append-only/);
    expect(await resolutionRows(a.id)).toEqual([original]);
    expect(await queueIds("md")).not.toContain(a.id);
  });

  it("RLS isolates the resolution table at the database: another tenant reads and writes nothing", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    await resolve("md", a.id, noAction());
    const probe = "SELECT id FROM critical_lab_result_resolution WHERE critical_lab_result_id=$1";

    expect(await asApp(ORG_A, probe, [a.id])).toHaveLength(1);
    expect(await asApp(ORG_B, probe, [a.id])).toHaveLength(0);
    expect(await asApp(null, probe, [a.id])).toHaveLength(0);
    await expect(
      asApp(
        ORG_B,
        `INSERT INTO critical_lab_result_resolution (organization_id, patient_id, critical_lab_result_id, resolution, reason, resolver_membership_id, resolver_discipline)
         VALUES ($1,$2,$3,'reviewed_no_action','a forged cross-tenant reason',gen_random_uuid(),'np')`,
        [ORG_A, PAT_A, a.id],
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("a refused publish rolls the whole resolution back, and the result can be resolved afterwards", async () => {
    const a = await quarantine(ORG_A, PAT_A);
    const failing: OrderWriteOutboxPort = {
      publish: async () => {
        throw new Error("outbox unavailable");
      },
    };
    const actor = {
      membershipId: membership[USERS.md.id] as string,
      userId: USERS.md.id,
      disciplines: ["medical_director"],
    };

    await expect(
      resolveCriticalLabResult(
        { db: handle.db, outbox: failing },
        ORG_A,
        a.id,
        { resolution: "reviewed_no_action", reason: REASON },
        actor,
        async () => undefined,
      ),
    ).rejects.toThrow("outbox unavailable");

    expect(await resolutionRows(a.id)).toHaveLength(0);
    expect((await resolve("md", a.id, noAction())).statusCode).toBe(200);
  });

  it("the escalation sweep never pages a result that has been resolved", async () => {
    const resolved = await quarantine(ORG_A, PAT_A);
    const open = await quarantine(ORG_A, PAT_A);
    await resolve("md", resolved.id, noAction());
    const paged: string[] = [];

    await sweepQuarantinedCriticalLabs(
      {
        db: handle.db,
        now: () => new Date(Date.now() + 2 * CRITICAL_LAB_NO_ORDER_RESPOND_WITHIN_MS),
        escalate: async (_org, row) => {
          paged.push(row.observationId);
        },
      },
      ORG_A,
    );

    expect(paged).toContain(open.observationId);
    expect(paged).not.toContain(resolved.observationId);
    const stamps = await admin.query(
      "SELECT id, escalated_at FROM critical_lab_result WHERE id = ANY($1::uuid[])",
      [[resolved.id, open.id]],
    );
    const stamp = (id: string) => stamps.rows.find((r) => r.id === id)?.escalated_at;
    expect(stamp(resolved.id)).toBeNull();
    expect(stamp(open.id)).not.toBeNull();
  });

  it("the destruction path deletes the resolution before its ledger row, so the patient can be destroyed", async () => {
    const d = await quarantine(ORG_A, PAT_D);
    expect((await resolve("md", d.id, noAction())).statusCode).toBe(200);
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cs01_destroyer') THEN
         CREATE ROLE cs01_destroyer LOGIN PASSWORD 'cs01_destroyer_pw' IN ROLE chartwarden_destruction;
       END IF; END $$;`,
    );
    const url = new URL(DB_URL as string);
    url.username = "cs01_destroyer";
    url.password = "cs01_destroyer_pw";
    const destroyer = createDbClient({ connectionString: url.toString() });
    try {
      const store = createDrizzleOrderEraseStore(destroyer.db as never);
      const boundary = new Date(Date.now() + 86_400_000).toISOString();
      const foreign = await store.eraseOrdersSubtree(ORG_B, PAT_D, boundary);
      expect(foreign).toMatchObject({ criticalLabResults: 0, criticalLabResolutions: 0 });
      expect(await resolutionRows(d.id)).toHaveLength(1);

      const counts = await store.eraseOrdersSubtree(ORG_A, PAT_D, boundary);

      expect(counts).toMatchObject({ criticalLabResults: 1, criticalLabResolutions: 1 });
    } finally {
      await destroyer.close();
      await admin.query("DROP OWNED BY cs01_destroyer");
      await admin.query("DROP ROLE cs01_destroyer");
    }
    expect(await resolutionRows(d.id)).toHaveLength(0);
    await admin.query("DELETE FROM patient WHERE id=$1", [PAT_D]); // the restrict FKs no longer block it
  });
});
