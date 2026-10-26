/**
 * M41 Billing - Commercial routes (issue #722) - the HTTP layer over LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Drives every route through the real Fastify chain (authenticate hook -> RBAC -> the three M41 ABAC predicates -> step-up ->
 * AI block -> idempotency -> handler -> typed error envelope) with the REAL services over the real schema:
 *   - 403 without the permission; 404 (not 403) for a provider entity outside the actor's scope and for a role that may not
 *     override; 403 without step-up on the override; 403 for an AI actor on every mutation; a mutation without
 *     `Idempotency-Key` is refused and writes nothing;
 *   - assemble (201) -> read (200, read-audited with the patient attribution, no member id or authorization number in the body)
 *     -> override a soft block (201, reason floor 422, second override 409) -> ready (200);
 *   - a hard block cannot be overridden (403) and `ready` answers 409 COMMERCIAL_CLAIM_BLOCKED with the blocking rules;
 *   - an authorization is recorded and listed; the list is read-audited.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:commercial-routes:live
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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM41OverrideAuditPort } from "../src/m41-override-audit";
import { buildPatientCoverageReader } from "../src/modules/05-patient/coverage-reader";
import {
  type CommercialClaimSeams,
  M41_OUTBOX_EVENTS,
  buildCommercialAbacPredicates,
  buildCommercialAuthorizationService,
  buildCommercialClaimAssemblyService,
  buildCommercialClaimLifecycleService,
  buildCommercialClaimReadService,
  buildCommercialSubmissionService,
  registerCommercialBillingRoutes,
} from "../src/modules/41-billing-commercial/index";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "00000000-0000-4000-8000-0000000043a1";
const USER = "00000000-0000-4000-8000-0000000043c1";
const OTHER_USER = "00000000-0000-4000-8000-0000000043c2";
const NOCASE = "00000000-0000-4000-8000-0000000043c3";
const REASON =
  "The payer confirmed by telephone that no authorization is needed for this hospice plan.";
const BASE = "/api/v1/billing/commercial";
const KEYS = [
  "commercial_billing.read",
  "commercial_billing.write",
  "commercial_billing.submit",
  "commercial_billing.override_validation",
];

describe.skipIf(!DB_URL)("M41 commercial billing routes - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId: string;
  let membershipId: string;
  let commercialPayer: string;
  let medicarePayer: string;
  const servers: FastifyInstance[] = [];
  let idem = 0;
  let otherProviderEntityId: string;
  // when set, the fake admission reports this provider entity instead of providerEntityId
  let admissionProvider: string | undefined;

  function headerAuth(request: FastifyRequest): void {
    const who = request.headers["x-test-user"];
    if (typeof who !== "string") return;
    request.context.userId = who === "plain" ? OTHER_USER : who === "nocase" ? NOCASE : USER;
    request.context.organizationId = ORG;
    request.context.roles = who === "ineligible" ? ["scheduler"] : ["billing_manager"];
    request.context.providerEntityIds = [who === "pe2" ? otherProviderEntityId : providerEntityId];
    request.context.attributes.membershipId = membershipId;
    request.context.attributes.stepUpRecent = request.headers["x-test-stepup"] === "yes";
    request.context.attributes.actorKind = who === "ai" ? "ai_agent" : "user";
  }

  async function seed(
    authorization: string,
  ): Promise<{ patientId: string; planId: string; admissionId: string }> {
    const planPayer = (
      await admin.query("INSERT INTO payer (kind, name) VALUES ('commercial', $1) RETURNING id", [
        `Synthetic ${randomUUID().slice(0, 6)}`,
      ])
    ).rows[0].id as string;
    const planId = (
      await admin.query(
        `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, authorization_requirement, effective_from)
         VALUES ($1,$2,'Synthetic PPO','CI',$3,'2026-01-01') RETURNING id`,
        [ORG, planPayer, authorization],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
       VALUES ($1,$2,'stedi','SYNTH01','2026-01-01')`,
      [ORG, planId],
    );
    await admin.query(
      `INSERT INTO commercial_contract_rate (organization_id, plan_id, level_of_care, revenue_code, rate_basis, rate_cents, effective_from)
       VALUES ($1,$2,'routine_home_care','0651','per_diem',20000,'2026-01-01')`,
      [ORG, planId],
    );
    const patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,'Jane','Doe','1950-01-01','female','active') RETURNING id`,
        [ORG, `mrn-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
       VALUES ($1,$2,$3,1,'commercial','MEM-0001234','2026-01-01')`,
      [patientId, ORG, planPayer],
    );
    return { patientId, planId, admissionId: randomUUID() };
  }

  function server(admissionId: string): FastifyInstance {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: USER,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
        },
        {
          orgId: ORG,
          userId: NOCASE,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
        },
        { orgId: ORG, userId: OTHER_USER, grants: [] },
      ]).store,
    );
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildCommercialAbacPredicates({
        db: handle.db,
        isInCaseload: async ({ userId }) => userId === USER,
      }),
    )) {
      reg.register(name, predicate);
    }
    reg.register("step_up_recent", async (ctx) => ctx.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M41_OUTBOX_EVENTS]));
    const seams: CommercialClaimSeams = {
      coverage: buildPatientCoverageReader(handle.db),
      // the per-patient axis: only USER has the patients on their caseload
      caseload: { isInCaseload: async ({ userId }) => userId === USER },
      admission: {
        resolveForRange: async () => ({
          admissionId,
          providerEntityId: admissionProvider ?? providerEntityId,
          hospiceAdmissionDate: "2026-03-01",
          admissionTypeCode: "1",
          admissionSourceCode: "1",
          dischargeDate: null,
          dischargeReason: null,
          deceasedDate: null,
          placeOfDeath: null,
          transferOut: null,
        }),
      },
      electionPeriods: {
        coveringRange: async () => [
          {
            electionPeriodId: randomUUID(),
            sequence: 1,
            effectiveFrom: "2026-03-01",
            effectiveTo: null,
            revoked: false,
            revocationDate: null,
          },
        ],
      },
      levelOfCare: {
        periodsInRange: async () => [
          {
            levelOfCarePeriodId: randomUUID(),
            levelOfCare: "routine_home_care" as const,
            from: "2026-03-01",
            to: "2026-03-31",
            chcDocumentedHours: null,
            gipAdmissionCriteriaDocumented: null,
          },
        ],
      },
      diagnoses: {
        forRange: async () => ({
          sequence: [{ position: 1, code: "C34.90", relationship: "terminal" as const }],
          withheldForConsentCount: 0,
          terminalWithheldForConsent: false,
        }),
      },
      clinicalParticipants: {
        resolveClinicalParticipants: async () => ({
          attending: {
            npi: "1245319599",
            firstName: "Alan",
            lastName: "Smith",
            status: "active" as const,
            licenseUnexpiredOnServiceDates: true,
          },
          hospicePhysician: null,
          placeOfService: "home",
        }),
      },
      outbox: {
        publish: (tx, e) =>
          publisher.publish(tx as Parameters<typeof publisher.publish>[0], {
            ...e,
            callerModule: "m41",
          }),
      },
      audit: buildM41OverrideAuditPort(),
    };
    const app = buildServer({
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      db: handle.db,
    });
    registerCommercialBillingRoutes(app, {
      assembly: buildCommercialClaimAssemblyService(handle.db, seams),
      lifecycle: buildCommercialClaimLifecycleService(handle.db, seams),
      authorizations: buildCommercialAuthorizationService(handle.db, seams),
      reads: buildCommercialClaimReadService(handle.db, seams),
      submissions: buildCommercialSubmissionService(handle.db, seams, { vendor: null }),
    });
    servers.push(app);
    return app;
  }

  const call = (
    app: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    opts: { user?: string; stepUp?: boolean; payload?: unknown; key?: boolean } = {},
  ) =>
    app.inject({
      method,
      url,
      headers: {
        "x-test-user": opts.user ?? "admin",
        ...(opts.stepUp ? { "x-test-stepup": "yes" } : {}),
        ...(method === "POST" && opts.key !== false ? { "idempotency-key": `k-${++idem}` } : {}),
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
    });
  const assembleBody = (patientId: string, extra: object = {}) => ({
    providerEntityId,
    patientId,
    serviceFrom: "2026-03-01",
    serviceTo: "2026-03-31",
    ...extra,
  });

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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'m41r-a','A','A')",
      [ORG],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m41r-a@x.test'),($2,'m41r-b@x.test')`,
      [USER, OTHER_USER],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m41r-c@x.test')`, [NOCASE]);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'123456','Synthetic Hospice','1234567893','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    otherProviderEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'654321','Synthetic Hospice Two','1245319599','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    commercialPayer = (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('commercial','Synthetic C') RETURNING id",
      )
    ).rows[0].id as string;
    medicarePayer = (
      await admin.query(
        "INSERT INTO payer (kind, name) VALUES ('medicare','Synthetic M') RETURNING id",
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 600_000);

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterEach(async () => {
    admissionProvider = undefined;
    await Promise.all(servers.splice(0).map((s) => s.close()));
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });
  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  const claimCount = async () =>
    (await admin.query("SELECT count(*)::int AS n FROM commercial_claim")).rows[0].n as number;

  it("guards assemble: no permission 403, provider outside scope 404, no idempotency key refused, AI actor 403; nothing is written", async () => {
    const s = await seed("not_required");
    const app = server(s.admissionId);
    const before = await claimCount();
    expect(
      (
        await call(app, "POST", `${BASE}/claims/assemble`, {
          user: "plain",
          payload: assembleBody(s.patientId),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(app, "POST", `${BASE}/claims/assemble`, {
          payload: assembleBody(s.patientId, { providerEntityId: otherProviderEntityId }),
        })
      ).statusCode,
    ).toBe(404);
    const noKey = await call(app, "POST", `${BASE}/claims/assemble`, {
      key: false,
      payload: assembleBody(s.patientId),
    });
    expect(noKey.statusCode).toBeGreaterThanOrEqual(400);
    expect(noKey.statusCode).toBeLessThan(500);
    expect(
      (
        await call(app, "POST", `${BASE}/claims/assemble`, {
          user: "ai",
          payload: assembleBody(s.patientId),
        })
      ).statusCode,
    ).toBe(403);
    expect(await claimCount()).toBe(before);
  });

  it("assembles (201), reads it back read-audited with no member id, and goes ready (200)", async () => {
    const s = await seed("not_required");
    const app = server(s.admissionId);
    const created = await call(app, "POST", `${BASE}/claims/assemble`, {
      payload: assembleBody(s.patientId),
    });
    expect(created.statusCode).toBe(201);
    const claimId = created.json().claimId as string;
    expect(created.json()).toMatchObject({
      state: "draft",
      tob: "812",
      totalChargeCents: 620_000,
      lineCount: 1,
    });

    const got = await call(app, "GET", `${BASE}/claims/${claimId}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().lines).toHaveLength(1);
    expect(got.body).not.toMatch(/MEM-0001234|Jane|Doe/);
    const read = await admin.query(
      "SELECT context, resource_id FROM audit_event WHERE event_type='commercial_claim.viewed' AND resource_id=$1",
      [claimId],
    );
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0].context).toMatchObject({ patientId: s.patientId });

    const ready = await call(app, "POST", `${BASE}/claims/${claimId}/ready`);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().state).toBe("ready");
    expect((await call(app, "POST", `${BASE}/claims/${claimId}/void`)).json().state).toBe("void");
  });

  it("serves the work queue, the supported-payers view and the claim detail (plan, authorization, COB) without PHI (#726)", async () => {
    const s = await seed("required_at_admission");
    const app = server(s.admissionId);
    const authorization = await call(app, "POST", `${BASE}/authorizations`, {
      payload: {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-SYNTH-7731",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
        effectiveTo: "2026-03-31",
      },
    });
    expect(authorization.statusCode).toBe(201);
    const created = await call(app, "POST", `${BASE}/claims/assemble`, {
      payload: assembleBody(s.patientId),
    });
    const claimId = created.json().claimId as string;

    const queue = await call(app, "GET", `${BASE}/claims?providerEntityId=${providerEntityId}`);
    expect(queue.statusCode).toBe(200);
    const row = (queue.json().items as { id: string }[]).find((c) => c.id === claimId);
    expect(row).toMatchObject({
      state: "draft",
      planName: "Synthetic PPO",
      patientId: s.patientId,
    });
    expect(queue.body).not.toMatch(/MEM-0001234|Jane|Doe|AUTH-SYNTH-7731/);
    // payer-kind: this claim has no other payer, so a Medicare-secondary filter excludes it and commercial-only keeps it
    const medicare = await call(
      app,
      "GET",
      `${BASE}/claims?providerEntityId=${providerEntityId}&payerKind=medicare_secondary`,
    );
    expect((medicare.json().items as { id: string }[]).some((c) => c.id === claimId)).toBe(false);
    const only = await call(
      app,
      "GET",
      `${BASE}/claims?providerEntityId=${providerEntityId}&payerKind=commercial_only&state=draft`,
    );
    expect((only.json().items as { id: string }[]).some((c) => c.id === claimId)).toBe(true);
    // a scoped actor that does not reach the entity gets 404; one outside the caseload sees an empty queue
    expect(
      (await call(app, "GET", `${BASE}/claims?providerEntityId=${otherProviderEntityId}`))
        .statusCode,
    ).toBe(404);
    const nocase = await call(app, "GET", `${BASE}/claims?providerEntityId=${providerEntityId}`, {
      user: "nocase",
    });
    expect(nocase.statusCode).toBe(200);
    expect(nocase.json().items).toEqual([]);

    const plans = await call(
      app,
      "GET",
      `${BASE}/payer-plans?providerEntityId=${providerEntityId}`,
    );
    expect(plans.statusCode).toBe(200);
    const plan = (plans.json().items as { id: string; routes: unknown[] }[]).find(
      (p) => p.id === s.planId,
    );
    expect(plan).toMatchObject({
      planName: "Synthetic PPO",
      claimFilingIndicator: "CI",
      authorizationRequirement: "required_at_admission",
      payerStatus: "active",
    });
    expect(plan?.routes).toEqual([
      expect.objectContaining({ clearinghouseKey: "stedi", clearinghousePayerId: "SYNTH01" }),
    ]);

    const detail = (await call(app, "GET", `${BASE}/claims/${claimId}`)).json();
    expect(detail.plan).toMatchObject({ id: s.planId, planName: "Synthetic PPO" });
    expect(detail.authorizations).toEqual([
      expect.objectContaining({ status: "approved", effectiveFrom: "2026-03-01" }),
    ]);
    expect(JSON.stringify(detail)).not.toContain("AUTH-SYNTH-7731");
    expect(detail.claim.claimControlNumber).toEqual(expect.any(String));
  });

  /** Bulk-insert VOID claims (exempt from the one-live-claim-per-day rule), three per timestamp so the keyset tie-break is exercised. */
  async function bulkClaims(
    entity: string,
    planId: string,
    count: number,
    tag: string,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO commercial_claim (organization_id, provider_entity_id, patient_id, admission_id, plan_id, primary_patient_payer_id,
         claim_filing_indicator, tob, frequency_code, service_from, service_to, admission_date, patient_status_code,
         claim_control_number, total_charge_cents, state, created_by_membership_id, updated_at)
       SELECT $1, $2, gen_random_uuid(), gen_random_uuid(), $3, gen_random_uuid(), 'CI', '812', '2',
         DATE '2026-03-01', DATE '2026-03-31', DATE '2026-03-01', '30', $4 || '-' || i, 1000, 'void', $5,
         now() - make_interval(secs => (i / 3)::int)
       FROM generate_series(1, $6::int) AS i`,
      [ORG, entity, planId, tag, membershipId, count],
    );
  }
  const follow = async (app: FastifyInstance, base: string, user?: string) => {
    const ids: string[] = [];
    const pages: { size: number; cursor: string | null }[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 40; guard += 1) {
      const res = await call(
        app,
        "GET",
        `${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        user ? { user } : {},
      );
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: { id: string }[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(body.hasMore).toBe(body.nextCursor !== null);
      ids.push(...body.items.map((i) => i.id));
      pages.push({ size: body.items.length, cursor: body.nextCursor });
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    return { ids, pages };
  };

  it("pages a queue of more than 100 reachable claims by keyset cursor without gaps or repeats (#726)", async () => {
    const s = await seed("not_required");
    const app = server(s.admissionId);
    await bulkClaims(otherProviderEntityId, s.planId, 230, "PGA");
    const { ids, pages } = await follow(
      app,
      `${BASE}/claims?providerEntityId=${otherProviderEntityId}&limit=100`,
      "pe2",
    );
    expect(new Set(ids).size).toBe(ids.length); // no repeats, even across equal timestamps
    const stored = await admin.query(
      "SELECT count(*)::int AS n FROM commercial_claim WHERE provider_entity_id = $1",
      [otherProviderEntityId],
    );
    expect(ids.length).toBe(stored.rows[0].n as number); // no gaps
    expect(pages[0]?.size).toBe(100);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.at(-1)?.cursor).toBeNull();
    // a malformed cursor is a 422 and never reaches SQL
    const bad = await call(
      app,
      "GET",
      `${BASE}/claims?providerEntityId=${otherProviderEntityId}&cursor=AAAA`,
      { user: "pe2" },
    );
    expect(bad.statusCode).toBe(422);
  });

  it("hits the scan cap for an actor whose caseload holds none of a long queue: empty page, hasMore, a cursor that continues (#726)", async () => {
    const s = await seed("not_required");
    const app = server(s.admissionId);
    await bulkClaims(providerEntityId, s.planId, 620, "CAP");
    const first = await call(app, "GET", `${BASE}/claims?providerEntityId=${providerEntityId}`, {
      user: "nocase",
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { items: unknown[]; hasMore: boolean; nextCursor: string | null };
    expect(body.items).toEqual([]); // nothing reachable in the first 500 rows scanned
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).not.toBeNull();
    // following the cursor reaches the end (still nothing reachable) and then stops
    const { ids, pages } = await follow(
      app,
      `${BASE}/claims?providerEntityId=${providerEntityId}`,
      "nocase",
    );
    expect(ids).toEqual([]);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages.at(-1)?.cursor).toBeNull();
  });

  it("scopes the DATA: an entity the actor reaches does not open another entity's patient, claim or authorizations", async () => {
    const s = await seed("required_at_admission");
    const app = server(s.admissionId);
    const before = await claimCount();
    // the actor reaches entity 2 and names it, but the patient is admitted under entity 1: the ABAC check alone would pass
    const crossAssemble = await call(app, "POST", `${BASE}/claims/assemble`, {
      user: "pe2",
      payload: assembleBody(s.patientId, { providerEntityId: otherProviderEntityId }),
    });
    expect(crossAssemble.statusCode).toBe(404);
    // a patient outside the actor's caseload (the service applies the caseload axis the route's entity check does not)
    expect(
      (
        await call(app, "POST", `${BASE}/claims/assemble`, {
          user: "nocase",
          payload: assembleBody(s.patientId),
        })
      ).statusCode,
    ).toBe(404);
    expect(await claimCount()).toBe(before);

    const claimId = (
      await call(app, "POST", `${BASE}/claims/assemble`, { payload: assembleBody(s.patientId) })
    ).json().claimId as string;
    for (const user of ["pe2", "nocase"]) {
      expect((await call(app, "GET", `${BASE}/claims/${claimId}`, { user })).statusCode).toBe(404);
      expect(
        (await call(app, "POST", `${BASE}/claims/${claimId}/ready`, { user })).statusCode,
      ).toBe(404);
      expect((await call(app, "POST", `${BASE}/claims/${claimId}/void`, { user })).statusCode).toBe(
        404,
      );
      expect(
        (
          await call(
            app,
            "POST",
            `${BASE}/claims/${claimId}/validation-results/${randomUUID()}/override`,
            { user, stepUp: true, payload: { reason: REASON } },
          )
        ).statusCode,
      ).toBe(404);
    }

    const recorded = await call(app, "POST", `${BASE}/authorizations`, {
      payload: {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-S1",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
      },
    });
    expect(recorded.statusCode).toBe(201);
    const authBody = (pe: string) => ({
      providerEntityId: pe,
      patientId: s.patientId,
      planId: s.planId,
      authorizationNumber: "AUTH-S2",
      obtainedOn: "2026-02-20",
      effectiveFrom: "2026-03-01",
    });
    expect(
      (
        await call(app, "POST", `${BASE}/authorizations`, {
          user: "pe2",
          payload: authBody(otherProviderEntityId),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, "POST", `${BASE}/authorizations`, {
          user: "nocase",
          payload: authBody(providerEntityId),
        })
      ).statusCode,
    ).toBe(404);
    const listUrl = (pe: string) =>
      `${BASE}/authorizations?providerEntityId=${pe}&patientId=${s.patientId}`;
    expect(
      (await call(app, "GET", listUrl(otherProviderEntityId), { user: "pe2" })).statusCode,
    ).toBe(404);
    expect((await call(app, "GET", listUrl(providerEntityId), { user: "pe2" })).statusCode).toBe(
      404,
    );
    expect((await call(app, "GET", listUrl(providerEntityId), { user: "nocase" })).statusCode).toBe(
      404,
    );
    expect(
      (
        await call(app, "POST", `${BASE}/authorizations/${recorded.json().id}/status`, {
          user: "pe2",
          payload: { status: "voided" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, "POST", `${BASE}/authorizations/${recorded.json().id}/status`, {
          user: "nocase",
          payload: { status: "voided" },
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(app, "GET", listUrl(providerEntityId))).json().items).toHaveLength(1);

    // an admission recorded under the other entity cannot be billed by this one
    admissionProvider = otherProviderEntityId;
    expect(
      (await call(app, "POST", `${BASE}/authorizations`, { payload: authBody(providerEntityId) }))
        .statusCode,
    ).toBe(404);
  });

  it("overrides a soft block over HTTP: 404 for an ineligible role, 403 without step-up, 422 for a short reason, 201, then 409", async () => {
    const s = await seed("confirm_with_payer");
    const app = server(s.admissionId);
    const claimId = (
      await call(app, "POST", `${BASE}/claims/assemble`, { payload: assembleBody(s.patientId) })
    ).json().claimId as string;
    const view = (await call(app, "GET", `${BASE}/claims/${claimId}`)).json();
    const soft = view.validation.results.find(
      (r: { ruleKey: string }) => r.ruleKey === "authorization_on_file",
    );
    expect(soft).toMatchObject({ overridable: true, blocking: true });
    const url = `${BASE}/claims/${claimId}/validation-results/${soft.id}/override`;
    const blocked = await call(app, "POST", `${BASE}/claims/${claimId}/ready`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("COMMERCIAL_CLAIM_BLOCKED");

    const overrides = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM commercial_validation_override WHERE claim_id=$1",
          [claimId],
        )
      ).rows[0].n as number;
    expect(
      (
        await call(app, "POST", url, {
          user: "ineligible",
          stepUp: true,
          payload: { reason: REASON },
        })
      ).statusCode,
    ).toBe(404);
    expect((await call(app, "POST", url, { payload: { reason: REASON } })).statusCode).toBe(403); // no step-up
    expect(
      (await call(app, "POST", url, { user: "ai", stepUp: true, payload: { reason: REASON } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(app, "POST", url, { stepUp: true, payload: { reason: "too short" } })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(await overrides()).toBe(0);

    const ok = await call(app, "POST", url, { stepUp: true, payload: { reason: REASON } });
    expect(ok.statusCode).toBe(201);
    expect(await overrides()).toBe(1);
    expect(await scalarAudit(soft.id)).toBe(1);
    expect(
      (await call(app, "POST", url, { stepUp: true, payload: { reason: REASON } })).statusCode,
    ).toBe(409);
    expect((await call(app, "POST", `${BASE}/claims/${claimId}/ready`)).json().state).toBe("ready");
  });

  it("guards submit and reconcile over HTTP with the real RBAC: step-up, AI actor, role and Idempotency-Key; an unbound transport writes nothing", async () => {
    const s = await seed("not_required");
    const app = server(s.admissionId);
    const claimId = (
      await call(app, "POST", `${BASE}/claims/assemble`, { payload: assembleBody(s.patientId) })
    ).json().claimId as string;
    expect((await call(app, "POST", `${BASE}/claims/${claimId}/ready`)).json().state).toBe("ready");
    const submit = `${BASE}/claims/${claimId}/submit`;
    const reconcile = `${BASE}/claims/${claimId}/submissions/${randomUUID()}/reconcile`;
    const rows = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM commercial_submission WHERE claim_id=$1",
          [claimId],
        )
      ).rows[0].n as number;

    for (const url of [submit, reconcile]) {
      const payload = url === submit ? undefined : { outcome: "not_received" };
      const stale = await call(app, "POST", url, { payload });
      expect(stale.statusCode).toBe(403);
      expect(stale.json().error.code).toBe("STEP_UP_REQUIRED");
      expect((await call(app, "POST", url, { user: "ai", stepUp: true, payload })).statusCode).toBe(
        403,
      );
      expect(
        (await call(app, "POST", url, { user: "ineligible", stepUp: true, payload })).statusCode,
      ).toBeGreaterThanOrEqual(403);
      const noKey = await call(app, "POST", url, { stepUp: true, payload, key: false });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
    expect(await rows()).toBe(0);

    // fresh step-up, a human with the key, but no clearinghouse is bound: refused with the stable code, nothing written
    const refused = await call(app, "POST", submit, { stepUp: true });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("COMMERCIAL_SEND_REFUSED");
    expect(JSON.stringify(refused.json())).toContain("CH_NOT_WIRED");
    expect(await rows()).toBe(0);
    // a submission id that does not exist is a 404, not a state change
    const missing = await call(app, "POST", reconcile, {
      stepUp: true,
      payload: { outcome: "not_received" },
    });
    expect(missing.statusCode).toBe(404);
    // read-only gate view works for the same actor and shows the same reason
    const gate = await call(app, "GET", `${submit.replace("/submit", "/send-gate")}`);
    expect(gate.statusCode).toBe(200);
    expect(gate.json()).toMatchObject({ canSubmit: false, clearinghouseKey: null });
  });

  async function scalarAudit(resultId: string): Promise<number> {
    return (
      await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m41.validation.override_applied' AND resource_id=$1",
        [resultId],
      )
    ).rows[0].n as number;
  }

  it("refuses to override a hard block (403) and answers ready with 409 naming the block", async () => {
    const s = await seed("required_at_admission");
    const app = server(s.admissionId);
    const claimId = (
      await call(app, "POST", `${BASE}/claims/assemble`, { payload: assembleBody(s.patientId) })
    ).json().claimId as string;
    const view = (await call(app, "GET", `${BASE}/claims/${claimId}`)).json();
    const hard = view.validation.results.find(
      (r: { ruleKey: string }) => r.ruleKey === "authorization_on_file",
    );
    expect(hard).toMatchObject({ overridable: false, blocking: true });
    const res = await call(
      app,
      "POST",
      `${BASE}/claims/${claimId}/validation-results/${hard.id}/override`,
      { stepUp: true, payload: { reason: REASON } },
    );
    expect(res.statusCode).toBe(403);
    const ready = await call(app, "POST", `${BASE}/claims/${claimId}/ready`);
    expect(ready.statusCode).toBe(409);
    expect(ready.json().error.message).toMatch(/Pre-authorization is required/);
    expect(ready.json().error.details.map((d: { field: string }) => d.field)).toContain(
      "authorization_on_file",
    );
  });

  it("refuses a non-commercial primary over HTTP with the stable code, and records and lists an authorization", async () => {
    const s = await seed("required_at_admission");
    const app = server(s.admissionId);
    const medicareOnly = (
      await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,'Jane','Doe','1950-01-01','female','active') RETURNING id`,
        [ORG, `mrn-${randomUUID().slice(0, 8)}`],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_payer (patient_id, organization_id, payer_id, rank, coverage_kind, subscriber_id, effective_from)
       VALUES ($1,$2,$3,1,'medicare_ffs','1EG4TE5MK73','2026-01-01')`,
      [medicareOnly, ORG, medicarePayer],
    );
    const refused = await call(app, "POST", `${BASE}/claims/assemble`, {
      payload: assembleBody(medicareOnly),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("NON_COMMERCIAL_PRIMARY_PAYER");

    const recorded = await call(app, "POST", `${BASE}/authorizations`, {
      payload: {
        providerEntityId,
        patientId: s.patientId,
        planId: s.planId,
        authorizationNumber: "AUTH-9",
        obtainedOn: "2026-02-20",
        effectiveFrom: "2026-03-01",
      },
    });
    expect(recorded.statusCode).toBe(201);
    expect(recorded.body).not.toContain("AUTH-9");
    const list = await call(
      app,
      "GET",
      `${BASE}/authorizations?providerEntityId=${providerEntityId}&patientId=${s.patientId}`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    const listed = await admin.query(
      "SELECT 1 FROM audit_event WHERE event_type='commercial_authorization.list_viewed'",
    );
    expect(listed.rows.length).toBeGreaterThan(0);
    const status = await call(app, "POST", `${BASE}/authorizations/${recorded.json().id}/status`, {
      payload: { status: "voided" },
    });
    expect(status.json().status).toBe("voided");
    expect(commercialPayer).toBeTruthy();
  });
});
