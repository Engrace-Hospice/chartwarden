/**
 * M41 advisory enrollment reports (migration 1323, ADR-0053 amendment D7) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`.
 *
 *   - `m23.clearinghouse.enrollment_reported`, published through the REAL catalog-validating publisher and delivered by the REAL
 *     dispatcher, becomes one open report; a redelivery adds nothing; payer mapping through commercial_payer_route (NULL when
 *     ambiguous); only the exact word `enrolled` suggests a status; a newer report supersedes, a late older one lands superseded.
 *   - the send gate still refuses after a report: nothing is written to commercial_payer_enrollment until staff record the
 *     enrollment through the existing admin path; then the gate passes.
 *   - routes through the real Fastify chain: read needs commercial_billing.read + provider scope, resolve needs
 *     manage_enrollment (no step-up), refuses an AI actor, is idempotent, 409 the other way, 404 across tenants.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:enrollment-reports:live
 * (SUPERUSER url to a THROWAWAY database on a PRIVATE pgvector/pgvector:pg18: this file DROPs the public schema.)
 */
import { randomUUID } from "node:crypto";
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
import { withOrgContext } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { buildServer } from "../src/bootstrap/index";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
import { buildDrizzleM23AbacResolver } from "../src/modules/23-billing-medicare/abac-resolver-drizzle";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import { evaluateSendGate } from "../src/modules/41-billing-commercial/eligibility/send-gate";
import {
  M41_OUTBOX_EVENTS,
  buildCommercialAbacPredicates,
  buildDrizzleEligibilityStore,
  buildEnrollmentReportService,
  buildM41EnrollmentReportConsumer,
  createCommercialAdminService,
} from "../src/modules/41-billing-commercial/index";
import { registerCommercialEnrollmentReportRoutes } from "../src/modules/41-billing-commercial/routes/enrollment-report.routes";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "00000000-0000-4000-8000-0000000323a1";
const ORG_B = "00000000-0000-4000-8000-0000000323b1";
const USER = "00000000-0000-4000-8000-0000000323c1";
const READER = "00000000-0000-4000-8000-0000000323c2";
const BASE = "/api/v1/billing/commercial/enrollment-reports";

