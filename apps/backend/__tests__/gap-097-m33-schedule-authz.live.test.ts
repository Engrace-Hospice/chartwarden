/**
 * GAP-097 — M33 scheduled-report authorization (owner / recipient / org_admin), LIVE Postgres.
 *
 * Before the fix the schedule routes were permission-only and the service checked only the org: a
 * non-owner could create over another member's private view, edit / pause / cancel another member's
 * schedule, list every schedule in the org, and the scheduled-run worker delivered to any recipient whose
 * membership was merely active. The in-memory slice backend (gap-097-m33-schedule-authz.test.ts) proves the
 * route wiring; THIS suite proves the same rules over the production Drizzle code and real RLS, as the
 * NOBYPASSRLS `wardenx_app` role (fixtures are seeded as the superuser):
 *
 *   1. `ReportScheduleRepository.listVisible` — owner OR recipient (`recipient_membership_ids @> [id]`),
 *      org_admin sees the whole org, ANY status, the status filter honoured, tenant isolation.
 *   2. `buildDrizzleReportingAbacResolver().loadReportSchedule` — the row the `report_schedule_access`
 *      predicate decides on; null for a foreign-org / absent / blank id.
 *   3. `createDrizzleM33WriteBackend` — get / update / pause / resume / cancel / delete-all-runs /
 *      list-runs / create owner, recipient and org_admin rules (a denied actor gets the non-leaking
 *      NotFoundError and the row is UNCHANGED), with the real catalog-validating outbox publisher so the
 *      `m33.report_schedule.created` emit is schema-checked and persisted, not a NOOP.
 *   4. The scheduled-run worker's `recipients.isRecipientEntitled` (bound by `buildM33WorkerPorts`, the same
 *      call `registerM33Workers` makes inside `withOrgContext`): active membership + the §4.7.2 view ladder
 *      evaluated from the recipient's CURRENT role keys — an expired role, a revoked membership, a foreign-org
 *      membership and a private view of another member are each dropped.
 *
 * No Redis: `buildM33WorkerPorts` is pure assembly and opens no Queue/Worker.
 *
 * Why this harness can fail: the first test proves the app connection is RLS-enforced (no org context ⇒
 * zero rows while the superuser sees them), and every authz assertion below is one the pre-GAP-097 code
 * violated (e.g. "a recipient cannot pause", "RECIP does not see OTHER's schedule in the list").
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m33:schedule-authz:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import {
  ReportDefinitionRepository,
  ReportScheduleRepository,
  ReportViewRepository,
} from "@chartwarden/reporting";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotFoundError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildDrizzleReportingAbacResolver } from "../src/modules/33-reporting/abac-resolver-db";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { buildM33WorkerPorts } from "../src/modules/33-reporting/jobs/m33-jobs";
import { createDrizzleM33WriteBackend } from "../src/modules/33-reporting/routes/index";
import { LIVE_CRON } from "../src/modules/33-reporting/wiring";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111197";
const ORG_B = "22222222-2222-2222-2222-222222222297";
const SHARED_ROLE_KEY = "gap097_analyst";
const PAST = new Date("2020-01-01T00:00:00.000Z");
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

type Status = "active" | "paused" | "cancelled";

describe.skipIf(!DB_URL)("GAP-097 M33 schedule authz — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let seedDb: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDrizzleM33WriteBackend>["service"];

  const member: Record<string, string> = {};
  /** The real `user.id` behind each member label (audit_event.actor_user_id FKs `user`). */
  const userOf: Record<string, string> = {};
  const viewId: Record<string, string> = {};
  let roleId: string;
  let seq = 0;

  const actor = (label: string, org = ORG_A, roles: string[] = ["analyst"]) => ({
    organizationId: org,
    userId: userOf[label] as string,
    membershipId: member[label] as string,
    roles,
  });
  const ADMIN_ROLES = ["org_admin"];

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
  }

  /** One user + one membership in `org` (status settable); registered under `label`. */
  async function seedMember(label: string, org: string, status = "active"): Promise<void> {
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${label}@gap097.test`,
      ])
    ).rows[0].id as string;
    userOf[label] = userId;
    member[label] = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3) RETURNING id`,
        [userId, org, status],
      )
    ).rows[0].id as string;
  }

  async function seedView(
    key: string,
    org: string,
    owner: string,
    share: { shareScope: "private" | "role" | "org"; shareRoleKeys?: string[] },
  ): Promise<void> {
    const defRepo = new ReportDefinitionRepository(seedDb.db);
    const definition = await defRepo.createDefinition({
      organizationId: org,
      authorship: "tenant",
      baseKey: "census_org_daily",
      ownerMembershipId: member[owner] as string,
      displayName: `Census ${key}`,
    });
    const version = await defRepo.createVersion({
      definitionId: definition.id,
      organizationId: org,
      versionNumber: 1,
      spec: {
        dimensions: [{ dimensionKey: "census_day" }],
        measures: [{ measureKey: "active_patient_count" }],
        filters: [],
      },
      status: "published",
    });
    const view = await new ReportViewRepository(seedDb.db).create({
      organizationId: org,
      definitionVersionId: version.id,
      ownerMembershipId: member[owner] as string,
      displayName: `View ${key}`,
      shareScope: share.shareScope,
      shareRoleKeys: share.shareRoleKeys ?? null,
    });
    viewId[key] = view.id;
  }

  /** A schedule row seeded as the superuser; nextRunAt is staggered so list order is deterministic. */
  async function seedSchedule(
    org: string,
    view: string,
    owner: string,
    recipients: readonly string[],
    status: Status = "active",
  ): Promise<string> {
    seq += 1;
    const row = await new ReportScheduleRepository(seedDb.db).create({
      organizationId: org,
      reportViewId: viewId[view] as string,
      ownerMembershipId: member[owner] as string,
      cronExpression: "0 9 * * *",
      tenantTimezone: "America/New_York",
      format: "csv",
      recipientMembershipIds: recipients.map((r) => member[r] as string),
      deliveryChannel: "in_app",
      nextRunAt: status === "active" ? new Date(Date.UTC(2099, 0, seq)) : null,
      status,
    });
    return row.id;
  }

  const rowOf = async (id: string) =>
    (await admin.query("SELECT * FROM report_schedule WHERE id=$1", [id])).rows[0];

  const asAppIn = <T>(org: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      fn(tx as unknown as DbClient),
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-097-a','A','A'),($2,'org-097-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const l of ["OWNER", "RECIP", "OTHER", "ADMIN", "STRANGER", "ROLEHOLDER", "EXPIRED"]) {
      await seedMember(l, ORG_A);
    }
    await seedMember("REVOKED", ORG_A, "revoked");
    await seedMember("B_OWNER", ORG_B);
    await seedMember("FOREIGN", ORG_B); // an ACTIVE membership, but in ANOTHER org

    // A org-A role the role-shared view names; ROLEHOLDER holds it, EXPIRED held it until 2020.
    roleId = (
      await admin.query(
        `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,'Analyst','clinical_staff') RETURNING id`,
        [ORG_A, SHARED_ROLE_KEY],
      )
    ).rows[0].id as string;
    for (const [label, expires] of [
      ["ROLEHOLDER", FUTURE],
      ["EXPIRED", PAST],
      ["REVOKED", FUTURE],
    ] as const) {
      await admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
        [ORG_A, member[label], roleId, expires],
      );
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    seedDb = createDbClient({ connectionString: DB_URL as string });

    await seedView("PRIVATE", ORG_A, "OWNER", { shareScope: "private" });
    await seedView("ORG", ORG_A, "OWNER", { shareScope: "org" });
    await seedView("ROLE", ORG_A, "OWNER", {
      shareScope: "role",
      shareRoleKeys: [SHARED_ROLE_KEY],
    });
    await seedView("B_VIEW", ORG_B, "B_OWNER", { shareScope: "org" });

    const catalog = buildBootOutboxCatalog([M33_OUTBOX_EVENTS]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    service = createDrizzleM33WriteBackend({
      db: handle.db,
      cron: LIVE_CRON,
      outbox: {
        publish: (tx, input) =>
          txPublisher.publish(tx as unknown as Parameters<typeof txPublisher.publish>[0], {
            ...input,
            callerModule: "m33",
          }),
      },
      now: () => new Date(),
    }).service;
  }, 180_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (seedDb) await seedDb.close();
    if (admin) await admin.end();
  });

  // ── fixtures shared by the read-only assertions (listVisible / resolver / service reads) ────────────
  const sched: Record<string, string> = {};
  beforeAll(async () => {
    sched.S1 = await seedSchedule(ORG_A, "ORG", "OWNER", ["RECIP"], "active");
    sched.S2 = await seedSchedule(ORG_A, "ORG", "OWNER", [], "paused");
    sched.S3 = await seedSchedule(ORG_A, "ORG", "OWNER", ["RECIP"], "cancelled");
    sched.S4 = await seedSchedule(ORG_A, "ORG", "OTHER", [], "active");
    sched.S5 = await seedSchedule(ORG_A, "ORG", "OTHER", ["RECIP", "ADMIN"], "paused");
    sched.SB = await seedSchedule(ORG_B, "B_VIEW", "B_OWNER", [], "active");
  }, 60_000);

  const idsOf = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort();
  const want = (...keys: string[]) => keys.map((k) => sched[k] as string).sort();

  it("harness bites: the app handle is RLS-enforced (no org context ⇒ zero rows; superuser sees them)", async () => {
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM report_schedule");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM report_schedule");
    expect(asSuper.rows[0].n).toBeGreaterThanOrEqual(6);
    expect(asApp.rows[0].n).toBe(0);
  });

  describe("ReportScheduleRepository.listVisible (real Drizzle, real RLS)", () => {
    const list = (viewer: string, isAdmin: boolean, status?: Status, org = ORG_A, ctxOrg = org) =>
      asAppIn(ctxOrg, (tx) =>
        new ReportScheduleRepository(tx).listVisible(
          org,
          { membershipId: member[viewer] as string, isAdmin },
          status,
        ),
      );

    it("owner sees exactly their own schedules, in every status", async () => {
      expect(idsOf(await list("OWNER", false))).toEqual(want("S1", "S2", "S3"));
    });

    it("a listed recipient sees the schedules that name them (jsonb containment), in every status", async () => {
      expect(idsOf(await list("RECIP", false))).toEqual(want("S1", "S3", "S5"));
    });

    it("a member who neither owns nor is listed sees nothing", async () => {
      expect(await list("STRANGER", false)).toEqual([]);
    });

    it("org_admin sees every schedule in the org regardless of membership id, and none of another org's", async () => {
      const all = await list("STRANGER", true);
      expect(idsOf(all)).toEqual(want("S1", "S2", "S3", "S4", "S5"));
      expect(idsOf(all)).not.toContain(sched.SB);
    });

    it("the status filter is honoured as asked (cancelled and paused are not coerced away)", async () => {
      expect(idsOf(await list("RECIP", false, "cancelled"))).toEqual(want("S3"));
      expect(idsOf(await list("RECIP", false, "paused"))).toEqual(want("S5"));
      expect(idsOf(await list("RECIP", false, "active"))).toEqual(want("S1"));
      expect(idsOf(await list("STRANGER", true, "cancelled"))).toEqual(want("S3"));
    });

    it("cross-tenant: an org-B admin listing org A, or org A's id under org B's context, gets nothing", async () => {
      expect(await list("B_OWNER", true, undefined, ORG_A, ORG_B)).toEqual([]);
      expect(idsOf(await list("B_OWNER", true, undefined, ORG_B))).toEqual(want("SB"));
    });
  });

  describe("abac-resolver-db loadReportSchedule", () => {
    const resolver = () => buildDrizzleReportingAbacResolver(handle.db);

    it("returns the owner and recipient facts the report_schedule_access predicate decides on", async () => {
      const facts = await resolver().loadReportSchedule(ORG_A, sched.S5 as string);
      expect(facts).toEqual({
        scheduleId: sched.S5,
        organizationId: ORG_A,
        ownerMembershipId: member.OTHER,
        recipientMembershipIds: [member.RECIP, member.ADMIN],
      });
    });

    it("is null for another tenant's schedule, an absent id, and blank inputs (never a cross-tenant row)", async () => {
      expect(await resolver().loadReportSchedule(ORG_B, sched.S1 as string)).toBeNull();
      expect(await resolver().loadReportSchedule(ORG_A, sched.SB as string)).toBeNull();
      expect(
        await resolver().loadReportSchedule(ORG_A, "99999999-9999-4999-8999-999999999999"),
      ).toBeNull();
      expect(await resolver().loadReportSchedule("", sched.S1 as string)).toBeNull();
      expect(await resolver().loadReportSchedule(ORG_A, "")).toBeNull();
    });

    it("loadReportView projects share scope + role keys and is null across tenants", async () => {
      const view = await resolver().loadReportView(ORG_A, viewId.ROLE as string);
      expect(view?.shareScope).toBe("role");
      expect(view?.shareRoleKeys).toEqual([SHARED_ROLE_KEY]);
      expect(await resolver().loadReportView(ORG_B, viewId.ROLE as string)).toBeNull();
    });
  });

  describe("createDrizzleM33WriteBackend owner / recipient / org_admin rules (real outbox publisher)", () => {
    const createArgs = (view: string, recipients: string[] = []) => ({
      reportViewId: viewId[view] as string,
      cronExpression: "0 9 * * *",
      tenantTimezone: "America/New_York",
      format: "csv" as const,
      recipientMembershipIds: recipients,
    });

    it("listSchedules: a recipient sees owner+recipient rows only; org_admin sees the org; status honoured", async () => {
      const asRecip = await service.listSchedules(actor("RECIP"), {}, undefined, 100);
      expect(idsOf(asRecip.items)).toEqual(want("S1", "S3", "S5"));
      const asAdmin = await service.listSchedules(
        actor("STRANGER", ORG_A, ADMIN_ROLES),
        { status: "cancelled" },
        undefined,
        100,
      );
      expect(idsOf(asAdmin.items)).toEqual(want("S3"));
    });

    it("get: owner, recipient and org_admin read; a stranger and another tenant get the non-leaking 404", async () => {
      await expect(service.getSchedule(actor("OWNER"), sched.S1 as string)).resolves.toMatchObject({
        id: sched.S1,
      });
      await expect(service.getSchedule(actor("RECIP"), sched.S1 as string)).resolves.toMatchObject({
        id: sched.S1,
      });
      await expect(
        service.getSchedule(actor("STRANGER", ORG_A, ADMIN_ROLES), sched.S1 as string),
      ).resolves.toMatchObject({ id: sched.S1 });
      await expect(
        service.getSchedule(actor("STRANGER"), sched.S1 as string),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.getSchedule(actor("B_OWNER", ORG_B, ADMIN_ROLES), sched.S1 as string),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("mutate: a RECIPIENT cannot update / pause / cancel (404, row unchanged); the owner can", async () => {
      const id = await seedSchedule(ORG_A, "ORG", "OWNER", ["RECIP"], "active");
      const before = await rowOf(id);
      await expect(
        service.updateSchedule(actor("RECIP"), id, { format: "xlsx" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.pauseSchedule(actor("RECIP"), id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.cancelSchedule(actor("RECIP"), id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const afterDenied = await rowOf(id);
      expect(afterDenied.status).toBe("active");
      expect(afterDenied.format).toBe(before.format);
      expect(afterDenied.cancelled_at).toBeNull();

      await service.updateSchedule(actor("OWNER"), id, { format: "xlsx" });
      expect((await rowOf(id)).format).toBe("xlsx");
      await service.pauseSchedule(actor("OWNER"), id);
      expect((await rowOf(id)).status).toBe("paused");
      await service.resumeSchedule(actor("OWNER"), id);
      expect((await rowOf(id)).status).toBe("active");
      await service.cancelSchedule(actor("OWNER"), id);
      expect((await rowOf(id)).status).toBe("cancelled");
    });

    it("mutate: a stranger is refused on every verb; org_admin may mutate another member's schedule", async () => {
      const id = await seedSchedule(ORG_A, "ORG", "OWNER", [], "active");
      await expect(
        service.updateSchedule(actor("STRANGER"), id, { format: "xlsx" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(service.pauseSchedule(actor("STRANGER"), id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.resumeSchedule(actor("STRANGER"), id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(service.cancelSchedule(actor("STRANGER"), id)).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect((await rowOf(id)).status).toBe("active");

      await service.pauseSchedule(actor("STRANGER", ORG_A, ADMIN_ROLES), id);
      expect((await rowOf(id)).status).toBe("paused");
    });

    it("mutate: another tenant's org_admin cannot reach an org-A schedule (RLS ⇒ 404, row unchanged)", async () => {
      const id = await seedSchedule(ORG_A, "ORG", "OWNER", [], "active");
      await expect(
        service.cancelSchedule(actor("B_OWNER", ORG_B, ADMIN_ROLES), id),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await rowOf(id)).status).toBe("active");
    });

    it("delete-all-runs and list-runs: delete is org_admin only; list-runs follows read rules", async () => {
      const id = await seedSchedule(ORG_A, "ORG", "OWNER", ["RECIP"], "active");
      await admin.query(
        `INSERT INTO report_schedule_run (schedule_id, organization_id, scheduled_for, status)
         VALUES ($1,$2,'2026-09-01T09:00:00Z','succeeded')`,
        [id, ORG_A],
      );
      await expect(service.deleteAllRuns(actor("OWNER"), id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.listScheduleRuns(actor("RECIP"), id, undefined, 10),
      ).resolves.toHaveProperty("items");
      await expect(
        service.listScheduleRuns(actor("STRANGER"), id, undefined, 10),
      ).rejects.toBeInstanceOf(NotFoundError);
      const runsLeft = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM report_schedule_run WHERE schedule_id=$1",
            [id],
          )
        ).rows[0].n as number;
      expect(await runsLeft()).toBe(1);
      const deleted = await service.deleteAllRuns(actor("STRANGER", ORG_A, ADMIN_ROLES), id);
      expect(deleted.deleted).toBe(1);
      expect(await runsLeft()).toBe(0);
    });

    it("create: the owner stamped is the SESSION membership; the real publisher persists m33.report_schedule.created", async () => {
      const created = await service.createSchedule(actor("OTHER"), createArgs("ORG", ["RECIP"]));
      expect(created.ownerMembershipId).toBe(member.OTHER);
      const { rows } = await admin.query(
        `SELECT organization_id, aggregate_id FROM outbox_event
          WHERE event_type='m33.report_schedule.created' AND aggregate_id=$1`,
        [created.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(ORG_A);
    });

    it("create: a PRIVATE view of another member cannot be scheduled (404, no row, no event)", async () => {
      const rowsBefore = (await admin.query("SELECT count(*)::int AS n FROM report_schedule"))
        .rows[0].n;
      const eventsBefore = (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m33.report_schedule.created'",
        )
      ).rows[0].n;
      await expect(
        service.createSchedule(actor("STRANGER"), createArgs("PRIVATE")),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await admin.query("SELECT count(*)::int AS n FROM report_schedule")).rows[0].n).toBe(
        rowsBefore,
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m33.report_schedule.created'",
          )
        ).rows[0].n,
      ).toBe(eventsBefore);
      // The view's own owner may.
      await expect(
        service.createSchedule(actor("OWNER"), createArgs("PRIVATE")),
      ).resolves.toMatchObject({ ownerMembershipId: member.OWNER });
    });

    it("create: a role-shared view is schedulable only by an actor holding a shared role", async () => {
      await expect(
        service.createSchedule(actor("STRANGER", ORG_A, ["analyst"]), createArgs("ROLE")),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        service.createSchedule(actor("ROLEHOLDER", ORG_A, [SHARED_ROLE_KEY]), createArgs("ROLE")),
      ).resolves.toMatchObject({ ownerMembershipId: member.ROLEHOLDER });
    });

    it("create: another tenant's view id is a 404 (RLS), even for an org_admin", async () => {
      await expect(
        service.createSchedule(actor("OWNER", ORG_A, ADMIN_ROLES), createArgs("B_VIEW")),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("scheduled-run worker isRecipientEntitled (buildM33WorkerPorts under withOrgContext)", () => {
    /**
     * Exactly what `registerM33Workers`' scheduledRun worker does per job: org tx → ports over the tx.
     * `admins` is the org_admin set the snapshot-scope gate (`gateRecipientsBySnapshotScope`) resolves.
     * By default every member counts as an admin so the gate is inert and these cases isolate the
     * §4.7.2 view ladder; the "snapshot-scope gate" cases below pin the admin set explicitly.
     */
    const entitled = (
      membership: string,
      view: string,
      org = ORG_A,
      admins: readonly string[] = Object.values(member),
    ): Promise<boolean> =>
      withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        buildM33WorkerPorts({
          connection: { host: "127.0.0.1", port: 6379 },
          db: tx as unknown as DbClient,
          jobOrganizationId: org,
          adminMemberships: { adminMembershipIds: () => new Set(admins) },
        }).scheduledRun.recipients.isRecipientEntitled(
          member[membership] as string,
          org,
          viewId[view] as string,
        ),
      );

    it("snapshot-scope gate: with no org_admin, an org-shared view is delivered to its owner only", async () => {
      expect(await entitled("OWNER", "ORG", ORG_A, [])).toBe(true);
      expect(await entitled("RECIP", "ORG", ORG_A, [])).toBe(false);
    });

    it("snapshot-scope gate: an admin-owned org-scope snapshot is delivered to org admins only", async () => {
      const admins = [member.OWNER as string, member.ADMIN as string];
      expect(await entitled("ADMIN", "ORG", ORG_A, admins)).toBe(true);
      expect(await entitled("RECIP", "ORG", ORG_A, admins)).toBe(false);
    });

    it("an active member is entitled to an org-shared view", async () => {
      expect(await entitled("RECIP", "ORG")).toBe(true);
    });

    it("a PRIVATE view is deliverable to its owner only", async () => {
      expect(await entitled("OWNER", "PRIVATE")).toBe(true);
      expect(await entitled("RECIP", "PRIVATE")).toBe(false);
    });

    it("a role-shared view requires a CURRENT, unexpired shared role", async () => {
      expect(await entitled("ROLEHOLDER", "ROLE")).toBe(true);
      expect(await entitled("EXPIRED", "ROLE")).toBe(false); // role expired in 2020 ⇒ dropped
      expect(await entitled("RECIP", "ROLE")).toBe(false); // never held it
    });

    it("a revoked membership is dropped even though it still carries the shared role", async () => {
      expect(await entitled("REVOKED", "ROLE")).toBe(false);
      expect(await entitled("REVOKED", "ORG")).toBe(false);
    });

    it("a membership in another org is dropped (no cross-tenant delivery), and so is another org's view", async () => {
      expect(await entitled("FOREIGN", "ORG")).toBe(false);
      expect(await entitled("RECIP", "B_VIEW")).toBe(false);
    });

    it("flipping a role's expiry flips the answer (the role-join is live, not cached)", async () => {
      expect(await entitled("EXPIRED", "ROLE")).toBe(false);
      await admin.query(
        "UPDATE membership_role SET expires_at=$1 WHERE membership_id=$2 AND role_id=$3",
        [FUTURE, member.EXPIRED, roleId],
      );
      try {
        expect(await entitled("EXPIRED", "ROLE")).toBe(true);
      } finally {
        await admin.query(
          "UPDATE membership_role SET expires_at=$1 WHERE membership_id=$2 AND role_id=$3",
          [PAST, member.EXPIRED, roleId],
        );
      }
      expect(await entitled("EXPIRED", "ROLE")).toBe(false);
    });
  });
});
