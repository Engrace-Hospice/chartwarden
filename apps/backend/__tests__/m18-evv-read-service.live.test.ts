/**
 * M18 EVV — the Drizzle `createDbEvvBackend` READ paths, proven against real Postgres (mirrors M6L-T01).
 *
 * M18's pure suites exercise the check-in/check-out pairing and aggregator machinery in memory; the RLS
 * live suite proves the policies at the table level. Neither drives the PRODUCTION read service — the one
 * the composition root casts to `EvvRouteService` and mounts. This applies the real migrations, seeds a full
 * EVV chain per tenant as superuser, then drives `createDbEvvBackend` over the M18-owned tables as the
 * unprivileged (NOBYPASSRLS) `chartwarden_app` role under `withOrgContext`, proving:
 *   • the event ledger / device roster reads return the seeded rows, coordinate-free on the wire (§4.3);
 *   • the production aggregator route returns its evidence projection, tenant-scoped, and emits its list-read audit;
 *   • RLS scopes every read by tenant (org B cannot see org A's event, and `getEvent` cross-tenant 404s);
 *   • the live write lifecycle persists through the same app-role connection.
 *
 * Gated on a live DB (default `bun run test` skips it):
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m18-evv-read-service.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbEvvBackend, registerEvvRoutes } from "../src/modules/18-evv/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** `evv_device.membership_id` / `evv_geofence_policy.set_by_membership_id` FK `membership`; each org needs one. */
const USER = "33333333-3333-3333-3333-333333333333";
/** visit_id / patient_id / device_attestation_id_at_record carry NO SQL FK (app-validated) — literals are fine. */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const VISIT = "55555555-5555-5555-5555-555555555555";
const DEVICE_ATTEST = "66666666-6666-6666-6666-666666666666";

type SeedIds = {
  membership: string;
  evvDevice: string;
  evvEvent: string;
  aggregatorSubmission: string;
};

function headerAuth(request: FastifyRequest): void {
  const userId = request.headers["x-test-user"];
  const organizationId = request.headers["x-test-org"];
  const membershipId = request.headers["x-test-membership"];
  if (typeof userId !== "string" || typeof organizationId !== "string") return;
  request.context.userId = userId;
  request.context.organizationId = organizationId;
  request.context.attributes.membershipId = typeof membershipId === "string" ? membershipId : "";
}

