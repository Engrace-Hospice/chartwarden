/**
 * M23 DDE work queue (ADR-0052) END TO END over real Postgres, as the NOBYPASSRLS `wardenx_app` role.
 *
 * The queue is human work tracking for Medicare Direct Data Entry: WardenX never calls DDE. What this proves
 * against real rows under REAL RLS, through the real Fastify routes, the real `provider_entity_billing_scope`
 * predicate and the real catalog-validating outbox publisher (never NOOP_OUTBOX):
 *   - a recorded MAC acceptance on an NOE item applies the notice's EXISTING acceptance transition
 *     (`ack_accepted`) and stores the operator-entered date as `payer_status_date` with source `dde_manual`;
 *   - record-submission needs the step-up (no step-up, no write); the append-only history and the M4 write-audit
 *     rows land; a read of an item leaves a read-audit event;
 *   - the `m23.dde_item.*` / `m23.noe.accepted` payloads are PHI-free (no notes, no MBI);
 *   - MBI-shaped notes are refused; cross-tenant isolation (read, write, forged insert); the history is append-only;
 *   - the NOE window-watch cron files ONE item per at-risk notice, idempotently, through the wired watchdog.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-queue:live
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
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { buildM23AbacPredicates } from "../src/modules/23-billing-medicare/abac-predicates";
import { buildDrizzleM23AbacResolver } from "../src/modules/23-billing-medicare/abac-resolver-drizzle";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import {
  type M23WorkerDeps,
  runNoeWindowWatch,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { M23_PERMISSION_KEY_LIST } from "../src/modules/23-billing-medicare/permission-keys";
import { registerDdeQueueRoutes } from "../src/modules/23-billing-medicare/routes/dde-queue.routes";
import { buildDdeQueueService } from "../src/modules/23-billing-medicare/services/dde-queue-service";
import { buildDdeWatchdog } from "../src/modules/23-billing-medicare/services/dde-watchdog";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MEMBERSHIP_A = "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1";
const MEMBERSHIP_B = "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1";
const PE_A = "77777777-7777-4777-8777-777777777777";
const NOTE = "keyed under option 28, call the MAC back Tuesday";
const BASE = "/api/v1/billing/dde-items";
const DDE_KEYS = [
  "billing.dde.read",
  "billing.dde.work",
  "billing.dde.mark_submitted",
  "billing.dde.admin",
];

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  const orgB = user === USER_B;
  request.context.userId = user;
  request.context.organizationId = orgB ? ORG_B : ORG_A;
  request.context.roles = ["org_admin"];
  request.context.attributes.membershipId = orgB ? MEMBERSHIP_B : MEMBERSHIP_A;
  if (request.headers["x-test-step-up"] === "1") request.context.attributes.stepUpRecent = true;
}

describe.skipIf(!DB_URL)("M23 DDE work queue, LIVE Postgres (ADR-0052)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let appUrl: string;
  let app: FastifyInstance;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let counter = 0;

  const asA = (extra: Record<string, string> = {}) => ({
    "x-test-user": USER_A,
    "idempotency-key": `dde-live-${++counter}`,
    ...extra,
  });
  const asB = () => ({ "x-test-user": USER_B, "idempotency-key": `dde-live-${++counter}` });
  const stepUp = { "x-test-step-up": "1" };
  const bound = (module: string) => ({
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule: module } as never),
  });

  async function seedNoe(
    over: Partial<{ state: string; windowTarget: string }> = {},
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO noe_record (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id,
         state, election_effective_date, window_target_at, noe_control_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-01-15',$8,$9)`,
      [
        id,
        ORG_A,
        PE_A,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        over.state ?? "READY",
        over.windowTarget ?? "2026-01-20",
        `NOE${counter++}${id.slice(0, 8)}`,
      ],
    );
    return id;
  }

  async function post(path: string, headers: Record<string, string>, payload: unknown) {
    return app.inject({
      method: "POST",
      url: `${BASE}${path}`,
      headers,
      payload: payload as never,
    });
  }

  async function keyAndAccept(itemId: string, macAcceptedOn: string, version = 0) {
    expect((await post(`/${itemId}/claim`, asA(), { expectedVersion: version })).statusCode).toBe(
      200,
    );
    expect(
      (await post(`/${itemId}/start`, asA(), { expectedVersion: version + 1 })).statusCode,
    ).toBe(200);
    const sub = await post(`/${itemId}/record-submission`, asA(stepUp), {
      expectedVersion: version + 2,
      dcn: "22123456789012345",
      notes: NOTE,
    });
    expect(sub.statusCode).toBe(200);
    return post(`/${itemId}/record-outcome`, asA(), {
      expectedVersion: version + 3,
      outcome: "accepted",
      macAcceptedOn,
    });
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
      `INSERT INTO "user" (id,email) VALUES ($1,'dde-a@x.test'),($2,'dde-b@x.test')`,
      [USER_A, USER_B],
    );
    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await app?.close();
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
      createInMemoryEffectivePermissionStore([grants(USER_A, ORG_A), grants(USER_B, ORG_B)]).store,
    );
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildM23AbacPredicates({
        resolver: buildDrizzleM23AbacResolver(handle.db as never),
        isInCaseload: async () => true,
      }),
    )) {
      reg.register(name, predicate);
    }
    reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerDdeQueueRoutes(app, {
      ddeQueueService: buildDdeQueueService(handle.db as never, { outbox: bound("m23") as never }),
    });
    await app.ready();
  });

  describe("migration 1060", () => {
    it("enables and FORCEs RLS on both tables and catalogues the four permission keys for the admin roles", async () => {
      const { rows } = await admin.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname IN ('dde_work_item','dde_work_event') ORDER BY relname`,
      );
      expect(rows).toEqual([
        { relname: "dde_work_event", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "dde_work_item", relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const perms = await admin.query(
        "SELECT key FROM permission WHERE key LIKE 'billing.dde.%' ORDER BY key",
      );
      expect(perms.rows.map((r) => r.key)).toEqual([...DDE_KEYS].sort());
    });

    it("lets payer_status_date_source take 'dde_manual' and still refuses an unknown source", async () => {
      const id = await seedNoe();
      await admin.query(
        "UPDATE noe_record SET payer_status_date='2026-01-18', payer_status_date_source='dde_manual' WHERE id=$1",
        [id],
      );
      await expect(
        admin.query(
          "UPDATE noe_record SET payer_status_date='2026-01-18', payer_status_date_source='guess' WHERE id=$1",
          [id],
        ),
      ).rejects.toThrow(/payer_status_date_chk/);
    });
  });

  describe("the NOE work item, end to end", () => {
    it("applies the notice's existing acceptance transition with the operator's MAC date (source dde_manual)", async () => {
      const noeId = await seedNoe({ windowTarget: "2026-01-20" });
      const created = await post("", asA(), { itemType: "noe", subjectId: noeId });
      expect(created.statusCode).toBe(201);
      const item = created.json();
      expect(item).toMatchObject({
        state: "queued",
        deadlineAt: "2026-01-20",
        itemType: "noe",
        subjectKind: "noe_record",
        providerEntityId: PE_A,
      });

      const dup = await post("", asA(), { itemType: "noe", subjectId: noeId });
      expect(dup.statusCode).toBe(409);

      expect(
        (await post(`/${item.ddeWorkItemId}/claim`, asA(), { expectedVersion: 0 })).statusCode,
      ).toBe(200);
      expect(
        (await post(`/${item.ddeWorkItemId}/start`, asA(), { expectedVersion: 1 })).statusCode,
      ).toBe(200);

      // The attestation needs a recent step-up: without it nothing is written.
      const noStepUp = await post(`/${item.ddeWorkItemId}/record-submission`, asA(), {
        expectedVersion: 2,
      });
      expect(noStepUp.statusCode).toBe(403);
      const stillInProgress = await admin.query(
        "SELECT state, submitted_at FROM dde_work_item WHERE id=$1",
        [item.ddeWorkItemId],
      );
      expect(stillInProgress.rows[0]).toMatchObject({ state: "in_progress", submitted_at: null });

      const sub = await post(`/${item.ddeWorkItemId}/record-submission`, asA(stepUp), {
        expectedVersion: 2,
        dcn: "22123456789012345",
        notes: NOTE,
      });
      expect(sub.statusCode).toBe(200);
      expect(sub.json().state).toBe("submitted");

      // Submitted with no acceptance is still at risk/overdue, never "met".
      const submittedStatus = sub.json().deadlineStatus;
      expect(["at_risk", "overdue"]).toContain(submittedStatus);

      const accepted = await post(`/${item.ddeWorkItemId}/record-outcome`, asA(), {
        expectedVersion: 3,
        outcome: "accepted",
        macAcceptedOn: "2026-01-18",
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        state: "accepted",
        macAcceptedOn: "2026-01-18",
        deadlineStatus: "met",
      });

      const noe = await admin.query(
        "SELECT state, payer_status_date::text AS d, payer_status_date_source AS s, accepted_at FROM noe_record WHERE id=$1",
        [noeId],
      );
      expect(noe.rows[0]).toMatchObject({
        state: "ACK_ACCEPTED",
        d: "2026-01-18",
        s: "dde_manual",
      });
      expect(noe.rows[0].accepted_at).not.toBeNull();

      // The item's append-only history, oldest first.
      const detail = await app.inject({
        method: "GET",
        url: `${BASE}/${item.ddeWorkItemId}`,
        headers: asA(),
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().events.map((e: { event: string }) => e.event)).toEqual([
        "create",
        "assign",
        "start",
        "submit",
        "accept",
      ]);
      expect(
        (await post(`/${item.ddeWorkItemId}/close`, asA(), { expectedVersion: 4 })).json().state,
      ).toBe("closed");
    });

    it("emits PHI-free events through the real publisher: no notes, no MBI, ids/type/state/codes only", async () => {
      const { rows } = await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE event_type LIKE 'm23.dde_item.%' OR event_type = 'm23.noe.accepted' ORDER BY created_at",
      );
      const types = rows.map((r) => r.event_type);
      expect(types).toContain("m23.dde_item.created");
      expect(types).toContain("m23.dde_item.state_changed");
      expect(types).toContain("m23.noe.accepted");
      const blob = JSON.stringify(rows.map((r) => r.payload));
      expect(blob).not.toContain("call the MAC back");
      expect(blob).not.toContain("notes");
      const accepted = rows.find((r) => r.event_type === "m23.noe.accepted");
      expect(accepted?.payload).toMatchObject({
        acknowledgmentId: null,
        payerStatusDateSource: "dde_manual",
        payerStatusDate: "2026-01-18",
      });
    });

    it("writes the M4 write-audit rows (notes scrubbed) and a read-audit event for the item read", async () => {
      const audit = await admin.query(
        "SELECT event_type, before, after FROM audit_event WHERE organization_id=$1 AND resource_kind IN ('dde_work_item','dde_work_event')",
        [ORG_A],
      );
      const types = new Set(audit.rows.map((r) => r.event_type));
      expect(types.has("dde_work_item.insert")).toBe(true);
      expect(types.has("dde_work_item.update")).toBe(true);
      expect(types.has("dde_work_event.insert")).toBe(true);
      expect(JSON.stringify(audit.rows)).not.toContain("call the MAC back");

      const read = await admin.query(
        "SELECT resource_id::text AS id, event_type FROM audit_event WHERE organization_id=$1 AND event_type = 'dde_work_item.viewed'",
        [ORG_A],
      );
      expect(read.rows.length).toBeGreaterThan(0);
      const itemIds = (
        await admin.query("SELECT id::text FROM dde_work_item WHERE organization_id=$1", [ORG_A])
      ).rows.map((r) => r.id);
      expect(itemIds).toContain(read.rows[0].id);
    });

    it("marks an acceptance dated after the window as missed, and a returned item reopens as attempt 2", async () => {
      const noeId = await seedNoe({ windowTarget: "2026-01-20" });
      const created = (await post("", asA(), { itemType: "noe", subjectId: noeId })).json();
      const late = await keyAndAccept(created.ddeWorkItemId, "2026-01-22");
      expect(late.json()).toMatchObject({ state: "accepted", deadlineStatus: "missed" });

      const noe2 = await seedNoe();
      const item2 = (await post("", asA(), { itemType: "noe", subjectId: noe2 })).json()
        .ddeWorkItemId as string;
      await post(`/${item2}/claim`, asA(), { expectedVersion: 0 });
      await post(`/${item2}/start`, asA(), { expectedVersion: 1 });
      await post(`/${item2}/record-submission`, asA(stepUp), { expectedVersion: 2 });
      const noCode = await post(`/${item2}/record-outcome`, asA(), {
        expectedVersion: 3,
        outcome: "returned",
      });
      expect(noCode.statusCode).toBe(422);
      const returned = await post(`/${item2}/record-outcome`, asA(), {
        expectedVersion: 3,
        outcome: "returned",
        rtpReasonCode: "37001",
      });
      expect(returned.json()).toMatchObject({
        state: "returned",
        rtpReasonCode: "37001",
        attemptNumber: 1,
      });
      const retried = await post(`/${item2}/retry`, asA(), { expectedVersion: 4 });
      expect(retried.json()).toMatchObject({ state: "in_progress", attemptNumber: 2 });
      // The notice was NOT touched by a return.
      const noe = await admin.query("SELECT state FROM noe_record WHERE id=$1", [noe2]);
      expect(noe.rows[0].state).toBe("READY");
    });

    it("refuses a stale version (412), a cancel after submission (409), and MBI-shaped or over-long notes (422)", async () => {
      const noeId = await seedNoe();
      const item = (await post("", asA(), { itemType: "noe", subjectId: noeId })).json();
      expect(
        (await post(`/${item.ddeWorkItemId}/claim`, asA(), { expectedVersion: 7 })).statusCode,
      ).toBe(412);
      const mbi = await post("", asA(), {
        itemType: "notr",
        subjectId: randomUUID(),
        notes: "patient 1EG4-TE5-MK73",
      });
      expect(mbi.statusCode).toBeGreaterThanOrEqual(400);
      const mbiOnSubmission = await post(`/${item.ddeWorkItemId}/record-submission`, asA(stepUp), {
        expectedVersion: 0,
        notes: "MBI 1EG4TE5MK73",
      });
      expect(mbiOnSubmission.statusCode).toBe(422);
      const tooLong = await post(`/${item.ddeWorkItemId}/record-submission`, asA(stepUp), {
        expectedVersion: 0,
        notes: "x".repeat(501),
      });
      expect(tooLong.statusCode).toBe(422);
      const notes = await admin.query("SELECT notes FROM dde_work_item WHERE id=$1", [
        item.ddeWorkItemId,
      ]);
      expect(notes.rows[0].notes).toBeNull();
      // cancel is legal before keying...
      expect(
        (await post(`/${item.ddeWorkItemId}/cancel`, asA(), { expectedVersion: 0 })).json().state,
      ).toBe("cancelled");
      // ...and not after.
      const noe2 = await seedNoe();
      const item2 = (await post("", asA(), { itemType: "noe", subjectId: noe2 })).json()
        .ddeWorkItemId as string;
      await post(`/${item2}/claim`, asA(), { expectedVersion: 0 });
      await post(`/${item2}/start`, asA(), { expectedVersion: 1 });
      await post(`/${item2}/record-submission`, asA(stepUp), { expectedVersion: 2 });
      expect((await post(`/${item2}/cancel`, asA(), { expectedVersion: 3 })).statusCode).toBe(409);
    });
  });

  describe("tenant isolation and the append-only history", () => {
    it("org B can neither read nor write org A's item, and RLS refuses a forged insert", async () => {
      const noeId = await seedNoe();
      const item = (await post("", asA(), { itemType: "noe", subjectId: noeId })).json()
        .ddeWorkItemId as string;

      expect(
        (await app.inject({ method: "GET", url: `${BASE}/${item}`, headers: asB() })).statusCode,
      ).toBe(404);
      const list = await app.inject({ method: "GET", url: BASE, headers: asB() });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toEqual([]);
      expect((await post(`/${item}/claim`, asB(), { expectedVersion: 0 })).statusCode).toBe(404);
      const cross = await post("", asB(), { itemType: "noe", subjectId: noeId });
      expect(cross.statusCode).toBe(404);

      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
        expect((await c.query("SELECT count(*)::int AS n FROM dde_work_item")).rows[0].n).toBe(0);
        await expect(
          c.query(
            `INSERT INTO dde_work_item (organization_id, provider_entity_id, patient_id, item_type, subject_kind, subject_id)
             VALUES ($1,$2,$3,'noe','noe_record',$4)`,
            [ORG_A, PE_A, randomUUID(), randomUUID()],
          ),
        ).rejects.toThrow(/row-level security/);
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    });

    it("refuses UPDATE and DELETE of a history row, even for the app role", async () => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(c.query("UPDATE dde_work_event SET event='create'")).rejects.toThrow();
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(c.query("DELETE FROM dde_work_event")).rejects.toThrow();
      } finally {
        await c.query("ROLLBACK");
        await c.end();
      }
    });
  });

  describe("the NOE window-watch cron", () => {
    it("files one item per at-risk notice, idempotently, and never respawns a cancelled one", async () => {
      const atRisk = await seedNoe({ windowTarget: "2026-02-02" });
      const far = await seedNoe({ windowTarget: "2026-03-30" });
      const deps = {
        connection: {},
        db: handle.db as never,
        now: () => new Date("2026-02-01T12:00:00Z"),
        outbox: bound("m23") as never,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        // The existing breach path is not under test here: past-window notices from the other cases stamp harmlessly.
        noticeWindow: { recordBreach: async () => undefined },
        alerts: { dispatch: async () => undefined },
        ddeWatchdog: buildDdeWatchdog({ outbox: bound("m23") as never }),
      } as unknown as M23WorkerDeps;

      await runNoeWindowWatch(deps);
      await runNoeWindowWatch(deps);

      const items = await admin.query(
        "SELECT id, state, source, deadline_at::text AS d FROM dde_work_item WHERE subject_id=$1",
        [atRisk],
      );
      expect(items.rows).toHaveLength(1);
      expect(items.rows[0]).toMatchObject({ state: "queued", source: "watchdog", d: "2026-02-02" });
      expect(
        (await admin.query("SELECT 1 FROM dde_work_item WHERE subject_id=$1", [far])).rowCount,
      ).toBe(0);

      const cancelled = await post(`/${items.rows[0].id}/cancel`, asA(), { expectedVersion: 0 });
      expect(cancelled.json().state).toBe("cancelled");
      await runNoeWindowWatch(deps);
      expect(
        (await admin.query("SELECT 1 FROM dde_work_item WHERE subject_id=$1", [atRisk])).rowCount,
      ).toBe(1);
    });
  });
});
