/**
 * M34 help requests (slice 7, piece 7B), LIVE Postgres on the real roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m34:help-request:live   (SUPERUSER url, THROWAWAY database)
 *
 * The tenant lane runs as the NOBYPASSRLS `chartwarden_app` role and the operators' lane as the BYPASSRLS `chartwarden_platform`
 * carrier (provisioned by scripts/db/provision-runtime-roles.ts), so every assertion about RLS, a column grant or a pinned policy is
 * made on a connection those rules apply to. The support-grant operations are a TEST DOUBLE (piece 7S's real bundle is joined by the
 * integration step): it inserts a plain `support_consent_grant` row of an EXISTING scope as the app role, and revokes it as the
 * superuser (the carrier's grant UPDATE arrives with 7S's migration).
 *
 *   isolation     a member sees only their organization's requests; a forged organization_id or tenant account is refused
 *   pins          the INSERT is born open by the session's own user through an active membership; the UPDATE touches only the approve and
 *                 close columns, each branch pinned; a closed request cannot move and an approved one keeps its grant
 *   machine       the state CHECK and the guard trigger hold the transitions (as the superuser, so only the schema is under test)
 *   one live      the partial unique index refuses a second live request; the loser of a race is told the winner's id
 *   service       file -> approve -> End help, the operator's Resolve and inbox, ChartWarden staff refused, the real publisher's event
 *   audit         every state change leaves a row naming the actor, and none carries the message or the note
 *   sweep         a stale open request is cancelled and an approved one whose grant ended is resolved, by the system
 *   eraser        the offboarding eraser removes the organization's requests before its grants (the grant FK restricts)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type {
  GrantSessionSummary,
  SupportGrantOperations,
  SupportSessionServiceDeps,
} from "@chartwarden/saas-tenant-platform";
import type { WriteActor } from "@chartwarden/shared/route-kit";
import {
  registerPlatformJob,
  runWithRequestContext,
  withOrgContext,
  withPlatformContext,
} from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { m34PlatformBypassAuditor } from "../src/index";
import { wireM34AlertRuleSeed } from "../src/modules/34-saas-tenant-platform/alert-rule-seed-persister";
import { createDrizzleSaasTenantPlatformEraseStore } from "../src/modules/34-saas-tenant-platform/erasers/saas-tenant-platform-eraser";
import { M34_OUTBOX_EVENTS } from "../src/modules/34-saas-tenant-platform/events-by-m34";
import type { HelpRequestService } from "../src/modules/34-saas-tenant-platform/help/help-request-contract";
import { buildDrizzleHelpRequestService } from "../src/modules/34-saas-tenant-platform/help/help-request-factory";
import {
  createDrizzleHelpRequestRunner,
  createLinkedHelpRequestPort,
} from "../src/modules/34-saas-tenant-platform/help/help-request-store-drizzle";
import { runHelpRequestSweep } from "../src/modules/34-saas-tenant-platform/help/help-request-sweep";
import { createDrizzleAlertEmitter } from "../src/modules/36-messaging/alert-emitter-drizzle";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-help-requests";
const JOB_ID = "m34-help-request-live-test";

const PLATFORM_ORG = "a0000000-0000-4000-8000-0000000000a0";
const ORG_A = "b1000000-0000-4000-8000-0000000000b1";
const ORG_B = "b2000000-0000-4000-8000-0000000000b2";
const T_A = "c1000000-0000-4000-8000-0000000000c1";
const T_B = "c2000000-0000-4000-8000-0000000000c2";

const U_NURSE = "d1000000-0000-4000-8000-0000000000d1";
const U_NURSE_2 = "d2000000-0000-4000-8000-0000000000d2";
const U_ADMIN = "d3000000-0000-4000-8000-0000000000d3";
const U_SUSPENDED = "d4000000-0000-4000-8000-0000000000d4";
const U_B = "d5000000-0000-4000-8000-0000000000d5";
const U_OPS = "d6000000-0000-4000-8000-0000000000d6";
const M_NURSE = "e1000000-0000-4000-8000-0000000000e1";
const M_NURSE_2 = "e2000000-0000-4000-8000-0000000000e2";
const M_ADMIN = "e3000000-0000-4000-8000-0000000000e3";
const M_SUSPENDED = "e4000000-0000-4000-8000-0000000000e4";
const M_B = "e5000000-0000-4000-8000-0000000000e5";
const M_OPS_HOME = "e6000000-0000-4000-8000-0000000000e6";
const M_OPS_IN_A = "e7000000-0000-4000-8000-0000000000e7";

const MESSAGE = "We cannot find our MAC enrolment letter";
const NOTE = "Walked them through the payer list";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const person = (
  userId: string,
  membershipId: string,
  organizationId: string,
  roles: string[] = ["nurse"],
): WriteActor => ({
  organizationId,
  userId,
  membershipId,
  roles,
  locationIds: [],
  sessionClass: "staff",
  actorKind: "user",
  stepUpRecent: true,
});

const NURSE = person(U_NURSE, M_NURSE, ORG_A);
const NURSE_2 = person(U_NURSE_2, M_NURSE_2, ORG_A);
const ADMIN = person(U_ADMIN, M_ADMIN, ORG_A, ["org_admin"]);
const MEMBER_B = person(U_B, M_B, ORG_B, ["org_admin"]);
const OPS_IN_A = person(U_OPS, M_OPS_IN_A, ORG_A, ["org_admin"]);
const OPERATOR: WriteActor = person(U_OPS, M_OPS_HOME, PLATFORM_ORG, ["platform_ops"]);

/** The pg error code under a Drizzle wrapper (or the error's own). */
function pgCode(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor instanceof Error; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!DB_URL)("M34 help requests, LIVE Postgres on the real roles", () => {
  let admin: Client;
  let tenantPool: ReturnType<typeof createDbClient>;
  let platformPool: ReturnType<typeof createDbClient>;
  const sessions = new Map<string, GrantSessionSummary>();

  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await admin.query(text, params)).rows as T[];

  /** SQL as the tenant app role scoped to `org` and acting as `user` (RLS and the column grants apply). */
  const asApp = <T>(org: string, user: string, fn: (tx: DbClient) => Promise<T>) =>
    withOrgContext<DbClient, T>(tenantPool.db, { organizationId: org, userId: user }, fn);
  /** SQL as the platform carrier (BYPASSRLS, column grants only), through the audited platform context. */
  const asCarrier = <T>(fn: (tx: DbClient) => Promise<T>) =>
    withPlatformContext<DbClient, T>(
      platformPool.db,
      { jobId: JOB_ID, reason: "live test: help request carrier", crossTenant: true },
      m34PlatformBypassAuditor,
      fn,
    );
  const refused = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await run();
    } catch (error) {
      return pgCode(error) ?? (error as { code?: string }).code ?? "unknown";
    }
    return undefined;
  };

  // The grant operations double: a plain grant row of an existing scope, as the app role.
  const grantOps: SupportGrantOperations = {
    depsFor: (tx) => ({ tx }) as unknown as SupportSessionServiceDeps,
    async issueAssistGrant(deps, input) {
      const { tx } = deps as unknown as { tx: DbClient };
      const inserted = await tx.execute<{ id: string; expires_at: Date }>(sql`
        INSERT INTO support_consent_grant (organization_id, tenant_account_id, scope, grant_reason, grantor_membership_id, expires_at)
        VALUES (${input.organizationId}, ${input.tenantAccountId}, 'organization_scoped', ${input.reason},
                ${input.grantorMembershipId}, now() + make_interval(hours => ${input.hours}))
        RETURNING id, expires_at`);
      const row = inserted.rows[0];
      if (!row) throw new Error("grant insert returned no row");
      return { grantId: row.id, expiresAt: new Date(row.expires_at) };
    },
    async revokeGrantAndCloseSessions(deps, input) {
      await admin.query(
        "UPDATE support_consent_grant SET revoked_at = now(), revoked_by_membership_id = $2, revocation_reason = $3 WHERE id = $1 AND revoked_at IS NULL",
        [input.grantId, input.revokedByMembershipId, input.reason],
      );
      await deps.linkedHelpRequests?.resolveForRevokedGrant({
        grantId: input.grantId,
        organizationId: input.organizationId,
        source: input.source,
        closedByUserId: null,
        note: null,
      });
      return { closedSessionIds: [] };
    },
    async sessionSummaryForGrant(_tx, grantId) {
      return sessions.get(grantId) ?? null;
    },
  };

  let service: HelpRequestService;
  const runner = () =>
    createDrizzleHelpRequestRunner({
      db: tenantPool.db,
      platformDb: platformPool.db,
      auditBypass: m34PlatformBypassAuditor,
      platformJobId: JOB_ID,
    });

  const filed = async (actor = NURSE, message = MESSAGE, stepKey?: string) =>
    service.file(actor, { message, ...(stepKey ? { stepKey } : {}) });
  const reset = async () => {
    await admin.query("DELETE FROM notification_delivery");
    await admin.query("DELETE FROM alert");
    await admin.query("DELETE FROM tenant_help_request");
    await admin.query("DELETE FROM support_consent_grant");
    await admin.query("DELETE FROM outbox_event WHERE event_type = 'm34.help_request.requested'");
    sessions.clear();
  };
  /** A grant of an existing scope, as the superuser. */
  const grantFor = async (org: string, account: string, membership: string, hours: number) =>
    (
      await q<{ id: string }>(
        `INSERT INTO support_consent_grant (organization_id, tenant_account_id, scope, grant_reason, grantor_membership_id, issued_at, expires_at)
         VALUES ($1,$2,'organization_scoped','live test grant',$3, now() - interval '30 hours', now() + make_interval(hours => $4)) RETURNING id`,
        [org, account, membership, hours],
      )
    )[0]?.id as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await admin.query("CREATE SCHEMA IF NOT EXISTS public");
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [id, slug] of [
      [PLATFORM_ORG, "cw-platform"],
      [ORG_A, "help-a"],
      [ORG_B, "help-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [id, org, name] of [
      [T_A, ORG_A, "Tenant A Hospice"],
      [T_B, ORG_B, "Tenant B Hospice"],
    ] as const) {
      await admin.query(
        `INSERT INTO tenant_account (id, organization_id, status, legal_business_name, billing_contact_email, breach_notification_email)
         VALUES ($1,$2,'onboarding',$3,'b@x.test','p@x.test')`,
        [id, org, name],
      );
    }
    for (const [id, email] of [
      [U_NURSE, "nurse@help.test"],
      [U_NURSE_2, "nurse2@help.test"],
      [U_ADMIN, "admin@help.test"],
      [U_SUSPENDED, "suspended@help.test"],
      [U_B, "b@help.test"],
      [U_OPS, "ops@help.test"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,$2)`, [id, email]);
    }
    for (const [id, user, org, status] of [
      [M_NURSE, U_NURSE, ORG_A, "active"],
      [M_NURSE_2, U_NURSE_2, ORG_A, "active"],
      [M_ADMIN, U_ADMIN, ORG_A, "active"],
      [M_SUSPENDED, U_SUSPENDED, ORG_A, "suspended"],
      [M_B, U_B, ORG_B, "active"],
      [M_OPS_HOME, U_OPS, PLATFORM_ORG, "active"],
      [M_OPS_IN_A, U_OPS, ORG_A, "active"],
    ] as const) {
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,$4)",
        [id, user, org, status],
      );
    }
    // ChartWarden staff: the operator holds the platform-owned `platform_ops` role at home (and is a plain member of tenant A).
    const platformOps = (
      await q<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level)
         VALUES (NULL, 'platform_ops', 'platform_ops', 'platform_staff', 'organization')
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET name = excluded.name RETURNING id`,
      )
    )[0]?.id;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [PLATFORM_ORG, M_OPS_HOME, platformOps],
    );
    const alertAudience = (
      await q<{ id: string }>(
        `INSERT INTO role (organization_id, key, name, category, scope_level)
         VALUES (NULL, 'platform_alert_audience', 'platform_alert_audience', 'platform_staff', 'organization')
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET name = excluded.name RETURNING id`,
      )
    )[0]?.id;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [ORG_A, M_OPS_IN_A, alertAudience],
    );

    tenantPool = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const provisioned = spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: join(__dirname, "../../.."),
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
      },
      encoding: "utf8",
    });
    expect(provisioned.status, provisioned.stderr).toBe(0);
    const platformUrl = new URL(DB_URL as string);
    platformUrl.username = "chartwarden_platform_login";
    platformUrl.password = PLATFORM_PASSWORD;
    platformPool = createDbClient({ connectionString: platformUrl.toString() });
    registerPlatformJob(JOB_ID);
    await wireM34AlertRuleSeed(tenantPool.db);
    const alerts = createDrizzleAlertEmitter(tenantPool.db);

    // The real, catalog-validating publisher: a payload that does not conform to the event rolls the request back.
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M34_OUTBOX_EVENTS]));
    service = buildDrizzleHelpRequestService({
      db: tenantPool.db,
      platformDb: platformPool.db,
      auditBypass: m34PlatformBypassAuditor,
      platformJobId: JOB_ID,
      outbox: {
        publish: (tx, event) => publisher.publish(tx, { ...event, callerModule: "m34" }),
      },
      alerts,
      grants: grantOps,
    });
  }, 300_000);

  afterAll(async () => {
    await tenantPool?.close();
    await platformPool?.close();
    await admin?.end();
  });

  describe("isolation and the INSERT pin, as the tenant app role", () => {
    it("lets a member see their own organization's requests and no other's", async () => {
      await reset();
      const request = await filed();
      const own = await asApp(ORG_A, U_NURSE, (tx) =>
        tx.execute(sql`SELECT id FROM tenant_help_request`),
      );
      expect(own.rows).toEqual([{ id: request.id }]);
      const others = await asApp(ORG_B, U_B, (tx) =>
        tx.execute(sql`SELECT id FROM tenant_help_request`),
      );
      expect(others.rows).toEqual([]);
      const list = await service.listForTenant(MEMBER_B, undefined, undefined);
      expect(list).toMatchObject({ current: null, items: [] });
    });

    it("refuses a forged organization_id and a tenant account of another organization", async () => {
      await reset();
      const insert =
        (session: { org: string; user: string }, row: { org: string; account: string }) => () =>
          asApp(session.org, session.user, (tx) =>
            tx.execute(sql`INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id)
            VALUES (${row.org}, ${row.account}, ${MESSAGE}, ${M_NURSE}, ${U_NURSE})`),
          );
      const nurseOfA = { org: ORG_A, user: U_NURSE };
      // a member of A naming B's organization: the policy's organization pin
      expect(await refused(insert(nurseOfA, { org: ORG_B, account: T_B }))).toBe("42501");
      // naming B's tenant account under A's own organization id: the composite FK
      expect(await refused(insert(nurseOfA, { org: ORG_A, account: T_B }))).toBe("23503");
      expect((await q("SELECT 1 FROM tenant_help_request")).length).toBe(0);
    });

    it("pins the requester: the session's own user, through an active membership of this organization", async () => {
      await reset();
      const base = (user: string, membership: string, sessionUser: string) => () =>
        asApp(ORG_A, sessionUser, (tx) =>
          tx.execute(sql`INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id)
            VALUES (${ORG_A}, ${T_A}, ${MESSAGE}, ${membership}, ${user})`),
        );
      // filing in a colleague's name
      expect(await refused(base(U_NURSE_2, M_NURSE_2, U_NURSE))).toBe("42501");
      // the user's own id with a colleague's membership
      expect(await refused(base(U_NURSE, M_NURSE_2, U_NURSE))).toBe("42501");
      // a suspended membership
      expect(await refused(base(U_SUSPENDED, M_SUSPENDED, U_SUSPENDED))).toBe("42501");
      // another organization's membership
      expect(await refused(base(U_B, M_B, U_B))).toBe("42501");
      expect(await refused(base(U_NURSE, M_NURSE, U_NURSE))).toBeUndefined();
    });

    it("cannot be born anything but open, with nothing else set: the columns are not grantable", async () => {
      await reset();
      for (const column of [
        "status",
        "support_consent_grant_id",
        "closed_by_actor_kind",
        "close_note",
        "requested_at",
      ]) {
        const value =
          column === "status"
            ? "'approved'"
            : column === "closed_by_actor_kind"
              ? "'tenant'"
              : column === "close_note"
                ? "'a note of eight'"
                : column === "requested_at"
                  ? "now() - interval '40 days'"
                  : "gen_random_uuid()";
        const code = await refused(() =>
          asApp(ORG_A, U_NURSE, (tx) =>
            tx.execute(
              sql.raw(
                `INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id, ${column})
                 VALUES ('${ORG_A}', '${T_A}', '${MESSAGE}', '${M_NURSE}', '${U_NURSE}', ${value})`,
              ),
            ),
          ),
        );
        expect(code, column).toBe("42501");
      }
    });
  });

  describe("the column-limited UPDATE and the guard trigger", () => {
    it("refuses a live request whose message is null", async () => {
      await reset();
      expect(
        await refused(() =>
          asApp(ORG_A, U_NURSE, (tx) =>
            tx.execute(sql`INSERT INTO tenant_help_request
              (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id)
              VALUES (${ORG_A}, ${T_A}, NULL, ${M_NURSE}, ${U_NURSE})`),
          ),
        ),
      ).toBe("23514");
    });

    it("lets the tenant role touch only the approve and close columns", async () => {
      await reset();
      const request = await filed();
      for (const column of [
        "message",
        "requested_by_user_id",
        "requested_by_membership_id",
        "organization_id",
        "tenant_account_id",
        "step_key",
        "close_note",
        "requested_at",
      ]) {
        const value =
          column === "message"
            ? "'rewritten message'"
            : column === "close_note"
              ? "'a note of eight'"
              : column === "step_key"
                ? "'mac_configured'"
                : column === "requested_at"
                  ? "now()"
                  : column.includes("organization")
                    ? `'${ORG_B}'`
                    : column.includes("account")
                      ? `'${T_B}'`
                      : `'${U_NURSE_2}'`;
        const code = await refused(() =>
          asApp(ORG_A, U_NURSE, (tx) =>
            tx.execute(
              sql.raw(
                `UPDATE tenant_help_request SET ${column} = ${value} WHERE id = '${request.id}'`,
              ),
            ),
          ),
        );
        expect(code, column).toBe("42501");
      }
      expect(
        (await q<{ message: string }>("SELECT message FROM tenant_help_request"))[0]?.message,
      ).toBe(MESSAGE);
    });

    it("pins an approval to a grant of this organization and tenant, by the session user's own active membership", async () => {
      await reset();
      const request = await filed();
      const foreignGrant = await grantFor(ORG_B, T_B, M_B, 8);
      const ownGrant = await grantFor(ORG_A, T_A, M_ADMIN, 8);
      const approve = (grant: string, membership: string, user: string) => () =>
        asApp(ORG_A, user, (tx) =>
          tx.execute(sql`UPDATE tenant_help_request SET status = 'approved', support_consent_grant_id = ${grant},
            approved_by_membership_id = ${membership}, approved_at = now() WHERE id = ${request.id}`),
        );
      expect(await refused(approve(foreignGrant, M_ADMIN, U_ADMIN))).toBe("42501"); // another organization's grant is invisible to the policy
      expect(await refused(approve(ownGrant, M_NURSE_2, U_ADMIN))).toBe("42501"); // someone else's membership
      expect(await refused(approve(ownGrant, M_SUSPENDED, U_SUSPENDED))).toBe("42501");
      expect(await refused(approve(ownGrant, M_ADMIN, U_ADMIN))).toBeUndefined();
      expect(
        (await q<{ status: string }>("SELECT status FROM tenant_help_request"))[0]?.status,
      ).toBe("approved");
    });

    it("pins a tenant end to the session user, with no operator or system as the closer", async () => {
      await reset();
      const request = await filed();
      const end = (kind: string, closer: string, sessionUser: string) => () =>
        asApp(ORG_A, sessionUser, (tx) =>
          tx.execute(
            sql.raw(`UPDATE tenant_help_request SET status = 'cancelled', closed_by_actor_kind = '${kind}',
              closed_by_user_id = ${closer}, closed_at = now() WHERE id = '${request.id}'`),
          ),
        );
      expect(await refused(end("platform_ops", `'${U_NURSE}'`, U_NURSE))).toBe("42501");
      expect(await refused(end("system", "NULL", U_NURSE))).toBe("42501");
      expect(await refused(end("tenant", `'${U_NURSE_2}'`, U_NURSE))).toBe("42501");
      expect(await refused(end("tenant", `'${U_NURSE}'`, U_NURSE))).toBeUndefined();
    });

    it("refuses any move out of a closed request, and any re-pointing of an approved one", async () => {
      await reset();
      const request = await filed();
      const first = await grantFor(ORG_A, T_A, M_ADMIN, 8);
      const second = await grantFor(ORG_A, T_A, M_ADMIN, 8);
      await admin.query(
        "UPDATE tenant_help_request SET status = 'approved', support_consent_grant_id = $2, approved_by_membership_id = $3, approved_at = now() WHERE id = $1",
        [request.id, first, M_ADMIN],
      );
      // the superuser too: this is the guard trigger, not a grant
      const repoint = await refused(() =>
        admin.query(
          "UPDATE tenant_help_request SET support_consent_grant_id = $2, status = 'resolved', closed_by_actor_kind = 'tenant', closed_at = now() WHERE id = $1",
          [request.id, second],
        ),
      );
      expect(repoint).toBe("23514");
      await admin.query(
        "UPDATE tenant_help_request SET status = 'resolved', closed_by_actor_kind = 'tenant', closed_by_user_id = $2, closed_at = now() WHERE id = $1",
        [request.id, U_NURSE],
      );
      expect(
        await refused(() =>
          admin.query("UPDATE tenant_help_request SET status = 'approved' WHERE id = $1", [
            request.id,
          ]),
        ),
      ).toBe("23514");
      expect(
        await refused(() =>
          admin.query("UPDATE tenant_help_request SET updated_at = now() WHERE id = $1", [
            request.id,
          ]),
        ),
      ).toBe("23514");
    });
  });

  describe("the state machine as a database fact", () => {
    const insertRow = (cols: string, vals: string, tenantAccount = T_A, org = ORG_A) =>
      admin.query(
        `INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id, ${cols})
         VALUES ('${org}', '${tenantAccount}', '${MESSAGE}', '${M_NURSE}', '${U_NURSE}', ${vals})`,
      );

    it("refuses states the machine does not have", async () => {
      await reset();
      const grant = await grantFor(ORG_A, T_A, M_ADMIN, 8);
      const cases: [string, string, string][] = [
        ["approved without a grant", "status", "'approved'"],
        [
          "cancelled that had a grant",
          "status, support_consent_grant_id, approved_by_membership_id, approved_at, closed_by_actor_kind, closed_at",
          `'cancelled', '${grant}', '${M_ADMIN}', now(), 'tenant', now()`,
        ],
        ["resolved without a closer", "status, closed_at", "'resolved', now()"],
        [
          "open that names a closer",
          "status, closed_by_actor_kind, closed_at",
          "'open', 'tenant', now()",
        ],
        [
          "a system close that names a user",
          "status, closed_by_actor_kind, closed_by_user_id, closed_at",
          `'cancelled', 'system', '${U_NURSE}', now()`,
        ],
        [
          "a note on a tenant close",
          "status, closed_by_actor_kind, closed_by_user_id, closed_at, close_note",
          `'cancelled', 'tenant', '${U_NURSE}', now(), 'a note of eight'`,
        ],
        ["an unknown status", "status", "'declined'"],
      ];
      for (const [name, cols, vals] of cases) {
        expect(await refused(() => insertRow(cols, vals)), name).toBe("23514");
      }
      expect((await q("SELECT 1 FROM tenant_help_request")).length).toBe(0);
    });

    it("bounds the message, the note and the step key", async () => {
      await reset();
      const message = (m: string) => () =>
        admin.query(
          "INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id) VALUES ($1,$2,$3,$4,$5)",
          [ORG_A, T_A, m, M_NURSE, U_NURSE],
        );
      expect(await refused(message("   short  "))).toBe("23514");
      expect(await refused(message("x".repeat(1001)))).toBe("23514");
      expect(await refused(() => insertRow("step_key", `'${"k".repeat(65)}'`))).toBe("23514");
      expect(await refused(() => insertRow("step_key", "''"))).toBe("23514");
      expect(await refused(message("x".repeat(1000)))).toBeUndefined();
    });
  });

  describe("one live request per tenant account", () => {
    it("is held by the partial unique index, and an ended request frees the slot", async () => {
      await reset();
      const insert = () =>
        asApp(ORG_A, U_NURSE, (tx) =>
          tx.execute(sql`INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id)
            VALUES (${ORG_A}, ${T_A}, ${MESSAGE}, ${M_NURSE}, ${U_NURSE})`),
        );
      expect(await refused(insert)).toBeUndefined();
      expect(await refused(insert)).toBe("23505");
      await admin.query(
        "UPDATE tenant_help_request SET status = 'cancelled', closed_by_actor_kind = 'tenant', closed_by_user_id = $1, closed_at = now()",
        [U_NURSE],
      );
      expect(await refused(insert)).toBeUndefined();
      // another tenant account is a different slot
      await asApp(ORG_B, U_B, (tx) =>
        tx.execute(sql`INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id)
          VALUES (${ORG_B}, ${T_B}, ${MESSAGE}, ${M_B}, ${U_B})`),
      );
    });

    it("answers two members filing at once with one request and a 409 naming it", async () => {
      await reset();
      const results = await Promise.allSettled([
        filed(NURSE),
        filed(NURSE_2, "A different question, filed at once"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const [live] = await q<{ id: string }>("SELECT id FROM tenant_help_request");
      expect(rejected[0]?.reason).toMatchObject({
        code: "HELP_REQUEST_ALREADY_OPEN",
        statusCode: 409,
      });
      expect(rejected[0]?.reason.details).toEqual([
        { field: "helpRequestId", code: "HELP_REQUEST_ALREADY_OPEN", message: live?.id },
      ]);
    });
  });

  describe("the service on the real roles", () => {
    it("files a request, emits the requested event through the real publisher with ids only, and audits without the message", async () => {
      await reset();
      const view = await filed(NURSE, MESSAGE, "mac_configured");
      expect(view).toMatchObject({
        status: "open",
        phase: "waiting_for_consent",
        stepKey: "mac_configured",
        message: MESSAGE,
      });
      const events = await q<{ payload: Record<string, unknown>; organization_id: string }>(
        "SELECT payload, organization_id FROM outbox_event WHERE event_type = 'm34.help_request.requested'",
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.organization_id).toBe(ORG_A);
      expect(events[0]?.payload).toMatchObject({
        helpRequestId: view.id,
        tenantAccountId: T_A,
        orgId: ORG_A,
        stepKey: "mac_configured",
      });
      expect(JSON.stringify(events[0]?.payload)).not.toContain("enrolment");
      const alert = await q<{
        id: string;
        payload: Record<string, unknown>;
        severity: string;
        correlation_id: string;
      }>(
        "SELECT id,payload,severity::text,correlation_id FROM alert WHERE organization_id=$1 AND event_type='m34.help_request.requested'",
        [ORG_A],
      );
      expect(alert).toHaveLength(1);
      expect(alert[0]).toMatchObject({
        severity: "warn",
        correlation_id: `m34-help-request-${view.id}`,
      });
      expect(alert[0]?.payload).toMatchObject({ helpRequestId: view.id, orgId: ORG_A });
      expect(JSON.stringify(alert[0]?.payload)).not.toContain("enrolment");
      const deliveries = await q<{ recipient_user_id: string; channel: string }>(
        "SELECT recipient_user_id,channel::text FROM notification_delivery WHERE alert_id=$1",
        [alert[0]?.id],
      );
      expect(deliveries).toContainEqual({ recipient_user_id: U_OPS, channel: "in_app" });
      const audit = await q<{
        actor_user_id: string;
        actor_kind: string;
        after: Record<string, unknown>;
      }>(
        `SELECT actor_user_id, actor_kind, after FROM audit_event
          WHERE resource_kind = 'tenant_help_request' AND event_type = 'tenant_help_request.insert' AND resource_id = $1`,
        [view.id],
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: U_NURSE, actor_kind: "user" });
      expect(audit[0]?.after).toMatchObject({ id: view.id, status: "open", message: "<changed>" });
    });

    it("refuses an unknown step and a PHI-shaped message, filing nothing", async () => {
      await reset();
      await expect(filed(NURSE, MESSAGE, "not_a_step")).rejects.toMatchObject({
        code: "HELP_REQUEST_STEP_UNKNOWN",
      });
      await expect(filed(NURSE, "claim denied for 900-12-3456")).rejects.toMatchObject({
        code: "EVIDENCE_LOOKS_LIKE_PHI",
      });
      expect((await q("SELECT 1 FROM tenant_help_request")).length).toBe(0);
    });

    it("approves into a linked grant, shows the session summary, and End help revokes the grant and resolves the request", async () => {
      await reset();
      const request = await filed();
      expect(await service.approve(NURSE_2, request.id, {}).catch((e) => e.statusCode)).toBe(403);
      const approved = await service.approve(ADMIN, request.id, { hours: 2 });
      expect(approved).toMatchObject({
        status: "approved",
        phase: "ready_to_start",
        grant: { status: "active" },
      });
      const [row] = await q<{
        support_consent_grant_id: string;
        approved_by_membership_id: string;
      }>("SELECT support_consent_grant_id, approved_by_membership_id FROM tenant_help_request");
      expect(row?.approved_by_membership_id).toBe(M_ADMIN);
      sessions.set(row?.support_consent_grant_id as string, {
        sessionId: "f0000000-0000-4000-8000-0000000000f0",
        state: "open",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + HOUR_MS),
        closedAt: null,
        closeReason: null,
        actionCount: 3,
        lastActionAt: new Date(),
      });
      const list = await service.listForTenant(NURSE, undefined, undefined);
      expect(list.current).toMatchObject({
        phase: "in_session",
        session: { state: "open", actionCount: 3 },
      });
      expect(JSON.stringify(list)).not.toContain("f0000000-0000-4000-8000-0000000000f0");
      await expect(service.approve(ADMIN, request.id, {})).rejects.toMatchObject({
        code: "HELP_REQUEST_NOT_OPEN",
      });

      const ended = await service.close(NURSE, request.id);
      expect(ended).toMatchObject({
        status: "resolved",
        phase: "ended",
        closedBy: "you",
        grant: { status: "revoked" },
      });
      const [grant] = await q<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM support_consent_grant",
      );
      expect(grant?.revoked_at).not.toBeNull();
      const [closed] = await q<{ closed_by_actor_kind: string; closed_by_user_id: string }>(
        "SELECT closed_by_actor_kind, closed_by_user_id FROM tenant_help_request",
      );
      expect(closed).toEqual({ closed_by_actor_kind: "tenant", closed_by_user_id: U_NURSE });
      // the slot is free again
      expect((await filed(NURSE_2, "A new question, now the slot is free")).status).toBe("open");
    });

    it("leaves an open request cancelled by its member, and refuses a colleague who is not an approver", async () => {
      await reset();
      const request = await filed();
      await expect(service.close(NURSE_2, request.id)).rejects.toMatchObject({ statusCode: 403 });
      expect(await service.close(NURSE, request.id)).toMatchObject({
        status: "cancelled",
        closedBy: "you",
      });
      await expect(service.close(MEMBER_B, request.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("refuses ChartWarden staff on the tenant lane, found by the real holder read", async () => {
      await reset();
      for (const call of [
        () => service.listForTenant(OPS_IN_A, undefined, undefined),
        () => service.file(OPS_IN_A, { message: MESSAGE }),
      ]) {
        await expect(call()).rejects.toMatchObject({ statusCode: 403 });
      }
      expect((await q("SELECT 1 FROM tenant_help_request")).length).toBe(0);
    });

    it("gives the operators an inbox across tenants and a Resolve that names no operator to the tenant", async () => {
      await reset();
      const requestA = await filed(NURSE, MESSAGE, "payer_enrollment");
      const requestB = await service.file(MEMBER_B, {
        message: "Help with our provider entity please",
      });
      await service.approve(ADMIN, requestA.id, {});
      const inbox = await service.listForPlatform(
        OPERATOR,
        { statuses: ["open", "approved"] },
        undefined,
        undefined,
      );
      expect(inbox.items.map((i) => i.id).sort()).toEqual([requestA.id, requestB.id].sort());
      expect(inbox.items.find((i) => i.id === requestA.id)).toMatchObject({
        orgSlug: "help-a",
        legalBusinessName: "Tenant A Hospice",
        stepKey: "payer_enrollment",
        phase: "ready_to_start",
        requestedByMembershipId: M_NURSE,
      });
      const paged = await service.listForPlatform(OPERATOR, { statuses: [] }, undefined, 1);
      expect(paged).toMatchObject({ hasMore: true });
      const next = await service.listForPlatform(
        OPERATOR,
        { statuses: [] },
        paged.nextCursor ?? undefined,
        1,
      );
      expect(next.items[0]?.id).not.toBe(paged.items[0]?.id);

      const resolved = await service.resolve(OPERATOR, requestA.id, { note: NOTE });
      expect(resolved).toMatchObject({
        status: "resolved",
        closedByActorKind: "platform_ops",
        closeNote: NOTE,
        grant: { status: "revoked" },
      });
      const [row] = await q<{
        closed_by_actor_kind: string;
        closed_by_user_id: string;
        close_note: string;
      }>(
        "SELECT closed_by_actor_kind, closed_by_user_id, close_note FROM tenant_help_request WHERE id = $1",
        [requestA.id],
      );
      expect(row).toEqual({
        closed_by_actor_kind: "platform_ops",
        closed_by_user_id: U_OPS,
        close_note: NOTE,
      });
      const tenantSide = await service.listForTenant(NURSE, undefined, undefined);
      expect(tenantSide.items[0]).toMatchObject({
        closedBy: "ChartWarden operations",
        closeNote: NOTE,
      });
      expect(JSON.stringify(tenantSide)).not.toContain(U_OPS);
      await expect(service.resolve(OPERATOR, requestA.id, { note: NOTE })).rejects.toMatchObject({
        code: "HELP_REQUEST_ENDED",
      });
      // an operator may also answer an open request that never needed consent
      expect(
        await service.resolve(OPERATOR, requestB.id, { note: "Answered in the wizard" }),
      ).toMatchObject({ status: "resolved", supportConsentGrantId: null });
    });

    it("leaves audit rows that name each actor and carry neither the message nor the note", async () => {
      const rows = await q<{
        event_type: string;
        actor_user_id: string | null;
        actor_kind: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT event_type, actor_user_id, actor_kind, before, after FROM audit_event
          WHERE resource_kind = 'tenant_help_request' ORDER BY created_at`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(6);
      const dump = JSON.stringify(rows);
      for (const text of [
        MESSAGE,
        NOTE,
        "Answered in the wizard",
        "Help with our provider entity",
      ]) {
        expect(dump).not.toContain(text);
      }
      expect(
        rows.some(
          (r) => r.event_type === "tenant_help_request.update" && r.actor_user_id === U_OPS,
        ),
      ).toBe(true);
      expect(
        rows.some(
          (r) => r.event_type === "tenant_help_request.update" && r.actor_user_id === U_ADMIN,
        ),
      ).toBe(true);
    });
  });

  describe("the platform carrier", () => {
    it("reads every tenant's requests and updates only the close columns", async () => {
      await reset();
      await filed();
      await service.file(MEMBER_B, { message: "Help with our provider entity please" });
      const seen = await asCarrier((tx) =>
        tx.execute(sql`SELECT organization_id FROM tenant_help_request`),
      );
      expect(
        new Set(seen.rows.map((r) => (r as { organization_id: string }).organization_id)),
      ).toEqual(new Set([ORG_A, ORG_B]));
      for (const column of [
        "message",
        "requested_by_user_id",
        "support_consent_grant_id",
        "approved_by_membership_id",
        "organization_id",
        "step_key",
      ]) {
        const value =
          column === "message"
            ? "'rewritten message'"
            : column === "step_key"
              ? "'mac_configured'"
              : "NULL";
        const code = await refused(() =>
          asCarrier((tx) =>
            tx.execute(sql.raw(`UPDATE tenant_help_request SET ${column} = ${value}`)),
          ),
        );
        expect(code, column).toBe("42501");
      }
      const close = await refused(() =>
        asCarrier((tx) =>
          tx.execute(
            sql`UPDATE tenant_help_request SET status = 'resolved', closed_by_actor_kind = 'platform_ops', closed_by_user_id = ${U_OPS}, closed_at = now(), close_note = ${NOTE} WHERE organization_id = ${ORG_B}`,
          ),
        ),
      );
      expect(close).toBeUndefined();
      // and may not INSERT one
      const insert = await refused(() =>
        asCarrier((tx) =>
          tx.execute(
            sql`INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id) VALUES (${ORG_B}, ${T_B}, ${MESSAGE}, ${M_B}, ${U_B})`,
          ),
        ),
      );
      expect(insert).toBe("42501");
    });
  });

  describe("the linked-request port 7S's revoke cascade ends a request through", () => {
    it("resolves the approved request of a grant: as the tenant (the session user closes) and as the system (no user)", async () => {
      await reset();
      const request = await filed();
      await service.approve(ADMIN, request.id, {});
      const [{ support_consent_grant_id: grantId }] = await q<{ support_consent_grant_id: string }>(
        "SELECT support_consent_grant_id FROM tenant_help_request",
      );
      const none = await asApp(ORG_A, U_NURSE, (tx) =>
        createLinkedHelpRequestPort(tx).resolveForRevokedGrant({
          grantId: "00000000-0000-4000-8000-000000000000",
          organizationId: ORG_A,
          source: "tenant",
          closedByUserId: null,
          note: null,
        }),
      );
      expect(none).toBeNull();
      // The cascade's input names no closer: the request's own actor (the ambient request context) closes it, as the session user.
      const resolved = await runWithRequestContext({ organizationId: ORG_A, userId: U_ADMIN }, () =>
        asApp(ORG_A, U_ADMIN, (tx) =>
          createLinkedHelpRequestPort(tx).resolveForRevokedGrant({
            grantId,
            organizationId: ORG_A,
            source: "tenant",
            closedByUserId: null,
            note: null,
          }),
        ),
      );
      expect(resolved).toEqual({ helpRequestId: request.id });
      expect(
        (
          await q<{ closed_by_actor_kind: string; closed_by_user_id: string }>(
            "SELECT closed_by_actor_kind, closed_by_user_id FROM tenant_help_request",
          )
        )[0],
      ).toEqual({ closed_by_actor_kind: "tenant", closed_by_user_id: U_ADMIN });
      // already ended: a no-op
      expect(
        await asApp(ORG_A, U_ADMIN, (tx) =>
          createLinkedHelpRequestPort(tx).resolveForRevokedGrant({
            grantId,
            organizationId: ORG_A,
            source: "tenant",
            closedByUserId: null,
            note: null,
          }),
        ),
      ).toBeNull();

      const second = await filed();
      await service.approve(ADMIN, second.id, {});
      const [{ support_consent_grant_id: grantTwo }] = await q<{
        support_consent_grant_id: string;
      }>("SELECT support_consent_grant_id FROM tenant_help_request WHERE id = $1", [second.id]);
      const bySystem = await asCarrier((tx) =>
        createLinkedHelpRequestPort(tx).resolveForRevokedGrant({
          grantId: grantTwo as string,
          organizationId: ORG_A,
          source: "system",
          closedByUserId: null,
          note: null,
        }),
      );
      expect(bySystem).toEqual({ helpRequestId: second.id });
      expect(
        (
          await q<{ closed_by_actor_kind: string; closed_by_user_id: string | null }>(
            "SELECT closed_by_actor_kind, closed_by_user_id FROM tenant_help_request WHERE id = $1",
            [second.id],
          )
        )[0],
      ).toEqual({ closed_by_actor_kind: "system", closed_by_user_id: null });
    });
  });

  describe("the sweep", () => {
    it("cancels an open request older than 14 days and resolves an approved one whose grant ended, by the system", async () => {
      await reset();
      // a request nobody answered for 15 days (inserted as the superuser: the app role cannot back-date)
      const stale = (
        await q<{ id: string }>(
          `INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id, requested_at)
           VALUES ($1,$2,$3,$4,$5, now() - interval '15 days') RETURNING id`,
          [ORG_A, T_A, MESSAGE, M_NURSE, U_NURSE],
        )
      )[0]?.id as string;
      // an approved one whose grant expired an hour ago, in the other tenant
      const expiredGrant = await grantFor(ORG_B, T_B, M_B, -1);
      const approved = (
        await q<{ id: string }>(
          `INSERT INTO tenant_help_request (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id, status, support_consent_grant_id, approved_by_membership_id, approved_at)
           VALUES ($1,$2,$3,$4,$5,'approved',$6,$4, now() - interval '9 hours') RETURNING id`,
          [ORG_B, T_B, "Help with our provider entity please", M_B, U_B, expiredGrant],
        )
      )[0]?.id as string;
      const result = await runHelpRequestSweep(runner());
      expect(result).toEqual({ cancelled: 1, resolved: 1, purged: 0 });
      const rows = await q<{
        id: string;
        status: string;
        closed_by_actor_kind: string;
        closed_by_user_id: string | null;
      }>("SELECT id, status, closed_by_actor_kind, closed_by_user_id FROM tenant_help_request");
      expect(rows.find((r) => r.id === stale)).toMatchObject({
        status: "cancelled",
        closed_by_actor_kind: "system",
        closed_by_user_id: null,
      });
      expect(rows.find((r) => r.id === approved)).toMatchObject({
        status: "resolved",
        closed_by_actor_kind: "system",
        closed_by_user_id: null,
      });
      // idempotent, and a fresh open request or a live grant is left alone
      const fresh = await filed();
      expect(await runHelpRequestSweep(runner())).toEqual({ cancelled: 0, resolved: 0, purged: 0 });
      expect(
        (
          await q<{ status: string }>("SELECT status FROM tenant_help_request WHERE id = $1", [
            fresh.id,
          ])
        )[0]?.status,
      ).toBe("open");
      const system = await q<{ actor_user_id: string | null; actor_kind: string }>(
        `SELECT actor_user_id, actor_kind FROM audit_event WHERE resource_kind = 'tenant_help_request' AND resource_id = $1 AND event_type = 'tenant_help_request.update'`,
        [stale],
      );
      expect(system[0]).toEqual({ actor_user_id: null, actor_kind: "system" });
    });

    it("refuses early deletion and nulls closed text at rest after 90 days", async () => {
      await reset();
      const old = (
        await q<{ id: string }>(
          `INSERT INTO tenant_help_request
            (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id,
             requested_at, status, closed_by_actor_kind, closed_by_user_id, closed_at, close_note)
           VALUES ($1,$2,$3,$4,$5,now() - interval '100 days','cancelled','platform_ops',$7,
                   now() - interval '91 days',$6) RETURNING id`,
          [ORG_A, T_A, MESSAGE, M_NURSE, U_NURSE, NOTE, U_OPS],
        )
      )[0]?.id as string;
      const fresh = (
        await q<{ id: string }>(
          `INSERT INTO tenant_help_request
            (organization_id, tenant_account_id, message, requested_by_membership_id, requested_by_user_id,
             requested_at, status, closed_by_actor_kind, closed_by_user_id, closed_at, close_note)
           VALUES ($1,$2,$3,$4,$5,now() - interval '2 days','cancelled','platform_ops',$7,
                   now() - interval '1 day',$6) RETURNING id`,
          [ORG_B, T_B, "Help with our provider entity please", M_B, U_B, NOTE, U_OPS],
        )
      )[0]?.id as string;

      expect(
        await refused(() =>
          asCarrier((tx) =>
            tx.execute(sql`UPDATE tenant_help_request
              SET message = NULL, close_note = NULL, message_purged_at = now()
              WHERE id = ${fresh}`),
          ),
        ),
      ).toBe("23514");
      expect(await runHelpRequestSweep(runner())).toEqual({ cancelled: 0, resolved: 0, purged: 1 });

      const [purged] = await q<{
        message: string | null;
        close_note: string | null;
        message_purged_at: Date | null;
      }>("SELECT message,close_note,message_purged_at FROM tenant_help_request WHERE id=$1", [old]);
      expect(purged).toMatchObject({ message: null, close_note: null });
      expect(purged?.message_purged_at).not.toBeNull();
      expect(
        (
          await q<{ message: string }>("SELECT message FROM tenant_help_request WHERE id=$1", [
            fresh,
          ])
        )[0]?.message,
      ).toBe("Help with our provider entity please");
      expect((await service.listForTenant(NURSE, undefined, undefined)).items[0]?.message).toBe(
        "[removed after 90 days]",
      );
      const [audit] = await q<{ after: Record<string, unknown> }>(
        `SELECT after FROM audit_event
          WHERE resource_kind='tenant_help_request' AND resource_id=$1 AND event_type='tenant_help_request.update'
          ORDER BY created_at DESC LIMIT 1`,
        [old],
      );
      expect(audit?.after).toMatchObject({ message: "<changed>", close_note: "<changed>" });
    });
  });

  describe("tenant offboarding", () => {
    it("erases requests, session headers and grants while retaining the disclosure ledger", async () => {
      await reset();
      const request = await filed();
      await service.approve(ADMIN, request.id, {});
      await service.file(MEMBER_B, { message: "Help with our provider entity please" });
      const [grant] = await q<{ id: string }>(
        "SELECT id FROM support_consent_grant WHERE organization_id = $1",
        [ORG_A],
      );
      if (!grant) throw new Error("approved help request did not create a consent grant");
      const [session] = await q<{ id: string }>(
        `INSERT INTO support_session
          (organization_id, support_consent_grant_id, actor_membership_id, started_at, expires_at)
         VALUES ($1, $2, $3, now(), now() + interval '1 hour') RETURNING id`,
        [ORG_A, grant.id, M_OPS_IN_A],
      );
      if (!session) throw new Error("support session insert returned no row");
      await q(
        `INSERT INTO support_session_event
          (organization_id, support_session_id, event_kind, occurred_at, context)
         VALUES ($1, $2, 'session.start', now(), '{"scope":"organization_scoped"}'::jsonb)`,
        [ORG_A, session.id],
      );
      await expect(
        admin.query("DELETE FROM support_consent_grant WHERE organization_id = $1", [ORG_A]),
      ).rejects.toMatchObject({ code: "23001" });
      const store = createDrizzleSaasTenantPlatformEraseStore({
        platformDb: platformPool.db,
        auditBypass: m34PlatformBypassAuditor,
        platformJobId: JOB_ID,
      });
      expect(await store.eraseSupportConsentGrants(ORG_A)).toEqual({ erased: 1 });
      expect(await store.eraseSupportSessions(ORG_A)).toEqual({ erased: 1 });
      expect(
        (await q("SELECT 1 FROM tenant_help_request WHERE organization_id = $1", [ORG_A])).length,
      ).toBe(0);
      expect(
        (await q("SELECT 1 FROM support_session WHERE organization_id = $1", [ORG_A])).length,
      ).toBe(0);
      expect(
        (await q("SELECT 1 FROM support_consent_grant WHERE organization_id = $1", [ORG_A])).length,
      ).toBe(0);
      expect(
        (
          await q(
            "SELECT 1 FROM support_session_event WHERE organization_id = $1 AND support_session_id = $2",
            [ORG_A, session.id],
          )
        ).length,
      ).toBe(1);
      // another organization's request is untouched
      expect(
        (await q("SELECT 1 FROM tenant_help_request WHERE organization_id = $1", [ORG_B])).length,
      ).toBe(1);
    });
  });
});