describe.skipIf(!DB_URL)("M18 EVV Drizzle read service — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbEvvBackend>;
  let app: ReturnType<typeof buildServer>;
  const seeded: Record<string, SeedIds> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const f of files) await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Seed one full M18 EVV chain for `org` as superuser (RLS + grants bypassed). */
  async function seedOrg(org: string, n: number): Promise<SeedIds> {
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, org],
      )
    ).rows[0].id as string;
    const providerEntity = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M18R${n}`, `M18R ${n}`, `NPI-M18R${n}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntity, `Loc-M18R${n}`],
      )
    ).rows[0].id as string;
    const evvDevice = (
      await admin.query(
        `INSERT INTO evv_device (organization_id, membership_id, platform, device_key_fingerprint,
           m2_device_attestation_id)
         VALUES ($1,$2,'ios',$3,$4) RETURNING id`,
        [org, membership, `fp-M18R${n}`, DEVICE_ATTEST],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO evv_geofence_policy (organization_id, scope, radius_m, max_accuracy_m, effective_from,
         set_by_membership_id)
       VALUES ($1,'tenant',150,50, now()::date, $2)`,
      [org, membership],
    );
    // event_at = now() routes into the current-month partition (0047 pre-creates current + 12 forward months).
    const evvEvent = (
      await admin.query(
        `INSERT INTO evv_event (organization_id, provider_entity_id, location_id, visit_id, patient_id, kind,
           service_type_code, posting_membership_id, posting_discipline_at_recording, evv_device_id,
           captured_at, event_at, coords_cipher, coords_dek_version, accuracy_m, gps_quality,
           device_attestation_id_at_record)
         VALUES ($1,$2,$3,$4,$5,'check_in','T1021',$6,'rn',$7, now(), now(),'enc',1,4.5,'high',$8)
         RETURNING id`,
        [org, providerEntity, location, VISIT, PATIENT, membership, evvDevice, DEVICE_ATTEST],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO evv_missing_resolution (organization_id, visit_id, kind, detected_by_source)
       VALUES ($1,$2,'missing_checkout','sync_reconcile')`,
      [org, VISIT],
    );
    const aggregatorSubmission = (
      await admin.query(
        `INSERT INTO evv_aggregator_submission
           (organization_id, visit_id, check_in_event_id, state_code, aggregator_vendor, status,
            attempt_count, last_attempt_at, next_retry_at, submitted_at, aggregator_transaction_id,
            aggregator_response_at, aggregator_rejection_code, aggregator_rejection_reason)
         VALUES ($1,$2,$3,'OR','sandata','rejected',3,
           '2026-11-18T18:01:02.000Z','2026-11-18T18:31:02.000Z','2026-11-18T18:01:03.000Z',
           $4,'2026-11-18T18:01:04.000Z','EVV-42','Synthetic provider enrollment mismatch')
         RETURNING id`,
        [org, VISIT, evvEvent, `txn-m18r-${n}`],
      )
    ).rows[0].id as string;
    return { membership, evvDevice, evvEvent, aggregatorSubmission };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m18r@x.test')`, [USER]);
    seeded[ORG_A] = await seedOrg(ORG_A, 1);
    seeded[ORG_B] = await seedOrg(ORG_B, 2);
    // Prod connects as the NOBYPASSRLS `chartwarden_app` role; `withOrgContext` does NOT SET ROLE, so to exercise
    // RLS faithfully connect the client AS chartwarden_app — NOLOGIN in the migrations, so grant LOGIN here.
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    service = createDbEvvBackend(handle.db);
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG_A,
          userId: USER,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["evv.aggregator.read"],
            },
          ],
        },
      ]).store,
    );
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerEvvRoutes(app, {
      service,
      assertMayStartVisit: async () => undefined,
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("listEvents returns the org's EVV event, coordinate-free on the wire (§4.3, RLS-scoped)", async () => {
    const events = await service.listEvents(ORG_A, {});
    expect(events.length).toBe(1);
    const dto = events[0];
    expect(dto.id).toBe(seeded[ORG_A].evvEvent);
    expect(dto.organizationId).toBe(ORG_A);
    expect(dto.kind).toBe("check_in");
    // §4.3: the event projection NEVER carries coordinates on the wire.
    expect("lat" in dto).toBe(false);
    expect("lng" in dto).toBe(false);
    expect("coordsCipher" in dto).toBe(false);
  });

  it("listDevices returns the org's device roster (RLS-scoped)", async () => {
    const devices = await service.listDevices(ORG_A);
    expect(devices.length).toBe(1);
    expect(devices[0].id).toBe(seeded[ORG_A].evvDevice);
    expect(devices[0].membershipId).toBe(seeded[ORG_A].membership);
    expect(devices[0].platform).toBe("ios");
  });

  it("RLS: org B cannot see org A's event through the read service", async () => {
    const bEvents = await service.listEvents(ORG_B, {});
    expect(bEvents.every((e) => e.id !== seeded[ORG_A].evvEvent)).toBe(true);
    expect(bEvents.every((e) => e.organizationId === ORG_B)).toBe(true);
    // getEvent scopes by app.org_id too → org A's event is a 404 for org B (NotFoundError, statusCode 404).
    await expect(service.getEvent(ORG_B, seeded[ORG_A].evvEvent)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("the production aggregator route returns evidence under RLS and writes its list-read audit", async () => {
    await admin.query(
      "DELETE FROM audit_event WHERE organization_id=$1 AND event_type='evv_aggregator_submission.list_viewed'",
      [ORG_A],
    );
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/evv/aggregator-submissions?stateCode=OR&status=rejected",
      headers: {
        "x-test-user": USER,
        "x-test-org": ORG_A,
        "x-test-membership": seeded[ORG_A].membership,
      },
    });
    expect(response.statusCode).toBe(200);
    const submissions =
      response.json<
        Array<{
          id: string;
          aggregatorTransactionId: string | null;
          attemptCount: number;
          lastAttemptAt: string | null;
          nextRetryAt: string | null;
          submittedAt: string | null;
          aggregatorResponseAt: string | null;
          aggregatorRejectionCode: string | null;
          aggregatorRejectionReason: string | null;
        }>
      >();
    expect(submissions).toEqual([
      expect.objectContaining({
        id: seeded[ORG_A].aggregatorSubmission,
        aggregatorTransactionId: "txn-m18r-1",
        attemptCount: 3,
        lastAttemptAt: "2026-11-18T18:01:02.000Z",
        nextRetryAt: "2026-11-18T18:31:02.000Z",
        submittedAt: "2026-11-18T18:01:03.000Z",
        aggregatorResponseAt: "2026-11-18T18:01:04.000Z",
        aggregatorRejectionCode: "EVV-42",
        aggregatorRejectionReason: "Synthetic provider enrollment mismatch",
      }),
    ]);
    expect(submissions.some((row) => row.id === seeded[ORG_B].aggregatorSubmission)).toBe(false);

    const auditRows = (
      await admin.query<{ actor_user_id: string; context: { count?: number; filter?: unknown } }>(
        `SELECT actor_user_id::text AS actor_user_id, context
           FROM audit_event
          WHERE organization_id=$1
            AND event_type='evv_aggregator_submission.list_viewed'
          ORDER BY created_at DESC`,
        [ORG_A],
      )
    ).rows;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actor_user_id: USER,
      context: {
        count: 1,
        filter: { stateCode: "OR", status: "rejected" },
      },
    });
  });

  it("the M18L write lifecycle persists over RLS: selfRegisterDevice round-trips through listDevices", async () => {
    // The write lifecycle is live (no route at 501). A device self-register needs only a membership (no M17
    // visit), so it is the read-suite's persistence smoke-check; the full write suite (m18-evv-write) exhausts
    // capture / geofence / resolution / aggregator. Prove one mutation commits under RLS and reads back scoped.
    const created = await service.selfRegisterDevice(ORG_A, seeded[ORG_A].membership, {
      platform: "android",
      modelDescription: "Pixel 8",
    });
    expect(created.status).toBe("pending_approval");
    const devices = await service.listDevices(ORG_A, seeded[ORG_A].membership);
    expect(devices.some((d) => d.id === created.id && d.platform === "android")).toBe(true);
    // RLS: org B cannot see org A's freshly-written device.
    const bDevices = await service.listDevices(ORG_B);
    expect(bDevices.every((d) => d.id !== created.id)).toBe(true);
  });
});
