// apps/backend/__tests__/_dde-live-harness.ts — shared setup for the DDE work-queue live suites (test support, not a
// test file): a migrated database, the superuser seeding client, the real NOBYPASSRLS `chartwarden_app` client, the real
// catalog-validating outbox publisher, and a Fastify app with the REAL Authorization Contract (RBAC, the real
// `provider_entity_billing_scope` predicate over the Drizzle resolver, step-up) in front of the real DDE service.
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
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
import { buildDrizzleM23AbacResolver } from "../src/modules/23-billing-medicare/abac-resolver-drizzle";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import { M23_PERMISSION_KEY_LIST } from "../src/modules/23-billing-medicare/permission-keys";
import { registerDdeQueueRoutes } from "../src/modules/23-billing-medicare/routes/dde-queue.routes";
import {
  type DdeQueueServicePorts,
  buildDdeQueueService,
} from "../src/modules/23-billing-medicare/services/dde-queue-service";
import { appRoleConnectionString } from "./_live-app-role";

const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
export const ORG_A = "11111111-1111-1111-1111-111111111111";
export const ORG_B = "22222222-2222-2222-2222-222222222222";
export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** A second member of ORG_A holding read / work / mark_submitted but NOT `billing.dde.admin`. */
export const USER_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const MEMBERSHIP_C = "c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1";
export const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
export const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
export const PE_A = "77777777-7777-4777-8777-777777777777";
export const PE_B = "88888888-8888-4888-8888-888888888888";
export const BASE = "/api/v1/billing/dde-items";

export function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  const orgB = user === USER_B;
  request.context.userId = user;
  request.context.organizationId = orgB ? ORG_B : ORG_A;
  // Default: an org-wide billing role. `x-test-roles` / `x-test-pe` narrow the actor to a provider-entity reach.
  const roles = request.headers["x-test-roles"];
  request.context.roles =
    typeof roles === "string" ? roles.split(",").filter((r) => r.length > 0) : ["org_admin"];
  const pe = request.headers["x-test-pe"];
  if (typeof pe === "string") {
    request.context.providerEntityIds = pe.split(",").filter((r) => r.length > 0);
  }
  request.context.attributes.membershipId = orgB
    ? MEMBERSHIP_B
    : user === USER_C
      ? MEMBERSHIP_C
      : MEMBERSHIP_A;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
}

export interface DdeLiveDb {
  readonly admin: Client;
  readonly handle: { db: DbClient; close: () => Promise<void> };
  readonly appUrl: string;
  readonly publisher: ReturnType<typeof buildTxOutboxPublisher>;
  /** A publisher bound to a caller module, in the shape the services' outbox ports take. */
  bound(module: string): never;
}

