/**
 * F-109 (#103) — `alert.outcome` and the §2.4.4 delivery lifecycle, LIVE Postgres.
 *
 * `alert.outcome` was `NOT NULL DEFAULT 'delivered'` and **written by nothing**. `computeOutcome` — the
 * §2.4.3 roll-up — has existed since M36-T04 with no caller. `notification_delivery.status` has **no
 * UPDATE anywhere in the repository**, so the §2.4.4 machine had exactly one reachable state. Every alert
 * row in every database asserted successful delivery while every one of its deliveries sat `pending`
 * forever, and `GET /api/v1/alerts/inbox` — whose only caller is the web Notifications tab — returned
 * `deliveryStatus: "pending"` for every line, always.
 *
 * The enum could not say otherwise: §2.4.3's machine OPENS in `pending` and `alert_outcome` had three
 * values, none of them that one. Migration 0240 adds it; 0241 moves the DEFAULT and corrects the rows
 * written under the old one.
 *
 * Settlement is the inbox READ, because ADR-0036 (Accepted; it wins over a module spec) records that the
 * socket §2.4.4 names was never built and "UI freshness is REST refetch/poll" — so the poll IS the in-app
 * delivery. Out-of-band rows stay `pending`: no dispatcher exists for them, and that is why an alert with
 * a recipient who has out-of-band preferences settles nowhere. That is the honest state, not a new defect.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:alert-outcome:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbMessagingRouteService,
  createDrizzleAlertEmitter,
  createDrizzleAlertEmitterPorts,
} from "../src/modules/36-messaging/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A1 = "33333333-3333-3333-3333-333333333331";
const USER_A2 = "33333333-3333-3333-3333-333333333332";
const USER_B1 = "33333333-3333-3333-3333-333333333333";

/** The one event this suite routes. `broadcast` resolves through a plain membership query, so no M5/M19
 *  recipient seam has to be bound for the fan-out to be real. */
const BROADCAST_EVENT = "test.f109.broadcast";
/** An event NO rule fires for — `emit()` still writes a no-op alert, and that row is the one the old
 *  `DEFAULT 'delivered'` was most wrong about. */
const UNROUTED_EVENT = "test.f109.unrouted";

