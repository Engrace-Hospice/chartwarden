/**
 * M36 transactional email provider (Postmark adapter), end to end, LIVE Postgres, as the RLS-enforced `wardenx_app`.
 *
 * The REAL composition (`bindTransactionalEmail`, the same function `index.ts` boots with) binds the REAL Postmark
 * adapter to a LOCAL FAKE HTTP SERVER standing in for api.postmarkapp.com (no network). What it proves:
 *   - a REAL Better Auth magic-link sign-in request reaches the provider (POST /email, server-token header, PHI-free
 *     body, link in the text), and following the delivered link establishes a session;
 *   - the funeral-home invite route, with the REAL link delivery over the bound adapter, mints a link, emails it
 *     (token only in the URL FRAGMENT), and the emailed token redeems exactly once;
 *   - a transient provider 503 is retried and still delivers exactly one usable link; a permanent 4xx revokes the
 *     link and answers 503 LINK_DELIVERY_FAILED (nothing live and unreachable);
 *   - UNBOUND in production (no credentials): the invite route answers 503 LINK_DELIVERY_UNAVAILABLE and mints and
 *     sends nothing, the auditor delivery throws, and the boot line names every missing variable;
 *   - no log line (boot notice or adapter) ever contains the server token, the recipient, or the link token.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m36:transactional-email:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  createSessionContextResolver,
  getIdentitySession,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerIdentityAuth,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { createAuditorLinkEmailDelivery } from "../src/modules/02-identity/auditor-link-delivery";
import {
  type IdentityRouteDeps,
  createContextActorResolver,
  createInMemoryAuditExecutor,
  createInMemoryCollaboratorLinkStore,
  createInMemoryInvitationStore,
  createInMemoryMembershipRepository,
  createInMemorySessionWriter,
  createInMemoryUserDirectory,
  registerIdentityRoutes,
} from "../src/modules/02-identity/index";
import { createLinkDelivery } from "../src/modules/02-identity/link-delivery";
import { bindTransactionalEmail } from "../src/modules/36-messaging/transactional-email-binding";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_platform_login",
  "wardenx_platform",
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "tenant_platform_writer",
];
const ORIGIN = "http://localhost:3000";
const SERVER_TOKEN = "pm-live-SERVER-TOKEN-0123456789abcdef";
const FROM = "no-reply@mail.wardenx.health";
const DECEASED = "11111111-1111-4111-8111-111111111111";

interface Received {
  readonly headers: IncomingMessage["headers"];
  readonly body: {
    From: string;
    To: string;
    Subject: string;
    TextBody: string;
    MessageStream: string;
    TrackLinks: string;
  };
}

/** A minimal Postmark: records every POST /email, answers from a per-test script (default 200 + MessageID). */
function startFakePostmark() {
  const received: Received[] = [];
  const script: Array<{ status: number; body?: object }> = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/email") {
        res.writeHead(404).end();
        return;
      }
      received.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      const next = script.shift() ?? { status: 200 };
      const body =
        next.status === 200
          ? { ErrorCode: 0, Message: "OK", MessageID: `fake-${received.length}` }
          : (next.body ?? { ErrorCode: 1, Message: "scripted failure" });
      res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
  });
  return {
    received,
    script,
    server,
    async listen(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!DB_URL)("M36 transactional email provider, LIVE Postgres + fake Postmark", () => {
  const fake = startFakePostmark();
  const logs: string[] = [];
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let authApp: FastifyInstance;
  let baseUrl: string;
  let boundBinding: ReturnType<typeof bindTransactionalEmail>;

  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    request.context.attributes.sessionId = "sess";
    request.context.attributes.membershipId = `m_${user}`;
    request.context.organizationId = "org_a";
    request.context.roles = [];
  }

  function inviteServer(binding: ReturnType<typeof bindTransactionalEmail>) {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: "org_a",
          userId: "rn_1",
          grants: [
            { roleKey: "rn", enabled: true, expiresAt: null, permissionKeys: ["funeral.invite"] },
          ],
        },
      ]).store,
    );
    registerAbacRegistry(createPredicateRegistry({ caseload_membership: () => true }));
    const memberships = createInMemoryMembershipRepository([]);
    const collaborators = createInMemoryCollaboratorLinkStore();
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    const deps: IdentityRouteDeps = {
      actors: createContextActorResolver(),
      memberships: memberships.repo,
      sessions: createInMemorySessionWriter().writer,
      invitations: createInMemoryInvitationStore().store,
      collaborators: collaborators.store,
      users: createInMemoryUserDirectory(memberships.repo).directory,
      audit: createInMemoryAuditExecutor().executor,
      outbox: { async publish() {} },
      deceasedPatients: { isDeceased: async (_org, id) => id === DECEASED },
      // The exact gate index.ts applies: delivery port only when the binding says it is available.
      ...(binding.linkDeliveryAvailable
        ? {
            linkDelivery: createLinkDelivery({
              transport: binding.linkEmailTransport,
              baseUrl: "https://portal.wardenx.test",
            }),
          }
        : {}),
      linkRecipientRequired: true,
    };
    registerIdentityRoutes(app, deps);
    return { app, collaborators };
  }

  const invite = (app: FastifyInstance, recipientEmail: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/funeral/invite",
      headers: { "x-test-user": "rn_1" },
      payload: { patientId: DECEASED, recipientEmail },
    });

  beforeAll(async () => {
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
    baseUrl = await fake.listen();
    boundBinding = bindTransactionalEmail({
      env: {
        NODE_ENV: "test",
        POSTMARK_SERVER_TOKEN: SERVER_TOKEN,
        POSTMARK_FROM_ADDRESS: FROM,
        POSTMARK_SENDER_VERIFIED: "true",
        POSTMARK_API_BASE_URL: baseUrl,
      },
      log: (line) => logs.push(line),
      sleep: async () => {},
    });

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // REAL Better Auth over the REAL bound provider transport.
    const auth = createIdentityAuth(handle.db as never, {
      emailTransport: boundBinding.emailTransport,
    });
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    const resolver = createSessionContextResolver(
      createDbSessionContextStore(
        handle.db as never,
        createDbActorEnrichmentReader(handle.db as never),
      ),
    );
    authApp = buildServer({
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      authenticate: createSessionAuthenticate({
        getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
        getResolver: () => resolver,
      }),
    });
    registerIdentityAuth(authApp, auth);
  });

  afterAll(async () => {
    await authApp?.close();
    await handle?.close?.();
    await admin?.end();
    await fake.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  it("binds the real adapter when credentials + verified From are configured", () => {
    expect(boundBinding.providerBound).toBe(true);
    expect(boundBinding.linkDeliveryAvailable).toBe(true);
  });

  it("a real Better Auth magic-link request is POSTed to the provider, and the delivered link signs in", async () => {
    const email = `signin-${randomUUID().slice(0, 8)}@m36-email.test`;
    await admin.query(`INSERT INTO "user" (email, email_verified) VALUES ($1, true)`, [email]);
    const before = fake.received.length;
    const req = await authApp.inject({
      method: "POST",
      url: "/api/auth/sign-in/magic-link",
      headers: { origin: ORIGIN },
      payload: { email, callbackURL: `${ORIGIN}/signed-in` },
    });
    expect(req.statusCode).toBe(200);
    expect(fake.received.length).toBe(before + 1);
    const sent = fake.received[fake.received.length - 1] as Received;
    expect(sent.headers["x-postmark-server-token"]).toBe(SERVER_TOKEN);
    expect(sent.body.To).toBe(email);
    expect(sent.body.From).toBe(FROM);
    expect(sent.body.MessageStream).toBe("outbound");
    expect(sent.body.TrackLinks).toBe("None");
    const link = new URL(/https?:\/\/\S+/.exec(sent.body.TextBody)?.[0] as string);
    const verify = await authApp.inject({
      method: "GET",
      url: `${link.pathname}${link.search}`,
      headers: { origin: ORIGIN },
    });
    expect(verify.statusCode).toBe(302);
    const sessions = await admin.query(
      `SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`,
      [email],
    );
    expect(sessions.rows[0].n).toBe(1);
  });

  it("funeral invite: emailed over the real adapter, token only in the URL fragment, redeems once", async () => {
    const { app, collaborators } = inviteServer(boundBinding);
    const before = fake.received.length;
    const recipient = `funeral-${randomUUID().slice(0, 8)}@funeral-home.test`;
    const res = await invite(app, recipient);
    expect(res.statusCode).toBe(201);
    expect(fake.received.length).toBe(before + 1);
    const sent = fake.received[fake.received.length - 1] as Received;
    expect(sent.body.To).toBe(recipient);
    const url = new URL(/https?:\/\/\S+/.exec(sent.body.TextBody)?.[0] as string);
    expect(url.pathname).toBe("/funeral/redeem");
    expect(url.search).toBe("");
    const token = decodeURIComponent(url.hash.replace(/^#token=/, ""));
    expect(token).toBe(collaborators.tokenFor(DECEASED));
    // No PHI: the body names no patient / decedent / org detail.
    expect(sent.body.TextBody).not.toContain(DECEASED);
    expect(res.body).not.toContain(token);
    const consumed = await app.inject({
      method: "POST",
      url: "/api/v1/collaborators/consume",
      payload: { token },
    });
    expect(consumed.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/api/v1/collaborators/consume",
      payload: { token },
    });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("retries a transient provider 503 and still delivers exactly one usable link", async () => {
    const { app } = inviteServer(boundBinding);
    const before = fake.received.length;
    fake.script.push({ status: 503 }, { status: 429 });
    const res = await invite(app, "retry@funeral-home.test");
    expect(res.statusCode).toBe(201);
    expect(fake.received.length).toBe(before + 3); // 503, 429, then 200 - one message, same body
    const bodies = fake.received.slice(before).map((r) => r.body.TextBody);
    expect(new Set(bodies).size).toBe(1);
    await app.close();
  });

  it("a permanent provider rejection revokes the link and answers 503 LINK_DELIVERY_FAILED (no retry)", async () => {
    const { app } = inviteServer(boundBinding);
    const before = fake.received.length;
    fake.script.push({ status: 422, body: { ErrorCode: 400, Message: "sender not verified" } });
    const res = await invite(app, "rejected@funeral-home.test");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LINK_DELIVERY_FAILED");
    expect(fake.received.length).toBe(before + 1);
    await app.close();
  });

  it("UNBOUND in production: invite answers 503 LINK_DELIVERY_UNAVAILABLE, sends nothing; boot line names the vars", async () => {
    const bootLines: string[] = [];
    const unbound = bindTransactionalEmail({
      env: { NODE_ENV: "production", POSTMARK_API_BASE_URL: baseUrl },
      log: (line) => bootLines.push(line),
    });
    expect(unbound.providerBound).toBe(false);
    expect(unbound.linkDeliveryAvailable).toBe(false);
    const joined = bootLines.join("\n");
    for (const name of [
      "POSTMARK_SERVER_TOKEN",
      "POSTMARK_FROM_ADDRESS",
      "POSTMARK_SENDER_VERIFIED",
    ]) {
      expect(joined).toContain(name);
    }
    const { app, collaborators } = inviteServer(unbound);
    const before = fake.received.length;
    const res = await invite(app, "nobody@funeral-home.test");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("LINK_DELIVERY_UNAVAILABLE");
    expect(collaborators.tokenFor(DECEASED)).toBeUndefined(); // nothing minted
    expect(fake.received.length).toBe(before); // nothing sent
    // The auditor delivery fails closed too (the enrolment route maps the throw to 503).
    await expect(
      createAuditorLinkEmailDelivery({
        transport: unbound.linkEmailTransport,
        baseUrl: "https://app.wardenx.test",
      }).deliver({
        organizationId: "o",
        engagementId: "e",
        auditorName: "A",
        auditorEmail: "auditor@firm.test",
        token: "t",
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/not bound/);
    expect(fake.received.length).toBe(before);
    await app.close();
  });

  it("a partial configuration stays unbound (token without a verified From)", () => {
    const lines: string[] = [];
    const partial = bindTransactionalEmail({
      env: { NODE_ENV: "production", POSTMARK_SERVER_TOKEN: SERVER_TOKEN },
      log: (l) => lines.push(l),
    });
    expect(partial.providerBound).toBe(false);
    expect(lines.join("\n")).toContain("POSTMARK_FROM_ADDRESS (missing)");
    expect(lines.join("\n")).not.toContain(SERVER_TOKEN);
  });

  it("no log line ever contains the server token, a recipient, or a link token", () => {
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    expect(all).not.toContain(SERVER_TOKEN);
    expect(all).not.toContain("@");
    expect(all).not.toContain("token=");
    expect(all).toMatch(/message_id=fake-\d+/);
  });
});
