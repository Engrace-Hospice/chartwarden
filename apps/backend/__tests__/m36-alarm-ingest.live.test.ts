/**
 * M36 WP 6.10 (ADR-0101) - alarm ingest, WATCH ONLY, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The real route stack (Authorization Contract, step-up predicate), the REAL alert emitter and fan-out over the seeded platform rules, the real
 * tenant-ring cipher path, and the guard triggers of migration 1250.
 *
 *   1. FLAG / ACCESS   off => create and rotate 404, the inbound route 401, list and disable still work; 401 / 403 on the staff routes.
 *   2. CREDENTIAL      the secret is returned once, is stored as a sealed cipher (never plaintext), and is absent from the audit rows.
 *   3. INBOUND         a signed alarm becomes ONE ordinary in-app alert for the supervisors: capped at warn, a fixed message, no response
 *                      request, no message, no routing row.
 *   4. IDEMPOTENCY     a replay, a retry after a failed emit and 6 concurrent copies alert exactly once; a changed body under one id is 409.
 *   5. UNMAPPED / DEAD an unmapped kind is recorded and refused; a rotated, disabled, stale or tampered request is the one 401.
 *   6. DATABASE        the app role cannot delete, cannot store a critical, cannot re-enable a source or edit a mapping, settles an event once.
 *   7. TENANCY         org B sees and changes nothing of org A; a credential of one org under the other org's key id is the same 401; the
 *                      alert reaches only the right org's people; RLS hides every alarm row from the other org at the database.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:alarm-ingest:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { RingBodyDek } from "@chartwarden/messaging";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { signAlarmRequest } from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-core";
import { createAlarmIngestService } from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-service";
import { createDrizzleAlarmIngestStore } from "../src/modules/36-messaging/alarm-ingest/alarm-ingest-store";
import {
  createDrizzleAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerAlarmIngestRoutes } from "../src/modules/36-messaging/routes/alarm-ingest-routes";
import { type LiveKit, as, bootLiveKit, headerAuth } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a6a0001";
const ORG_B = "22222222-2222-4222-8222-22220a6a0002";
const FLAG = "messaging.alarm_ingest";
const MANAGE = ["messaging.alarm_ingest.manage"];
const SOURCES = "/api/v1/messaging/alarm-sources";
const INGEST = "/api/v1/messaging/alarm-ingest/events";
const MAPPINGS = [
  { alarmKind: "bed_exit", alertType: "alarm_ingest.patient_sensor", severityCeiling: "warn" },
  { alarmKind: "call", alertType: "alarm_ingest.nurse_call", severityCeiling: "info" },
];

interface Cred {
  id: string;
  keyId: string;
  secret: string;
}

describe.skipIf(!DB_URL)("M36 WP 6.10 alarm ingest - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  const flags: Record<string, boolean> = { [FLAG]: true };
  let stepUpFresh = true;
  let failEmits = 0;
  let officerA: string;
  let officerB: string;
  let nurseA: string;
  let supervisorA: string;
  let supervisorB: string;

  const call = (method: "GET" | "POST", url: string, user: string | null, org: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: user ? as(user, org) : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const create = async (org = ORG_A, user = officerA, name = "Ward 2 sensors"): Promise<Cred> => {
    const res = await call("POST", SOURCES, user, org, { name, mappings: MAPPINGS });
    expect(res.statusCode).toBe(201);
    return res.json() as Cred;
  };
  const nowSec = () => String(Math.floor(Date.now() / 1000));
  const post = (
    cred: { keyId: string; secret: string },
    body: unknown,
    over: { keyId?: string; secret?: string; timestamp?: string } = {},
  ) => {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    const keyId = over.keyId ?? cred.keyId;
    const timestamp = over.timestamp ?? nowSec();
    return app.inject({
      method: "POST",
      url: INGEST,
      headers: {
        "content-type": "application/json",
        "x-wx-key-id": keyId,
        "x-wx-timestamp": timestamp,
        "x-wx-signature": signAlarmRequest({ secret: over.secret ?? cred.secret, keyId, timestamp, rawBody }),
      },
      payload: rawBody,
    });
  };
  const alerts = (org: string, type?: string) =>
    kit.one<{ id: string; severity: string; payload: Record<string, unknown>; correlation_id: string }>(
      `SELECT id, severity, payload, correlation_id FROM alert WHERE organization_id=$1 ${type ? "AND event_type=$2" : ""} ORDER BY created_at`,
      type ? [org, type] : [org],
    );
  const tableCounts = async () => ({
    ackRequests: await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_request"),
    ackEvents: await kit.count("SELECT count(*)::int AS n FROM message_acknowledgment_event"),
    messages: await kit.count("SELECT count(*)::int AS n FROM message"),
  });

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr101");
    officerA = await kit.seedUser("officer-a", ORG_A, MANAGE);
    nurseA = await kit.seedUser("nurse-a", ORG_A, ["messaging.read"]);
    supervisorA = await kit.seedUser("supervisor-a", ORG_A, ["messaging.read"]);
    officerB = await kit.seedUser("officer-b", ORG_B, MANAGE);
    supervisorB = await kit.seedUser("supervisor-b", ORG_B, ["messaging.read"]);

    // The alert audience: holders of messaging.review through a DB role (what the seeded rule's permission_holders resolver reads).
    await kit.admin.query(
      `INSERT INTO permission (key,resource,action,category) VALUES ('messaging.review','messaging','review','clinical') ON CONFLICT (key) DO NOTHING`,
    );
    for (const [org, user] of [
      [ORG_A, supervisorA],
      [ORG_B, supervisorB],
    ] as const) {
      const role = (
        await kit.admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'rn_supervisor','Supervisor','clinical_staff',true) RETURNING id`,
          [org],
        )
      ).rows[0].id as string;
      await kit.admin.query(
        `INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'messaging.review')`,
        [org, role],
      );
      await kit.admin.query(
        `INSERT INTO membership_role (organization_id,membership_id,role_id)
         SELECT $1, m.id, $2 FROM membership m WHERE m.user_id=$3 AND m.organization_id=$1`,
        [org, role, user],
      );
    }

    const registry = createPredicateRegistry();
    registry.register("step_up_recent", async () => stepUpFresh);
    registerAbacRegistry(registry);

    const emitter = createDrizzleAlertEmitter(kit.handle.db);
    registerMessagingSeams({ emitter });
    await wireAlertRuleSeed(kit.handle.db);
    // The tenant ring: a distinct key per org (the AAD also binds the org).
    const ringKey = (org: string): RingBodyDek => ({
      version: "v1",
      key: createHash("sha256").update(`adr101-ring:${org}`).digest(),
    });
    const keys = {
      dekForOrg: async (org: string) => ringKey(org),
      dekForOrgVersion: async (org: string) => ringKey(org),
    };
    const service = createAlarmIngestService({
      store: createDrizzleAlarmIngestStore(kit.handle.db),
      cipher: createMessageBodyCipher({ keys }),
      flags: { forOrg: async () => flags },
      alerts: () => ({
        emit: (org, input) => {
          if (failEmits > 0) {
            failEmits -= 1;
            return Promise.reject(new Error("fan-out down"));
          }
          return emitter.emit(org, input);
        },
      }),
    });
    app = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    registerAlarmIngestRoutes(app, { service });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await kit?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  it("1. flag off: create and rotate 404 (before the step-up), the inbound route 401, list and disable still work; 401 / 403 on staff routes", async () => {
    const cred = await create();
    flags[FLAG] = false;
    stepUpFresh = false;
    try {
      expect((await call("POST", SOURCES, officerA, ORG_A, { name: "x", mappings: MAPPINGS })).statusCode).toBe(404);
      expect((await call("POST", `${SOURCES}/${cred.id}/rotate-secret`, officerA, ORG_A, {})).statusCode).toBe(404);
      expect((await post(cred, { eventId: "off-1", alarmKind: "call" })).statusCode).toBe(401);
      expect((await call("GET", SOURCES, officerA, ORG_A)).statusCode).toBe(200);
    } finally {
      flags[FLAG] = true;
      stepUpFresh = true;
    }
    expect((await post(cred, { eventId: "off-1", alarmKind: "call" })).statusCode).toBe(202);
    expect((await call("GET", SOURCES, null, ORG_A)).statusCode).toBe(401);
    expect((await call("GET", SOURCES, nurseA, ORG_A)).statusCode).toBe(403);
    expect((await call("POST", SOURCES, nurseA, ORG_A, { name: "x", mappings: MAPPINGS })).statusCode).toBe(403);
    stepUpFresh = false;
    for (const url of [SOURCES, `${SOURCES}/${cred.id}/rotate-secret`, `${SOURCES}/${cred.id}/disable`]) {
      const res = await call("POST", url, officerA, ORG_A, url === SOURCES ? { name: "x", mappings: MAPPINGS } : {});
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code, url).toBe("STEP_UP_REQUIRED");
    }
    stepUpFresh = true;
    // disable works with the flag off
    flags[FLAG] = false;
    expect((await call("POST", `${SOURCES}/${cred.id}/disable`, officerA, ORG_A, {})).statusCode).toBe(200);
    flags[FLAG] = true;
  });

  it("2. the secret is returned once, stored sealed (never plaintext) and is not in the audit rows or the list", async () => {
    const cred = await create(ORG_A, officerA, "Audit probe");
    expect(cred.secret).toMatch(/^wxas_[A-Za-z0-9_-]{43}$/);
    const [row] = await kit.one<{ cipher: Buffer }>(
      `SELECT secret_cipher AS cipher FROM alarm_source WHERE id=$1`,
      [cred.id],
    );
    expect(row!.cipher[0]).toBe(2); // the ring envelope marker
    expect(row!.cipher.toString("utf8")).not.toContain(cred.secret);
    expect(row!.cipher.toString("latin1")).not.toContain(cred.secret);
    const audit = await kit.one<{ blob: string }>(
      `SELECT (coalesce(before::text,'') || coalesce(after::text,'') || coalesce(context::text,'')) AS blob
         FROM audit_event WHERE resource_kind='alarm_source' AND resource_id=$1`,
      [cred.id],
    );
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) {
      expect(a.blob).not.toContain(cred.secret);
      expect(a.blob).not.toContain(row!.cipher.toString("hex"));
      expect(a.blob).not.toContain(row!.cipher.toString("base64"));
    }
    const list = await call("GET", SOURCES, officerA, ORG_A);
    expect(list.body).not.toContain(cred.secret);
    expect(list.body).not.toContain("secret_cipher");
    expect(list.json().sources.find((s: { id: string }) => s.id === cred.id)).toBeDefined();
  });

  it("3. a signed alarm becomes ONE ordinary in-app alert for the supervisors: capped at warn, fixed message, no response request, no message", async () => {
    const cred = await create(ORG_A, officerA, "Ward 3 bed sensors");
    const before = await tableCounts();
    const res = await post(cred, { eventId: "bed-100", alarmKind: "bed_exit", severity: "critical" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted", outcome: "alerted" });

    const [event] = await kit.one<Record<string, unknown>>(
      `SELECT * FROM alarm_ingest_event WHERE source_id=$1 AND event_id='bed-100'`,
      [cred.id],
    );
    expect(event).toMatchObject({
      status: "alerted",
      alert_type: "alarm_ingest.patient_sensor",
      requested_severity: "critical",
      effective_severity: "warn",
      recipient_count: 1,
    });
    const found = (await alerts(ORG_A, "alarm_ingest.patient_sensor")).filter(
      (a) => a.correlation_id === `alarm:${event!.id as string}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warn");
    expect(Object.keys(found[0]!.payload).sort()).toEqual(
      ["alarmEventId", "alarmKind", "eventType", "message", "sourceId"].sort(),
    );
    expect(String(found[0]!.payload.message)).toMatch(/does not replace the nurse-call/);
    const deliveries = await kit.one<{ recipient_user_id: string; channel: string }>(
      `SELECT recipient_user_id, channel FROM notification_delivery WHERE alert_id=$1`,
      [found[0]!.id],
    );
    expect(deliveries.map((d) => d.channel)).toEqual(["in_app"]);
    expect(deliveries.map((d) => d.recipient_user_id)).toEqual([supervisorA]);

    // Watch only: no response request, no event, no message was created.
    expect(await tableCounts()).toEqual(before);
    // A sender-supplied kind cannot reach a non-alarm catalog type: the event row's alert type is a mapped alarm_ingest.* type only.
    expect(await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event WHERE alert_type NOT LIKE 'alarm_ingest.%'`)).toBe(0);
  });

  it("4. idempotency: a replay, a retry after a failed emit and 6 concurrent copies alert exactly once; a changed body is 409", async () => {
    const cred = await create(ORG_A, officerA, "Idempotency probe");
    const first = await post(cred, { eventId: "dup-1", alarmKind: "call" });
    expect(first.json()).toEqual({ status: "accepted", outcome: "alerted" });
    expect((await post(cred, { eventId: "dup-1", alarmKind: "call" })).json()).toEqual({ status: "duplicate", outcome: "alerted" });
    expect((await post(cred, { eventId: "dup-1", alarmKind: "call", severity: "warn" })).statusCode).toBe(409);

    const concurrent = await Promise.all(Array.from({ length: 6 }, () => post(cred, { eventId: "race-1", alarmKind: "call" })));
    for (const r of concurrent) expect([202, 503]).toContain(r.statusCode);
    // any copy that lost a race to settle may have been told to retry; a retry now is a plain duplicate
    expect((await post(cred, { eventId: "race-1", alarmKind: "call" })).statusCode).toBe(202);
    const [race] = await kit.one<{ id: string; status: string }>(
      `SELECT id, status FROM alarm_ingest_event WHERE source_id=$1 AND event_id='race-1'`,
      [cred.id],
    );
    expect(race!.status).toBe("alerted");
    expect(await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event WHERE source_id=$1 AND event_id='race-1'`, [cred.id])).toBe(1);
    expect(await kit.count(`SELECT count(*)::int AS n FROM alert WHERE organization_id=$1 AND correlation_id=$2`, [ORG_A, `alarm:${race!.id}`])).toBe(1);

    failEmits = 1;
    const down = await post(cred, { eventId: "retry-1", alarmKind: "call" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("ALARM_NOT_ALERTED");
    const [pending] = await kit.one<{ id: string; status: string }>(
      `SELECT id, status FROM alarm_ingest_event WHERE source_id=$1 AND event_id='retry-1'`,
      [cred.id],
    );
    expect(pending!.status).toBe("received");
    expect((await post(cred, { eventId: "retry-1", alarmKind: "call" })).json()).toEqual({ status: "duplicate", outcome: "alerted" });
    expect(await kit.count(`SELECT count(*)::int AS n FROM alert WHERE organization_id=$1 AND correlation_id=$2`, [ORG_A, `alarm:${pending!.id}`])).toBe(1);
  });

  it("5. unmapped kinds are recorded and refused; rotated, disabled, stale and tampered requests are the one 401", async () => {
    const cred = await create(ORG_A, officerA, "Dead credential probe");
    const unmapped = await post(cred, { eventId: "u-1", alarmKind: "smoke_detector" });
    expect(unmapped.statusCode).toBe(422);
    expect(unmapped.json().error.code).toBe("ALARM_KIND_UNMAPPED");
    expect(await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event WHERE source_id=$1 AND status='unmapped'`, [cred.id])).toBe(1);
    const listed = (await call("GET", SOURCES, officerA, ORG_A)).json().sources.find((s: { id: string }) => s.id === cred.id);
    expect(listed.last24h.unmapped).toBe(1);

    const body = { eventId: "dead-1", alarmKind: "call" };
    const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "");
    const refusals = [
      await post(cred, body, { secret: "wxas_nope" }),
      await post(cred, body, { timestamp: String(Number(nowSec()) - 1000) }),
      await post(cred, body, { keyId: `${ORG_A}.${randomUUID()}` }),
      await app.inject({ method: "POST", url: INGEST, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) }),
    ];
    for (const r of refusals) expect(r.statusCode).toBe(401);
    expect(new Set(refusals.map((r) => strip(r.body))).size).toBe(1);

    const rotated = (await call("POST", `${SOURCES}/${cred.id}/rotate-secret`, officerA, ORG_A, {})).json() as Cred;
    expect(rotated.secret).not.toBe(cred.secret);
    expect((await post(cred, body)).statusCode).toBe(401); // the old secret is dead at once
    expect((await post(rotated, body)).statusCode).toBe(202);
    const [src] = await kit.one<{ secret_generation: number; rotated_at: Date | null }>(
      `SELECT secret_generation, rotated_at FROM alarm_source WHERE id=$1`,
      [cred.id],
    );
    expect(src!.secret_generation).toBe(2);
    expect(src!.rotated_at).not.toBeNull();

    expect((await call("POST", `${SOURCES}/${cred.id}/disable`, officerA, ORG_A, {})).statusCode).toBe(200);
    expect((await post(rotated, { eventId: "dead-2", alarmKind: "call" })).statusCode).toBe(401);
    expect((await call("POST", `${SOURCES}/${cred.id}/rotate-secret`, officerA, ORG_A, {})).statusCode).toBe(404);
    expect((await call("POST", `${SOURCES}/${cred.id}/disable`, officerA, ORG_A, {})).statusCode).toBe(200); // idempotent
  });

  it("6. the database: no delete, no critical, no re-enable, no mapping edit, an event settles once, a generation moves by one", async () => {
    const cred = await create(ORG_A, officerA, "Database probe");
    await post(cred, { eventId: "db-1", alarmKind: "call" });
    const app_ = async (sql: string, params: unknown[] = []) => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_A]);
        return await kit.appConn.query(sql, params);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    };
    await expect(app_(`DELETE FROM alarm_source WHERE id=$1`, [cred.id])).rejects.toThrow(/permission denied/i);
    await expect(app_(`DELETE FROM alarm_ingest_event WHERE source_id=$1`, [cred.id])).rejects.toThrow(/permission denied/i);
    await expect(app_(`UPDATE alarm_source_mapping SET severity_ceiling='info' WHERE source_id=$1`, [cred.id])).rejects.toThrow(/permission denied/i);
    await expect(
      app_(
        `INSERT INTO alarm_source_mapping (organization_id,source_id,alarm_kind,alert_type,severity_ceiling) VALUES ($1,$2,'x','alarm_ingest.equipment','critical')`,
        [ORG_A, cred.id],
      ),
    ).rejects.toThrow(/alarm_source_mapping_ceiling/);
    await expect(
      app_(
        `INSERT INTO alarm_source_mapping (organization_id,source_id,alarm_kind,alert_type,severity_ceiling) VALUES ($1,$2,'x','m36.ack.requested','warn')`,
        [ORG_A, cred.id],
      ),
    ).rejects.toThrow(/alarm_source_mapping_alert_type/);
    await expect(
      app_(
        `INSERT INTO alarm_ingest_event (organization_id,source_id,event_id,payload_digest,alarm_kind,alert_type,effective_severity,status)
         VALUES ($1,$2,'crit-1',$3,'call','alarm_ingest.nurse_call','critical','received')`,
        [ORG_A, cred.id, "0".repeat(64)],
      ),
    ).rejects.toThrow(/alarm_ingest_event_effective_severity/);
    await expect(app_(`UPDATE alarm_source SET secret_generation = secret_generation + 5 WHERE id=$1`, [cred.id])).rejects.toThrow(/alarm_source_rotation/);
    await expect(app_(`UPDATE alarm_source SET name='renamed' WHERE id=$1`, [cred.id])).rejects.toThrow(/permission denied/i);
    await expect(app_(`UPDATE alarm_ingest_event SET status='received' WHERE source_id=$1`, [cred.id])).rejects.toThrow(/alarm_ingest_event_forward_only/);
    await expect(app_(`UPDATE alarm_ingest_event SET payload_digest=$2 WHERE source_id=$1`, [cred.id, "1".repeat(64)])).rejects.toThrow(/permission denied/i);

    await call("POST", `${SOURCES}/${cred.id}/disable`, officerA, ORG_A, {});
    await expect(app_(`UPDATE alarm_source SET enabled=true, disabled_at=NULL, disabled_by=NULL WHERE id=$1`, [cred.id])).rejects.toThrow(/alarm_source_final|alarm_source_disabled_shape/);
  });

  it("7. tenancy: org B sees and changes nothing of org A; cross-org credentials are the same 401; the alert reaches only the right org", async () => {
    const credA = await create(ORG_A, officerA, "Tenant A probe");
    const credB = await create(ORG_B, officerB, "Tenant B probe");
    const idsA = (await call("GET", SOURCES, officerA, ORG_A)).json().sources.map((s: { id: string }) => s.id);
    const listB = (await call("GET", SOURCES, officerB, ORG_B)).json().sources.map((s: { id: string }) => s.id);
    expect(listB).toContain(credB.id);
    expect(listB.filter((id: string) => idsA.includes(id))).toEqual([]);

    // B's officer cannot rotate or disable A's source: the same 404 as a random id, and A's row is untouched.
    const snapshot = async () =>
      JSON.stringify(await kit.one(`SELECT * FROM alarm_source WHERE id=$1`, [credA.id]));
    const before = await snapshot();
    const foreign = await call("POST", `${SOURCES}/${credA.id}/rotate-secret`, officerB, ORG_B, {});
    const random = await call("POST", `${SOURCES}/${randomUUID()}/rotate-secret`, officerB, ORG_B, {});
    const strip = (b: string) => b.replace(/"(requestId|correlationId)":"[^"]*"/g, "").replace(/[0-9a-f-]{36}/g, "ID");
    expect(foreign.statusCode).toBe(404);
    expect(strip(foreign.body)).toBe(strip(random.body));
    expect((await call("POST", `${SOURCES}/${credA.id}/disable`, officerB, ORG_B, {})).statusCode).toBe(404);
    expect(await snapshot()).toBe(before);

    // A credential of one org under the other org's key id: the same 401, and nothing is written in either org.
    const eventsBefore = await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event`);
    const aSecretUnderB = await post(credA, { eventId: "x-1", alarmKind: "call" }, { keyId: `${ORG_B}.${credA.id}` });
    const bSecretUnderA = await post(credB, { eventId: "x-2", alarmKind: "call" }, { keyId: `${ORG_A}.${credB.id}` });
    const bIdUnderA = await post(credB, { eventId: "x-3", alarmKind: "call" }, { keyId: `${ORG_A}.${credB.id}`, secret: credA.secret });
    for (const r of [aSecretUnderB, bSecretUnderA, bIdUnderA]) expect(r.statusCode).toBe(401);
    expect(new Set([aSecretUnderB, bSecretUnderA, bIdUnderA].map((r) => strip(r.body))).size).toBe(1);
    expect(await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event`)).toBe(eventsBefore);

    // A's alarm alerts A's supervisor only; B's supervisor has no delivery from it.
    const ok = await post(credA, { eventId: "tenant-1", alarmKind: "call" });
    expect(ok.statusCode).toBe(202);
    const [ev] = await kit.one<{ id: string }>(`SELECT id FROM alarm_ingest_event WHERE source_id=$1 AND event_id='tenant-1'`, [credA.id]);
    const recipients = await kit.one<{ recipient_user_id: string }>(
      `SELECT d.recipient_user_id FROM notification_delivery d JOIN alert a ON a.id=d.alert_id WHERE a.correlation_id=$1`,
      [`alarm:${ev!.id}`],
    );
    expect(recipients.map((r) => r.recipient_user_id)).toEqual([supervisorA]);
    expect(recipients.map((r) => r.recipient_user_id)).not.toContain(supervisorB);
    expect(await kit.count(`SELECT count(*)::int AS n FROM alert WHERE organization_id=$1 AND event_type LIKE 'alarm_ingest.%'`, [ORG_B])).toBe(0);

    // RLS at the database, as chartwarden_app with app.org_id = B: zero of A's alarm rows; an A-org insert is rejected.
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query(`SELECT set_config('app.org_id', $1, true)`, [ORG_B]);
      for (const t of ["alarm_source", "alarm_source_mapping", "alarm_ingest_event"]) {
        const rows = await kit.appConn.query(`SELECT organization_id FROM ${t}`);
        expect(rows.rows.every((r: { organization_id: string }) => r.organization_id === ORG_B), t).toBe(true);
      }
      await expect(
        kit.appConn.query(
          `INSERT INTO alarm_source (organization_id,name,secret_cipher,created_by) VALUES ($1,'x','\\x00',$2)`,
          [ORG_A, officerB],
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await kit.appConn.query("ROLLBACK");
    }
  });

  it("8. bounds: a body over the cap is refused, an unknown field is refused, nothing is written for either", async () => {
    const cred = await create(ORG_A, officerA, "Bounds probe");
    const before = await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event WHERE source_id=$1`, [cred.id]);
    expect((await post(cred, JSON.stringify({ eventId: "big-1", alarmKind: "call", pad: "x".repeat(2000) }))).statusCode).toBe(413);
    expect((await post(cred, { eventId: "extra-1", alarmKind: "call", note: "Mrs Jones, room 4" })).statusCode).toBe(422);
    expect(await kit.count(`SELECT count(*)::int AS n FROM alarm_ingest_event WHERE source_id=$1`, [cred.id])).toBe(before);
  });
});
