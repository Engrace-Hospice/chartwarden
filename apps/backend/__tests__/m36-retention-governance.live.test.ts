/**
 * M36 WP 5.6 S4 (ADR-0086, PROPOSED) - retention and legal-hold governance routes, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The production composition: REAL Better Auth sessions behind the REAL authenticate hook and DB permission resolver, the REAL governance
 * routes (permission `messaging.retention.manage`, fresh step-up), M4's REAL apply/release seam (same row, same `data.legal_hold_*` audit event,
 * same outbox payload), the REAL overlay materialiser and the REAL weekly scan for the overview.
 *
 *   1. ACCESS    401 anonymous; 403 without the key (every route); 403 STEP_UP_REQUIRED without a fresh step-up (apply and release).
 *   2. VALIDATION 422 short reason / empty scope / org-wide with ids; another tenant's hold and an unknown id are the same 404.
 *   3. APPLY     201, overlay materialised in the same transaction, audited with the reason (data.legal_hold_applied), read audit lands.
 *   4. BACKSTOP  editing a held message is a typed 409 MESSAGE_UNDER_LEGAL_HOLD (not a 500) and the body is untouched; allowed after release.
 *   5. PREVIEW   eligible_on_release = past the window AND held by no other active hold.
 *   6. RELEASE   stale confirmed count => 409 RELEASE_PREVIEW_STALE (nothing changes); right count => released + audited with the reason;
 *                a second release => 409 ALREADY_RELEASED.
 *   7. OVERVIEW  periods read-only, next scan is Sunday 02:00 UTC, the last scan's counts and pending certificate; destruction_mode off
 *                (the tenant ops flag is absent), then dry_run with the flag on, then live with the deployment key too.
 *   8. NO PII    every response carries only the contract's keys: no body, no email, no patient. The only person name is the placing staff
 *                member's display name (`placed_by_name`, through the identity directory port: this tenant's members only).
 *   9. REDACTION the routes: 401 / 403 without the key, 403 STEP_UP_REQUIRED on approve, the requester cannot approve (403), a second person
 *                can, the message is then masked for the author's own read, a HELD message can be redacted (cipher kept), org B is a 404.
 *  10. CHIP      the message list carries `legalHold: true` for the officer only, never for the author.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:retention-governance:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbAuditQuery } from "@chartwarden/audit";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createSessionContextResolver,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  REDACTION_SINGLE_OFFICER_FLAG_KEY,
  RETENTION_DESTRUCTION_FLAG_KEY,
  retentionDestructionModeOf,
} from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActivePermissionHolderCounter } from "../src/bootstrap/active-permission-holders";
import { createDrizzleFeatureFlagReader } from "../src/bootstrap/feature-flag-store";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { wireModuleSeams } from "../src/index";
import { readStaffNames } from "../src/modules/02-identity/staff-names";
import { createMembershipsHoldingPermissionReader } from "../src/modules/03-authorization/permission-holders";
import { M4_OUTBOX_EVENTS } from "../src/modules/04-audit/events-by-m4";
import {
  activeLegalHolds,
  createMessagingGovernanceHoldPort,
  openMessageCertificate,
  releaseLegalHoldInTx,
  restoredCountForM4Route,
} from "../src/modules/04-audit/messaging-hold-workflow";
import { mountMessagingRoutes } from "../src/modules/36-messaging/index";
import { countHoldOverlayMessages } from "../src/modules/36-messaging/jobs/retention-hold-sql";
import { runRetentionScanForOrg } from "../src/modules/36-messaging/jobs/retention-scan";
import { appRoleConnectionString } from "./_live-app-role";
import { catalogOutbox } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_platform_login",
  "chartwarden_platform",
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "chartwarden_destruction",
  "tenant_platform_writer",
];
const ORG = "33333333-3333-4333-8333-3333000a9601";
const ORG_2 = "44444444-4444-4444-8444-4444000a9602";
const ORIGIN = "http://localhost:3000";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SUBJECT_A = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a96a1";
const SUBJECT_B = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a96a2";
const SUBJECT_C = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a96a3";
const STAFF = ["messaging.read", "messaging.send"];
const OFFICER_KEYS = [...STAFF, "messaging.retention.manage"];
const REASON = "Litigation hold per counsel, matter 2026-114";
const BASE = "/api/v1/messaging/governance";
/** The only keys a governance response may carry (the contract in packages/types/src/messaging-retention.ts). */
const ALLOWED_KEYS = new Set([
  "classes",
  "class",
  "period_years",
  "source",
  "eligible",
  "held",
  "capped",
  "certificate_id",
  "certificate_status",
  "next_scan_at",
  "last_scan_at",
  "destruction_mode",
  "placed_by_name",
  "holds",
  "id",
  "name",
  "status",
  "scope",
  "channel_ids",
  "user_ids",
  "patient_ids",
  "org_wide",
  "placed_by",
  "placed_at",
  "released_at",
  "held_messages",
  "hold_id",
  "eligible_on_release",
  "redactions",
  "message_id",
  "requested_by",
  "requested_by_name",
  "requested_at",
  "approved_by",
  "approved_by_name",
  "approved_at",
  "under_legal_hold",
  "self_approved",
  "countersign_deadline_at",
  "countersigned_by",
  "countersigned_by_name",
  "single_officer_fallback_available",
]);

