/**
 * GAP-136 — the M20 field-safety §4.1 ROUTES against REAL Postgres, as the NOBYPASSRLS `wardenx_app`
 * role. Until this suite, nothing drove `routes/write-service-drizzle.ts` / `read-service-drizzle.ts`
 * end to end: the live suites covered the consumers, the crons and table RLS only. This one mounts the
 * production plugins (`mountM20Routes`) over the production Drizzle services exactly as the composition
 * root binds them — the real catalog-validating tx outbox publisher (callerModule `m20`), the real DEK
 * cipher/decipher envelope, the real Drizzle ABAC resolver for M20's six §4.7 predicates — and proves:
 *   - every write route's happy path (check-in record/amend, SOS raise/cancel/acknowledge/resolve,
 *     incident create/patch/submit/transition/OSHA sign-off, policy patch, subscription create/delete,
 *     high-risk area create/patch, consent grant/revoke) writes the row and publishes its §4.10 event;
 *   - every read route answers over RLS (check-in, my-day, SOS alert, active board, location stream,
 *     incident + list, policy, subscriptions, areas, dashboard, consent surface);
 *   - RBAC (no permission → 403), ABAC (another clinician's row → 404, a non-supervisor on a supervisor
 *     route → 403, a non-responder acknowledging → 404) and step-up (no fresh step-up → 403) denials;
 *   - another tenant sees none of it (404 / empty), on the app role, not a superuser.
 *
 * `step_up_recent` is a test stub reading a header: the ceremony itself is proven live by
 * ac-03-step-up-tighten-only / gap-003; what is under test here is that M20 COMPOSES it on the two §4.1
 * step-up rows and refuses without it. The SOS cancel-window expiry is advanced by an admin UPDATE (the
 * cron that does it is proven by m20-sos-sla-watchdog.live.test.ts).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m20:routes:live
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerFieldSafetyAbacPredicates } from "../src/modules/20-field-safety/abac-predicates";
import { buildDrizzleSafetyAbacResolver } from "../src/modules/20-field-safety/abac-resolver-drizzle";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/events-by-m20";
import { M20_PERMISSION_KEY_LIST } from "../src/modules/20-field-safety/permission-keys";
import {
  buildDrizzleM20ReadService,
  buildDrizzleM20WriteService,
} from "../src/modules/20-field-safety/routes/index";
import { mountM20Routes } from "../src/modules/20-field-safety/routes/mount";
import { createSafetyCiphers } from "../src/modules/20-field-safety/safety-crypto";
import { registerFieldSafetySeams } from "../src/modules/20-field-safety/seams/index";
import { buildDrizzleSafetySeamStore } from "../src/modules/20-field-safety/seams/store-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "a2000000-0000-4000-8000-0000000000a1";
const ORG_B = "b2000000-0000-4000-8000-0000000000b1";

const NARRATIVE = `${"The clinician was approached by an unleashed dog at the gate. ".repeat(4)}`;
const RESOLUTION = `${"Supervisor reached the clinician by phone; she is safe and left the home. ".repeat(2)}`;
const ACTION_TAKEN = "Called the clinician on her mobile and confirmed she is safe.";
const REASON = "Reviewed with the clinician and the team lead today.";

interface Actor {
  readonly user: string;
  readonly org: string;
  readonly roles: string;
  readonly membership: string;
  readonly pe: string;
  readonly location: string;
}

/** Header-auth shim: the M2-assembled context a real session would carry, minus the cookie. */
function headerAuth(request: FastifyRequest): void {
  const h = (k: string): string => {
    const v = request.headers[k];
    return typeof v === "string" ? v : "";
  };
  if (h("x-test-user") === "") return;
  request.context.userId = h("x-test-user");
  request.context.organizationId = h("x-test-org");
  request.context.roles = h("x-test-roles") === "" ? [] : h("x-test-roles").split(",");
  request.context.providerEntityIds = h("x-test-pe") === "" ? [] : [h("x-test-pe")];
  request.context.locationIds = h("x-test-loc") === "" ? [] : [h("x-test-loc")];
  request.context.attributes = {
    ...(h("x-test-membership") === "" ? {} : { membershipId: h("x-test-membership") }),
    stepUpRecent: h("x-test-stepup") === "1",
  };
}

