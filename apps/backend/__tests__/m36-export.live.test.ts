/**
 * M36 ADR-0089 (PROPOSED), WP 5.7 - restricted messaging export (migration 1147), LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role,
 * through the real routes (fastify inject), the real service, the real builder and sweep and the real catalog-validating outbox publisher.
 *
 *   1. FLAG        off => the neutral 404 on request only; approve / cancel / download / the sweep do not read it.
 *   2. ACCESS      a clinical role is 403; the three compliance roles hold the keys in the database; a missing step-up is 403.
 *   3. TWO PEOPLE  the approver is never the requester: refused by the service AND by the database guard.
 *   4. CAPS        3 live, 10 a day, serialised under concurrency.
 *   5. TRANSITIONS forward-only at the database.
 *   6. BUILD       real encrypted bodies -> a held, a Part 2 and an erased message left out and counted -> ciphertext at rest, sha256, 24 h.
 *   7. DOWNLOAD    requester only, step-up, exact plaintext, one trail row + count bump, a tampered object fails closed, expiry on the DB clock.
 *   8. SWEEP       expired object deleted, DEK dropped, flag-independent; a stuck build fails with EXPORT_BUILD_TIMEOUT.
 *   9. RLS         another organisation sees and decides nothing.
 *  10. OUTBOX      every event, PHI-free payload keys; the approvers' alert consumer and the build consumer over the real rows.
 *  11. AUDIT       rows land for create / decide / ready / download; the justification, the note and the wrapped key are omitted.
 *  12. REVIEW FIXES microsecond keyset over > one page, deleted tombstones, the message-level and stale-snapshot Part 2 gate, the actor-bound job guard,
 *                 the quota-before-scope 429, the lost-enqueue listing, requester eligibility at build.
 *
 * Object storage is an in-memory map (the S3 binding is not reachable here); the tenant KEK, the body cipher, the data-key wrap and AES-GCM are real.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:export:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resolveActorPermissions,
} from "@chartwarden/auth";
import {
  EXPORT_EVENT_APPROVED,
  EXPORT_EVENT_DOWNLOADED,
  EXPORT_EVENT_EXPIRED,
  EXPORT_EVENT_READY,
  EXPORT_EVENT_REQUESTED,
  MESSAGING_EXPORT_FLAG_KEY,
} from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createPlatformKekAdapter } from "../src/bootstrap/tenant-kek";
import { createExportBuildStore } from "../src/modules/36-messaging/export/export-build-store";
import { createExportBuilder } from "../src/modules/36-messaging/export/export-builder";
import {
  createExportKeyWrap,
  openArtefact,
} from "../src/modules/36-messaging/export/export-crypto";
import {
  createExportExpiryStore,
  createExportExpirySweep,
} from "../src/modules/36-messaging/export/export-expiry-sweep";
import { sudPatientsFromFacts } from "../src/modules/36-messaging/export/export-ports";
import { createExportArtefactReader } from "../src/modules/36-messaging/export/export-reader";
import { createExportService } from "../src/modules/36-messaging/export/export-service";
import { createDrizzleExportStore } from "../src/modules/36-messaging/export/export-store";
import {
  buildM36ExportBuildConsumer,
  exportBuildJob,
} from "../src/modules/36-messaging/export/export-worker";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { buildM36ExportNotificationsConsumer } from "../src/modules/36-messaging/outbox-consumers/export-notifications";
import { registerExportRoutes } from "../src/modules/36-messaging/routes/export-routes";
import {
  type LiveKit,
  STAFF_KEYS,
  as,
  bootLiveKit,
  catalogOutbox,
  errorCode,
  headerAuth,
  mkChannel,
} from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a890001";
const ORG_B = "22222222-2222-4222-8222-22220a890002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a89a1";
const PART2_PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a89a2";
const API = "/api/v1/messaging/export";
const WHY = "Subpoena response for the Smith family estate matter";
const NOTE = "approved-note-private-text";
const MARKER = `PLAIN-MARKER-${randomUUID()}`;
const EXPORT_KEYS = [
  "messaging.read",
  "messaging.export.request",
  "messaging.export.approve",
  "messaging.export.download",
];
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<Row[]>;

/** Noon UTC, `n` days ago: far from any day boundary, always before the build's snapshot instant. */
const dayAt = (n: number): Date => {
  const d = new Date(Date.now() - n * DAY_MS);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};
