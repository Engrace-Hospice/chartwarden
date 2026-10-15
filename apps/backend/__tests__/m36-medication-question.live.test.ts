/**
 * M36 WP 3.10 - medication clarification ("Ask a nurse about a medication"), LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role. This is the Workflow D acceptance suite (05-clinical-workflows-and-safety.md lines 30-33).
 *
 * The real route stack (Authorization Contract, `channel_visibility`, the DB route service, the audit plumbing, the M1
 * idempotency store) over the REAL catalog-validating outbox publisher (not NOOP_OUTBOX).
 *
 *   1. HAPPY PATH    an aide links a medication and asks: ONE message, ONE link row and ONE nurse task, assigned to the
 *                    patient's primary RN, patient taken from the channel; the RN sees it in their task list.
 *   2. CLOSING       the RN accepts and completes (action_taken); no order table moves.
 *   3. NO ORDER      "increase morphine to 10 mg q2h" typed in the question: every M11/M12 owned table is unchanged, no
 *                    m11.* / m12.* outbox row, the text appears in no outbox payload, task row or audit row.
 *   4. NO ROUTE      the aide's resolved permissions are identical before and after asking and hold no order key (the
 *                    M11/M12 routes themselves are refused in m36-medication-question-no-order-route.test).
 *   5. REPLAY        the same client_message_id (new key and same key) => one message, one task, one set of events.
 *   6. ATOMIC        an injected task-store failure rolls back the message AND the link row.
 *   7. NO NURSE      without allow_unrouted: 422 and nothing written; with it: message, no task, one unrouted outbox row.
 *   8. OFFBOARDING   the RN leaves => the primary RN / care team takes it, never the aide; nobody => needs_owner + unrouted.
 *   9. DB BACKSTOPS  source_kind is not updatable by wardenx_app; the not-creator and shape CHECKs fire.
 *  10. TENANCY       org B and an outsider get a random channel's answer and nothing is written.
 *  11. READ AUDIT    the ask and the options read each land an audit row with a resource id.
 *  12. FLAG          off => 404 on the ask, {enabled:false} on options.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:medication-question:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the wardenx_* roles.
 */
import { randomUUID } from "node:crypto";
import {
  createPredicateRegistry,
  registerAbacRegistry,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  resolveActorPermissions,
} from "@wardenx/auth";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MODULES } from "../../../architecture/module-manifest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbClinicalLinkStore } from "../src/modules/36-messaging/clinical-link/clinical-link-store-db";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import { buildMedicationQuestionBinding } from "../src/modules/36-messaging/medication-questions/binding";
import {
  buildMedicationQuestionDeps,
  createDbChannelFactsLookup,
} from "../src/modules/36-messaging/medication-questions/deps";
import { registerMessagingRoutes } from "../src/modules/36-messaging/routes/messaging-routes";
import { buildTaskDeps } from "../src/modules/36-messaging/tasks/deps";
import { createDbTaskStore } from "../src/modules/36-messaging/tasks/task-store-db";
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

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-11110a100001";
const ORG_B = "22222222-2222-4222-8222-22220a100002";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a1a1a";
const MED = "33333333-3333-4333-8333-00000000a301";
const ASK = (channel: string) => `/api/v1/messaging/channels/${channel}/medication-questions`;
const ORDER_TEXT = "increase morphine to 10 mg q2h";
const MQ_FLAGS = { "messaging.medication_questions": true, "messaging.tasks": true };
const ALL_FLAGS = { ...MQ_FLAGS, "messaging.clinical_links": true };