describe.skipIf(!DB_URL)("GAP-136 M20 field-safety routes — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const actors: Record<string, Actor> = {};

  async function seedActor(
    key: string,
    org: string,
    roles: string,
    pe: string,
    location: string,
  ): Promise<void> {
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${key}@gap136-m20.test`,
      ])
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id,
           default_location_ids) VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
        [user, org, pe, JSON.stringify([location])],
      )
    ).rows[0].id as string;
    actors[key] = { user, org, roles, membership, pe, location };
  }

  async function seedOrg(org: string, slug: string): Promise<{ pe: string; location: string }> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
      [org, slug],
    );
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
      )
    ).rows[0].id as string;
    const location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    return { pe, location };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    const a = await seedOrg(ORG_A, "gap136-m20-a");
    const b = await seedOrg(ORG_B, "gap136-m20-b");
    await seedActor("rn", ORG_A, "registered_nurse", a.pe, a.location);
    await seedActor("rn2", ORG_A, "registered_nurse", a.pe, a.location);
    await seedActor("sup", ORG_A, "director_of_nursing", a.pe, a.location);
    await seedActor("billing", ORG_A, "billing_specialist", a.pe, a.location);
    await seedActor("noperm", ORG_A, "registered_nurse", a.pe, a.location);
    await seedActor("donB", ORG_B, "director_of_nursing", b.pe, b.location);

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M20_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, emission: object) =>
        txPublisher.publish(tx as never, { ...emission, callerModule: "m20" } as never),
    };

    const permissions = createInMemoryEffectivePermissionStore(
      Object.values(actors)
        .filter((actor) => actor !== actors.noperm)
        .map((actor) => ({
          orgId: actor.org,
          userId: actor.user,
          grants: [
            {
              roleKey: actor.roles,
              enabled: true,
              expiresAt: null,
              permissionKeys: [...M20_PERMISSION_KEY_LIST],
            },
          ],
        })),
    );
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(permissions.store);
    registerAbacRegistry();
    registerFieldSafetyAbacPredicates({
      resolver: buildDrizzleSafetyAbacResolver(handle.db, { roleGrants: permissions.store }),
      // No M19 roster in this suite: the on-call arm answers "nobody", so only the subscription arm can
      // make a supervisor a responder — the arm the subscription routes below create.
      ports: { onCallForProviderEntity: async () => [] },
    });
    registerPredicateIdempotent(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );

    const key = randomBytes(32);
    const ciphers = createSafetyCiphers({
      async dekForOrg() {
        return { version: "v1", key };
      },
      async dekForOrgVersion() {
        return { version: "v1", key };
      },
    });
    // The board IS the §4.3 SafetyDashboardProvider seam (read-service decision 3); the composition root
    // registers it over the Drizzle seam store in `wireModuleSeams`, so this suite does the same.
    registerFieldSafetySeams({ store: buildDrizzleSafetySeamStore(handle.db) });
    const readService = buildDrizzleM20ReadService(handle.db, { decipher: ciphers.decipher });
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountM20Routes(app, {
      readService,
      writeService: buildDrizzleM20WriteService(handle.db, readService, {
        outbox: outbox as never,
        cipher: ciphers.cipher,
      }),
    });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM outbox_event");
  });

  const headersFor = (key: string, extra: Record<string, string> = {}): Record<string, string> => {
    const actor = actors[key] as Actor;
    return {
      "x-test-user": actor.user,
      "x-test-org": actor.org,
      "x-test-roles": actor.roles,
      "x-test-membership": actor.membership,
      "x-test-pe": actor.pe,
      "x-test-loc": actor.location,
      "idempotency-key": randomUUID(),
      ...extra,
    };
  };
  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    as: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: headersFor(as, extra),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const eventTypes = async (): Promise<string[]> =>
    (await admin.query("SELECT event_type FROM outbox_event ORDER BY created_at, id")).rows.map(
      (r) => r.event_type as string,
    );

  // ── check-ins ────────────────────────────────────────────────────────────────────────────────────
  describe("check-ins", () => {
    it("records, reads, amends within the grace and lists today's check-ins", async () => {
      const created = await call("POST", "/api/v1/safety/check-ins", "rn", {
        kind: "ad_hoc",
        status: "ok",
      });
      expect(created.statusCode).toBe(201);
      const checkIn = created.json().checkIn;
      expect(checkIn).toMatchObject({
        postedByMembershipId: actors.rn?.membership,
        kind: "ad_hoc",
        status: "ok",
      });
      // the first write seeded the §3.2 Phase-E policy floor on the way
      const { rows: versions } = await admin.query(
        "SELECT count(*)::int AS n FROM safety_policy_version WHERE organization_id=$1",
        [ORG_A],
      );
      expect(versions[0].n).toBe(1);

      const read = await call("GET", `/api/v1/safety/check-ins/${checkIn.id}`, "rn");
      expect(read.statusCode).toBe(200);
      expect(read.json().id).toBe(checkIn.id);

      const amended = await call("PATCH", `/api/v1/safety/check-ins/${checkIn.id}`, "rn", {
        status: "concerned_continue",
        concernNote: "Large dog loose in the yard, keeping my distance.",
        amendmentReason: "Tapped the wrong status",
      });
      expect(amended.statusCode).toBe(200);
      expect(amended.json()).toMatchObject({
        correctsCheckInId: checkIn.id,
        status: "concerned_continue",
      });

      const myDay = await call("GET", "/api/v1/safety/check-ins/me/today", "rn");
      expect(myDay.statusCode).toBe(200);
      expect(myDay.json().recentCheckIns.map((c: { id: string }) => c.id)).toContain(
        amended.json().id,
      );

      expect(await eventTypes()).toEqual([
        "m20.safety.check_in_recorded",
        "m20.safety.check_in_recorded",
      ]);
    });

    it("refuses a non-ok check-in without a 20-character note (422) and writes nothing", async () => {
      const res = await call("POST", "/api/v1/safety/check-ins", "rn", {
        kind: "ad_hoc",
        status: "concerned_stop",
      });
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain("CONCERN_NOTE_REQUIRED");
      expect(await eventTypes()).toEqual([]);
    });

    it("requires an Idempotency-Key on the record route (400)", async () => {
      const headers = headersFor("rn");
      const { "idempotency-key": _drop, ...withoutKey } = headers;
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/safety/check-ins",
        headers: withoutKey,
        payload: { kind: "ad_hoc", status: "ok" },
      });
      expect(res.statusCode).toBe(400);
    });

    describe("GAP-030 schedule binding", () => {
      async function policyVersionFor(owner: string): Promise<string> {
        const o = actors[owner] as Actor;
        const existing = await admin.query(
          "SELECT safety_policy_version_id FROM safety_check_in WHERE organization_id = $1 LIMIT 1",
          [o.org],
        );
        if (existing.rows[0]) return existing.rows[0].safety_policy_version_id as string;
        await call("POST", "/api/v1/safety/check-ins", owner, { kind: "ad_hoc", status: "ok" });
        const created = await admin.query(
          "SELECT safety_policy_version_id FROM safety_check_in WHERE organization_id = $1 LIMIT 1",
          [o.org],
        );
        return created.rows[0].safety_policy_version_id as string;
      }

      async function seedSchedule(owner: string, state: string): Promise<string> {
        const o = actors[owner] as Actor;
        const versionId = await policyVersionFor(owner);
        const detected = state === "proposed" ? null : new Date();
        const inserted = await admin.query(
          `INSERT INTO safety_check_in_schedule
             (organization_id, provider_entity_id, location_id, clinician_membership_id, kind,
              expected_at, window_minutes, state, overdue_detected_at, safety_policy_version_id)
           VALUES ($1,$2,$3,$4,'between_visits', now() - interval '20 minutes', 15, $5, $6, $7)
           RETURNING id`,
          [o.org, o.pe, o.location, o.membership, state, detected, versionId],
        );
        return inserted.rows[0].id as string;
      }

      const scheduleState = async (id: string): Promise<string> =>
        (await admin.query("SELECT state FROM safety_check_in_schedule WHERE id = $1", [id]))
          .rows[0].state as string;

      it("a clinician cannot close another clinician's schedule row", async () => {
        const scheduleId = await seedSchedule("rn", "overdue");
        const res = await call("POST", "/api/v1/safety/check-ins", "rn2", {
          kind: "between_visits",
          status: "ok",
          scheduleId,
        });
        expect(res.statusCode).toBe(404);
        expect(await scheduleState(scheduleId)).toBe("overdue");
      });

      it("the owner closes her own schedule row and scheduleClosed is true", async () => {
        const scheduleId = await seedSchedule("rn", "overdue");
        const res = await call("POST", "/api/v1/safety/check-ins", "rn", {
          kind: "between_visits",
          status: "ok",
          scheduleId,
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().scheduleClosed).toBe(true);
        expect(await scheduleState(scheduleId)).toBe("recorded");
      });

      it("a schedule row that is no longer actionable is not closed again", async () => {
        const scheduleId = await seedSchedule("rn", "overdue");
        await call("POST", "/api/v1/safety/check-ins", "rn", {
          kind: "between_visits",
          status: "ok",
          scheduleId,
        });
        const again = await call("POST", "/api/v1/safety/check-ins", "rn", {
          kind: "between_visits",
          status: "ok",
          scheduleId,
        });
        expect(again.statusCode).toBe(404);
      });
    });

    it("RBAC/ABAC: no permission is 403; another clinician's check-in is 404; her supervisor-less peer cannot amend it", async () => {
      const created = (
        await call("POST", "/api/v1/safety/check-ins", "rn", { kind: "ad_hoc", status: "ok" })
      ).json().checkIn;
      expect(
        (await call("POST", "/api/v1/safety/check-ins", "noperm", { kind: "ad_hoc", status: "ok" }))
          .statusCode,
      ).toBe(403);
      expect((await call("GET", `/api/v1/safety/check-ins/${created.id}`, "rn2")).statusCode).toBe(
        404,
      );
      expect(
        (
          await call("PATCH", `/api/v1/safety/check-ins/${created.id}`, "rn2", {
            amendmentReason: "Not mine to amend",
          })
        ).statusCode,
      ).toBe(403);
    });
  });

  // ── consent ──────────────────────────────────────────────────────────────────────────────────────
  describe("consent", () => {
    it("grants, reads and revokes a purpose; the grant then gates SOS coordinates", async () => {
      const granted = await call("POST", "/api/v1/safety/consent/grant", "rn2", {
        purpose: "sos_coordinates",
        acknowledgmentTextSnapshot: "I agree my location is shared when I press SOS.",
      });
      expect(granted.statusCode).toBe(201);
      expect(granted.json()).toMatchObject({ purpose: "sos_coordinates", status: "granted" });

      const surface = await call("GET", "/api/v1/safety/consent?purpose=sos_coordinates", "rn2");
      expect(surface.statusCode).toBe(200);
      expect(surface.json().consents[0].status).toBe("granted");

      // with consent + a bound DEK, the coordinate is sealed (no warning, coordinatesCaptured)
      const sos = await call("POST", "/api/v1/safety/sos", "rn2", {
        postedCoordinates: { latitude: 45.5, longitude: -122.6, accuracyM: 8 },
      });
      expect(sos.statusCode).toBe(201);
      expect(sos.json().warningsSurfaced).toEqual([]);
      const { rows } = await admin.query(
        "SELECT posted_coordinates_cipher FROM safety_sos_alert WHERE id=$1",
        [sos.json().id],
      );
      expect((rows[0].posted_coordinates_cipher as Buffer).toString("utf8")).not.toContain("45.5");

      const revoked = await call("POST", "/api/v1/safety/consent/revoke", "rn2", {
        purpose: "sos_coordinates",
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().status).toBe("revoked");
      // a second revoke has nothing granted to revoke
      expect(
        (await call("POST", "/api/v1/safety/consent/revoke", "rn2", { purpose: "sos_coordinates" }))
          .statusCode,
      ).toBe(404);
    });

    it("an emergency_contact_call grant needs the contact (422); with it, the contact is sealed", async () => {
      const missing = await call("POST", "/api/v1/safety/consent/grant", "rn2", {
        purpose: "emergency_contact_call",
        acknowledgmentTextSnapshot: "Call my spouse if I do not answer.",
      });
      expect(missing.statusCode).toBe(422);
      const ok = await call("POST", "/api/v1/safety/consent/grant", "rn2", {
        purpose: "emergency_contact_call",
        acknowledgmentTextSnapshot: "Call my spouse if I do not answer.",
        contact: { name: "Sam", phone: "+15035550100", relationship: "spouse" },
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().contactOnFile).toBe(true);
      const { rows } = await admin.query(
        "SELECT consent_scope_detail::text AS d FROM safety_emergency_contact_consent WHERE consent_purpose='emergency_contact_call' AND status='granted'",
      );
      expect(rows[0].d).not.toContain("5550100");
    });
  });

  // ── SOS spine ────────────────────────────────────────────────────────────────────────────────────
  describe("SOS", () => {
    let subscriptionId = "";

    it("a supervisor subscribes to the clinician (admin route), which makes her a responder", async () => {
      const created = await call("POST", "/api/v1/safety/supervisor-subscriptions", "sup", {
        supervisorMembershipId: actors.sup?.membership,
        scopeKind: "explicit",
        clinicianMembershipId: actors.rn?.membership,
        alertKinds: ["sos", "overdue", "incident"],
      });
      expect(created.statusCode).toBe(201);
      subscriptionId = created.json().id;
      expect(created.json()).toMatchObject({
        scopeKind: "explicit",
        clinicianMembershipId: actors.rn?.membership,
      });
      const list = await call("GET", "/api/v1/safety/supervisor-subscriptions", "sup");
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((s: { id: string }) => s.id)).toContain(subscriptionId);
      // a clinician is not a supervisor
      expect((await call("GET", "/api/v1/safety/supervisor-subscriptions", "rn")).statusCode).toBe(
        403,
      );
      // a scope kind without its selector covers nobody → 422
      const incomplete = await call("POST", "/api/v1/safety/supervisor-subscriptions", "sup", {
        supervisorMembershipId: actors.sup?.membership,
        scopeKind: "location",
        alertKinds: ["sos"],
      });
      expect(incomplete.statusCode).toBe(422);
    });

    it("raise → acknowledge → resolve: the full press lifecycle, its history and its events", async () => {
      const raised = await call("POST", "/api/v1/safety/sos", "rn", {});
      expect(raised.statusCode).toBe(201);
      const sosId = raised.json().id as string;
      expect(raised.json().lifecycleState).toBe("cancel_window_open");
      // no coordinates sent → the alert still goes out, with the warning naming why there is no pin
      expect(raised.json().warningsSurfaced[0].code).toBe("COORDINATES_ABSENT");

      // the board shows it to the supervisor and to the clinician herself
      const board = await call("GET", "/api/v1/safety/sos/active", "sup");
      expect(board.statusCode).toBe(200);
      expect(board.json().alerts.map((a: { id: string }) => a.id)).toContain(sosId);

      // the cancel window lapses (the watchdog's job — m20-sos-sla-watchdog.live proves the cron)
      await admin.query(
        "UPDATE safety_sos_alert SET lifecycle_state='acknowledging', version=version+1 WHERE id=$1",
        [sosId],
      );

      // a peer clinician is not a responder → 404 (per-row PHI is unprobeable)
      expect(
        (
          await call("POST", `/api/v1/safety/sos/${sosId}/acknowledge`, "rn2", {
            actionTaken: ACTION_TAKEN,
          })
        ).statusCode,
      ).toBe(404);

      // stale If-Match → 409
      const stale = await call(
        "POST",
        `/api/v1/safety/sos/${sosId}/acknowledge`,
        "sup",
        { actionTaken: ACTION_TAKEN },
        { "if-match": '"0"' },
      );
      expect(stale.statusCode).toBe(409);

      const acked = await call("POST", `/api/v1/safety/sos/${sosId}/acknowledge`, "sup", {
        actionTaken: ACTION_TAKEN,
        outcome: "reached_clinician_by_phone",
      });
      expect(acked.statusCode).toBe(200);
      expect(acked.json()).toMatchObject({
        lifecycleState: "acknowledged",
        acknowledgedByMembershipId: actors.sup?.membership,
      });
      expect(acked.json().acknowledgments).toHaveLength(1);

      // the coordinate stream: the responder may read it during the alert
      const stream = await call("GET", `/api/v1/safety/sos/${sosId}/location-stream`, "sup");
      expect(stream.statusCode).toBe(200);
      expect(stream.json().sosAlertId).toBe(sosId);
      expect(
        (await call("GET", `/api/v1/safety/sos/${sosId}/location-stream`, "rn2")).statusCode,
      ).toBe(404);

      const resolved = await call("POST", `/api/v1/safety/sos/${sosId}/resolve`, "sup", {
        resolutionNarrative: RESOLUTION,
        outcome: "clinician_safe_continued",
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json()).toMatchObject({
        lifecycleState: "resolved",
        outcome: "clinician_safe_continued",
        resolutionNarrative: RESOLUTION,
      });
      const { rows } = await admin.query(
        "SELECT resolution_narrative_cipher FROM safety_sos_alert WHERE id=$1",
        [sosId],
      );
      expect((rows[0].resolution_narrative_cipher as Buffer).toString("utf8")).not.toContain(
        "Supervisor reached",
      );

      // the clinician reads her own alert; a peer cannot
      const own = await call("GET", `/api/v1/safety/sos/${sosId}`, "rn");
      expect(own.statusCode).toBe(200);
      expect(own.json().stateHistory.map((h: { toState: string }) => h.toState)).toEqual(
        expect.arrayContaining(["acknowledged", "resolving", "resolved"]),
      );
      expect((await call("GET", `/api/v1/safety/sos/${sosId}`, "rn2")).statusCode).toBe(404);

      expect(await eventTypes()).toEqual(
        expect.arrayContaining([
          "m20.safety.sos_alert_raised",
          "m20.safety.sos_alert_acknowledged",
          "m20.safety.sos_alert_resolved",
        ]),
      );
    });

    it("the clinician cancels inside the window; a peer cannot cancel it", async () => {
      // the floor policy requires a biometric to cancel; the token is the device's verdict
      const raised = (await call("POST", "/api/v1/safety/sos", "rn", {})).json();
      expect(
        (await call("POST", `/api/v1/safety/sos/${raised.id}/cancel`, "rn2", {})).statusCode,
      ).toBe(403);
      // GAP-031 — the verdict is the SERVER-verified step-up on the session, never the client's token.
      const cancelled = await call(
        "POST",
        `/api/v1/safety/sos/${raised.id}/cancel`,
        "rn",
        { biometricVerificationToken: "device-attested" },
        { "x-test-stepup": "1" },
      );
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        cancelStatus: "cancelled_in_window",
        lifecycleState: "cancelled_in_window",
      });
    });

    it("GAP-031: an arbitrary biometric token without a fresh step-up does NOT cancel the SOS", async () => {
      const raised = (await call("POST", "/api/v1/safety/sos", "rn", {})).json();
      const attempt = await call("POST", `/api/v1/safety/sos/${raised.id}/cancel`, "rn", {
        biometricVerificationToken: "any-string-the-client-likes",
      });
      expect(attempt.statusCode).toBe(200);
      expect(attempt.json()).toMatchObject({
        cancelStatus: "cancel_attempted_but_rejected",
        lifecycleState: "cancel_window_open",
      });
      const row = await admin.query("SELECT lifecycle_state FROM safety_sos_alert WHERE id = $1", [
        raised.id,
      ]);
      expect(row.rows[0].lifecycle_state).toBe("cancel_window_open");
    });

    it("a role outside the field disciplines cannot press SOS (field_eligible_for_sos → 403)", async () => {
      const res = await call("POST", "/api/v1/safety/sos", "billing", {});
      expect(res.statusCode).toBe(403);
      expect(await eventTypes()).toEqual([]);
    });

    it("deleting the only subscription reports the coverage gap it leaves", async () => {
      const del = await call(
        "DELETE",
        `/api/v1/safety/supervisor-subscriptions/${subscriptionId}`,
        "sup",
      );
      expect(del.statusCode).toBe(200);
      expect(del.json().id).toBe(subscriptionId);
      expect(del.json().deactivatedAt).toEqual(expect.any(String));
      expect(
        (await call("DELETE", `/api/v1/safety/supervisor-subscriptions/${subscriptionId}`, "sup"))
          .statusCode,
      ).toBe(404);
    });
  });

  // ── incidents ────────────────────────────────────────────────────────────────────────────────────
  describe("incidents", () => {
    it("create → patch → OSHA sign-off → submit → transition → close, with every guard on the way", async () => {
      const created = await call("POST", "/api/v1/safety/incidents", "rn", {
        affectedClinicianMembershipId: actors.rn?.membership,
        category: "dog_bite",
        severity: "moderate",
        occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
        narrative: NARRATIVE,
        witnesses: "Neighbour across the street",
      });
      expect(created.statusCode).toBe(201);
      const incident = created.json();
      expect(incident).toMatchObject({
        lifecycleState: "draft",
        reportedByMembershipId: actors.rn?.membership,
        narrative: NARRATIVE,
        version: 1,
      });
      const { rows } = await admin.query(
        "SELECT narrative_cipher FROM safety_incident WHERE id=$1",
        [incident.id],
      );
      expect((rows[0].narrative_cipher as Buffer).toString("utf8")).not.toContain("unleashed");

      // a clinician cannot open an incident ON somebody else — naming a peer needs the supervisor arm
      // (GAP-136: the guard used to drop the body's subject, so this answered 201)
      const peerCreate = await call("POST", "/api/v1/safety/incidents", "rn2", {
        affectedClinicianMembershipId: actors.rn?.membership,
        category: "dog_bite",
        severity: "minor",
        occurredAt: new Date().toISOString(),
        narrative: NARRATIVE,
      });
      expect(peerCreate.statusCode).toBe(403);

      // PATCH requires If-Match (428), refuses a stale one (409), and a peer cannot see it (404)
      expect(
        (
          await call("PATCH", `/api/v1/safety/incidents/${incident.id}`, "rn", {
            severity: "serious",
          })
        ).statusCode,
      ).toBe(428);
      expect(
        (
          await call(
            "PATCH",
            `/api/v1/safety/incidents/${incident.id}`,
            "rn",
            { severity: "serious" },
            { "if-match": '"99"' },
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await call(
            "PATCH",
            `/api/v1/safety/incidents/${incident.id}`,
            "rn2",
            { severity: "serious" },
            { "if-match": '"1"' },
          )
        ).statusCode,
      ).toBe(404);
      const patched = await call(
        "PATCH",
        `/api/v1/safety/incidents/${incident.id}`,
        "rn",
        { severity: "serious", workersCompClaimInitiated: true },
        { "if-match": '"1"' },
      );
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ severity: "serious", version: 2 });

      // submitting as OSHA-reportable needs the sign-off first (422)
      const early = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/submit`,
        "rn",
        { oshaReportable: true },
        { "if-match": '"2"' },
      );
      expect(early.statusCode).toBe(422);
      expect(JSON.stringify(early.json())).toContain("OSHA_SIGNOFF_REQUIRED");

      const signoffBody = {
        oshaReportable: true,
        reason: "Dog bite broke the skin; state rules make this reportable.",
        stateCode: "or",
        reportingWindowHours: 24,
      };
      // step-up is composed on the sign-off: none → 403; a clinician is not a supervisor → 403
      expect(
        (
          await call(
            "POST",
            `/api/v1/safety/incidents/${incident.id}/osha-signoff`,
            "sup",
            signoffBody,
            {
              "if-match": '"2"',
            },
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            "POST",
            `/api/v1/safety/incidents/${incident.id}/osha-signoff`,
            "rn",
            signoffBody,
            {
              "if-match": '"2"',
              "x-test-stepup": "1",
            },
          )
        ).statusCode,
      ).toBe(403);
      const signed = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/osha-signoff`,
        "sup",
        signoffBody,
        { "if-match": '"2"', "x-test-stepup": "1" },
      );
      expect(signed.statusCode).toBe(200);
      expect(signed.json()).toMatchObject({
        oshaReportable: true,
        oshaReportableSignedOffByMembershipId: actors.sup?.membership,
        version: 3,
      });

      const submitted = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/submit`,
        "rn",
        { oshaReportable: true },
        { "if-match": '"3"' },
      );
      expect(submitted.statusCode).toBe(200);
      expect(submitted.json()).toMatchObject({ lifecycleState: "submitted", version: 4 });

      // a submitted report is immutable to its subject
      expect(
        (
          await call(
            "PATCH",
            `/api/v1/safety/incidents/${incident.id}`,
            "rn",
            { severity: "minor" },
            { "if-match": '"4"' },
          )
        ).statusCode,
      ).toBe(409);

      // the supervisor state machine; the clinician cannot drive it
      expect(
        (
          await call(
            "POST",
            `/api/v1/safety/incidents/${incident.id}/state`,
            "rn",
            { toState: "under_review", reason: REASON },
            { "if-match": '"4"' },
          )
        ).statusCode,
      ).toBe(403);
      const review = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/state`,
        "sup",
        { toState: "under_review", reason: REASON },
        { "if-match": '"4"' },
      );
      expect(review.statusCode).toBe(200);
      expect(review.json().lifecycleState).toBe("under_review");
      const noPlan = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/state`,
        "sup",
        { toState: "closed_with_action_plan", reason: REASON },
        { "if-match": '"5"' },
      );
      expect(noPlan.statusCode).toBe(422);
      const closed = await call(
        "POST",
        `/api/v1/safety/incidents/${incident.id}/state`,
        "sup",
        {
          toState: "closed_with_action_plan",
          reason: REASON,
          actionPlan: "Pre-visit call to confirm animals are secured.",
        },
        { "if-match": '"5"' },
      );
      expect(closed.statusCode).toBe(200);
      expect(closed.json()).toMatchObject({
        lifecycleState: "closed_with_action_plan",
        actionPlan: "Pre-visit call to confirm animals are secured.",
      });
      expect(closed.json().stateHistory.map((h: { toState: string }) => h.toState)).toEqual([
        "draft",
        "submitted",
        "under_review",
        "closed_with_action_plan",
      ]);

      // reads: the subject and the supervisor see it; a peer does not
      expect((await call("GET", `/api/v1/safety/incidents/${incident.id}`, "rn")).statusCode).toBe(
        200,
      );
      expect((await call("GET", `/api/v1/safety/incidents/${incident.id}`, "rn2")).statusCode).toBe(
        404,
      );
      const list = await call("GET", "/api/v1/safety/incidents?oshaReportable=true", "sup");
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((i: { id: string }) => i.id)).toContain(incident.id);

      expect(await eventTypes()).toEqual(
        expect.arrayContaining([
          "m20.safety.incident_reported",
          "m20.safety.workers_comp_claim_initiated",
          "m20.safety.osha_reportable_incident_filed",
          "m20.safety.incident_submitted",
          "m20.safety.incident_report_requested",
          "m20.safety.incident_closed_with_action",
        ]),
      );
    });
  });

  // ── policy + high-risk areas ─────────────────────────────────────────────────────────────────────
  describe("policy and high-risk areas", () => {
    it("reads the effective policy, and a stepped-up supervisor re-issues it as a NEW version", async () => {
      const read = await call("GET", "/api/v1/safety/policy", "rn");
      expect(read.statusCode).toBe(200);
      const before = read.json();

      // the floor IS the band's loosest edge, so loosening it is refused (422 naming the band)…
      const loosen = await call(
        "PATCH",
        "/api/v1/safety/policy",
        "sup",
        {
          sosTier1SlaSeconds: (before.sosTier1SlaSeconds as number) + 30,
          editReason: "Night coverage is thinner; give tier one more time to answer.",
        },
        { "x-test-stepup": "1" },
      );
      expect(loosen.statusCode).toBe(422);
      expect(JSON.stringify(loosen.json())).toContain("POLICY_OUT_OF_BOUNDS");
      // …and tightening it is a new version.
      const body = {
        sosTier1SlaSeconds: (before.sosTier1SlaSeconds as number) - 15,
        editReason: "Tighten tier one: we want a faster first answer at night.",
      };
      expect((await call("PATCH", "/api/v1/safety/policy", "sup", body)).statusCode).toBe(403);
      expect(
        (await call("PATCH", "/api/v1/safety/policy", "rn", body, { "x-test-stepup": "1" }))
          .statusCode,
      ).toBe(403);
      const patched = await call("PATCH", "/api/v1/safety/policy", "sup", body, {
        "x-test-stepup": "1",
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().sosTier1SlaSeconds).toBe(body.sosTier1SlaSeconds);
      // append-only (GAP-136): the previous version row is untouched, the new one supersedes it by its
      // later effective_from, and the effective read answers the new one
      const { rows } = await admin.query(
        "SELECT id, sos_tier_1_sla_seconds AS t1 FROM safety_policy_version WHERE organization_id=$1 ORDER BY effective_from",
        [ORG_A],
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.find((r) => r.id === before.versionId)?.t1).toBe(before.sosTier1SlaSeconds);
      expect(rows[rows.length - 1].id).toBe(patched.json().versionId);
      const reread = (await call("GET", "/api/v1/safety/policy", "rn")).json();
      expect(reread).toMatchObject({
        versionId: patched.json().versionId,
        sosTier1SlaSeconds: body.sosTier1SlaSeconds,
      });
      // an as-of read before the edit still answers the version that was in force then
      const asOf = encodeURIComponent(new Date(Date.parse(reread.effectiveFrom) - 1).toISOString());
      const past = (await call("GET", `/api/v1/safety/policy?asOf=${asOf}`, "rn")).json();
      expect(past.sosTier1SlaSeconds).toBe(before.sosTier1SlaSeconds);
      expect(await eventTypes()).toEqual(["m20.safety.policy_changed"]);
    });

    it("creates, lists and retires a high-risk area; an open ring is refused (422)", async () => {
      const ring = [
        [-122.7, 45.5],
        [-122.6, 45.5],
        [-122.6, 45.6],
        [-122.7, 45.5],
      ];
      const created = await call("POST", "/api/v1/safety/high-risk-areas", "sup", {
        riskCategory: "general_caution",
        advisoryMessage: "Loose dogs reported on this block.",
        polygon: [ring],
        effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
      });
      expect(created.statusCode).toBe(201);
      const areaId = created.json().id as string;
      expect(
        (
          await call("POST", "/api/v1/safety/high-risk-areas", "sup", {
            riskCategory: "general_caution",
            advisoryMessage: "Open ring",
            polygon: [ring.slice(0, 3).concat([[-122.65, 45.55]])],
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await call("POST", "/api/v1/safety/high-risk-areas", "rn", {
            riskCategory: "general_caution",
            advisoryMessage: "Not a supervisor",
            polygon: [ring],
          })
        ).statusCode,
      ).toBe(403);

      const list = await call("GET", "/api/v1/safety/high-risk-areas", "rn");
      expect(list.statusCode).toBe(200);
      expect(list.json().data.map((a: { id: string }) => a.id)).toContain(areaId);

      // retiring before the area even started is a 422 naming the window (GAP-136: it was a 500 on
      // the `m20_shra_window` CHECK)
      const backwards = await call("PATCH", `/api/v1/safety/high-risk-areas/${areaId}`, "sup", {
        effectiveTo: new Date(Date.now() - 7_200_000).toISOString(),
      });
      expect(backwards.statusCode).toBe(422);
      expect(JSON.stringify(backwards.json())).toContain("AREA_WINDOW_INVALID");

      const retired = await call("PATCH", `/api/v1/safety/high-risk-areas/${areaId}`, "sup", {
        advisoryMessage: "Retired: dogs rehomed.",
        effectiveTo: new Date(Date.now() - 1000).toISOString(),
      });
      expect(retired.statusCode).toBe(200);
      expect(retired.json().advisoryMessage).toBe("Retired: dogs rehomed.");
      const active = await call("GET", "/api/v1/safety/high-risk-areas", "rn");
      expect(active.json().data.map((a: { id: string }) => a.id)).not.toContain(areaId);
    });
  });

  // ── dashboard ────────────────────────────────────────────────────────────────────────────────────
  describe("dashboard", () => {
    it("the supervisor reads the board; a session without the key is refused", async () => {
      const board = await call("GET", "/api/v1/safety/dashboard", "sup");
      expect(board.statusCode).toBe(200);
      expect(board.json()).toMatchObject({
        clinicians: expect.any(Array),
        activeSosCount: expect.any(Number),
        overdueCount: expect.any(Number),
      });
      expect((await call("GET", "/api/v1/safety/dashboard", "noperm")).statusCode).toBe(403);
      // org B's board never shows an org A clinician
      const boardB = (await call("GET", "/api/v1/safety/dashboard", "donB")).json();
      const orgAMemberships = Object.values(actors)
        .filter((a) => a.org === ORG_A)
        .map((a) => a.membership);
      for (const c of boardB.clinicians as { membershipId: string }[]) {
        expect(orgAMemberships).not.toContain(c.membershipId);
      }
    });
  });

  // ── tenant isolation ─────────────────────────────────────────────────────────────────────────────
  describe("tenant isolation (RLS on the app role)", () => {
    it("org B's DON sees none of org A's alerts, incidents, check-ins, areas or subscriptions", async () => {
      const sos = (await call("POST", "/api/v1/safety/sos", "rn", {})).json();
      const checkIn = (
        await call("POST", "/api/v1/safety/check-ins", "rn", { kind: "ad_hoc", status: "ok" })
      ).json().checkIn;
      const incident = (
        await call("POST", "/api/v1/safety/incidents", "rn", {
          affectedClinicianMembershipId: actors.rn?.membership,
          category: "near_miss",
          severity: "minor",
          occurredAt: new Date(Date.now() - 60_000).toISOString(),
          narrative: NARRATIVE,
        })
      ).json();

      expect((await call("GET", `/api/v1/safety/sos/${sos.id}`, "donB")).statusCode).toBe(404);
      expect((await call("GET", `/api/v1/safety/check-ins/${checkIn.id}`, "donB")).statusCode).toBe(
        404,
      );
      expect(
        (await call("GET", `/api/v1/safety/incidents/${incident.id}`, "donB")).statusCode,
      ).toBe(404);
      expect(
        (
          await call(
            "POST",
            `/api/v1/safety/incidents/${incident.id}/state`,
            "donB",
            { toState: "under_review", reason: REASON },
            { "if-match": '"1"' },
          )
        ).statusCode,
      ).toBe(404);
      const board = (await call("GET", "/api/v1/safety/sos/active", "donB")).json();
      expect(board.alerts).toEqual([]);
      const incidents = (await call("GET", "/api/v1/safety/incidents", "donB")).json();
      expect(incidents.data).toEqual([]);
      const areas = (
        await call("GET", "/api/v1/safety/high-risk-areas?includeExpired=true", "donB")
      ).json();
      expect(areas.data).toEqual([]);
      const subs = (await call("GET", "/api/v1/safety/supervisor-subscriptions", "donB")).json();
      expect(subs.data).toEqual([]);

      // and the rows are untouched
      const { rows } = await admin.query(
        "SELECT lifecycle_state FROM safety_incident WHERE id=$1",
        [incident.id],
      );
      expect(rows[0].lifecycle_state).toBe("draft");
    });
  });
});
