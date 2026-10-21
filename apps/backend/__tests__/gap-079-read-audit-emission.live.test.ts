/**
 * GAP-079 — the M26 Cap + M39 Consent PHI reads emit real `audit_event` rows, against real Postgres.
 *
 * Both modules' patient-scoped GETs sat outside `DEFAULT_READ_AUDIT_PREFIXES`, so the fail-closed
 * coverage hook never looked at them: they registered with nothing to declare and emitted nothing.
 * Per-beneficiary Medicare cap accrual data and every consent-record-keyed read left no trail at all
 * — an accounting-of-disclosures request under §164.528, or a snooping investigation, could not have
 * reconstructed them.
 *
 * The in-process suites (read-audit-coverage / read-audit-emission) prove the DECLARATIONS and the
 * hook's resolution logic against a fake db. This one proves the other half: a real HTTP GET through
 * the real route config, through `withOrgContext` as the NOBYPASSRLS `chartwarden_app` role, lands a row
 * in the partitioned `audit_event` table that the §164.528 accounting query can actually find — it
 * joins on `context->>'patientId'` (packages/audit `touchesPatient`), which is why the assertions
 * here are on that field and not merely on the event's existence.
 *
 * The consent/cap DATA comes from the modules' in-memory services: what is under test is the read
 * trail the host emits, not either module's store (covered by their own live suites).
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run \
 *     apps/backend/__tests__/gap-079-read-audit-emission.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import {
  type ConsentRecordView,
  type ConsentRouteService,
  createInMemoryConsentRouteService,
} from "@chartwarden/consent";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerCapRoutes } from "../src/modules/26-cap/routes/cap.routes";
import type { M26ReadService } from "../src/modules/26-cap/routes/read-service";
import type { M26WriteService } from "../src/modules/26-cap/routes/write-service";
import { registerConsentRoutes } from "../src/modules/39-consent/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import {
  DEFAULT_TEST_ROLE,
  PERMISSIVE_ACCESS,
  installPermissiveConsentAbac,
} from "./consent-abac-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const CONSENT = "55555555-5555-4555-8555-555555555555";
const PERIOD = "66666666-6666-4666-8666-666666666666";

/** The permissions the two read surfaces gate on (§4.6/§4.7 keys, unchanged by this suite). */
const PERMISSIONS = [
  "consent.read",
  "consent.read_history",
  "consent.read_eval_audit",
  "cap.accrual.read",
  "cap.projection.read",
  "cap.event.read",
  "cap.period.read",
];

function headerAuth(request: FastifyRequest): void {
  request.context.userId = USER;
  request.context.organizationId = ORG;
  // GAP-109: the decision-audit list is compliance/privacy-officer only, so a request may name its role.
  const role = request.headers["x-test-role"];
  request.context.roles = [typeof role === "string" ? role : DEFAULT_TEST_ROLE];
}

const consentRecord: ConsentRecordView = {
  id: CONSENT,
  organizationId: ORG,
  patientId: PATIENT,
  typeKey: "42_cfr_part_2_release",
  grantorKind: "patient_self",
  captureMethod: "typed_signature_in_app",
  scopeDescriptor: {},
  status: "active",
  version: 1,
  effectiveAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  signedAt: "2026-01-01T00:00:00.000Z",
  createdById: USER,
};

/**
 * The M26 read methods these three routes call. Cast once: the routes only ever invoke what is
 * defined here, and a drift in the methods under test still fails to compile.
 */
const capReadService = {
  getPatientAccrual: async () => ({
    patientId: PATIENT,
    capPeriodId: PERIOD,
    paidCents: 125_000,
    outstandingBilledCents: 0,
    firstElectionInPeriod: "2026-01-15",
    lastPaidThrough: "2026-06-30",
  }),
  listAccrualLines: async () => ({
    items: [
      {
        id: "line-1",
        sourceKind: "claim",
        sourceId: "c1",
        amountCents: 125_000,
        serviceFrom: "2026-01-15",
        serviceTo: "2026-01-31",
        postedAt: "2026-02-01T00:00:00.000Z",
      },
    ],
    nextCursor: null,
  }),
  listPeriods: async () => [],
} as unknown as M26ReadService;