describe.skipIf(!DB_URL)("F-109 — alert outcome + §2.4.4 settlement, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let emitter: ReturnType<typeof createDrizzleAlertEmitter>;
  let service: ReturnType<typeof createDbMessagingRouteService>;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

  async function alertRow(id: string) {
    const { rows } = await admin.query("SELECT outcome FROM alert WHERE id=$1", [id]);
    return rows[0];
  }
  async function deliveries(alertId: string) {
    const { rows } = await admin.query(
      `SELECT recipient_user_id, channel, status, sent_at, settled_at
         FROM notification_delivery WHERE alert_id=$1 ORDER BY recipient_user_id, channel`,
      [alertId],
    );
    return rows;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const [u, org] of [
      [USER_A1, ORG_A],
      [USER_A2, ORG_A],
      [USER_B1, ORG_B],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [u, `${u}@x.test`]);
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [u, org],
      );
    }
    // One platform-default (organization_id NULL) broadcast rule — both tenants inherit it.
    await admin.query(
      `INSERT INTO alert_rule (organization_id,event_type,category,severity_floor,recipient_resolver,resolver_args)
       VALUES (NULL,$1,'operational','info','broadcast','{}'::jsonb)`,
      [BROADCAST_EVENT],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    emitter = createDrizzleAlertEmitter(handle.db);
    service = createDbMessagingRouteService(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("migration 0240/0241 — the enum carries `pending` and it is the column default", async () => {
    const { rows } = await admin.query(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'alert_outcome' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(["pending", "delivered", "partial", "failed"]);
    const def = await admin.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name='alert' AND column_name='outcome'`,
    );
    expect(String(def.rows[0].column_default)).toContain("pending");
  });

  it("an alert no rule routes settles `failed`, not `delivered`", async () => {
    const { alertId, resolvedRecipientCount } = await emitter.emit(ORG_A, {
      eventType: UNROUTED_EVENT,
      payload: {},
      severity: "info",
      correlationId: randomUUID(),
    });
    expect(resolvedRecipientCount).toBe(0);
    expect(await deliveries(alertId)).toHaveLength(0);
    // The old default said `delivered` here — successfully delivered to the zero people it reached.
    expect((await alertRow(alertId)).outcome).toBe("failed");
  });

  it("a routed alert opens `pending` with an unsettled in-app floor for every recipient", async () => {
    const { alertId, resolvedRecipientCount } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: { note: "f109" },
      severity: "info",
      correlationId: randomUUID(),
    });
    expect(resolvedRecipientCount).toBe(2); // both org-A members; org B's is a different tenant
    const rows = await deliveries(alertId);
    expect(rows.map((r) => r.channel)).toEqual(["in_app", "in_app"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
    expect((await alertRow(alertId)).outcome).toBe("pending");
  });

  it("the inbox read IS the in-app delivery, and it re-settles the parent", async () => {
    const { alertId } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: {},
      severity: "info",
      correlationId: randomUUID(),
    });

    // USER_A1 polls. Before F-109 every inbox line read "pending" for every user, forever.
    const inbox = await service.alertInbox(ORG_A, USER_A1);
    const item = inbox.find((i) => i.alertId === alertId);
    expect(item?.deliveryStatus).toBe("delivered");

    const rows = await deliveries(alertId);
    const mine = rows.find((r) => r.recipient_user_id === USER_A1);
    const theirs = rows.find((r) => r.recipient_user_id === USER_A2);
    expect(mine?.status).toBe("delivered");
    expect(mine?.settled_at).not.toBeNull();
    // One caller's poll settles only that caller's row.
    expect(theirs?.status).toBe("pending");
    // …so the alert is still pending: §2.4.3 `delivered` needs EVERY recipient's floor.
    expect((await alertRow(alertId)).outcome).toBe("pending");

    await service.alertInbox(ORG_A, USER_A2);
    expect((await alertRow(alertId)).outcome).toBe("delivered");
  });

  it("projects message + safe deepLink without exposing the private payload", async () => {
    const message = "A field clinician's overdue safety check-in has escalated.";
    const { alertId } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: {
        message,
        deepLink: "/patients/patient-123/emar",
        patientId: "patient-secret",
        escalationData: { tier: 3 },
      },
      severity: "info",
      correlationId: randomUUID(),
    });

    const unread = (await service.alertInbox(ORG_A, USER_A1)).find((i) => i.alertId === alertId);
    expect(unread).toEqual({
      alertId,
      eventType: BROADCAST_EVENT,
      category: "operational",
      severity: "info",
      summary: message,
      deepLink: "/patients/patient-123/emar",
      createdAt: expect.any(String),
      deliveryStatus: "delivered",
      readAt: null,
    });
    expect(unread).not.toHaveProperty("payload");
    expect(unread).not.toHaveProperty("patientId");
    expect(unread).not.toHaveProperty("escalationData");

    await service.markAlertRead(ORG_A, USER_A1, alertId);
    const read = (await service.alertInbox(ORG_A, USER_A1)).find((i) => i.alertId === alertId);
    expect(read?.deliveryStatus).toBe("delivered");
    expect(read?.readAt).toEqual(expect.any(String));
  });

  it("a second poll settles nothing again (the receipt is not re-stamped)", async () => {
    const { alertId } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: {},
      severity: "info",
      correlationId: randomUUID(),
    });
    await service.alertInbox(ORG_A, USER_A1);
    const first = (await deliveries(alertId)).find((r) => r.recipient_user_id === USER_A1);
    await service.alertInbox(ORG_A, USER_A1);
    const second = (await deliveries(alertId)).find((r) => r.recipient_user_id === USER_A1);
    expect(second.settled_at.toISOString()).toBe(first.settled_at.toISOString());
  });

  it("org B's poll cannot settle org A's delivery", async () => {
    const { alertId } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: {},
      severity: "info",
      correlationId: randomUUID(),
    });
    // Same user id is deliberately NOT used — B's member polls B's inbox and A's rows must be invisible
    // to it through both the parent-join RLS policy and the explicit organization predicate.
    const inbox = await service.alertInbox(ORG_B, USER_B1);
    expect(inbox.some((i) => i.alertId === alertId)).toBe(false);
    expect((await deliveries(alertId)).every((r) => r.status === "pending")).toBe(true);
    expect((await alertRow(alertId)).outcome).toBe("pending");
  });

  it("an out-of-band channel keeps the alert pending after the in-app read — no dispatcher settles it", async () => {
    // USER_A1 asks for email too. `planFanOut` adds the row; nothing in this platform sends it, which is
    // exactly what an unsettled alert is now able to say.
    await admin.query(
      `INSERT INTO user_notification_preferences (user_id, organization_id, routing_map)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (user_id, organization_id) DO UPDATE SET routing_map = EXCLUDED.routing_map`,
      [USER_A1, ORG_A, JSON.stringify({ operational: { info: ["in_app", "email"] } })],
    );
    const { alertId } = await emitter.emit(ORG_A, {
      eventType: BROADCAST_EVENT,
      payload: {},
      severity: "info",
      correlationId: randomUUID(),
    });
    await service.alertInbox(ORG_A, USER_A1);
    await service.alertInbox(ORG_A, USER_A2);

    const rows = await deliveries(alertId);
    const email = rows.find((r) => r.channel === "email");
    expect(email?.status).toBe("pending"); // untouched: the read settles in-app only
    expect((await alertRow(alertId)).outcome).toBe("pending");
  });
  it("GAP-096: a legacy tenant-owned platform_* row does not make its holder a platform-alert recipient", async () => {
    const membershipOf = async (u: string) =>
      (await admin.query("SELECT id FROM membership WHERE user_id=$1", [u])).rows[0].id as string;
    // A row that predates migration 0318: the NOT VALID CHECK refuses it today, so it is planted the
    // way history left it (constraint lifted for the insert, then restored as it was, NOT VALID).
    const checkDef = (
      await admin.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='role_platform_authority_platform_owned'",
      )
    ).rows[0].def as string;
    await admin.query("ALTER TABLE role DROP CONSTRAINT role_platform_authority_platform_owned");
    const legacy = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'platform_security_owner','Legacy','operations',true) RETURNING id",
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query(
      `ALTER TABLE role ADD CONSTRAINT role_platform_authority_platform_owned ${checkDef}`,
    );
    const platform = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES (NULL,'platform_security_owner','Platform Security Owner','platform_staff',true) RETURNING id",
      )
    ).rows[0].id as string;
    for (const [u, roleId] of [
      [USER_A1, legacy],
      [USER_A2, platform],
    ] as const)
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [ORG_A, await membershipOf(u), roleId],
      );

    const { recipients } = createDrizzleAlertEmitterPorts(handle.db);
    expect(await recipients.roleSetMembers(ORG_A, ["platform_security_owner"])).toEqual([USER_A2]);
  });
  it("roleSetMembersForProviderEntity resolves only members whose default PE is the named one (biller_for_pe)", async () => {
    const membershipOf = async (u: string) =>
      (await admin.query("SELECT id FROM membership WHERE user_id=$1", [u])).rows[0].id as string;
    const PE_1 = "00000000-0000-4000-8000-0000000000e1";
    const PE_2 = "00000000-0000-4000-8000-0000000000e2";
    const biller = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'biller','Biller','operations',true) RETURNING id",
        [ORG_A],
      )
    ).rows[0].id as string;
    for (const u of [USER_A1, USER_A2])
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [ORG_A, await membershipOf(u), biller],
      );
    await admin.query("UPDATE membership SET default_provider_entity_id=$1 WHERE id=$2", [
      PE_1,
      await membershipOf(USER_A1),
    ]);
    await admin.query("UPDATE membership SET default_provider_entity_id=$1 WHERE id=$2", [
      PE_2,
      await membershipOf(USER_A2),
    ]);

    const { recipients } = createDrizzleAlertEmitterPorts(handle.db);
    expect(await recipients.roleSetMembersForProviderEntity?.(ORG_A, ["biller"], PE_1)).toEqual([
      USER_A1,
    ]);
    expect(await recipients.roleSetMembersForProviderEntity?.(ORG_A, ["biller"], PE_2)).toEqual([
      USER_A2,
    ]);
    expect(
      await recipients.roleSetMembersForProviderEntity?.(
        ORG_A,
        ["biller"],
        "00000000-0000-4000-8000-0000000000e3",
      ),
    ).toEqual([]);
  });
});