interface Login {
  readonly cookie: string;
  readonly csrf: string;
}
interface Person {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

describe.skipIf(!DB_URL)("M36 WP 5.6 retention and legal-hold governance, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let auth: ReturnType<typeof createIdentityAuth>;
  let app: FastifyInstance;
  let author: Person;
  let officer: Person;
  let noStepUp: Person;
  let plain: Person;
  let outsider: Person;
  let authorLogin: Login;
  let officerLogin: Login;
  let outsiderLogin: Login;
  let chA = "";
  let chB = "";
  let chC = "";
  let chOps = "";
  let freshMsg = "";
  let holdA = "";
  let holdA2 = "";
  const seenKeys = new Set<string>();
  // The executor's mode, as the composition root derives it: the tenant ops flag (a real feature_flag row, read by the real reader), then the
  // deployment's execute key (a plain variable here).
  let executeKey = false;
  let flagReader: ReturnType<typeof createDrizzleFeatureFlagReader>;

  async function seedPerson(label: string, org: string, keys: readonly string[]): Promise<Person> {
    const email = `${label}-${randomUUID().slice(0, 8)}@wp56.test`;
    const password = `Wx9$${randomUUID()}Qz!`;
    await auth.api.signUpEmail({ body: { email, password, name: label } });
    const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
      .id as string;
    await admin.query(`UPDATE "user" SET status='active' WHERE id=$1`, [userId]);
    const membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, org],
      )
    ).rows[0].id as string;
    const roleId = (
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id",
        [org, `r_${label}_${randomUUID().slice(0, 6)}`],
      )
    ).rows[0].id as string;
    for (const key of keys) {
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,$3)",
        [org, roleId, key],
      );
    }
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
    return { userId, email, password };
  }

  async function login(person: Person, org: string, stepUp: boolean): Promise<Login> {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: ORIGIN, "user-agent": UA },
      payload: { email: person.email, password: person.password },
    });
    expect(res.statusCode).toBe(200);
    const sessionId = (
      await admin.query(
        "SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [person.userId],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [org, sessionId]);
    if (stepUp) {
      await admin.query(
        "UPDATE session SET last_step_up_at=now(), last_step_up_factor='totp' WHERE id=$1",
        [sessionId],
      );
    }
    return {
      cookie: res.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      csrf: res.cookies.find((c) => c.name === "chartwarden_csrf")?.value ?? "",
    };
  }

  const call = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    who: Login | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: {
        origin: ORIGIN,
        ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
        ...(who ? { cookie: who.cookie, "x-csrf-token": who.csrf } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  /** A governance call whose JSON body is recorded for the no-PII key check. */
  async function gov(method: "GET" | "POST", path: string, who: Login | null, payload?: unknown) {
    const res = await call(method, `${BASE}${path}`, who, payload);
    if (res.statusCode < 300) keysOf(res.json(), seenKeys);
    return res;
  }

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as T[];
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await admin.query(sql, params)).rows[0]?.n ?? 0);

  async function channel(kind: "location" | "announcement", subject: string | null) {
    return (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [
          ORG,
          kind,
          subject,
          `wp56-${randomUUID().slice(0, 8)}`,
          kind === "announcement" ? "operational" : "care_related",
        ],
      )
    ).rows[0].id as string;
  }
  async function member(ch: string, userId: string) {
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
      [ORG, ch, userId],
    );
  }
  async function oldMessage(ch: string, years: number): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind, created_at)
         VALUES ($1,$2,$3,'user','\\x01aa',repeat('0',64),'plain', now() - make_interval(years => $4::int, days => 5)) RETURNING id`,
        [ORG, ch, author.userId, years],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    process.env.MESSAGING_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'wp56a','wp56a','wp56a','active'),($2,'wp56b','wp56b','wp56b','active')",
      [ORG, ORG_2],
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    auth = createIdentityAuth(handle.db as never);
    flagReader = createDrizzleFeatureFlagReader(handle.db);
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    registerDbEffectivePermissionResolver(handle.db as never);
    const store = createDbSessionContextStore(
      handle.db as never,
      createDbActorEnrichmentReader(handle.db as never),
    );
    wireModuleSeams({ sessionContextStore: store });
    const resolver = createSessionContextResolver(store);
    app = buildServer({
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      authenticate: createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
      }),
    });
    registerIdentityAuth(app, auth, {
      credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()),
      onAuditError: (err) => {
        throw err;
      },
    });
    mountMessagingRoutes(app, handle.db as never, {
      outbox: catalogOutbox() as never,
      retentionGovernance: {
        // M4's REAL publisher over the M4 catalog: the apply/release events are catalog-validated like production.
        holds: createMessagingGovernanceHoldPort({
          outbox: {
            publish: (tx, e) =>
              buildTxOutboxPublisher(buildBootOutboxCatalog([M4_OUTBOX_EVENTS])).publish(
                tx as never,
                { ...e, callerModule: "m4" } as never,
              ),
          },
        }),
        auditQuery: createDbAuditQuery(handle.db as never),
        // The identity directory port and the executor's mode, bound as the composition root binds them.
        staffNames: readStaffNames,
        // The single-officer redaction fallback, bound as the composition root binds it: the tenant flag and M3's holder count.
        redactionFallback: {
          enabled: async (organizationId) =>
            (await flagReader.forOrg(organizationId))[REDACTION_SINGLE_OFFICER_FLAG_KEY] === true,
          eligibleApprovers: buildActivePermissionHolderCounter(
            createMembershipsHoldingPermissionReader(handle.db),
          ),
        },
        destructionMode: async (organizationId) =>
          retentionDestructionModeOf(
            (await flagReader.forOrg(organizationId))[RETENTION_DESTRUCTION_FLAG_KEY] === true,
            executeKey,
          ),
      },
    });
    await app.ready();

    author = await seedPerson("author", ORG, STAFF);
    officer = await seedPerson("officer", ORG, OFFICER_KEYS);
    noStepUp = await seedPerson("nostepup", ORG, OFFICER_KEYS);
    plain = await seedPerson("plain", ORG, STAFF);
    outsider = await seedPerson("outsider", ORG_2, OFFICER_KEYS);

    chA = await channel("location", SUBJECT_A);
    chB = await channel("location", SUBJECT_B);
    chC = await channel("location", SUBJECT_C);
    chOps = await channel("announcement", null);
    for (const ch of [chA, chB, chC]) await member(ch, author.userId);
    // chA: three past-window messages (8y, care_related 7y) plus one fresh; chB: one past-window; chC: one past-window nobody holds;
    // chOps: one past-window operational (1y) nobody holds.
    for (let i = 0; i < 3; i += 1) await oldMessage(chA, 8);
    await oldMessage(chB, 8);
    await oldMessage(chC, 8);
    await oldMessage(chOps, 2);
    authorLogin = await login(author, ORG, false);
    const posted = await call("POST", `/api/v1/messaging/channels/${chA}/messages`, authorLogin, {
      body: "routine update, nothing sensitive",
    });
    expect(posted.statusCode, posted.body).toBe(201);
    freshMsg = posted.json().messageId as string;
    officerLogin = await login(officer, ORG, true);
    outsiderLogin = await login(outsider, ORG_2, true);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await admin?.end();
  });

  it("ACCESS: anonymous 401, no key 403, no fresh step-up 403 STEP_UP_REQUIRED", async () => {
    const plainLogin = await login(plain, ORG, true);
    const staleLogin = await login(noStepUp, ORG, false);
    const id = randomUUID();
    for (const [m, p, b] of [
      ["GET", "/retention", undefined],
      ["GET", "/legal-holds", undefined],
      ["POST", "/legal-holds", { name: "x", reason: REASON, org_wide: true }],
      ["GET", `/legal-holds/${id}/release-preview`, undefined],
      ["POST", `/legal-holds/${id}/release`, { reason: REASON, confirmed_eligible_count: 0 }],
    ] as const) {
      expect((await gov(m, p, null, b)).statusCode, `${m} ${p} anonymous`).toBe(401);
      expect((await gov(m, p, plainLogin, b)).statusCode, `${m} ${p} without the key`).toBe(403);
    }
    const apply = await gov("POST", "/legal-holds", staleLogin, {
      name: "x",
      reason: REASON,
      channel_ids: [chA],
    });
    expect(apply.statusCode).toBe(403);
    expect(apply.body).toContain("STEP_UP_REQUIRED");
    const release = await gov("POST", `/legal-holds/${id}/release`, staleLogin, {
      reason: REASON,
      confirmed_eligible_count: 0,
    });
    expect(release.statusCode).toBe(403);
    expect(release.body).toContain("STEP_UP_REQUIRED");
    expect(await count("SELECT count(*)::int AS n FROM legal_hold")).toBe(0);
  });

  it("VALIDATION: a short reason, an empty scope and an org-wide hold with ids are 422; nothing is written", async () => {
    const short = await gov("POST", "/legal-holds", officerLogin, {
      name: "x",
      reason: "too short",
      channel_ids: [chA],
    });
    expect(short.statusCode).toBe(422);
    const blanks = await gov("POST", "/legal-holds", officerLogin, {
      name: "x",
      reason: "          ",
      channel_ids: [chA],
    });
    expect(blanks.statusCode).toBe(422);
    const empty = await gov("POST", "/legal-holds", officerLogin, { name: "x", reason: REASON });
    expect(empty.statusCode).toBe(422);
    const both = await gov("POST", "/legal-holds", officerLogin, {
      name: "x",
      reason: REASON,
      org_wide: true,
      channel_ids: [chA],
    });
    expect(both.statusCode).toBe(422);
    expect(await count("SELECT count(*)::int AS n FROM legal_hold")).toBe(0);
  });

  it("APPLY: audited with the reason, the overlay materialised in the same transaction, the list read audited", async () => {
    const res = await gov("POST", "/legal-holds", officerLogin, {
      name: "Smith v. Example",
      reason: REASON,
      channel_ids: [chA],
    });
    expect(res.statusCode, res.body).toBe(201);
    const dto = res.json() as { id: string; status: string; held_messages: number; scope: any };
    holdA = dto.id;
    expect(dto).toMatchObject({ status: "active", held_messages: 4 });
    expect(dto.scope).toMatchObject({ channel_ids: [chA], org_wide: false });
    expect(
      await count("SELECT count(*)::int AS n FROM legal_hold_message WHERE legal_hold_id=$1", [
        holdA,
      ]),
    ).toBe(4);
    const applied = await rows<{ context: { reason: string; matchedRecordCount: number } }>(
      "SELECT context FROM audit_event WHERE event_type='data.legal_hold_applied' AND resource_id=$1",
      [holdA],
    );
    expect(applied).toHaveLength(1);
    expect(applied[0]?.context).toMatchObject({ reason: REASON, matchedRecordCount: 4 });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m4.legal_hold.applied'",
      ),
    ).toBe(1);

    const list = await gov("GET", "/legal-holds", officerLogin);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { holds: { id: string }[] }).holds.map((h) => h.id)).toEqual([holdA]);
    expect(list.headers["cache-control"]).toBe("no-store");
    const read = await rows(
      "SELECT 1 FROM audit_event WHERE event_type='legal_hold.list_viewed' AND organization_id=$1",
      [ORG],
    );
    expect(read.length).toBeGreaterThanOrEqual(1);
  });

  it("LIST COUNT: held_messages is the materialised overlay count (one grouped query); preview keeps the exact live count", async () => {
    const lagging = await oldMessage(chA, 0); // sent after the hold: no overlay row until the next scan
    try {
      const list = await gov("GET", "/legal-holds", officerLogin);
      const entry = (list.json() as { holds: { id: string; held_messages: number }[] }).holds.find(
        (h) => h.id === holdA,
      );
      expect(entry?.held_messages).toBe(4);
      const preview = await gov("GET", `/legal-holds/${holdA}/release-preview`, officerLogin);
      expect((preview.json() as { held_messages: number }).held_messages).toBe(5);
    } finally {
      await admin.query("DELETE FROM message WHERE id=$1", [lagging]);
    }
  });

  it("BACKSTOP: editing a held message is a typed 409 (not a 500) and the body is untouched", async () => {
    const before = await rows<{ sha: string }>(
      "SELECT body_sha256 AS sha FROM message WHERE id=$1",
      [freshMsg],
    );
    const res = await call("PATCH", `/api/v1/messaging/messages/${freshMsg}`, authorLogin, {
      body: "an attempt to rewrite a held message",
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code ?? res.json().error?.code).toBe("MESSAGE_UNDER_LEGAL_HOLD");
    const after = await rows<{ sha: string }>(
      "SELECT body_sha256 AS sha FROM message WHERE id=$1",
      [freshMsg],
    );
    expect(after).toEqual(before);
  });

  it("CROSS-TENANT: another tenant's officer and an unknown id get the same 404 on preview and release", async () => {
    const unknown = randomUUID();
    const foreign = await gov("GET", `/legal-holds/${holdA}/release-preview`, outsiderLogin);
    const missing = await gov("GET", `/legal-holds/${unknown}/release-preview`, outsiderLogin);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(Object.keys(foreign.json()).sort()).toEqual(Object.keys(missing.json()).sort());
    const body = { reason: REASON, confirmed_eligible_count: 0 };
    expect(
      (await gov("POST", `/legal-holds/${holdA}/release`, outsiderLogin, body)).statusCode,
    ).toBe(404);
    expect(
      (await gov("POST", `/legal-holds/${unknown}/release`, officerLogin, body)).statusCode,
    ).toBe(404);
    const theirs = await gov("GET", "/legal-holds", outsiderLogin);
    expect((theirs.json() as { holds: unknown[] }).holds).toHaveLength(0);
    expect(
      await count("SELECT count(*)::int AS n FROM legal_hold WHERE id=$1 AND status='active'", [
        holdA,
      ]),
    ).toBe(1);
  });

  it("PREVIEW: eligible_on_release is past the window AND held by no other active hold", async () => {
    const solo = await gov("GET", `/legal-holds/${holdA}/release-preview`, officerLogin);
    expect(solo.statusCode).toBe(200);
    expect(solo.json()).toEqual({ hold_id: holdA, held_messages: 4, eligible_on_release: 3 });
    // A second hold on the same channel shields the three: releasing the first frees nothing.
    const second = await gov("POST", "/legal-holds", officerLogin, {
      name: "Regulator request",
      reason: REASON,
      channel_ids: [chA],
    });
    expect(second.statusCode, second.body).toBe(201);
    holdA2 = (second.json() as { id: string }).id;
    const shielded = await gov("GET", `/legal-holds/${holdA}/release-preview`, officerLogin);
    expect(shielded.json()).toMatchObject({ held_messages: 4, eligible_on_release: 0 });
    const read = await rows(
      "SELECT 1 FROM audit_event WHERE event_type='legal_hold.viewed' AND resource_id=$1",
      [holdA],
    );
    expect(read.length).toBeGreaterThanOrEqual(1);
    // Release the second (correct count 0): the first is back to 3.
    const rel = await gov("POST", `/legal-holds/${holdA2}/release`, officerLogin, {
      reason: REASON,
      confirmed_eligible_count: 0,
    });
    expect(rel.statusCode, rel.body).toBe(200);
    expect(
      (await gov("GET", `/legal-holds/${holdA}/release-preview`, officerLogin)).json(),
    ).toMatchObject({ eligible_on_release: 3 });
  });

  it("OVERVIEW: read-only periods, Sunday 02:00 UTC next scan, and the last scan's counts and pending certificate", async () => {
    const empty = await gov("GET", "/retention", officerLogin);
    expect(empty.statusCode).toBe(200);
    const first = empty.json() as {
      classes: { class: string; period_years: number; eligible: number | null; source: string }[];
      next_scan_at: string;
      last_scan_at: string | null;
      destruction_mode: string;
    };
    expect(first.classes.map((c) => [c.class, c.period_years])).toEqual([
      ["care_related", 7],
      ["bereavement", 7],
      ["operational", 1],
    ]);
    expect(first.classes.every((c) => c.source === "platform_default" && c.eligible === null)).toBe(
      true,
    );
    expect(first.last_scan_at).toBeNull();
    expect(first.destruction_mode).toBe("off");
    const next = new Date(first.next_scan_at);
    expect([next.getUTCDay(), next.getUTCHours(), next.getUTCMinutes()]).toEqual([0, 2, 0]);
    expect(next.getTime()).toBeGreaterThan(Date.now());

    // Hold chB too, then let the REAL scan run as the app role.
    const holdB = await gov("POST", "/legal-holds", officerLogin, {
      name: "Second matter",
      reason: REASON,
      channel_ids: [chB],
    });
    expect(holdB.statusCode, holdB.body).toBe(201);
    await runRetentionScanForOrg(
      {
        db: handle.db as never,
        messageHolds: { activeHolds: activeLegalHolds, openCertificate: openMessageCertificate },
      },
      ORG,
    );
    const after = (await gov("GET", "/retention", officerLogin)).json() as {
      last_scan_at: string | null;
      classes: {
        class: string;
        eligible: number | null;
        held: number | null;
        certificate_id: string | null;
        certificate_status: string | null;
      }[];
    };
    expect(after.last_scan_at).not.toBeNull();
    const care = after.classes.find((c) => c.class === "care_related");
    expect(care).toMatchObject({ eligible: 1, held: 4, certificate_status: "pending" });
    expect(care?.certificate_id).toMatch(/^[0-9a-f-]{36}$/);
    const ops = after.classes.find((c) => c.class === "operational");
    expect(ops).toMatchObject({ eligible: 1, held: 0 });
    expect(after.classes.find((c) => c.class === "bereavement")).toMatchObject({
      eligible: 0,
      certificate_id: null,
    });
  });

  it("RELEASE: a stale confirmed count is 409 RELEASE_PREVIEW_STALE and changes nothing; the right count releases, audited", async () => {
    const stale = await gov("POST", `/legal-holds/${holdA}/release`, officerLogin, {
      reason: REASON,
      confirmed_eligible_count: 99,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toContain("RELEASE_PREVIEW_STALE");
    expect(
      await count("SELECT count(*)::int AS n FROM legal_hold WHERE id=$1 AND status='active'", [
        holdA,
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='data.legal_hold_released' AND resource_id=$1",
        [holdA],
      ),
    ).toBe(0);

    // Two concurrent releases: one winner (200), one loser (409 ALREADY_RELEASED), exactly one audit row (asserted below).
    const releaseOnce = () =>
      gov("POST", `/legal-holds/${holdA}/release`, officerLogin, {
        reason: "Matter settled, counsel confirmed in writing",
        confirmed_eligible_count: 3,
      });
    const raced = await Promise.all([releaseOnce(), releaseOnce()]);
    expect(raced.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const ok = raced.find((r) => r.statusCode === 200) as (typeof raced)[number];
    expect(raced.find((r) => r.statusCode === 409)?.body).toContain("ALREADY_RELEASED");
    expect(ok.json()).toMatchObject({ id: holdA, status: "released", held_messages: 0 });
    const released = await rows<{ context: { reason: string; restoredRecordCount: number } }>(
      "SELECT context FROM audit_event WHERE event_type='data.legal_hold_released' AND resource_id=$1",
      [holdA],
    );
    expect(released).toHaveLength(1);
    expect(released[0]?.context.reason).toBe("Matter settled, counsel confirmed in writing");
    expect(
      await count(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m4.legal_hold.released'",
      ),
    ).toBeGreaterThanOrEqual(1);

    const again = await gov("POST", `/legal-holds/${holdA}/release`, officerLogin, {
      reason: REASON,
      confirmed_eligible_count: 3,
    });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain("ALREADY_RELEASED");
    const short = await gov("POST", `/legal-holds/${holdA}/release`, officerLogin, {
      reason: "nope",
      confirmed_eligible_count: 3,
    });
    expect(short.statusCode).toBe(422);
    // Ten blanks pass the schema's minLength; only the service's trim check refuses them.
    const blanks = await gov("POST", `/legal-holds/${holdA}/release`, officerLogin, {
      reason: "          ",
      confirmed_eligible_count: 3,
    });
    expect(blanks.statusCode, blanks.body).toBe(422);
  });

  it("RELEASE RACE (deterministic): two transactions that both read the hold as active release it once - one winner, one audit row, a 409 for the loser", async () => {
    const raceHold = (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason)
         VALUES ($1,'race','{"channelIds":[],"origin":"messaging_governance"}'::jsonb,'litigation hold race') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((resolve) => {
      open = resolve;
    });
    // countRestored runs after the active read and before the UPDATE: hold both transactions there, then let them race the UPDATE.
    const release = (tag: string) =>
      withOrgContext<DbClient, unknown>(
        handle.db as never,
        { organizationId: ORG, userId: author.userId },
        (tx) =>
          releaseLegalHoldInTx(
            tx,
            {},
            { organizationId: ORG, userId: author.userId, correlationId: `race-${tag}` },
            {
              organizationId: ORG,
              holdId: raceHold,
              reason: "race release",
              countRestored: async () => {
                arrived += 1;
                if (arrived === 2) open();
                await both;
                return 0;
              },
            },
          ),
      );
    const settled = await Promise.allSettled([release("a"), release("b")]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "ALREADY_RELEASED", statusCode: 409 });
    expect(
      await count(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='data.legal_hold_released' AND resource_id=$1",
        [raceHold],
      ),
    ).toBe(1);
  });

  it("M4 RELEASE of a governance-origin hold reports the messages it covered (overlay count), not an audit-event count", async () => {
    const govHold = (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason)
         VALUES ($1,'m4-release-count','{"channelIds":[],"origin":"messaging_governance"}'::jsonb,'m4 route releases a governance hold') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3)`,
      [ORG, govHold, freshMsg],
    );
    const out = await withOrgContext<DbClient, { restoredRecordCount: number }>(
      handle.db as never,
      { organizationId: ORG, userId: author.userId },
      (tx) =>
        releaseLegalHoldInTx(
          tx,
          {},
          { organizationId: ORG, userId: author.userId, correlationId: "m4-release-count" },
          {
            organizationId: ORG,
            holdId: govHold,
            reason: "released through M4's route",
            // The M4 route's audit-event counter would answer 777 here; the overlay count must win.
            countRestored: (criteria) =>
              restoredCountForM4Route(
                tx,
                ORG,
                govHold,
                criteria,
                async () => 777,
                countHoldOverlayMessages,
              ),
          },
        ),
    );
    expect(out.restoredRecordCount).toBe(1);
    // An M4-placed hold still takes the route's own audit-event count.
    const m4Held = (
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason)
         VALUES ($1,'m4-own','{"channelIds":[]}'::jsonb,'m4 own hold') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    const own = await withOrgContext<DbClient, { restoredRecordCount: number }>(
      handle.db as never,
      { organizationId: ORG, userId: author.userId },
      (tx) =>
        releaseLegalHoldInTx(
          tx,
          {},
          { organizationId: ORG, userId: author.userId, correlationId: "m4-own-release" },
          {
            organizationId: ORG,
            holdId: m4Held,
            reason: "released through M4's route",
            countRestored: (criteria) =>
              restoredCountForM4Route(
                tx,
                ORG,
                m4Held,
                criteria,
                async () => 777,
                countHoldOverlayMessages,
              ),
          },
        ),
    );
    expect(own.restoredRecordCount).toBe(777);
  });

  it("BACKSTOP lifts with the hold: the same edit succeeds once the only covering hold is released", async () => {
    const res = await call("PATCH", `/api/v1/messaging/messages/${freshMsg}`, authorLogin, {
      body: "a correction after the hold was released",
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("ORIGIN: holds placed through M4 (legalhold.manage) are invisible to and unreleasable by messaging.retention.manage; the scan still honours them", async () => {
    // M4's POST /legal-holds writes exactly this row (no `origin`): inserted as the owner so the suite needs no legalhold.* grants.
    const m4Hold = async (name: string, criteria: object) =>
      (
        await rows<{ id: string }>(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
           VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id`,
          [ORG, name, JSON.stringify(criteria), REASON, officer.userId],
        )
      )[0]?.id as string;
    const careEligible = async () => {
      const o = (await gov("GET", "/retention", officerLogin)).json() as {
        classes: { class: string; eligible: number | null; held: number | null }[];
      };
      return o.classes.find((c) => c.class === "care_related");
    };
    const scan = () =>
      runRetentionScanForOrg(
        {
          db: handle.db as never,
          messageHolds: { activeHolds: activeLegalHolds, openCertificate: openMessageCertificate },
        },
        ORG,
      );
    await scan();
    const before = await careEligible();

    const patientHold = await m4Hold("M4 patient hold", { patientIds: [SUBJECT_A] });
    const channelHold = await m4Hold("M4 channel hold", { channelIds: [chC] });

    const list = (await gov("GET", "/legal-holds", officerLogin)).json() as {
      holds: { id: string }[];
    };
    expect(list.holds.map((h) => h.id)).not.toContain(patientHold);
    expect(list.holds.map((h) => h.id)).not.toContain(channelHold);
    for (const id of [patientHold, channelHold]) {
      const preview = await gov("GET", `/legal-holds/${id}/release-preview`, officerLogin);
      expect(preview.statusCode, preview.body).toBe(404);
      const release = await gov("POST", `/legal-holds/${id}/release`, officerLogin, {
        reason: REASON,
        confirmed_eligible_count: 0,
      });
      expect(release.statusCode, release.body).toBe(404);
      expect(
        await count("SELECT count(*)::int AS n FROM legal_hold WHERE id=$1 AND status='active'", [
          id,
        ]),
      ).toBe(1);
    }

    // Enforcement is unchanged: the scan honours ALL active holds, so chC's past-window message is withheld.
    await scan();
    const after = await careEligible();
    expect(after?.eligible).toBe((before?.eligible ?? 0) - 1);
    expect(after?.held).toBe((before?.held ?? 0) + 1);

    // A hold placed through the governance route still lists, previews and releases as before, with the marker stamped.
    const placed = await gov("POST", "/legal-holds", officerLogin, {
      name: "Governance-placed",
      reason: REASON,
      channel_ids: [chOps],
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const placedId = (placed.json() as { id: string }).id;
    expect(
      await count(
        "SELECT count(*)::int AS n FROM legal_hold WHERE id=$1 AND criteria->>'origin'='messaging_governance'",
        [placedId],
      ),
    ).toBe(1);
    const listed = (await gov("GET", "/legal-holds", officerLogin)).json() as {
      holds: { id: string }[];
    };
    expect(listed.holds.map((h) => h.id)).toContain(placedId);
    const preview = await gov("GET", `/legal-holds/${placedId}/release-preview`, officerLogin);
    expect(preview.statusCode, preview.body).toBe(200);
    const released = await gov("POST", `/legal-holds/${placedId}/release`, officerLogin, {
      reason: REASON,
      confirmed_eligible_count: (preview.json() as { eligible_on_release: number })
        .eligible_on_release,
    });
    expect(released.statusCode, released.body).toBe(200);
  });

  it("NAMES: the list names the placing staff member (this tenant's directory), the other tenant's officer sees no hold, an unknown name stays null", async () => {
    const list = (await gov("GET", "/legal-holds", officerLogin)).json() as {
      holds: { placed_by: string; placed_by_name: string | null }[];
    };
    // Holds seeded straight into the table by other tests have no placing user (placed_by is empty); every route-placed one names the officer.
    const placed = list.holds.filter((h) => h.placed_by !== "");
    expect(placed.length).toBeGreaterThan(0);
    for (const h of placed) {
      expect(h.placed_by).toBe(officer.userId);
      expect(h.placed_by_name).toBe("officer");
    }
    // A hold whose placing user has no membership in this organisation resolves no name (never another tenant's directory).
    const stranger = await seedPerson("stranger", ORG_2, STAFF);
    await admin.query(
      `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by)
       VALUES ($1,'placed by a stranger',$2::jsonb,'placed by a user outside this organisation',$3)`,
      [
        ORG,
        JSON.stringify({ origin: "messaging_governance", channelIds: [chOps] }),
        stranger.userId,
      ],
    );
    const again = (await gov("GET", "/legal-holds", officerLogin)).json() as {
      holds: { name: string; placed_by: string; placed_by_name: string | null }[];
    };
    const strangerHold = again.holds.find((h) => h.name === "placed by a stranger");
    expect(strangerHold).toMatchObject({ placed_by: stranger.userId, placed_by_name: null });
    await admin.query("DELETE FROM legal_hold WHERE name='placed by a stranger'");
    expect((await gov("GET", "/legal-holds", outsiderLogin)).json()).toEqual({ holds: [] });
  });

  it("MODE: destruction_mode is off without the tenant flag, dry_run with it, live only with the deployment key too; another tenant's flag does not leak", async () => {
    const mode = async () =>
      ((await gov("GET", "/retention", officerLogin)).json() as { destruction_mode: string })
        .destruction_mode;
    expect(await mode()).toBe("off");
    executeKey = true;
    expect(await mode()).toBe("off"); // the deployment key alone does nothing
    executeKey = false;
    await admin.query(
      `INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,'messaging.retention_destruction','bool','true'::jsonb)`,
      [ORG_2],
    );
    expect(await mode()).toBe("off"); // org 2's flag is org 2's
    await admin.query(
      "UPDATE feature_flag SET organization_id=$1 WHERE flag_key='messaging.retention_destruction'",
      [ORG],
    );
    expect(await mode()).toBe("dry_run");
    executeKey = true;
    expect(await mode()).toBe("live");
    executeKey = false;
    await admin.query("DELETE FROM feature_flag WHERE flag_key='messaging.retention_destruction'");
    expect(await mode()).toBe("off");
  });

  it("REDACTION + CHIP: keys and a fresh step-up gate it; the requester cannot approve; a second person can; the message is then masked on read; a HELD message keeps its cipher; the chip is the officer's only", async () => {
    const redactKeys = [...STAFF, "messaging.redact.request", "messaging.redact.approve"];
    const r1 = await seedPerson("redactor1", ORG, redactKeys);
    const r2 = await seedPerson("redactor2", ORG, redactKeys);
    const r3 = await seedPerson("redactor3", ORG, redactKeys);
    const r4 = await seedPerson("redactor4", ORG_2, redactKeys);
    const r1Login = await login(r1, ORG, true);
    const r2Login = await login(r2, ORG, true);
    const staleLogin = await login(r3, ORG, false);
    const outsiderRedactorLogin = await login(r4, ORG_2, true);
    const plainLogin = await login(plain, ORG, true);
    // A channel of its own: the seeded channels carry fake ciphertext that could never be opened for a read.
    const chR = await channel("location", "aaaaaaaa-aaaa-4aaa-8aaa-0000000a96a4");
    await member(chR, author.userId);
    await member(chR, officer.userId);

    const sent = await call("POST", `/api/v1/messaging/channels/${chR}/messages`, authorLogin, {
      body: "sensitive detail that must be masked",
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const messageId = sent.json().messageId as string;
    const hold = await gov("POST", "/legal-holds", officerLogin, {
      name: "Redaction under hold",
      reason: REASON,
      channel_ids: [chR],
    });
    expect(hold.statusCode, hold.body).toBe(201);
    const holdId = (hold.json() as { id: string }).id;
    const cipherOf = async () =>
      (
        await rows<{ c: string; h: string }>(
          "SELECT encode(body_cipher,'hex') c, body_sha256 h FROM message WHERE id=$1",
          [messageId],
        )
      )[0];
    const before = await cipherOf();
    const readAs = async (who: Login) => {
      const res = await call("GET", `/api/v1/messaging/channels/${chR}/messages`, who);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as {
        messages: { messageId: string; body: string; redactedAt?: string; legalHold?: boolean }[];
      };
    };

    // ACCESS
    expect(
      (await gov("POST", "/redactions", null, { message_id: messageId, reason: REASON }))
        .statusCode,
    ).toBe(401);
    expect(
      (await gov("POST", "/redactions", plainLogin, { message_id: messageId, reason: REASON }))
        .statusCode,
    ).toBe(403);
    expect((await gov("GET", "/redactions", plainLogin)).statusCode).toBe(403);
    expect(
      (await gov("POST", "/redactions", r1Login, { message_id: messageId, reason: "short" }))
        .statusCode,
    ).toBe(422);

    // REQUEST: masks nothing yet
    const requested = await gov("POST", "/redactions", r1Login, {
      message_id: messageId,
      reason: REASON,
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const dto = requested.json() as {
      id: string;
      status: string;
      requested_by_name: string;
      under_legal_hold: boolean;
    };
    expect(dto).toMatchObject({
      status: "requested",
      requested_by_name: "redactor1",
      under_legal_hold: true,
    });
    expect(
      (await gov("POST", "/redactions", r2Login, { message_id: messageId, reason: REASON }))
        .statusCode,
    ).toBe(409);
    expect((await readAs(authorLogin)).messages.find((m) => m.messageId === messageId)?.body).toBe(
      "sensitive detail that must be masked",
    );

    // APPROVE: not the requester, not without a fresh step-up
    const selfApprove = await gov("POST", `/redactions/${dto.id}/approve`, r1Login);
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.body).toContain("REDACTION_SELF_APPROVAL");
    const stale = await gov("POST", `/redactions/${dto.id}/approve`, staleLogin);
    expect(stale.statusCode).toBe(403);
    expect(stale.body).toContain("STEP_UP_REQUIRED");
    expect((await gov("POST", `/redactions/${dto.id}/approve`, plainLogin)).statusCode).toBe(403);
    const approved = await gov("POST", `/redactions/${dto.id}/approve`, r2Login);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      approved_by_name: "redactor2",
      under_legal_hold: true,
    });
    expect((await gov("POST", `/redactions/${dto.id}/approve`, r2Login)).statusCode).toBe(409);

    // MASKED on read for the author; the held message's cipher and hash are untouched; edits are refused
    const masked = (await readAs(authorLogin)).messages.find((m) => m.messageId === messageId);
    expect(masked?.body).toBe("");
    expect(masked?.redactedAt).toBeTruthy();
    expect(masked?.legalHold).toBeUndefined(); // an ordinary reader never learns of the hold
    expect(await cipherOf()).toEqual(before);
    expect(
      (
        await call("PATCH", `/api/v1/messaging/messages/${messageId}`, authorLogin, {
          body: "rewritten",
        })
      ).statusCode,
    ).toBe(409);

    // CHIP: the officer (messaging.retention.manage) sees the flag on the held message
    const officerView = (await readAs(officerLogin)).messages.find(
      (m) => m.messageId === messageId,
    );
    expect(officerView?.legalHold).toBe(true);
    expect(officerView?.redactedAt).toBeTruthy();

    // LIST: either key reads it; another tenant sees none of it and cannot redact this message
    const listed = (await gov("GET", "/redactions", r1Login)).json() as {
      redactions: { id: string }[];
    };
    expect(listed.redactions.map((r) => r.id)).toContain(dto.id);
    expect((await gov("GET", "/redactions", outsiderRedactorLogin)).json()).toEqual({
      redactions: [],
      single_officer_fallback_available: false,
    });
    expect(
      (
        await gov("POST", "/redactions", outsiderRedactorLogin, {
          message_id: messageId,
          reason: REASON,
        })
      ).statusCode,
    ).toBe(404);

    // Release the hold so the rest of the suite is unaffected; the chip goes with it.
    const preview = (
      await gov("GET", `/legal-holds/${holdId}/release-preview`, officerLogin)
    ).json() as {
      eligible_on_release: number;
    };
    const released = await gov("POST", `/legal-holds/${holdId}/release`, officerLogin, {
      reason: REASON,
      confirmed_eligible_count: preview.eligible_on_release,
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(
      (await readAs(officerLogin)).messages.find((m) => m.messageId === messageId)?.legalHold,
    ).toBeUndefined();
  });

  describe("single-officer redaction fallback (ADR-0055 D9, migration 1165, PROVISIONAL)", () => {
    // A tenant of its own with exactly ONE person who can approve: the fallback is about THAT tenant, and ORG already has three approvers.
    const ORG_3 = "55555555-5555-4555-8555-5555000a9603";
    const FLAG = "messaging.redaction_single_officer_fallback";
    let sole: Person;
    let soleLogin: Login;
    let soleStale: Login;
    let second: Person;
    let secondLogin: Login;
    let counter: Person;
    let counterLogin: Login;
    let counterStale: Login;
    let ch3 = "";

    const setFlag = async (on: boolean) => {
      await admin.query("DELETE FROM feature_flag WHERE organization_id=$1 AND flag_key=$2", [
        ORG_3,
        FLAG,
      ]);
      if (on) {
        await admin.query(
          "INSERT INTO feature_flag (organization_id,flag_key,value_type,value) VALUES ($1,$2,'bool','true'::jsonb)",
          [ORG_3, FLAG],
        );
      }
    };
    /** A message in ORG_3 and the sole officer's open request on it. Redaction never reads a body, so the cipher is a placeholder. */
    const requestOne = async (): Promise<{ messageId: string; id: string }> => {
      const messageId = (
        await admin.query(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, body_kind)
           VALUES ($1,$2,$3,'user','\\x01aa',repeat('0',64),'plain') RETURNING id`,
          [ORG_3, ch3, sole.userId],
        )
      ).rows[0].id as string;
      const res = await gov("POST", "/redactions", soleLogin, {
        message_id: messageId,
        reason: REASON,
      });
      expect(res.statusCode, res.body).toBe(201);
      return { messageId, id: (res.json() as { id: string }).id };
    };
    const stateOf = async (id: string) =>
      (
        await rows<{
          approved: boolean;
          selfApproved: boolean;
          countersigned: boolean;
          hours: number | null;
        }>(
          `SELECT approved_at IS NOT NULL approved, self_approved_at IS NOT NULL "selfApproved", countersigned_by IS NOT NULL countersigned,
                  extract(epoch FROM (countersign_deadline_at - self_approved_at))/3600 hours
             FROM message_redaction WHERE id=$1`,
          [id],
        )
      )[0];
    const auditCount = (eventType: string, resourceId: string) =>
      count(
        "SELECT count(*) n FROM audit_event WHERE event_type=$1 AND resource_id=$2 AND organization_id=$3",
        [eventType, resourceId, ORG_3],
      );

    beforeAll(async () => {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'wp56c','wp56c','wp56c','active')",
        [ORG_3],
      );
      const keys = [...STAFF, "messaging.redact.request", "messaging.redact.approve"];
      // The sole officer ALSO holds the countersign key, so the "never the requester" rule is proved at the service and the database, not by a missing key.
      sole = await seedPerson("sole-officer", ORG_3, [...keys, "messaging.redact.countersign"]);
      second = await seedPerson("second-officer", ORG_3, keys);
      counter = await seedPerson("counter-signer", ORG_3, ["messaging.redact.countersign"]);
      // The second officer is on the books but starts DISABLED, so the tenant has exactly one eligible approver.
      await admin.query(
        `UPDATE membership SET status='suspended' WHERE user_id=$1 AND organization_id=$2`,
        [second.userId, ORG_3],
      );
      soleLogin = await login(sole, ORG_3, true);
      soleStale = await login(sole, ORG_3, false);
      secondLogin = await login(second, ORG_3, true);
      counterLogin = await login(counter, ORG_3, true);
      counterStale = await login(counter, ORG_3, false);
      ch3 = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'location','aaaaaaaa-aaaa-4aaa-8aaa-0000000a96b1','wp56-c','care_related') RETURNING id`,
          [ORG_3],
        )
      ).rows[0].id as string;
    });

    it("OFF by default: with the tenant setting off, self-approval is refused and the list says it is unavailable", async () => {
      await setFlag(false);
      const { id } = await requestOne();
      const res = await gov("POST", `/redactions/${id}/self-approve`, soleLogin);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("REDACTION_FALLBACK_UNAVAILABLE");
      expect((await stateOf(id))?.selfApproved).toBe(false);
      const list = (await gov("GET", "/redactions", soleLogin)).json() as {
        single_officer_fallback_available: boolean;
      };
      expect(list.single_officer_fallback_available).toBe(false);
      // the plain route still refuses the requester
      expect((await gov("POST", `/redactions/${id}/approve`, soleLogin)).body).toContain(
        "REDACTION_SELF_APPROVAL",
      );
    });

    it("a tenant with TWO eligible officers never gets the fallback, even with the setting on", async () => {
      await setFlag(true);
      await admin.query(
        `UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2`,
        [second.userId, ORG_3],
      );
      const { id } = await requestOne();
      const res = await gov("POST", `/redactions/${id}/self-approve`, soleLogin);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain("REDACTION_FALLBACK_UNAVAILABLE");
      expect(
        (
          (await gov("GET", "/redactions", soleLogin)).json() as {
            single_officer_fallback_available: boolean;
          }
        ).single_officer_fallback_available,
      ).toBe(false);
      await admin.query(
        `UPDATE membership SET status='suspended' WHERE user_id=$1 AND organization_id=$2`,
        [second.userId, ORG_3],
      );
    });

    it("ON with exactly one officer: needs its OWN fresh step-up, masks nothing, starts a 72 h period, is audited beyond the row trigger; only the requester can do it", async () => {
      await setFlag(true);
      const { id, messageId } = await requestOne();
      expect(
        (
          (await gov("GET", "/redactions", soleLogin)).json() as {
            single_officer_fallback_available: boolean;
          }
        ).single_officer_fallback_available,
      ).toBe(true);
      expect((await gov("POST", `/redactions/${id}/self-approve`, null)).statusCode).toBe(401);
      const stale = await gov("POST", `/redactions/${id}/self-approve`, soleStale);
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain("STEP_UP_REQUIRED");
      expect((await gov("POST", `/redactions/${id}/self-approve`, counterLogin)).statusCode).toBe(
        403,
      ); // no approve key
      const ok = await gov("POST", `/redactions/${id}/self-approve`, soleLogin);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({
        status: "awaiting_countersign",
        self_approved: true,
        approved_at: null,
        approved_by: null,
        countersigned_by: null,
      });
      expect(Math.round((await stateOf(id))?.hours ?? 0)).toBe(72);
      expect(await auditCount("m36.redaction.self_approved", id)).toBe(1);
      // not final: nothing masks it (the reader keys on approved_at), and it is out of search / uneditable like any request
      expect((await stateOf(id))?.approved).toBe(false);
      expect(
        await count(
          "SELECT count(*) n FROM message_redaction WHERE message_id=$1 AND approved_at IS NOT NULL",
          [messageId],
        ),
      ).toBe(0);
      // a second self-approval is 409
      expect((await gov("POST", `/redactions/${id}/self-approve`, soleLogin)).statusCode).toBe(409);
      // only the requester: another officer using the self route is refused (they use the ordinary approve)
      const stranger = await gov("POST", `/redactions/${id}/self-approve`, secondLogin);
      expect([401, 403, 409]).toContain(stranger.statusCode);
    });

    it("COUNTERSIGN: a second role with its own permission and fresh step-up makes it final; never the requester; once", async () => {
      await setFlag(true);
      const { id } = await requestOne();
      expect((await gov("POST", `/redactions/${id}/self-approve`, soleLogin)).statusCode).toBe(200);
      expect((await gov("POST", `/redactions/${id}/countersign`, null)).statusCode).toBe(401);
      const own = await gov("POST", `/redactions/${id}/countersign`, soleLogin);
      expect(own.statusCode).toBe(403);
      expect(own.body).toContain("REDACTION_COUNTERSIGN_SELF");
      expect((await stateOf(id))?.approved).toBe(false);
      const stale = await gov("POST", `/redactions/${id}/countersign`, counterStale);
      expect(stale.statusCode).toBe(403);
      expect(stale.body).toContain("STEP_UP_REQUIRED");
      expect(await auditCount("m36.redaction.countersigned", id)).toBe(0);
      const done = await gov("POST", `/redactions/${id}/countersign`, counterLogin);
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({
        status: "approved",
        self_approved: true,
        approved_by_name: "sole-officer",
        countersigned_by_name: "counter-signer",
      });
      expect(await stateOf(id)).toMatchObject({
        approved: true,
        selfApproved: true,
        countersigned: true,
      });
      expect(await auditCount("m36.redaction.countersigned", id)).toBe(1);
      expect((await gov("POST", `/redactions/${id}/countersign`, counterLogin)).statusCode).toBe(
        409,
      );
    });

    it("COUNTERSIGN is refused once the fallback is closed: the setting turned off (or a second officer added) between self-approval and countersign leaves the row non-final", async () => {
      await setFlag(true);
      const { id } = await requestOne();
      expect((await gov("POST", `/redactions/${id}/self-approve`, soleLogin)).statusCode).toBe(200);
      await setFlag(false);
      const off = await gov("POST", `/redactions/${id}/countersign`, counterLogin);
      expect(off.statusCode).toBe(403);
      expect(off.body).toContain("REDACTION_FALLBACK_UNAVAILABLE");
      expect(await stateOf(id)).toMatchObject({ approved: false, countersigned: false });
      expect(await auditCount("m36.redaction.countersigned", id)).toBe(0);
      // a second eligible officer closes it too
      await setFlag(true);
      await admin.query(
        `UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2`,
        [second.userId, ORG_3],
      );
      const two = await gov("POST", `/redactions/${id}/countersign`, counterLogin);
      expect(two.statusCode).toBe(403);
      expect(two.body).toContain("REDACTION_FALLBACK_UNAVAILABLE");
      expect((await stateOf(id))?.approved).toBe(false);
      await admin.query(
        `UPDATE membership SET status='suspended' WHERE user_id=$1 AND organization_id=$2`,
        [second.userId, ORG_3],
      );
      // reopened: the same row can be countersigned
      const done = await gov("POST", `/redactions/${id}/countersign`, counterLogin);
      expect(done.statusCode, done.body).toBe(200);
      expect((await stateOf(id))?.approved).toBe(true);
    });

    it("COUNTERSIGN by the requester is refused by the database too (CHECK and guard), even if a caller bypassed the service", async () => {
      await setFlag(true);
      const { id } = await requestOne();
      expect((await gov("POST", `/redactions/${id}/self-approve`, soleLogin)).statusCode).toBe(200);
      await expect(
        withOrgContext<DbClient, unknown>(
          handle.db,
          { organizationId: ORG_3, userId: sole.userId },
          (tx) =>
            tx.execute(
              sql`UPDATE message_redaction SET countersigned_by = ${sole.userId}::uuid, approved_by = ${sole.userId}::uuid WHERE id = ${id}::uuid`,
            ),
        ),
      ).rejects.toThrow();
      expect((await stateOf(id))?.approved).toBe(false);
    });

    it("LAPSED: after 72 h the countersign is refused and it stays non-final; a DIFFERENT officer can still approve it the ordinary way", async () => {
      await setFlag(true);
      const { id } = await requestOne();
      expect((await gov("POST", `/redactions/${id}/self-approve`, soleLogin)).statusCode).toBe(200);
      // Age the self-approval (the guard forbids touching these columns, so the test switches it off for this one statement).
      await admin.query(
        "ALTER TABLE message_redaction DISABLE TRIGGER trg_message_redaction_guard",
      );
      await admin.query(
        "UPDATE message_redaction SET self_approved_at = now() - interval '80 hours', countersign_deadline_at = now() - interval '8 hours' WHERE id=$1",
        [id],
      );
      await admin.query("ALTER TABLE message_redaction ENABLE TRIGGER trg_message_redaction_guard");
      const late = await gov("POST", `/redactions/${id}/countersign`, counterLogin);
      expect(late.statusCode).toBe(409);
      expect(late.body).toContain("REDACTION_COUNTERSIGN_LAPSED");
      expect((await stateOf(id))?.approved).toBe(false);
      const listed = (await gov("GET", "/redactions", soleLogin)).json() as {
        redactions: { id: string; status: string }[];
      };
      expect(listed.redactions.find((r) => r.id === id)?.status).toBe("lapsed");
      // the database enforces the deadline itself (its own clock), not just the service
      await expect(
        withOrgContext<DbClient, unknown>(
          handle.db,
          { organizationId: ORG_3, userId: counter.userId },
          (tx) =>
            tx.execute(
              sql`UPDATE message_redaction SET countersigned_by = ${counter.userId}::uuid, approved_by = ${sole.userId}::uuid WHERE id = ${id}::uuid`,
            ),
        ),
      ).rejects.toThrow();
      // a second, different officer is an ordinary two-person approval
      const lateOfficer = await seedPerson("late-officer", ORG_3, [
        ...STAFF,
        "messaging.redact.request",
        "messaging.redact.approve",
      ]);
      const ordinary = await gov(
        "POST",
        `/redactions/${id}/approve`,
        await login(lateOfficer, ORG_3, true),
      );
      expect(ordinary.statusCode, ordinary.body).toBe(200);
      expect(ordinary.json()).toMatchObject({
        status: "approved",
        approved_by_name: "late-officer",
      });
      expect(await stateOf(id)).toMatchObject({
        approved: true,
        selfApproved: true,
        countersigned: false,
      });
    });

    it("CROSS-TENANT (IDOR): another organisation's officer and countersigner get the random-id 404 on both new routes and change nothing", async () => {
      await setFlag(true);
      const { id } = await requestOne();
      const before = await stateOf(id);
      const foreignOfficer = await seedPerson("foreign-officer", ORG_2, [
        ...STAFF,
        "messaging.redact.approve",
        "messaging.redact.countersign",
      ]);
      const foreign = await login(foreignOfficer, ORG_2, true);
      const random = randomUUID();
      for (const route of ["self-approve", "countersign"] as const) {
        const real = await gov("POST", `/redactions/${id}/${route}`, foreign);
        const fake = await gov("POST", `/redactions/${random}/${route}`, foreign);
        expect(real.statusCode, route).toBe(404);
        expect(real.statusCode).toBe(fake.statusCode);
        expect(Object.keys(real.json()).sort()).toEqual(Object.keys(fake.json()).sort());
      }
      expect(await stateOf(id)).toEqual(before);
    });
  });

  it("NO PII: every response carried only contract keys (no body, no name, no email)", () => {
    const stray = [...seenKeys].filter((k) => !ALLOWED_KEYS.has(k));
    expect(stray).toEqual([]);
    for (const banned of [
      "body",
      "body_cipher",
      "display_name",
      "email",
      "first_name",
      "last_name",
      "patient_name",
    ]) {
      expect(seenKeys.has(banned), banned).toBe(false);
    }
  });
});