describe.skipIf(!DB_URL)("GAP-079 read-audit emission — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  /** The audit rows this request wrote, newest last. */
  async function readEvents(): Promise<
    Array<{ event_type: string; resource_id: string | null; context: Record<string, unknown> }>
  > {
    const { rows } = await admin.query(
      `SELECT event_type, resource_id::text, context, actor_user_id::text
         FROM audit_event WHERE organization_id = $1 ORDER BY created_at, event_type`,
      [ORG],
    );
    return rows;
  }

  /** Build the host with the REAL default read-audit prefixes + a live db, and mount both surfaces. */
  function makeApp() {
    const grantStore = createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: USER,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: PERMISSIONS }],
      },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    // GAP-109: the consent routes are ABAC-gated now; this suite proves read-audit emission, not scope.
    installPermissiveConsentAbac();
    const app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    const { service } = createInMemoryConsentRouteService({ records: [consentRecord] });
    registerConsentRoutes(app, {
      service: service as unknown as ConsentRouteService,
      access: PERMISSIVE_ACCESS,
    });
    registerCapRoutes(app, {
      readService: capReadService,
      writeService: {} as M26WriteService,
    });
    return app;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'gap079@x.test')`, [USER]);
    // Production connects as the NOBYPASSRLS `chartwarden_app` role; the audit insert must succeed as it.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await admin.query("DELETE FROM audit_event WHERE organization_id = $1", [ORG]);
  });

  it("GET /consents/:consentId writes consent.viewed attributed to the patient in the RESPONSE", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: `/api/v1/consents/${CONSENT}` });
    expect(res.statusCode).toBe(200);
    await app.close();

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("consent.viewed");
    // The route is keyed by consent id; without the payload fallback this field would be absent and
    // the read would never surface in the patient's §164.528 accounting.
    expect(events[0].context.patientId).toBe(PATIENT);
    expect(events[0].resource_id).toBe(CONSENT);
    // Field NAMES are recorded, never values (§2.3).
    expect(events[0].context.fields).toContain("status");
  });

  it("GET /consents/:consentId/version-chain writes an attributed history read", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/consents/${CONSENT}/version-chain`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const events = await readEvents();
    expect(events.map((e) => e.event_type)).toEqual(["consent_version_chain.viewed"]);
    expect(events[0].resource_id).toBe(CONSENT);
  });

  it("GET /consents/eval-audit/by-patient writes a list read attributed via the QUERY param", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/consents/eval-audit/by-patient?patientId=${PATIENT}`,
      headers: { "x-test-role": "compliance_officer" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("consent_eval_audit.list_viewed");
    expect(events[0].context.patientId).toBe(PATIENT);
    expect(events[0].context.count).toBe(0);
  });

  it("GET /cap/accruals/patient/… writes cap_accrual.viewed for the named beneficiary", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/cap/accruals/patient/${PERIOD}/${PATIENT}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("cap_accrual.viewed");
    expect(events[0].context.patientId).toBe(PATIENT);
    // No resourceIdParam is declared, so the read is accounted against the patient itself (§164.528).
    expect(events[0].resource_id).toBe(PATIENT);
    expect(events[0].context.fields).toContain("paidCents");
  });

  it("GET /cap/accruals/patient/…/lines writes ONE aggregate list event, not one per line (§3.4)", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/cap/accruals/patient/${PERIOD}/${PATIENT}/lines`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("cap_accrual_line.list_viewed");
    expect(events[0].context.patientId).toBe(PATIENT);
    expect(events[0].context.count).toBe(1);
  });

  it("a waived read (agency-level cap periods) writes nothing", async () => {
    const app = makeApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/cap/periods" });
    expect(res.statusCode).toBe(200);
    await app.close();

    expect(await readEvents()).toHaveLength(0);
  });

  it("a DENIED read writes nothing — the trail records reads that happened, not attempts", async () => {
    const grantStore = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: USER, grants: [] },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    const app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    const { service } = createInMemoryConsentRouteService({ records: [consentRecord] });
    registerConsentRoutes(app, { service: service as unknown as ConsentRouteService });
    const res = await app.inject({ method: "GET", url: `/api/v1/consents/${CONSENT}` });
    expect(res.statusCode).toBe(403);
    await app.close();

    expect(await readEvents()).toHaveLength(0);
  });
});