/** Migrate a fresh database, seed two orgs and two users, and open the real app-role client. */
export async function connectDdeLiveDb(dbUrl: string): Promise<DdeLiveDb> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  for (const r of ROLES) {
    await admin.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
        `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
    );
  }
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  for (const [id, slug] of [
    [ORG_A, "org-a"],
    [ORG_B, "org-b"],
  ] as const) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
      [id, slug, slug],
    );
  }
  await admin.query(
    `INSERT INTO "user" (id,email) VALUES ($1,'dde-a@x.test'),($2,'dde-b@x.test'),($3,'dde-c@x.test')`,
    [USER_A, USER_B, USER_C],
  );
  const appUrl = await appRoleConnectionString(admin, dbUrl);
  const handle = createDbClient({ connectionString: appUrl });
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
  const bound = (module: string) =>
    ({
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: module } as never),
    }) as never;
  return { admin, handle, appUrl, publisher, bound };
}

/** Fresh authorization contract + a DDE app over the real service. Call from `beforeEach`. */
export async function buildDdeApp(
  live: DdeLiveDb,
  ports: Partial<DdeQueueServicePorts> = {},
): Promise<FastifyInstance> {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  const grants = (userId: string, orgId: string) => ({
    orgId,
    userId,
    grants: [
      {
        roleKey: "seed",
        enabled: true,
        expiresAt: null,
        permissionKeys: [...M23_PERMISSION_KEY_LIST],
      },
    ],
  });
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants(USER_A, ORG_A),
      grants(USER_B, ORG_B),
      {
        orgId: ORG_A,
        userId: USER_C,
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["billing.dde.read", "billing.dde.work", "billing.dde.mark_submitted"],
          },
        ],
      },
    ]).store,
  );
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(
    buildM23AbacPredicates({
      resolver: buildDrizzleM23AbacResolver(live.handle.db as never),
      isInCaseload: async () => true,
    }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);
  const app = buildServer({
    db: live.handle.db,
    authenticate: headerAuth,
    security: { rateLimitEnabled: false },
  });
  registerDdeQueueRoutes(app, {
    ddeQueueService: buildDdeQueueService(live.handle.db as never, {
      outbox: live.bound("m23"),
      ...ports,
    }),
  });
  await app.ready();
  return app;
}

/** Seed an NOE directly as the superuser (logical FKs only, so random ids are fine). */
export async function seedNoe(
  admin: Client,
  over: Partial<{
    state: string;
    windowTarget: string;
    electionDate: string;
    orgId: string;
    providerEntityId: string;
  }> = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO noe_record (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id,
       state, election_effective_date, window_target_at, noe_control_number)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      over.orgId ?? ORG_A,
      over.providerEntityId ?? PE_A,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      over.state ?? "READY",
      over.electionDate ?? "2026-01-15",
      over.windowTarget ?? "2026-01-20",
      `NOE${id.slice(0, 12)}`,
    ],
  );
  return id;
}

/** Seed an NOTR directly as the superuser. */
export async function seedNotr(
  admin: Client,
  over: Partial<{ state: string; windowTarget: string; endDate: string }> = {},
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO notr_record (id, organization_id, provider_entity_id, patient_id, admission_id, trigger_kind, discharge_event_id,
       state, effective_end_date, window_target_at, notr_control_number)
     VALUES ($1,$2,$3,$4,$5,'discharge',gen_random_uuid(),$6,$7,$8,$9)`,
    [
      id,
      ORG_A,
      PE_A,
      randomUUID(),
      randomUUID(),
      over.state ?? "READY",
      over.endDate ?? "2026-01-15",
      over.windowTarget ?? "2026-01-20",
      `NOTR${id.slice(0, 11)}`,
    ],
  );
  return id;
}

/**
 * Seed a claim (default `ACK_PENDING`) and the 837I submission that answers it, directly as the superuser (logical FKs
 * only, so random ids are fine). Returns the ids the ack cron needs.
 */
export async function seedClaimWithSubmission(
  admin: Client,
  over: Partial<{ state: string; orgId: string; providerEntityId: string; patientId: string }> = {},
): Promise<{ claimId: string; submissionId: string; patientId: string }> {
  const claimId = randomUUID();
  const submissionId = randomUUID();
  const patientId = over.patientId ?? randomUUID();
  const org = over.orgId ?? ORG_A;
  const pe = over.providerEntityId ?? PE_A;
  const ccn = `CCN${claimId.slice(0, 12)}`;
  await admin.query(
    `INSERT INTO claim (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id_from,
       election_period_id_to, patient_payer_id, tob, service_from, service_to, state, claim_control_number,
       mac_jurisdiction, sequestration_applied_pct, sequestration_policy_id, created_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'811','2026-01-01','2026-01-31',$8,$9,'ngs_j6','2.00',$10,$11)`,
    [
      claimId,
      org,
      pe,
      patientId,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      over.state ?? "ACK_PENDING",
      ccn,
      randomUUID(),
      MEMBERSHIP_A,
    ],
  );
  await admin.query(
    `INSERT INTO claim_submission (id, organization_id, provider_entity_id, kind, claim_id, claim_control_number, attempt_index)
     VALUES ($1,$2,$3,'claim_837i',$4,$5,0)`,
    [submissionId, org, pe, claimId, ccn],
  );
  return { claimId, submissionId, patientId };
}