const dateOf = (d: Date): string => d.toISOString().slice(0, 10);
/** A 404 body with the per-request ids blanked, so two refusals can be compared for sameness. */
const shape = (body: string): string =>
  body.replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe.skipIf(!DB_URL)("M36 ADR-0089 restricted messaging export - LIVE Postgres", () => {
  let kit: LiveKit;
  let on: FastifyInstance;
  let off: FastifyInstance;
  let stepUpFresh = true;
  let part2Unreadable = false;
  const part2Stale = new Set<string>();
  const part2Asked: string[][] = [];
  let approver: string;
  let third: string;
  let clinical: string;
  let author: string;
  let outsider: string;

  const objects = new Map<string, Buffer>();
  const objKey = (org: string, key: string) => `${org}/${key}`;
  const bodyCipher = createMessageBodyCipher({ kek: randomBytes(32), sealScheme: "legacy" });
  const kekKey = randomBytes(32);
  const keys = createExportKeyWrap(
    createPlatformKekAdapter({
      active: { kekId: "live-kek", key: kekKey },
      byId: new Map([["live-kek", kekKey]]),
    }),
  );
  const outbox = () => catalogOutbox() as never;
  const getObject = async (a: { organizationId: string; objectKey: string }) =>
    objects.get(objKey(a.organizationId, a.objectKey)) ?? null;
  const deleteObject = async (a: { organizationId: string; objectKey: string }) => {
    objects.delete(objKey(a.organizationId, a.objectKey));
  };
  const mkBuilder = (over: { part2Patients?: never } = {}) =>
    createExportBuilder({
      store: createExportBuildStore({ db: kit.handle.db, outbox: outbox() }),
      keys,
      openBody: (org, cipher) => bodyCipher.open(org, cipher),
      part2Patients: async (_org, ids) => {
        if (part2Unreadable) throw new Error("privacy flags unreadable");
        part2Asked.push([...ids]);
        // The same mapping the production binding uses, so a stale (invalidated) snapshot fails closed here too.
        return sudPatientsFromFacts(
          ids.map((id) => ({
            patientId: id,
            privacyFlags: id === PART2_PATIENT ? ["sud"] : [],
            ...(part2Stale.has(id) ? { privacyFlagsStale: true } : {}),
          })),
          ids,
        );
      },
      putObject: async (a) => {
        objects.set(objKey(a.organizationId, a.objectKey), Buffer.from(a.bytes));
      },
      deleteObject,
      ...over,
    });
  let builder: ReturnType<typeof mkBuilder>;
  const sweep = () =>
    createExportExpirySweep({
      store: createExportExpiryStore({ db: kit.handle.db, outbox: outbox() }),
      deleteObject,
    });

  const mkServer = (flag: boolean): FastifyInstance => {
    const service = createExportService({
      store: createDrizzleExportStore(kit.handle.db),
      outbox: outbox(),
      flags: { forOrg: async () => ({ [MESSAGING_EXPORT_FLAG_KEY]: flag }) },
      holds: async (organizationId, userId, key) =>
        (await resolveActorPermissions({ organizationId, userId })).has(key),
      artefactReader: createExportArtefactReader({ get: getObject, keys }),
    });
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerExportRoutes(server, { service });
    return server;
  };

  const send = (
    server: FastifyInstance,
    method: "GET" | "POST",
    url: string,
    user: string,
    payload?: unknown,
    org = ORG_A,
  ) =>
    server.inject({
      method,
      url,
      headers: as(user, org),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const create = (user: string, over: Record<string, unknown>, server = on) =>
    send(server, "POST", API, user, { justification: WHY, ...over });
  const approve = (user: string, id: string, server = on, payload: object = { note: NOTE }) =>
    send(server, "POST", `${API}/${id}/approve`, user, payload);
  const download = (user: string, id: string, server = on) =>
    send(server, "GET", `${API}/${id}/download`, user);

  /** Runs `body` as the app role for `user` in `org`; commits when `commit`. Returns the first error message or null. */
  const appTx = async (
    user: string,
    org: string,
    body: (q: Query) => Promise<unknown>,
    commit = false,
  ): Promise<string | null> => {
    await kit.appConn.query("BEGIN");
    try {
      await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
      await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [user]);
      await body(async (sql, p = []) => (await kit.appConn.query(sql, p)).rows as Row[]);
      await kit.appConn.query(commit ? "COMMIT" : "ROLLBACK");
      return null;
    } catch (err) {
      await kit.appConn.query("ROLLBACK").catch(() => undefined);
      return (err as Error).message;
    }
  };

  const newRequester = (keysOf: string[] = EXPORT_KEYS) => kit.seedUser("rq", ORG_A, keysOf);
  const jobRow = async (id: string) =>
    (await kit.one<Row>("SELECT * FROM message_export_job WHERE id=$1", [id]))[0] as Row;
  const eventsOf = (id: string) =>
    kit.one<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
      [id],
    );
  const trailCount = (id: string) =>
    kit.count("SELECT count(*)::int AS n FROM message_export_download WHERE job_id=$1", [id]);

  /** The job guard is a BEFORE trigger the superuser can switch off to FIXTURE a state the app role can never reach. Setup only. */
  const withGuardOff = async (fn: () => Promise<unknown>) => {
    await kit.admin.query(
      "ALTER TABLE message_export_job DISABLE TRIGGER trg_message_export_job_guard",
    );
    try {
      await fn();
    } finally {
      await kit.admin.query(
        "ALTER TABLE message_export_job ENABLE TRIGGER trg_message_export_job_guard",
      );
    }
  };
  const age = (id: string, by = "25 hours") =>
    withGuardOff(() =>
      kit.admin.query(
        "UPDATE message_export_job SET ready_at = ready_at - $2::interval, expires_at = expires_at - $2::interval WHERE id=$1",
        [id, by],
      ),
    );

  const seedMessage = async (
    channel: string,
    text: string | null,
    at: Date,
    by = author,
  ): Promise<string> => {
    const sealed =
      text === null
        ? { cipher: Buffer.alloc(0), sha256: "0".repeat(64) }
        : await bodyCipher.seal(ORG_A, text);
    return (
      await kit.one<{ id: string }>(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user',$4,$5,$6) RETURNING id`,
        [ORG_A, channel, by, sealed.cipher, sealed.sha256, at.toISOString()],
      )
    )[0].id;
  };

  /** request -> approve (two people, through the routes) -> the build. Returns the job id. */
  const buildFlow = async (requester: string, scope: Record<string, unknown>) => {
    stepUpFresh = true;
    const made = await create(requester, scope);
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id as string;
    const ok = await approve(approver, id);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await builder.buildJob(ORG_A, id)).toMatchObject({ outcome: expect.any(String) });
    return id;
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "adr89");
    builder = mkBuilder();
    const registry = createPredicateRegistry();
    // The real step_up_recent predicate has its own suites; here it is a switch so the route wiring is what is proven.
    registry.register("step_up_recent", async () => stepUpFresh);
    registerAbacRegistry(registry);
    approver = await kit.seedUser("approver", ORG_A, EXPORT_KEYS);
    third = await kit.seedUser("third", ORG_A, EXPORT_KEYS);
    clinical = await kit.seedUser("clinical", ORG_A, STAFF_KEYS);
    author = await kit.seedUser("author", ORG_A, STAFF_KEYS);
    outsider = await kit.seedUser("outsider", ORG_B, EXPORT_KEYS);
    on = mkServer(true);
    off = mkServer(false);
    await Promise.all([on.ready(), off.ready()]);
  }, 120_000);

  afterAll(async () => {
    await Promise.all([on?.close(), off?.close()]);
    await kit?.close();
  });

  // ── 1 + 2: flag and access ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("flag and access", () => {
    let channel: string;
    beforeAll(async () => {
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
    });

    it("flag off => the neutral 404 on request, before any step-up; nothing is written", async () => {
      const rq = await newRequester();
      stepUpFresh = false;
      const res = await create(rq, { scopeKind: "channel", channelId: channel }, off);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("STEP_UP");
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message_export_job WHERE requested_by=$1", [
          rq,
        ]),
      ).toBe(0);
    });

    it("the flag gates only the request: approve, cancel, download and the lists still work with it off", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const a = (await create(rq, { scopeKind: "channel", channelId: channel })).json().id;
      const b = (await create(rq, { scopeKind: "channel", channelId: channel })).json().id;
      expect((await send(off, "POST", `${API}/${b}/cancel`, rq)).statusCode).toBe(200);
      expect((await approve(approver, a, off)).statusCode).toBe(200);
      expect((await send(off, "GET", `${API}/pending`, approver)).statusCode).toBe(200);
      expect((await send(off, "GET", `${API}/mine`, rq)).statusCode).toBe(200);
      expect((await builder.buildJob(ORG_A, a)).outcome).toBe("ready");
      const got = await download(rq, a, off);
      expect(got.statusCode, got.body).toBe(200);
    });

    it("a default clinical role is 403 on every export route; an unknown channel and a bad scope are the same 404", async () => {
      stepUpFresh = true;
      const probe = randomUUID();
      for (const [method, url] of [
        ["POST", API],
        ["GET", `${API}/mine`],
        ["GET", `${API}/pending`],
        ["GET", `${API}/${probe}`],
        ["POST", `${API}/${probe}/approve`],
        ["POST", `${API}/${probe}/cancel`],
        ["GET", `${API}/${probe}/download`],
      ] as const) {
        const res = await send(
          on,
          method,
          url,
          clinical,
          method === "POST"
            ? { scopeKind: "channel", channelId: channel, justification: WHY }
            : undefined,
        );
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      const rq = await newRequester();
      const unknown = await create(rq, { scopeKind: "channel", channelId: randomUUID() });
      const noChannelPatient = await create(rq, { scopeKind: "patient", patientId: randomUUID() });
      expect(unknown.statusCode).toBe(404);
      expect(noChannelPatient.statusCode).toBe(404);
      expect(shape(noChannelPatient.body)).toBe(shape(unknown.body));
    });

    it("a patient whose only channel is a bereavement one is the neutral 404 (the builder exports care_team channels only, so such a job would build empty)", async () => {
      stepUpFresh = true;
      const bereaved = randomUUID();
      await kit.one(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
         VALUES ($1,'bereavement',$2,'wp57-bereavement','bereavement', now() + interval '1 year')`,
        [ORG_A, bereaved],
      );
      const rq = await newRequester();
      const res = await create(rq, { scopeKind: "patient", patientId: bereaved });
      expect(res.statusCode, res.body).toBe(404);
    });

    it("request, approve and download each demand a fresh step-up (403 STEP_UP_REQUIRED) and write nothing without it", async () => {
      const rq = await newRequester();
      stepUpFresh = false;
      const noReq = await create(rq, { scopeKind: "channel", channelId: channel });
      expect(noReq.statusCode).toBe(403);
      expect(noReq.body).toContain("STEP_UP_REQUIRED");
      stepUpFresh = true;
      const id = (await create(rq, { scopeKind: "channel", channelId: channel })).json().id;
      stepUpFresh = false;
      const noApprove = await approve(approver, id);
      expect(noApprove.statusCode).toBe(403);
      expect(noApprove.body).toContain("STEP_UP_REQUIRED");
      expect((await jobRow(id)).status).toBe("pending_approval");
      stepUpFresh = true;
      await approve(approver, id);
      await builder.buildJob(ORG_A, id);
      stepUpFresh = false;
      const noDownload = await download(rq, id);
      expect(noDownload.statusCode).toBe(403);
      expect(noDownload.body).toContain("STEP_UP_REQUIRED");
      expect(await trailCount(id)).toBe(0);
      stepUpFresh = true;
    });

    it("the database grants the three keys to compliance_officer, administrator and org_admin only", async () => {
      const perms = await kit.one<{ key: string; category: string }>(
        "SELECT key, category::text AS category FROM permission WHERE key LIKE 'messaging.export.%' ORDER BY key",
      );
      expect(perms.map((p) => p.key)).toEqual([
        "messaging.export.approve",
        "messaging.export.download",
        "messaging.export.request",
      ]);
      const holders = await kit.one<{ key: string; permission_key: string }>(
        `SELECT DISTINCT r.key, rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
          WHERE rp.permission_key LIKE 'messaging.export.%'`,
      );
      // Roles are provisioned per tenant, so a fresh database may hold none; whoever holds a key is one of the three.
      for (const h of holders) {
        expect(["compliance_officer", "administrator", "org_admin"]).toContain(h.key);
      }
    });

    it("a compliance-style holder (request key only) can request; an approve-only holder cannot", async () => {
      stepUpFresh = true;
      const requestOnly = await newRequester(["messaging.export.request"]);
      const approveOnly = await newRequester(["messaging.export.approve"]);
      const ok = await create(requestOnly, { scopeKind: "channel", channelId: channel });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(
        (await create(approveOnly, { scopeKind: "channel", channelId: channel })).statusCode,
      ).toBe(403);
    });
  });

  // ── 3: two people ────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("two-person rule", () => {
    it("the requester cannot approve or reject their own request (service 403) and the database guard refuses a direct write", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const rq = await newRequester();
      const id = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      const self = await approve(rq, id);
      expect(self.statusCode).toBe(403);
      expect((await send(on, "POST", `${API}/${id}/reject`, rq, {})).statusCode).toBe(403);
      expect((await jobRow(id)).status).toBe("pending_approval");
      // Direct SQL as the app role: the guard's CHECK refuses decided_by = requested_by.
      const direct = await appTx(rq, ORG_A, (q) =>
        q("UPDATE message_export_job SET status='approved', decided_by=$2 WHERE id=$1", [id, rq]),
      );
      expect(direct).toMatch(/message_export_job_two_people/);
      expect((await jobRow(id)).status).toBe("pending_approval");
      // A second person decides; a second decision is a 409.
      expect((await approve(approver, id)).statusCode).toBe(200);
      const again = await approve(third, id);
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe("EXPORT_ALREADY_DECIDED");
      const late = await send(on, "POST", `${API}/${id}/cancel`, rq);
      expect(late.statusCode).toBe(409);
    });

    it("a rejection ends the job; only the requester cancels; the approvers' queue never lists one's own request", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const rq = await newRequester();
      const id = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      expect((await send(on, "POST", `${API}/${id}/cancel`, approver)).statusCode).toBe(404);
      const own = await send(on, "GET", `${API}/pending`, rq);
      expect(own.json().jobs.map((j: { id: string }) => j.id)).not.toContain(id);
      const queue = await send(on, "GET", `${API}/pending`, approver);
      expect(queue.json().jobs.map((j: { id: string }) => j.id)).toContain(id);
      const rejected = await send(on, "POST", `${API}/${id}/reject`, approver, { note: NOTE });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().status).toBe("rejected");
      expect((await builder.buildJob(ORG_A, id)).outcome).toBe("skipped");
    });
  });

  // ── 4: caps ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("caps", () => {
    let channel: string;
    beforeAll(async () => {
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
    });
    const scope = () => ({ scopeKind: "channel", channelId: channel });

    it("at most 3 live jobs per requester; a cancelled one frees a slot", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await create(rq, scope());
        expect(r.statusCode, r.body).toBe(201);
        ids.push(r.json().id);
      }
      const fourth = await create(rq, scope());
      expect(fourth.statusCode).toBe(429);
      expect(errorCode(fourth)).toBe("EXPORT_LIMIT");
      await send(on, "POST", `${API}/${ids[0]}/cancel`, rq);
      expect((await create(rq, scope())).statusCode).toBe(201);
    });

    it("at most 10 requests a day even when none is live", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      for (let i = 0; i < 10; i += 1) {
        const r = await create(rq, scope());
        expect(r.statusCode, `request ${i + 1}: ${r.body}`).toBe(201);
        expect((await send(on, "POST", `${API}/${r.json().id}/cancel`, rq)).statusCode).toBe(200);
      }
      const eleventh = await create(rq, scope());
      expect(eleventh.statusCode).toBe(429);
      expect(errorCode(eleventh)).toBe("EXPORT_LIMIT");
    });

    it("the cap is serialised: 5 concurrent requests from one person yield exactly 3 jobs", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const results = await Promise.all(Array.from({ length: 5 }, () => create(rq, scope())));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([201, 201, 201, 429, 429]);
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message_export_job WHERE requested_by=$1", [
          rq,
        ]),
      ).toBe(3);
    });
  });

  // ── 5: transitions at the database ───────────────────────────────────────────────────────────────────────────────────────
  describe("status transitions are forward-only at the database", () => {
    const READY_SET =
      "UPDATE message_export_job SET status='ready', artefact_key='k', artefact_sha256='x', artefact_bytes=1, wrapped_dek='w', message_count=0, held_excluded=0, part2_excluded=0 WHERE id=$1";
    let channel: string;
    beforeAll(async () => {
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER}-t`, dayAt(2));
    });
    const mk = async (to: "pending" | "approved" | "ready" | "rejected" | "cancelled") => {
      stepUpFresh = true;
      const rq = await newRequester();
      const id = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      if (to === "pending") return id;
      if (to === "cancelled") {
        await send(on, "POST", `${API}/${id}/cancel`, rq);
        return id;
      }
      if (to === "rejected") {
        await send(on, "POST", `${API}/${id}/reject`, approver, {});
        return id;
      }
      await approve(approver, id);
      if (to === "ready") await builder.buildJob(ORG_A, id);
      return id;
    };
    const as_ = (id: string, sql: string, user = approver) =>
      appTx(user, ORG_A, (q) => q(sql, [id]));

    it("approved -> ready is refused (the builder must claim it first)", async () => {
      const id = await mk("approved");
      expect(await as_(id, READY_SET)).toMatch(/message_export_job_transition/);
    });

    it("failed is reachable only from building", async () => {
      const failed = "UPDATE message_export_job SET status='failed', failure_code='X' WHERE id=$1";
      for (const state of ["pending", "approved", "ready"] as const) {
        expect(await as_(await mk(state), failed), state).toMatch(/message_export_job_transition/);
      }
    });

    it("ready -> approved/building, rejected/cancelled -> approved, and a ready export's expiry cannot be extended", async () => {
      const ready = await mk("ready");
      expect((await jobRow(ready)).status).toBe("ready");
      expect(
        await as_(ready, "UPDATE message_export_job SET status='approved' WHERE id=$1"),
      ).toMatch(/message_export_job_transition/);
      expect(
        await as_(ready, "UPDATE message_export_job SET status='building' WHERE id=$1"),
      ).toMatch(/message_export_job_transition/);
      expect(
        await as_(
          ready,
          "UPDATE message_export_job SET expires_at = expires_at + interval '5 days' WHERE id=$1",
        ),
      ).toMatch(/message_export_job_/);
      for (const state of ["rejected", "cancelled"] as const) {
        const id = await mk(state);
        expect(
          await as_(
            id,
            "UPDATE message_export_job SET status='approved', decided_by=decided_by WHERE id=$1",
          ),
          state,
        ).toMatch(
          /message_export_job_transition|message_export_job_decision_state|message_export_job_/,
        );
      }
    });

    it("pending -> ready/expired/building are refused; the expiry sweep cannot run early (not_expired)", async () => {
      const pending = await mk("pending");
      expect(await as_(pending, READY_SET)).toMatch(/message_export_job_transition/);
      expect(
        await as_(pending, "UPDATE message_export_job SET status='building' WHERE id=$1"),
      ).toMatch(/message_export_job_transition/);
      expect(
        await as_(pending, "UPDATE message_export_job SET status='expired' WHERE id=$1"),
      ).toMatch(/message_export_job_transition/);
      const ready = await mk("ready");
      expect(
        await as_(ready, "UPDATE message_export_job SET status='expired' WHERE id=$1"),
      ).toMatch(/message_export_job_not_expired/);
    });

    it("scope, requester and justification are immutable; the app role cannot delete or rewrite free text", async () => {
      const id = await mk("pending");
      expect(
        await as_(
          id,
          "UPDATE message_export_job SET justification='edited edited edited edited' WHERE id=$1",
        ),
      ).toMatch(/permission denied/);
      expect(await as_(id, "DELETE FROM message_export_job WHERE id=$1")).toMatch(
        /permission denied/,
      );
      expect(await as_(id, "UPDATE message_export_download SET bytes=1 WHERE job_id=$1")).toMatch(
        /permission denied/,
      );
    });

    it("a ready job's expires_at is exactly ready_at + 24h on the database clock", async () => {
      const id = await mk("ready");
      const [row] = await kit.one<{ exact: boolean; fresh: boolean }>(
        `SELECT expires_at = ready_at + interval '24 hours' AS exact, ready_at > now() - interval '1 minute' AS fresh
           FROM message_export_job WHERE id=$1`,
        [id],
      );
      expect(row).toEqual({ exact: true, fresh: true });
    });
  });

  // ── 6 + 7 + 10 + 11: the build, the download, the outbox and the audit over one real flow ─────────────────────────────────
  describe("build, download, outbox and audit", () => {
    let cCare: string;
    let cDisc: string;
    let cPart2: string;
    let held: string;
    let m1: string;
    let m4: string;
    let rq: string;
    let main: string;
    let holdId: string;
    const text = { m1: `${MARKER} alpha`, m4: `${MARKER} delta`, m5: `${MARKER} old` };

    beforeAll(async () => {
      cCare = await mkChannel(kit, "care_team", PATIENT, [author]);
      cDisc = await mkChannel(kit, "discipline", randomUUID(), [author]);
      cPart2 = await mkChannel(kit, "care_team", PART2_PATIENT, [author]);
      m1 = await seedMessage(cCare, text.m1, dayAt(5));
      held = await seedMessage(cCare, `${MARKER} held`, dayAt(4));
      await seedMessage(cCare, null, dayAt(3)); // erased body
      m4 = await seedMessage(cCare, text.m4, dayAt(2));
      await seedMessage(cCare, text.m5, dayAt(40));
      await seedMessage(cDisc, `${MARKER} disc-1`, dayAt(2));
      await seedMessage(cDisc, `${MARKER} disc-2`, dayAt(1));
      await seedMessage(cPart2, `${MARKER} sud-1`, dayAt(2));
      await seedMessage(cPart2, `${MARKER} sud-2`, dayAt(1));
      await kit.one(
        `INSERT INTO message_attachment (organization_id, channel_id, message_id, mime_type, byte_size, filename)
         VALUES ($1,$2,$3,'application/pdf',2048,'consent.pdf')`,
        [ORG_A, cCare, m1],
      );
      // WP 5.6: a legal hold over ONE message (channel + a one-minute window) and its overlay row.
      const heldAt = dayAt(4);
      holdId = (
        await kit.one<{ id: string }>(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
           VALUES ($1,'wp57-hold',$2::jsonb,'litigation hold for the export suite',$3) RETURNING id`,
          [
            ORG_A,
            JSON.stringify({
              channelIds: [cCare],
              dateRange: {
                from: new Date(heldAt.getTime() - 60_000).toISOString(),
                to: new Date(heldAt.getTime() + 60_000).toISOString(),
              },
            }),
            author,
          ],
        )
      )[0].id;
      await kit.one(
        "INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3)",
        [ORG_A, holdId, held],
      );
      rq = await newRequester();
    }, 60_000);

    const bodiesOf = (doc: { messages: Array<{ body: string }> }) =>
      doc.messages.map((m) => m.body).sort();

    it("(request) a patient-scope job is created pending; the approver sees scope and justification; a third user gets the 404", async () => {
      stepUpFresh = true;
      const made = await create(rq, { scopeKind: "patient", patientId: PATIENT });
      expect(made.statusCode, made.body).toBe(201);
      main = made.json().id;
      expect(made.json()).toMatchObject({ status: "pending_approval", justification: WHY });
      const seen = await send(on, "GET", `${API}/${main}`, approver);
      expect(seen.statusCode).toBe(200);
      expect(seen.json().justification).toBe(WHY);
      // A holder of the request key who is neither the requester nor an approver gets the uniform 404.
      const bystander = await newRequester(["messaging.export.request"]);
      expect((await send(on, "GET", `${API}/${main}`, bystander)).statusCode).toBe(404);
    });

    it("(build) the approved event drives the build consumer -> worker; the job is ready with counts, a manifest and a 24h window", async () => {
      stepUpFresh = true;
      expect((await approve(approver, main)).statusCode).toBe(200);
      // The real m36.export.approved row, through the real consumer and the worker entry point (the queue is a spy).
      const [row] = await kit.one<{
        id: string;
        organization_id: string;
        event_type: string;
        aggregate_kind: string;
        aggregate_id: string;
        payload: unknown;
        attempt_count: number;
        created_at: Date;
      }>("SELECT * FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2", [
        main,
        EXPORT_EVENT_APPROVED,
      ]);
      const asEvent = (r: typeof row): DispatchableOutboxEvent => ({
        id: r.id,
        organizationId: r.organization_id,
        eventType: r.event_type,
        aggregateKind: r.aggregate_kind,
        aggregateId: r.aggregate_id,
        payload: r.payload,
        attemptCount: r.attempt_count,
        createdAt: r.created_at,
      });
      const queued: Array<{ organizationId: string; jobId: string }> = [];
      const consumer = buildM36ExportBuildConsumer({
        enqueue: async (data) => {
          queued.push(data);
        },
      });
      await consumer.handle(asEvent(row));
      expect(queued).toEqual([{ organizationId: ORG_A, jobId: main }]);
      const outcome = await exportBuildJob(builder, queued[0]);
      expect(outcome).toEqual({ outcome: "ready", messageCount: 2 + 1 });
      // A redelivery claims nothing.
      expect((await exportBuildJob(builder, queued[0])).outcome).toBe("skipped");

      const job = await jobRow(main);
      expect(job).toMatchObject({
        status: "ready",
        message_count: 3, // m1, m4 and the 40-day-old one; the held, the erased and nothing else
        held_excluded: 1,
        part2_excluded: 0,
        failure_code: null,
      });
      const [times] = await kit.one<{ exact: boolean }>(
        "SELECT expires_at = ready_at + interval '24 hours' AS exact FROM message_export_job WHERE id=$1",
        [main],
      );
      expect(times.exact).toBe(true);
    });

    it("(at rest) the stored object is ciphertext, the sha256 matches the plaintext, the wrapped key is the only key held", async () => {
      const job = await jobRow(main);
      const stored = objects.get(objKey(ORG_A, job.artefact_key as string)) as Buffer;
      expect(stored).toBeDefined();
      expect(stored.includes(Buffer.from(MARKER))).toBe(false);
      expect(stored.includes(Buffer.from("manifest"))).toBe(false);
      expect(stored.length).toBe(job.artefact_bytes);
      const dek = await keys.unwrap(ORG_A, job.wrapped_dek as string);
      const plaintext = openArtefact(stored, dek, { organizationId: ORG_A, jobId: main });
      expect(sha256(plaintext)).toBe(job.artefact_sha256);
      const doc = JSON.parse(plaintext.toString("utf8"));
      expect(doc.manifest).toMatchObject({
        manifestVersion: 1,
        format: "json",
        jobId: main,
        organizationId: ORG_A,
        requestedBy: rq,
        approvedBy: approver,
        messageCount: 3,
        heldExcluded: 1,
        part2Excluded: 0,
        scope: { scopeKind: "patient", patientId: PATIENT, channelId: null },
      });
      expect(bodiesOf(doc)).toEqual([text.m1, text.m4, text.m5].sort());
      // A wrong job id or tenant cannot open it (the AAD binds both).
      expect(() => openArtefact(stored, dek, { organizationId: ORG_B, jobId: main })).toThrow();
      expect(() =>
        openArtefact(stored, dek, { organizationId: ORG_A, jobId: randomUUID() }),
      ).toThrow();
      // Attachment METADATA only, on the message that carries it.
      const withAttachment = doc.messages.find((m: { id: string }) => m.id === m1);
      expect(withAttachment.attachments).toEqual([
        expect.objectContaining({
          name: "consent.pdf",
          mimeType: "application/pdf",
          byteSize: 2048,
        }),
      ]);
      expect(JSON.stringify(doc)).not.toContain(`${MARKER} held`);
      expect(JSON.stringify(doc)).not.toContain("sud-");
    });

    it("(download) the requester gets the exact plaintext; one trail row and one count bump per download", async () => {
      stepUpFresh = true;
      const job = await jobRow(main);
      const res = await download(rq, main);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(sha256(res.rawPayload)).toBe(job.artefact_sha256);
      expect(bodiesOf(res.json())).toEqual([text.m1, text.m4, text.m5].sort());
      expect(await trailCount(main)).toBe(1);
      expect((await jobRow(main)).download_count).toBe(1);
      expect((await download(rq, main)).statusCode).toBe(200);
      expect(await trailCount(main)).toBe(2);
      expect((await jobRow(main)).download_count).toBe(2);
      const detail = await send(on, "GET", `${API}/${main}`, rq);
      expect(detail.json()).toMatchObject({
        downloadable: true,
        downloadCount: 2,
        messageCount: 3,
      });
      expect(JSON.stringify(detail.json())).not.toContain(job.wrapped_dek as string);
    });

    it("(download) the approver and a third user get the uniform 404; no key is 403; nothing is recorded for them", async () => {
      stepUpFresh = true;
      const before = await trailCount(main);
      const unknown = await download(approver, randomUUID());
      for (const who of [approver, third]) {
        const res = await download(who, main);
        expect(res.statusCode).toBe(404);
        expect(shape(res.body)).toBe(shape(unknown.body));
      }
      expect((await download(clinical, main)).statusCode).toBe(403);
      expect(await trailCount(main)).toBe(before);
    });

    it("(download) a tampered or missing object fails closed: no bytes, no trail row, no count bump", async () => {
      stepUpFresh = true;
      const job = await jobRow(main);
      const key = objKey(ORG_A, job.artefact_key as string);
      const original = objects.get(key) as Buffer;
      const trailBefore = await trailCount(main);
      const countBefore = (await jobRow(main)).download_count;
      const tampered = Buffer.from(original);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
      objects.set(key, tampered);
      const bad = await download(rq, main);
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(bad.body).not.toContain(MARKER);
      objects.delete(key);
      const gone = await download(rq, main);
      expect(gone.statusCode).toBeGreaterThanOrEqual(400);
      objects.set(key, original);
      expect(await trailCount(main)).toBe(trailBefore);
      expect((await jobRow(main)).download_count).toBe(countBefore);
      expect((await download(rq, main)).statusCode).toBe(200);
    });

    it("(trail guard) the database refuses a download row from anyone but the requester, and for a job that is not ready", async () => {
      const insert = (user: string, jobId: string) =>
        appTx(
          user,
          ORG_A,
          (q) =>
            q(
              "INSERT INTO message_export_download (organization_id, job_id, user_id) VALUES ($1,$2,$3)",
              [ORG_A, jobId, user],
            ),
          true,
        );
      expect(await insert(approver, main)).toMatch(/message_export_download_job/);
      expect(await insert(rq, main)).toBeNull();
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const pending = (
        await create(await newRequester(), { scopeKind: "channel", channelId: channel })
      ).json();
      expect(await insert(pending.requestedBy, pending.id)).toMatch(/message_export_download_job/);
      // Forging the actor inside the row is refused too (app.user_id is the truth).
      const forged = await appTx(approver, ORG_A, (q) =>
        q(
          "INSERT INTO message_export_download (organization_id, job_id, user_id) VALUES ($1,$2,$3)",
          [ORG_A, main, rq],
        ),
      );
      expect(forged).toMatch(/message_export_download_job/);
    });

    it("(scope) a channel scope exports only that channel; a Part 2 patient is left out and counted; a date range filters", async () => {
      const rq2 = await newRequester();
      const channelJob = await buildFlow(rq2, { scopeKind: "channel", channelId: cDisc });
      expect(await jobRow(channelJob)).toMatchObject({
        status: "ready",
        message_count: 2,
        held_excluded: 0,
        part2_excluded: 0,
      });
      const part2Job = await buildFlow(rq2, { scopeKind: "patient", patientId: PART2_PATIENT });
      expect(await jobRow(part2Job)).toMatchObject({
        status: "ready",
        message_count: 0,
        part2_excluded: 2,
      });
      stepUpFresh = true;
      const got = await download(rq2, part2Job);
      expect(got.statusCode).toBe(200);
      expect(got.json().messages).toEqual([]);
      expect(got.body).not.toContain("sud-");
      const rq3 = await newRequester();
      const ranged = await buildFlow(rq3, {
        scopeKind: "patient",
        patientId: PATIENT,
        dateFrom: dateOf(dayAt(6)),
        dateTo: dateOf(dayAt(1)),
      });
      expect(await jobRow(ranged)).toMatchObject({ message_count: 2, held_excluded: 1 });
      const narrow = await buildFlow(rq3, {
        scopeKind: "patient",
        patientId: PATIENT,
        dateFrom: dateOf(dayAt(3)),
        dateTo: dateOf(dayAt(1)),
      });
      // Only m4 (the erased body at day 3 is not exported, the held message at day 4 is outside the window).
      expect(await jobRow(narrow)).toMatchObject({ message_count: 1, held_excluded: 0 });
      expect(bodiesOf((await download(rq3, narrow)).json())).toEqual([text.m4]);
      // Range validation: a reversed or over-long range is a 400, not a job.
      expect(
        (
          await create(rq3, {
            scopeKind: "patient",
            patientId: PATIENT,
            dateFrom: dateOf(dayAt(1)),
            dateTo: dateOf(dayAt(5)),
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await create(rq3, {
            scopeKind: "patient",
            patientId: PATIENT,
            dateFrom: "2020-01-01",
            dateTo: "2022-01-01",
          })
        ).statusCode,
      ).toBe(422);
    });

    it("(part 2) a channel scope over a bereavement channel whose subject is flagged leaves those messages out and counts them", async () => {
      const bereavement = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class, archives_at)
           VALUES ($1,'bereavement',$2,'wp57-bereavement','bereavement', now() + interval '1 year') RETURNING id`,
          [ORG_A, PART2_PATIENT],
        )
      )[0].id;
      await seedMessage(bereavement, `${MARKER} grief-1`, dayAt(2));
      await seedMessage(bereavement, `${MARKER} grief-2`, dayAt(1));
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: bereavement,
      });
      expect(await jobRow(id)).toMatchObject({
        status: "ready",
        message_count: 0,
        part2_excluded: 2,
      });
      const stored = objects.get(objKey(ORG_A, `messaging-export/${id}.enc`));
      expect(stored).toBeDefined();
      const got = await download((await jobRow(id)).requested_by as string, id);
      expect(got.statusCode).toBe(200);
      expect(got.json().messages).toEqual([]);
      expect(got.body).not.toContain("grief-");
    });

    it("(eligibility) a deactivated approver gets 403 and the job stays pending; a deactivated requester gets the uniform 404 and no trail row", async () => {
      const deactivate = (user: string) =>
        kit.admin.query("UPDATE membership SET status='revoked' WHERE user_id=$1", [user]);
      const gone = await kit.seedUser("gone-approver", ORG_A, EXPORT_KEYS);
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const pending = (
        await create(await newRequester(), { scopeKind: "channel", channelId: channel })
      ).json().id as string;
      await deactivate(gone);
      expect((await approve(gone, pending)).statusCode).toBe(403);
      expect((await send(on, "POST", `${API}/${pending}/reject`, gone, {})).statusCode).toBe(403);
      expect((await jobRow(pending)).status).toBe("pending_approval");

      const requester = await newRequester();
      const ready = await buildFlow(requester, { scopeKind: "channel", channelId: channel });
      expect((await jobRow(ready)).status).toBe("ready");
      await deactivate(requester);
      stepUpFresh = true;
      const refused = await download(requester, ready);
      const unknown = await download(requester, randomUUID());
      expect(refused.statusCode).toBe(404);
      expect(shape(refused.body)).toBe(shape(unknown.body));
      expect(await trailCount(ready)).toBe(0);
    });

    it("(fail closed) an unreadable Part 2 flag fails the build with EXPORT_PART2_UNKNOWN and stores nothing", async () => {
      const rq4 = await newRequester();
      stepUpFresh = true;
      const id = (await create(rq4, { scopeKind: "patient", patientId: PATIENT })).json()
        .id as string;
      await approve(approver, id);
      part2Unreadable = true;
      try {
        expect(await builder.buildJob(ORG_A, id)).toMatchObject({
          outcome: "failed",
          failureCode: "EXPORT_PART2_UNKNOWN",
        });
      } finally {
        part2Unreadable = false;
      }
      expect(await jobRow(id)).toMatchObject({
        status: "failed",
        artefact_key: null,
        wrapped_dek: null,
      });
      expect(objects.has(objKey(ORG_A, `messaging-export/${id}.enc`))).toBe(false);
      const res = await download(rq4, id);
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe("EXPORT_NOT_READY");
    });

    it("(cap) a scope over EXPORT_MAX_MESSAGES fails closed EXPORT_TOO_LARGE, nothing truncated, nothing stored", async () => {
      const big = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const sealed = await bodyCipher.seal(ORG_A, "bulk");
      await kit.admin.query("BEGIN");
      try {
        // Fixture only: skip the per-row triggers (audit, hints) for 50 001 inserts.
        await kit.admin.query("SET LOCAL session_replication_role = replica");
        await kit.admin.query(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
           SELECT $1, $2, $3, 'user', $4, $5, now() - interval '30 days' + (g * interval '1 second')
             FROM generate_series(1, 50001) AS g`,
          [ORG_A, big, author, sealed.cipher, sealed.sha256],
        );
        await kit.admin.query("COMMIT");
      } catch (err) {
        await kit.admin.query("ROLLBACK");
        throw err;
      }
      const rq5 = await newRequester();
      stepUpFresh = true;
      const id = (await create(rq5, { scopeKind: "channel", channelId: big })).json().id as string;
      await approve(approver, id);
      expect(await builder.buildJob(ORG_A, id)).toMatchObject({
        outcome: "failed",
        failureCode: "EXPORT_TOO_LARGE",
      });
      expect(await jobRow(id)).toMatchObject({
        status: "failed",
        failure_code: "EXPORT_TOO_LARGE",
        artefact_key: null,
        message_count: null,
      });
      expect(objects.has(objKey(ORG_A, `messaging-export/${id}.enc`))).toBe(false);
      expect((await eventsOf(id)).map((e) => e.event_type)).not.toContain(EXPORT_EVENT_READY);
    }, 180_000);

    it("(legal hold) a released hold no longer excludes the message", async () => {
      await kit.one(
        "UPDATE legal_hold SET status = 'released', released_at = now() WHERE id = $1",
        [holdId],
      );
      const rq6 = await newRequester();
      const id = await buildFlow(rq6, { scopeKind: "patient", patientId: PATIENT });
      expect(await jobRow(id)).toMatchObject({ message_count: 4, held_excluded: 0 });
      await kit.one("UPDATE legal_hold SET status = 'active', released_at = NULL WHERE id = $1", [
        holdId,
      ]);
    });

    it("(outbox) every event of the main job carries exactly its PHI-free keys, never a justification, note or scope id", async () => {
      const events = await eventsOf(main);
      const keysByType = new Map<string, string[]>();
      for (const e of events) keysByType.set(e.event_type, Object.keys(e.payload).sort());
      expect([...keysByType.keys()].sort()).toEqual(
        [
          EXPORT_EVENT_REQUESTED,
          EXPORT_EVENT_APPROVED,
          EXPORT_EVENT_READY,
          EXPORT_EVENT_DOWNLOADED,
        ].sort(),
      );
      expect(keysByType.get(EXPORT_EVENT_REQUESTED)).toEqual([
        "at",
        "jobId",
        "organizationId",
        "requestedBy",
      ]);
      expect(keysByType.get(EXPORT_EVENT_APPROVED)).toEqual([
        "at",
        "decidedBy",
        "jobId",
        "organizationId",
        "requestedBy",
      ]);
      expect(keysByType.get(EXPORT_EVENT_READY)).toEqual([
        "at",
        "expiresAt",
        "jobId",
        "organizationId",
        "requestedBy",
      ]);
      expect(keysByType.get(EXPORT_EVENT_DOWNLOADED)).toEqual([
        "at",
        "downloadedBy",
        "jobId",
        "organizationId",
      ]);
      const everything = JSON.stringify(events);
      for (const secret of [WHY, NOTE, PATIENT, cCare, "justification"]) {
        expect(everything).not.toContain(secret);
      }
      // One downloaded event per download (three downloads of `main` succeeded, two direct trail rows wrote none).
      expect(events.filter((e) => e.event_type === EXPORT_EVENT_DOWNLOADED)).toHaveLength(
        (await trailCount(main)) - 1,
      );
    });

    it("(outbox) the real requested row becomes ONE fixed-text alert for the approvers, with no scope or justification", async () => {
      const [row] = await kit.one<{
        id: string;
        organization_id: string;
        payload: unknown;
        created_at: Date;
      }>(
        "SELECT id, organization_id, payload, created_at FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2",
        [main, EXPORT_EVENT_REQUESTED],
      );
      const emitted: Array<{ orgId: string; alert: Record<string, unknown> }> = [];
      // The AlertEmitter seam is a spy: the live kit does not bind the M39 emitter, so the rule/resolver (permission_holders) is covered by the
      // consumer's unit test and the alert catalog's own suites; what is proven here is the consumer over the REAL outbox row.
      const consumer = buildM36ExportNotificationsConsumer({
        alerts: {
          emit: async (orgId: string, alert: Record<string, unknown>) =>
            void emitted.push({ orgId, alert }),
        } as never,
      });
      await consumer.handle({
        id: row.id,
        organizationId: row.organization_id,
        eventType: EXPORT_EVENT_REQUESTED,
        aggregateKind: "message_export_job",
        aggregateId: main,
        payload: row.payload,
        attemptCount: 0,
        createdAt: row.created_at,
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.orgId).toBe(ORG_A);
      expect(emitted[0]?.alert).toMatchObject({
        eventType: "m36.export.requested",
        correlationId: `export:${main}:requested`,
      });
      const text = JSON.stringify(emitted[0]);
      for (const secret of [WHY, PATIENT, cCare]) expect(text).not.toContain(secret);
    });

    it("(audit) create / decide / ready / download land as audit rows that omit the justification, the note and the wrapped key", async () => {
      const rows = await kit.one<{
        event_type: string;
        after: Record<string, unknown> | null;
        before: Record<string, unknown> | null;
      }>(
        `SELECT event_type, after, before FROM audit_event
          WHERE resource_kind IN ('message_export_job','message_export_download')
            AND (resource_id = $1::uuid OR after->>'job_id' = $2)
          ORDER BY created_at, id`,
        [main, main],
      );
      const types = rows.map((r) => r.event_type);
      expect(types).toContain("message_export_job.insert");
      expect(types).toContain("message_export_job.update");
      expect(types).toContain("message_export_download.insert");
      const statuses = rows
        .filter((r) => r.event_type === "message_export_job.update")
        .map((r) => r.after?.status);
      expect(statuses).toEqual(expect.arrayContaining(["approved", "building", "ready"]));
      for (const r of rows) {
        for (const side of [r.after, r.before]) {
          const keysOf = Object.keys(side ?? {});
          expect(keysOf).not.toContain("justification");
          expect(keysOf).not.toContain("decision_note");
          expect(keysOf).not.toContain("wrapped_dek");
        }
      }
      expect(JSON.stringify(rows)).not.toContain(WHY);
      expect(JSON.stringify(rows)).not.toContain(NOTE);
    });
  });

  // ── 7 + 8: expiry on the DB clock, the sweep, a stuck build ───────────────────────────────────────────────────────────────
  describe("expiry and the sweep", () => {
    let channel: string;
    beforeAll(async () => {
      channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} exp`, dayAt(2));
    });

    it("after expires_at the download is 409 EXPORT_EXPIRED and the database refuses the trail row; the sweep then deletes the object, drops the key and emits expired - with the flag OFF", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const id = await buildFlow(rq, { scopeKind: "channel", channelId: channel });
      const job = await jobRow(id);
      const key = objKey(ORG_A, job.artefact_key as string);
      expect(objects.has(key)).toBe(true);
      expect((await download(rq, id)).statusCode).toBe(200);

      await age(id);
      const expired = await download(rq, id, off);
      expect(expired.statusCode).toBe(409);
      expect(errorCode(expired)).toBe("EXPORT_EXPIRED");
      expect(await trailCount(id)).toBe(1);
      const refused = await appTx(rq, ORG_A, (q) =>
        q(
          "INSERT INTO message_export_download (organization_id, job_id, user_id) VALUES ($1,$2,$3)",
          [ORG_A, id, rq],
        ),
      );
      expect(refused).toMatch(/message_export_download_job/);
      expect((await send(on, "GET", `${API}/${id}`, rq)).json().downloadable).toBe(false);

      // The sweep reads no flag at all (the off server is up; the sweep is bound to the database only).
      const result = await sweep().expireForOrg(ORG_A);
      expect(result.expired).toBe(1);
      expect(objects.has(key)).toBe(false);
      expect(await jobRow(id)).toMatchObject({ status: "expired", wrapped_dek: null });
      const events = await eventsOf(id);
      const expiredEvent = events.find((e) => e.event_type === EXPORT_EVENT_EXPIRED);
      expect(expiredEvent && Object.keys(expiredEvent.payload).sort()).toEqual([
        "at",
        "jobId",
        "organizationId",
      ]);
      const again = await download(rq, id);
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe("EXPORT_EXPIRED");
      // A second sweep finds nothing.
      expect((await sweep().expireForOrg(ORG_A)).expired).toBe(0);
    });

    it("a ready export inside its window is untouched by the sweep", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const id = await buildFlow(rq, { scopeKind: "channel", channelId: channel });
      expect((await sweep().expireForOrg(ORG_A)).expired).toBe(0);
      expect((await jobRow(id)).status).toBe("ready");
    });

    it("a build stuck in `building` for over 30 minutes is failed EXPORT_BUILD_TIMEOUT; a young one is left alone", async () => {
      stepUpFresh = true;
      const rq = await newRequester();
      const stuck = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      const young = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      await approve(approver, stuck);
      await approve(approver, young);
      await withGuardOff(async () => {
        await kit.admin.query(
          "UPDATE message_export_job SET status='building', building_at = now() - interval '31 minutes' WHERE id=$1",
          [stuck],
        );
        await kit.admin.query(
          "UPDATE message_export_job SET status='building', building_at = now() - interval '5 minutes' WHERE id=$1",
          [young],
        );
      });
      const result = await sweep().expireForOrg(ORG_A);
      expect(result.timedOut).toBe(1);
      expect(await jobRow(stuck)).toMatchObject({
        status: "failed",
        failure_code: "EXPORT_BUILD_TIMEOUT",
      });
      expect((await jobRow(young)).status).toBe("building");
    });
  });

  // ── 9: tenancy ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("another organisation", () => {
    it("sees none of the jobs or downloads and cannot read, approve, reject, cancel or download them (404); the app role reads nothing", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} tenant`, dayAt(2));
      const rq = await newRequester();
      const id = await buildFlow(rq, { scopeKind: "channel", channelId: channel });
      expect((await download(rq, id)).statusCode).toBe(200);

      const as_b = (method: "GET" | "POST", url: string, payload?: unknown) =>
        send(on, method, url, outsider, payload, ORG_B);
      expect((await as_b("GET", `${API}/${id}`)).statusCode).toBe(404);
      expect((await as_b("POST", `${API}/${id}/approve`, {})).statusCode).toBe(404);
      expect((await as_b("POST", `${API}/${id}/reject`, {})).statusCode).toBe(404);
      expect((await as_b("POST", `${API}/${id}/cancel`)).statusCode).toBe(404);
      expect((await as_b("GET", `${API}/${id}/download`)).statusCode).toBe(404);
      expect((await as_b("GET", `${API}/pending`)).json().jobs).toEqual([]);
      expect((await as_b("GET", `${API}/mine`)).json().jobs).toEqual([]);
      // Nor can another tenant request an export of this tenant's channel.
      expect(
        (await as_b("POST", API, { scopeKind: "channel", channelId: channel, justification: WHY }))
          .statusCode,
      ).toBe(404);

      let jobs = -1;
      let trail = -1;
      await appTx(outsider, ORG_B, async (q) => {
        jobs = (await q("SELECT id FROM message_export_job")).length;
        trail = (await q("SELECT id FROM message_export_download")).length;
      });
      expect({ jobs, trail }).toEqual({ jobs: 0, trail: 0 });
      let own = -1;
      await appTx(rq, ORG_A, async (q) => {
        own = (await q("SELECT id FROM message_export_job WHERE id=$1", [id])).length;
      });
      expect(own).toBe(1);
      // A forged row against this tenant is refused by RLS / the foreign key.
      const forged = await appTx(outsider, ORG_B, (q) =>
        q(
          `INSERT INTO message_export_job (organization_id, requested_by, scope_kind, channel_id, justification)
           VALUES ($1,$2,'channel',$3,$4)`,
          [ORG_B, outsider, channel, WHY],
        ),
      );
      expect(forged).toMatch(/row-level security|foreign key|violates/i);
      // The artefact opens only under its own tenant's key binding.
      const job = await jobRow(id);
      const dek = await keys.unwrap(ORG_A, job.wrapped_dek as string);
      expect(() =>
        openArtefact(objects.get(objKey(ORG_A, job.artefact_key as string)) as Buffer, dek, {
          organizationId: ORG_B,
          jobId: id,
        }),
      ).toThrow();
    });
  });

  // ── 12: the pre-PR review fixes ──────────────────────────────────────────────────────────────────────────────────────────
  describe("review fixes", () => {
    const artefactOf = async (id: string) => {
      stepUpFresh = true;
      const res = await download((await jobRow(id)).requested_by as string, id);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        manifest: Record<string, unknown>;
        messages: Array<{ id: string; body: string }>;
      };
    };
    const refer = (messageId: string, patientId: string) =>
      kit.admin.query(
        `INSERT INTO message_entity_reference (organization_id, message_id, reference_kind, entity_id, start_offset, end_offset)
         VALUES ($1,$2,'patient',$3,0,1)`,
        [ORG_A, messageId, patientId],
      );
    const bulkInsert = async (channel: string, rows: number, createdAtSql: string) => {
      const sealed = await bodyCipher.seal(ORG_A, "bulk");
      await kit.admin.query("BEGIN");
      try {
        await kit.admin.query("SET LOCAL session_replication_role = replica");
        await kit.admin.query(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
           SELECT $1, $2, $3, 'user', $4, $5, ${createdAtSql} FROM generate_series(1, $6::int) AS g`,
          [ORG_A, channel, author, sealed.cipher, sealed.sha256, rows],
        );
        await kit.admin.query("COMMIT");
      } catch (err) {
        await kit.admin.query("ROLLBACK");
        throw err;
      }
    };

    it("(keyset) more than one page of messages inside the same millisecond: no duplicate, none lost, database order", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      // 1 100 rows (> EXPORT_PAGE_SIZE) whose created_at differ only in microseconds.
      await bulkInsert(
        channel,
        1100,
        "date_trunc('milliseconds', now() - interval '30 days') + (g * interval '1 microsecond')",
      );
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: channel,
      });
      expect(await jobRow(id)).toMatchObject({ status: "ready", message_count: 1100 });
      const doc = await artefactOf(id);
      const ids = doc.messages.map((m) => m.id);
      expect(new Set(ids).size).toBe(1100);
      const ordered = (
        await kit.one<{ id: string }>(
          "SELECT id FROM message WHERE channel_id=$1 ORDER BY created_at, id",
          [channel],
        )
      ).map((r) => r.id);
      expect(ids).toEqual(ordered);
    }, 120_000);

    it("(deleted) an author-deleted tombstone keeps its cipher but is never exported or listed", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} kept`, dayAt(3));
      const gone = await seedMessage(channel, `${MARKER} deleted-by-author`, dayAt(2));
      await kit.admin.query("UPDATE message SET status='deleted', deleted_at = now() WHERE id=$1", [
        gone,
      ]);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message WHERE id=$1 AND octet_length(body_cipher) > 0",
          [gone],
        ),
      ).toBe(1);
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: channel,
      });
      expect(await jobRow(id)).toMatchObject({ message_count: 1, part2_excluded: 0 });
      const got = await artefactOf(id);
      expect(JSON.stringify(got)).not.toContain("deleted-by-author");
      expect(got.messages.map((m) => m.id)).not.toContain(gone);
    });

    it("(part 2) a message that references a flagged patient is left out and counted, whatever the channel kind", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} plain-talk`, dayAt(3));
      const sud = await seedMessage(channel, `${MARKER} sud-discussion`, dayAt(2));
      await refer(sud, PART2_PATIENT);
      const ok = await seedMessage(channel, `${MARKER} other-patient`, dayAt(1));
      await refer(ok, PATIENT);
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: channel,
      });
      expect(await jobRow(id)).toMatchObject({
        status: "ready",
        message_count: 2,
        part2_excluded: 1,
      });
      const got = await artefactOf(id);
      expect(JSON.stringify(got)).not.toContain("sud-discussion");
      expect(got.messages).toHaveLength(2);
    });

    const clinicalLinkTo = (messageId: string, patientId: string) =>
      kit.admin.query(
        `INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, patient_id, created_by)
         VALUES ($1,$2,'visit',$3,$4,$5)`,
        [ORG_A, messageId, randomUUID(), patientId, author],
      );
    const promotionFor = (messageId: string, channelId: string, patientId: string) =>
      kit.admin.query(
        `INSERT INTO chart_promotion_request (organization_id, message_id, channel_id, patient_id, target_module, target_kind,
           requested_by_user_id, source_author_user_id, source_sent_at, source_body_sha256)
         VALUES ($1,$2,$3,$4,'m8','encounter_addendum',$5,$5,now(),$6)`,
        [ORG_A, messageId, channelId, patientId, author, "0".repeat(64)],
      );

    it("(part 2) a message tied to a flagged patient ONLY by a clinical link or a chart-promotion request is left out and counted; an unflagged link is exported", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const linked = await seedMessage(channel, `${MARKER} link-only-sud`, dayAt(4));
      await clinicalLinkTo(linked, PART2_PATIENT);
      const promoted = await seedMessage(channel, `${MARKER} promotion-only-sud`, dayAt(3));
      await promotionFor(promoted, channel, PART2_PATIENT);
      const fine = await seedMessage(channel, `${MARKER} link-other-patient`, dayAt(2));
      await clinicalLinkTo(fine, PATIENT);
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: channel,
      });
      expect(await jobRow(id)).toMatchObject({
        status: "ready",
        message_count: 1,
        part2_excluded: 2,
      });
      const got = await artefactOf(id);
      expect(JSON.stringify(got)).not.toContain("link-only-sud");
      expect(JSON.stringify(got)).not.toContain("promotion-only-sud");
      expect(got.messages.map((m) => m.id)).toEqual([fine]);
    });

    it("(part 2, TOCTOU) a flagged patient referenced AFTER the up-front decision is caught by the per-page re-check", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} toctou-stays`, dayAt(3));
      const late = await seedMessage(channel, `${MARKER} toctou-late-ref`, dayAt(2));
      const base = createExportBuildStore({ db: kit.handle.db, outbox: outbox() });
      const racing = createExportBuilder({
        store: {
          ...base,
          // Between the decision (reference lookup + count) and the page read.
          count: async (o, q) => {
            const res = await base.count(o, q);
            await refer(late, PART2_PATIENT);
            return res;
          },
        },
        keys,
        openBody: (org, cipher) => bodyCipher.open(org, cipher),
        part2Patients: async (_org, ids) =>
          sudPatientsFromFacts(
            ids.map((i) => ({ patientId: i, privacyFlags: i === PART2_PATIENT ? ["sud"] : [] })),
            ids,
          ),
        putObject: async (a) => {
          objects.set(objKey(a.organizationId, a.objectKey), Buffer.from(a.bytes));
        },
        deleteObject,
      });
      stepUpFresh = true;
      const requester = await newRequester();
      const made = await create(requester, { scopeKind: "channel", channelId: channel });
      const id = made.json().id as string;
      await approve(approver, id);
      expect(await racing.buildJob(ORG_A, id)).toEqual({ outcome: "ready", messageCount: 1 });
      expect(await jobRow(id)).toMatchObject({ message_count: 1, part2_excluded: 1 });
      expect(JSON.stringify(await artefactOf(id))).not.toContain("toctou-late-ref");
    });

    it("(snapshot edge) a message edited after the build started is not exported", async () => {
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      await seedMessage(channel, `${MARKER} edge-stays`, dayAt(3));
      const edited = await seedMessage(channel, `${MARKER} edge-edited-late`, dayAt(2));
      const base = createExportBuildStore({ db: kit.handle.db, outbox: outbox() });
      const racing = createExportBuilder({
        store: {
          ...base,
          // After the snapshot edge (`until`) is taken, before the pages are read.
          referencedPatients: async (o, q) => {
            const res = await base.referencedPatients(o, q);
            await kit.admin.query(
              "UPDATE message SET status='edited', edited_at = now() + interval '1 minute' WHERE id=$1",
              [edited],
            );
            return res;
          },
        },
        keys,
        openBody: (org, cipher) => bodyCipher.open(org, cipher),
        part2Patients: async () => new Set<string>(),
        putObject: async (a) => {
          objects.set(objKey(a.organizationId, a.objectKey), Buffer.from(a.bytes));
        },
        deleteObject,
      });
      stepUpFresh = true;
      const made = await create(await newRequester(), { scopeKind: "channel", channelId: channel });
      const id = made.json().id as string;
      await approve(approver, id);
      expect(await racing.buildJob(ORG_A, id)).toEqual({ outcome: "ready", messageCount: 1 });
      expect(JSON.stringify(await artefactOf(id))).not.toContain("edge-edited-late");
    });

    it("(part 2) a location channel exports normally: its subject (a location id) never reaches the flag reader", async () => {
      const locationId = randomUUID();
      const channel = await mkChannel(kit, "location", locationId, [author]);
      await seedMessage(channel, `${MARKER} loc-1`, dayAt(2));
      part2Asked.length = 0;
      const id = await buildFlow(await newRequester(), {
        scopeKind: "channel",
        channelId: channel,
      });
      expect(await jobRow(id)).toMatchObject({
        status: "ready",
        message_count: 1,
        part2_excluded: 0,
      });
      expect(part2Asked.flat()).not.toContain(locationId);
    });

    it("(part 2, fail closed) an invalidated privacy snapshot fails the build EXPORT_PART2_UNKNOWN instead of reading as not-SUD", async () => {
      const stale = randomUUID();
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const m = await seedMessage(channel, `${MARKER} refs-stale`, dayAt(2));
      await refer(m, stale);
      part2Stale.add(stale);
      try {
        stepUpFresh = true;
        const requester = await newRequester();
        const made = await create(requester, { scopeKind: "channel", channelId: channel });
        const id = made.json().id as string;
        await approve(approver, id);
        expect(await builder.buildJob(ORG_A, id)).toMatchObject({
          outcome: "failed",
          failureCode: "EXPORT_PART2_UNKNOWN",
        });
      } finally {
        part2Stale.delete(stale);
      }
    });

    it("(database guard) a request or a decision recorded for another user than app.user_id is refused", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const rq = await newRequester();
      const forgedInsert = await appTx(approver, ORG_A, (q) =>
        q(
          `INSERT INTO message_export_job (organization_id, requested_by, scope_kind, channel_id, justification)
           VALUES ($1,$2,'channel',$3,$4)`,
          [ORG_A, rq, channel, WHY],
        ),
      );
      expect(forgedInsert).toMatch(/message_export_job_actor/);
      const id = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      // `third` is logged in but names `approver` as the decider.
      const forgedDecision = await appTx(third, ORG_A, (q) =>
        q("UPDATE message_export_job SET status='approved', decided_by=$2 WHERE id=$1", [
          id,
          approver,
        ]),
      );
      expect(forgedDecision).toMatch(/message_export_job_actor/);
      expect((await jobRow(id)).status).toBe("pending_approval");
      // The honest decision by the logged-in user still goes through.
      const honest = await appTx(
        third,
        ORG_A,
        (q) =>
          q("UPDATE message_export_job SET status='approved', decided_by=$2 WHERE id=$1", [
            id,
            third,
          ]),
        true,
      );
      expect(honest).toBeNull();
      expect((await jobRow(id)).status).toBe("approved");
    });

    it("(quota) a full quota is the same 429 for a real and an unknown scope", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const rq = await newRequester();
      for (let i = 0; i < 3; i += 1) {
        expect((await create(rq, { scopeKind: "channel", channelId: channel })).statusCode).toBe(
          201,
        );
      }
      const real = await create(rq, { scopeKind: "channel", channelId: channel });
      const unknown = await create(rq, { scopeKind: "channel", channelId: randomUUID() });
      expect([real.statusCode, unknown.statusCode]).toEqual([429, 429]);
      expect(errorCode(unknown)).toBe("EXPORT_LIMIT");
    });

    it("(lost enqueue) the sweep lists an approved job older than 15 minutes, and only that", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const rq = await newRequester();
      const old = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      const young = (await create(rq, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      await approve(approver, old);
      await approve(approver, young);
      await withGuardOff(() =>
        kit.admin.query(
          "UPDATE message_export_job SET decided_at = decided_at - interval '20 minutes' WHERE id=$1",
          [old],
        ),
      );
      const stale = await sweep().staleApprovedForOrg(ORG_A);
      expect(stale).toContain(old);
      expect(stale).not.toContain(young);
      // Once built it is no longer approved, so it is not listed again.
      await builder.buildJob(ORG_A, old);
      expect(await sweep().staleApprovedForOrg(ORG_A)).not.toContain(old);
    });

    it("(eligibility at build) a requester deactivated after approval fails the build EXPORT_REQUESTER_INELIGIBLE and stores nothing", async () => {
      stepUpFresh = true;
      const channel = await mkChannel(kit, "discipline", randomUUID(), [author]);
      const requester = await newRequester();
      const id = (await create(requester, { scopeKind: "channel", channelId: channel })).json()
        .id as string;
      await approve(approver, id);
      await kit.admin.query("UPDATE membership SET status='revoked' WHERE user_id=$1", [requester]);
      expect(await builder.buildJob(ORG_A, id)).toMatchObject({
        outcome: "failed",
        failureCode: "EXPORT_REQUESTER_INELIGIBLE",
      });
      expect(await jobRow(id)).toMatchObject({ status: "failed", artefact_key: null });
      expect(objects.has(objKey(ORG_A, `messaging-export/${id}.enc`))).toBe(false);
    });
  });
});