describe.skipIf(!DB_URL)("M41 enrollment reports - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let peA = "";
  let peB = "";
  let payerA = "";
  const servers: FastifyInstance[] = [];
  let seq = 0;

  const provider = async (org: string, ccn: string, npi: string) =>
    (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'Synthetic Hospice',$3,'\\x00','12-31') RETURNING id`,
        [org, ccn, npi],
      )
    ).rows[0].id as string;
  const newPayer = async () =>
    (
      await admin.query("INSERT INTO payer (kind, name) VALUES ('commercial', $1) RETURNING id", [
        `Synthetic ${randomUUID().slice(0, 6)}`,
      ])
    ).rows[0].id as string;
  const planWithRoute = async (org: string, payerId: string, chPayerId: string) => {
    const planId = (
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
         VALUES ($1,$2,'Synthetic PPO','CI','not_required','2026-01-01') RETURNING id`,
        [org, payerId],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
       VALUES ($1,$2,'claimmd',$3,'2026-01-01')`,
      [org, planId, chPayerId],
    );
  };

  /** Publish one report the way the M23 sweep does, then let the dispatcher deliver it. */
  async function report(
    org: string,
    pe: string,
    over: Record<string, unknown> = {},
    key = `test:99999:${++seq}`,
  ): Promise<string> {
    await withOrgContext(handle.db, { organizationId: org, userId: "" }, async (tx) => {
      await publisher.publish(tx as never, {
        eventName: "m23.clearinghouse.enrollment_reported",
        organizationId: org,
        aggregateKind: "clearinghouse_report",
        aggregateId: pe,
        callerModule: "m23",
        payload: {
          sourceEventKey: key,
          usage: "test",
          vendor: "claimmd",
          providerEntityId: pe,
          vendorStatus: "enrolled",
          reportedAt: "2026-11-05T12:00:00.000Z",
          eventTime: "2026-11-05 12:00:00",
          vendorEnrollId: "77",
          enrollType: "era",
          clearinghousePayerId: "SYN01",
          ...over,
        },
      });
    });
    await dispatcher.tick();
    return key;
  }
  const rows = async (pe: string) =>
    (
      await admin.query(
        "SELECT * FROM commercial_enrollment_report WHERE provider_entity_id = $1 ORDER BY reported_at, created_at",
        [pe],
      )
    ).rows as Record<string, unknown>[];

  function headerAuth(request: FastifyRequest): void {
    const who = request.headers["x-test-user"];
    if (typeof who !== "string") return;
    request.context.userId = who === "reader" ? READER : USER;
    request.context.organizationId = who === "b" ? ORG_B : ORG_A;
    request.context.roles = ["billing_manager"];
    request.context.providerEntityIds = [who === "b" ? peB : peA];
    request.context.attributes.stepUpRecent = false; // resolving needs no step-up
    request.context.attributes.actorKind = who === "ai" ? "ai_agent" : "user";
  }
  function server(): FastifyInstance {
    const manage = ["commercial_billing.read", "commercial_billing.manage_enrollment"];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG_A,
          userId: USER,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: manage }],
        },
        {
          orgId: ORG_B,
          userId: USER,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: manage }],
        },
        {
          orgId: ORG_A,
          userId: READER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["commercial_billing.read"],
            },
          ],
        },
      ]).store,
    );
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildCommercialAbacPredicates({ db: handle.db, isInCaseload: async () => true }),
    )) {
      reg.register(name, predicate);
    }
    // The enrollment routes reuse M23's provider_entity_billing_scope (registered by M23 at boot).
    for (const [name, predicate] of Object.entries(
      buildM23AbacPredicates({
        resolver: buildDrizzleM23AbacResolver(handle.db as never),
        isInCaseload: async () => true,
      }),
    )) {
      reg.register(name, predicate);
    }
    registerAbacRegistry(reg);
    const app = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      db: handle.db,
    });
    registerCommercialEnrollmentReportRoutes(app, {
      reports: buildEnrollmentReportService(handle.db),
    });
    servers.push(app);
    return app;
  }
  const call = (
    app: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    user = "admin",
    payload?: object,
  ) =>
    app.inject({ method, url, headers: { "x-test-user": user }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m41e-a"],
      [ORG_B, "m41e-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m41e-a@x.test'),($2,'m41e-b@x.test')`,
      [USER, READER],
    );
    peA = await provider(ORG_A, "323001", "1234567893");
    peB = await provider(ORG_B, "323002", "1999999984");
    payerA = await newPayer();
    await planWithRoute(ORG_A, payerA, "SYN01");
    // Two payers routed on the same Claim.MD payer id: ambiguous, so no payer is guessed.
    await planWithRoute(ORG_A, await newPayer(), "SYN02");
    await planWithRoute(ORG_A, await newPayer(), "SYN02");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS, M41_OUTBOX_EVENTS]);
    publisher = buildTxOutboxPublisher(catalog);
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      eventCatalog: catalog,
      consumers: [buildM41EnrollmentReportConsumer({ db: handle.db })],
    });
  }, 600_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE commercial_enrollment_report, commercial_payer_enrollment");
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("records one open report per event, maps the payer, and ignores a redelivery", async () => {
    const key = await report(ORG_A, peA);
    await report(ORG_A, peA, {}, key);
    const [r, ...rest] = await rows(peA);
    expect(rest).toHaveLength(0);
    expect(r).toMatchObject({
      organization_id: ORG_A,
      payer_id: payerA,
      clearinghouse_key: "claimmd",
      enroll_type: "era",
      vendor_status: "enrolled",
      suggested_status: "enrolled",
      vendor_enroll_id: "77",
      state: "open",
    });
  });

  it("guesses no payer when the route mapping is ambiguous, and suggests nothing for another word", async () => {
    await report(ORG_A, peA, {
      clearinghousePayerId: "SYN02",
      vendorStatus: "denied",
      enrollType: "1500",
    });
    const [r] = await rows(peA);
    expect(r).toMatchObject({
      payer_id: null,
      clearinghouse_payer_id: "SYN02",
      suggested_status: null,
      state: "open",
    });
  });

  it("supersedes an older open report and stores a late older one already superseded", async () => {
    await report(ORG_A, peA, { eventTime: "2026-11-05 10:00:00", vendorStatus: "pending" });
    await report(ORG_A, peA, { eventTime: "2026-11-05 12:00:00", vendorStatus: "enrolled" });
    await report(ORG_A, peA, { eventTime: "2026-11-05 09:00:00", vendorStatus: "received" });
    const states = (await rows(peA)).map((r) => [r.vendor_status, r.state]);
    expect(states).toEqual([
      ["received", "superseded"],
      ["pending", "superseded"],
      ["enrolled", "open"],
    ]);
  });

  it("opens no send gate: the gate refuses after a report until staff record the enrollment", async () => {
    await report(ORG_A, peA);
    const enrollments = async () =>
      (
        await admin.query(
          "SELECT status, effective_from, effective_to FROM commercial_payer_enrollment WHERE provider_entity_id = $1",
          [peA],
        )
      ).rows.map((e) => ({
        status: e.status,
        effectiveFrom: (e.effective_from as Date).toISOString().slice(0, 10),
        effectiveTo: null,
      }));
    const gate = async () =>
      evaluateSendGate({
        clearinghouseKey: "claimmd",
        routes: [{ clearinghousePayerId: "SYN01", effectiveFrom: "2026-01-01", effectiveTo: null }],
        enrollments: await enrollments(),
        serviceDate: "2026-11-05",
      });
    expect(await enrollments()).toEqual([]);
    expect((await gate()).ok).toBe(false);
    // Staff apply the report through the existing admin path (what the enrollments POST calls).
    await createCommercialAdminService(buildDrizzleEligibilityStore(handle.db)).createEnrollment(
      { organizationId: ORG_A, userId: USER },
      {
        providerEntityId: peA,
        payerId: payerA,
        clearinghouseKey: "claimmd",
        status: "enrolled",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        evidenceRef: "claimmd:77",
      },
    );
    expect(await gate()).toMatchObject({ ok: true, clearinghousePayerId: "SYN01" });
  });

  it("serves reports through the real route chain: read scope, manage to resolve, idempotent, 409, AI refused, tenants apart", async () => {
    await report(ORG_A, peA);
    await report(ORG_B, peB);
    const app = server();
    const list = await call(app, "GET", `${BASE}?providerEntityId=${peA}&state=open`);
    expect(list.statusCode).toBe(200);
    const [item] = list.json().items;
    expect(item).toMatchObject({
      providerEntityId: peA,
      vendorStatus: "enrolled",
      suggestedStatus: "enrolled",
    });
    // Org A's user sees nothing of org B's entity (provider scope answers 404, never 403).
    expect((await call(app, "GET", `${BASE}?providerEntityId=${peB}`)).statusCode).toBe(404);
    const url = `${BASE}/${item.id}/resolve`;
    const body = { providerEntityId: peA, resolution: "applied" };
    expect((await call(app, "POST", url, "reader", body)).statusCode).toBe(403);
    expect((await call(app, "POST", url, "ai", body)).statusCode).toBe(403);
    const first = await call(app, "POST", url, "admin", body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: "applied" });
    expect((await call(app, "POST", url, "admin", body)).statusCode).toBe(200); // idempotent
    expect(
      (await call(app, "POST", url, "admin", { ...body, resolution: "dismissed" })).statusCode,
    ).toBe(409);
    // Org B's admin cannot resolve org A's report even by id (RLS: not found).
    const [bItem] = (await rows(peB)) as { id: string }[];
    expect(
      (
        await call(app, "POST", `${BASE}/${bItem?.id}/resolve`, "b", {
          ...body,
          providerEntityId: peA,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, "POST", `${BASE}/${item.id}/resolve`, "b", {
          ...body,
          providerEntityId: peB,
        })
      ).statusCode,
    ).toBe(404);
  });
});