describe.skipIf(!DB_URL)("M36 WP 3.10 medication clarification - LIVE Postgres", () => {
  let kit: LiveKit;
  let app: FastifyInstance;
  let offApp: FastifyInstance;
  let failingApp: FastifyInstance;
  let tasks: ReturnType<typeof buildTaskDeps>;
  let aide: string;
  let plainAide: string;
  let rn: string;
  let rn2: string;
  let colleague: string;
  let orgBUser: string;
  let channel: string;
  const keysOf = new Map<string, readonly string[]>();
  /** Knobs the CareTeamProvider ports read lazily. */
  let primaryRn: string | null = null;
  let careTeam: string[] = [];
  let failTaskInsert = false;

  const seed = async (suffix: string, org: string, keys: string[] = STAFF_KEYS) => {
    const id = await kit.seedUser(suffix, org, keys);
    keysOf.set(id, keys);
    return id;
  };
  const permissionsFor = async (_org: string, userId: string) => new Set(keysOf.get(userId) ?? []);

  const makeServer = (
    medicationQuestions: ReturnType<typeof buildMedicationQuestionDeps> | undefined,
  ) => {
    const server = buildServer({
      db: kit.handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(kit.handle.db),
    });
    registerMessagingRoutes(server, {
      service: kit.service,
      announcements: createDbAnnouncementService(kit.handle.db),
      tasks,
      clinicalLinks: {
        isEnabled: async () => true,
        sources: {
          summary: async (_kind, _org, id) =>
            id === MED
              ? { id, patientId: PATIENT as never, status: "active", occurredAt: null }
              : null,
        },
        store: createDbClinicalLinkStore(kit.handle.db),
      },
      ...(medicationQuestions ? { medicationQuestions } : {}),
    });
    return server;
  };

  const deps = (flags: Record<string, boolean>) =>
    buildMedicationQuestionDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => flags },
      outbox: catalogOutbox() as never,
      messaging: kit.service,
      permissionsFor,
      part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
      careTeamMembers: async () => careTeam,
      primaryRn: async () => primaryRn,
    });

  const ask = (
    server: FastifyInstance,
    user: string,
    body: Record<string, unknown>,
    opts: { org?: string; key?: string; channelId?: string } = {},
  ) =>
    server.inject({
      method: "POST",
      url: ASK(opts.channelId ?? channel),
      headers: as(user, opts.org ?? ORG_A, opts.key ?? randomUUID()),
      payload: { client_message_id: randomUUID(), text: "What dose is due?", ...body },
    });
  const getJson = (server: FastifyInstance, user: string, url: string, org = ORG_A) =>
    server.inject({ method: "GET", url, headers: as(user, org) });
  const act = (user: string, taskId: string, action: string, payload?: object) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/tasks/${taskId}/${action}`,
      headers: as(user, ORG_A),
      ...(payload ? { payload: payload as Record<string, unknown> } : {}),
    });

  const messageCount = () =>
    kit.count("SELECT count(*)::int AS n FROM message WHERE channel_id=$1", [channel]);
  const taskCount = () =>
    kit.count("SELECT count(*)::int AS n FROM communication_task WHERE channel_id=$1", [channel]);
  const linkCount = () =>
    kit.count("SELECT count(*)::int AS n FROM clinical_link WHERE patient_id=$1", [PATIENT]);
  const outboxCount = (eventType: string, aggregateId?: string) =>
    kit.count(
      `SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1 ${
        aggregateId ? "AND aggregate_id=$2" : ""
      }`,
      aggregateId ? [eventType, aggregateId] : [eventType],
    );
  const taskRow = async (id: string) =>
    (
      await kit.one<Record<string, unknown>>(
        "SELECT status, assignee_id::text, created_by::text, needs_owner, source_kind, clinical_concern, closed_reason, patient_id::text FROM communication_task WHERE id=$1",
        [id],
      )
    )[0];
  const orderTables = MODULES.filter((m) => m.id === 11 || m.id === 12).flatMap(
    (m) => m.ownedTables,
  );
  const orderTableCounts = async () => {
    const counts: Record<string, number> = {};
    for (const table of orderTables) {
      const [exists] = await kit.one<{ r: string | null }>("SELECT to_regclass($1) AS r", [
        `public."${table}"`,
      ]);
      if (!exists?.r) continue;
      counts[table] = await kit.count(`SELECT count(*)::int AS n FROM "${table}"`);
    }
    return counts;
  };

  beforeAll(async () => {
    kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp310");
    aide = await seed("aide", ORG_A, ["messaging.read", "messaging.send", "prescribing.read"]);
    plainAide = await seed("aide2", ORG_A, ["messaging.read", "messaging.send"]);
    rn = await seed("rn", ORG_A);
    rn2 = await seed("rn2", ORG_A);
    colleague = await seed("colleague", ORG_A);
    orgBUser = await seed("orgb", ORG_B);
    channel = await mkChannel(kit, "care_team", PATIENT, [aide, plainAide, rn, rn2, colleague]);
    primaryRn = rn;
    careTeam = [aide, plainAide, rn, rn2, colleague];

    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return kit.service.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registry.register("caseload_or_scope", async (_ctx, target) => target.patientId === PATIENT);
    registerAbacRegistry(registry);

    tasks = buildTaskDeps({
      db: kit.handle.db,
      flags: { forOrg: async () => ({ "messaging.tasks": true }) },
      outbox: catalogOutbox() as never,
      messaging: kit.service,
      careTeamMembers: async () => careTeam,
      primaryRn: async () => primaryRn,
    });
    app = makeServer(deps(ALL_FLAGS));
    offApp = makeServer(deps({ "messaging.medication_questions": false, "messaging.tasks": true }));
    // The same binding with a task store that fails on insert: proves the hook shares the send transaction.
    const real = createDbTaskStore(kit.handle.db);
    failingApp = makeServer(
      buildMedicationQuestionBinding({
        flags: { forOrg: async () => ALL_FLAGS },
        outbox: catalogOutbox() as never,
        messaging: kit.service,
        channelFacts: createDbChannelFactsLookup(kit.handle.db),
        eligibility: {
          permissionsFor,
          part2Gate: { allowedUserIds: async ({ userIds }) => new Set(userIds) },
          isActiveUser: async () => true,
        },
        displayName: async () => null,
        taskStore: {
          ...real,
          createOrGetActive: async (tx, args) => {
            if (failTaskInsert) throw new Error("injected task-store failure");
            return real.createOrGetActive(tx, args);
          },
        },
        careTeamMembers: async () => careTeam,
        primaryRn: async () => primaryRn,
      }) as never,
    );
    await Promise.all([app.ready(), offApp.ready(), failingApp.ready()]);
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), offApp?.close(), failingApp?.close()]);
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await kit?.close();
  });

  describe("workflow D happy path", () => {
    it("an aide links a medication and the primary RN gets ONE clinical task; the RN sees it", async () => {
      const messagesBefore = await messageCount();
      const tasksBefore = await taskCount();
      const linksBefore = await linkCount();

      const res = await ask(app, aide, { text: "Is this the right strength?", medication_id: MED });

      expect(res.statusCode, res.body).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ routed: true, created: true, patient_id: PATIENT });
      expect(body.task).toMatchObject({
        source_kind: "medication_question",
        clinical_concern: true,
        assignee_id: rn,
        created_by: aide,
        patient_id: PATIENT,
        status: "open",
      });
      expect(await messageCount()).toBe(messagesBefore + 1);
      expect(await taskCount()).toBe(tasksBefore + 1);
      expect(await linkCount()).toBe(linksBefore + 1);
      const [link] = await kit.one<{ link_kind: string; source_id: string; message_id: string }>(
        "SELECT link_kind, source_id::text, message_id::text FROM clinical_link WHERE message_id=$1",
        [body.message_id],
      );
      expect(link).toEqual({
        link_kind: "medication",
        source_id: MED,
        message_id: body.message_id,
      });
      expect(await outboxCount("m36.task.created", body.task.id)).toBe(1);

      const mine = await getJson(app, rn, "/api/v1/messaging/tasks?scope=assigned");
      expect(mine.statusCode).toBe(200);
      expect(mine.json().tasks.find((t: { id: string }) => t.id === body.task.id)).toMatchObject({
        source_kind: "medication_question",
        assignee_id: rn,
      });
    });

    it("an aide WITHOUT prescribing.read can still ask (no link) and gets 201 with a task", async () => {
      const res = await ask(app, plainAide, { text: "Which medication is the blue pill?" });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().task).toMatchObject({
        assignee_id: rn,
        source_kind: "medication_question",
      });
    });

    it("a supplied medication the caller may not link is a 422 and writes nothing", async () => {
      const before = [await messageCount(), await taskCount(), await linkCount()];
      const res = await ask(app, plainAide, { medication_id: MED });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("CLINICAL_LINK_NOT_AVAILABLE");
      expect([await messageCount(), await taskCount(), await linkCount()]).toEqual(before);
    });
  });

  describe("closing", () => {
    it("the RN accepts and completes with action_taken; no order table moves", async () => {
      const orders = await orderTableCounts();
      const made = (await ask(app, aide, { text: "Please check the patch change." })).json();

      expect((await act(rn, made.task.id, "accept")).statusCode).toBe(200);
      const done = await act(rn, made.task.id, "complete", { reason: "action_taken" });

      expect(done.statusCode, done.body).toBe(200);
      expect(await taskRow(made.task.id)).toMatchObject({
        status: "done",
        closed_reason: "action_taken",
      });
      expect(await orderTableCounts()).toEqual(orders);
    });
  });

  describe("an instruction typed in chat is never an order", () => {
    it("moves no M11/M12 table and leaves the text out of outbox, task and audit rows", async () => {
      const orders = await orderTableCounts();
      const orderEventsBefore = await kit.count(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm11.%' OR event_type LIKE 'm12.%'",
      );

      const res = await ask(app, aide, { text: ORDER_TEXT, medication_id: MED });

      expect(res.statusCode, res.body).toBe(201);
      expect(await orderTableCounts()).toEqual(orders);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm11.%' OR event_type LIKE 'm12.%'",
        ),
      ).toBe(orderEventsBefore);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM outbox_event WHERE payload::text ILIKE '%morphine%'",
        ),
      ).toBe(0);
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND (before::text ILIKE '%morphine%' OR after::text ILIKE '%morphine%')",
          [ORG_A],
        ),
      ).toBe(0);
      expect(JSON.stringify(res.json())).not.toContain("morphine");
    });
  });

  describe("the aide has no ordering route", () => {
    it("resolved permissions are identical before and after asking and hold no order or prescribing write key", async () => {
      const resolve = async () =>
        [...(await resolveActorPermissions({ organizationId: ORG_A, userId: aide }))].sort();
      const before = await resolve();

      await ask(app, aide, { text: "Is the dose right?" });
      const after = await resolve();

      expect(after).toEqual(before);
      const writeKeys = after.filter(
        (k) =>
          /^(orders|prescribing|emar)\./.test(k) &&
          !["orders.read", "prescribing.read"].includes(k),
      );
      expect(writeKeys).toEqual([]);
    });
  });

  describe("idempotent replay", () => {
    it("the same client_message_id under a new key and under the same key leaves one message and one task", async () => {
      const clientId = randomUUID();
      const key = randomUUID();
      const messagesBefore = await messageCount();
      const tasksBefore = await taskCount();

      const first = await ask(app, aide, { client_message_id: clientId }, { key });
      const sameKey = await ask(app, aide, { client_message_id: clientId }, { key });
      const newKey = await ask(app, aide, { client_message_id: clientId });

      expect(first.statusCode).toBe(201);
      expect(sameKey.statusCode).toBeLessThan(300);
      expect(newKey.statusCode).toBe(200);
      expect(newKey.json()).toMatchObject({ created: false, routed: true });
      expect(newKey.json().message_id).toBe(first.json().message_id);
      expect(newKey.json().task.id).toBe(first.json().task.id);
      expect(await messageCount()).toBe(messagesBefore + 1);
      expect(await taskCount()).toBe(tasksBefore + 1);
      expect(await outboxCount("m36.task.created", first.json().task.id)).toBe(1);
    });
  });

  describe("atomicity", () => {
    it("a task-store failure inside the send transaction rolls back the message and the link row", async () => {
      const before = [await messageCount(), await taskCount(), await linkCount()];
      failTaskInsert = true;
      try {
        const res = await ask(failingApp, aide, { medication_id: MED });
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
      } finally {
        failTaskInsert = false;
      }
      expect([await messageCount(), await taskCount(), await linkCount()]).toEqual(before);
      // control: the same app succeeds when the store does not fail, so the 5xx above was the injected failure.
      expect((await ask(failingApp, aide, { medication_id: MED })).statusCode).toBe(201);
    });
  });

  describe("no nurse available", () => {
    it("is 422 without allow_unrouted and writes nothing; with it the message is sent, no task, one unrouted event", async () => {
      primaryRn = null;
      try {
        const before = [await messageCount(), await taskCount()];
        const refused = await ask(app, aide, { text: ORDER_TEXT });
        expect(refused.statusCode).toBe(422);
        expect(errorCode(refused)).toBe("MEDICATION_QUESTION_NO_NURSE");
        expect([await messageCount(), await taskCount()]).toEqual(before);

        const sent = await ask(app, aide, { text: ORDER_TEXT, allow_unrouted: true });
        expect(sent.statusCode, sent.body).toBe(201);
        expect(sent.json()).toMatchObject({ routed: false, task: null, created: true });
        expect(await messageCount()).toBe(before[0] + 1);
        expect(await taskCount()).toBe(before[1]);
        const [ev] = await kit.one<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM outbox_event WHERE event_type='m36.medication_question.unrouted' AND aggregate_id=$1",
          [sent.json().message_id],
        );
        expect(Object.keys(ev?.payload ?? {}).sort()).toEqual([
          "askedByUserId",
          "at",
          "channelId",
          "messageId",
          "organizationId",
          "reason",
        ]);
        expect(ev?.payload.reason).toBe("no_nurse");
        expect(JSON.stringify(ev)).not.toContain(PATIENT);
      } finally {
        primaryRn = rn;
      }
    });

    it("rejects a chosen colleague who is not on the care team", async () => {
      const outsider = await seed("not-on-team", ORG_A);
      const before = await messageCount();
      const res = await ask(app, aide, { assignee_user_id: outsider });
      expect(res.statusCode).toBe(422);
      expect(errorCode(res)).toBe("MEDICATION_QUESTION_ASSIGNEE_INVALID");
      expect(await messageCount()).toBe(before);
    });
  });

  describe("offboarding", () => {
    it("reassigns to the new primary RN, never back to the aide who asked", async () => {
      primaryRn = rn;
      const made = (await ask(app, aide, { text: "Offboarding case one" })).json();
      primaryRn = rn2;
      await tasks.reassignForLeaver(ORG_A, rn);
      primaryRn = rn;

      const row = await taskRow(made.task.id);
      expect(row).toMatchObject({ assignee_id: rn2, needs_owner: false });
      expect(row?.assignee_id).not.toBe(aide);
    });

    it("with nobody else it flags needs_owner and publishes ONE unrouted(owner_left), once on redelivery", async () => {
      const lonelyRn = await seed("lonely-rn", ORG_A);
      const lonelyAide = await seed("lonely-aide", ORG_A);
      const patient = randomUUID();
      const ch = await mkChannel(kit, "care_team", patient, [lonelyAide, lonelyRn]);
      primaryRn = lonelyRn;
      careTeam = [lonelyAide, lonelyRn];
      try {
        const made = (
          await ask(app, lonelyAide, { text: "Lonely case" }, { channelId: ch })
        ).json();
        primaryRn = null;
        await tasks.reassignForLeaver(ORG_A, lonelyRn);
        await tasks.reassignForLeaver(ORG_A, lonelyRn);

        expect(await taskRow(made.task.id)).toMatchObject({
          assignee_id: lonelyRn,
          needs_owner: true,
        });
        expect(await outboxCount("m36.medication_question.unrouted", made.message_id)).toBe(1);
        const [ev] = await kit.one<{ payload: { reason: string } }>(
          "SELECT payload FROM outbox_event WHERE event_type='m36.medication_question.unrouted' AND aggregate_id=$1",
          [made.message_id],
        );
        expect(ev?.payload.reason).toBe("owner_left");
      } finally {
        primaryRn = rn;
        careTeam = [aide, plainAide, rn, rn2, colleague];
      }
    });
  });

  describe("database backstops", () => {
    const asApp = async (sql: string, params: unknown[]) => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        return await kit.appConn.query(sql, params);
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    };

    it("wardenx_app cannot UPDATE source_kind, and a reassignment to the asker violates the CHECK", async () => {
      const made = (await ask(app, aide, { text: "Backstop case" })).json();
      await expect(
        asApp("UPDATE communication_task SET source_kind='message' WHERE id=$1", [made.task.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asApp("UPDATE communication_task SET assignee_id=created_by WHERE id=$1", [made.task.id]),
      ).rejects.toThrow(/communication_task_medq_not_creator/);
    });

    it("the superuser still cannot store an unknown source_kind (shape CHECK)", async () => {
      const made = (await ask(app, aide, { text: "Shape case" })).json();
      await expect(
        kit.admin.query("UPDATE communication_task SET source_kind='bogus' WHERE id=$1", [
          made.task.id,
        ]),
      ).rejects.toThrow(/communication_task_source_kind_shape/);
    });
  });

  describe("tenancy", () => {
    it("org B and an outsider get a random channel's answer and nothing is written", async () => {
      const outsider = await seed("outsider", ORG_A);
      const before = [await messageCount(), await taskCount()];
      const random = randomUUID();
      for (const [user, org] of [
        [orgBUser, ORG_B],
        [outsider, ORG_A],
      ] as const) {
        const real = await ask(app, user, {}, { org });
        const control = await ask(app, user, {}, { org, channelId: random });
        expect(real.statusCode).toBeGreaterThanOrEqual(400);
        expect(real.statusCode).toBeLessThan(500);
        expect(real.statusCode).toBe(control.statusCode);
        const opts = await getJson(app, user, `${ASK(channel)}/options`, org);
        const optsControl = await getJson(app, user, `${ASK(random)}/options`, org);
        expect(opts.statusCode).toBe(optsControl.statusCode);
        expect(opts.body).not.toContain(PATIENT);
      }
      expect([await messageCount(), await taskCount()]).toEqual(before);
    });
  });

  describe("read audit", () => {
    it("the ask and the options read each land an audit row with a resource id", async () => {
      const made = (await ask(app, aide, { text: "Audit case" })).json();
      const opts = await getJson(app, aide, `${ASK(channel)}/options`);
      expect(opts.statusCode).toBe(200);
      expect(opts.json()).toMatchObject({
        enabled: true,
        patient_linked: true,
        nurse: { user_id: rn },
      });

      const askRows = await kit.count(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND actor_user_id=$3 AND event_type LIKE '%.viewed'",
        [ORG_A, made.message_id, aide],
      );
      const optionRows = await kit.count(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND actor_user_id=$3 AND event_type LIKE '%.viewed'",
        [ORG_A, channel, aide],
      );
      expect(askRows).toBeGreaterThanOrEqual(1);
      expect(optionRows).toBeGreaterThanOrEqual(1);
    });
  });

  describe("flag", () => {
    it("off => the ask is a 404 that writes nothing, and options answers {enabled:false}", async () => {
      const before = [await messageCount(), await taskCount()];
      const res = await ask(offApp, aide, {});
      expect(res.statusCode).toBe(404);
      expect([await messageCount(), await taskCount()]).toEqual(before);
      const opts = await getJson(offApp, aide, `${ASK(channel)}/options`);
      expect(opts.statusCode).toBe(200);
      expect(opts.json()).toEqual({ enabled: false });
    });
  });
});
