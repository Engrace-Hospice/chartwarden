/**
 * M23 Claim.MD webhook intake (ADR-0053 amendment D7/D8), LIVE Postgres on the REAL runtime roles.
 *
 * The receipt store runs on the BYPASSRLS `chartwarden_platform_login` built by `scripts/db/provision-runtime-roles.ts`
 * (executed here), through an allowlisted, audited withPlatformContext, so a missing production grant fails here. The
 * tenant role `chartwarden_app` is proved unable to read the receipts at all.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:claimmd-webhook:live
 * (SUPERUSER url to a THROWAWAY database on a PRIVATE pgvector/pgvector:pg18: this file DROPs the public schema.)
 * Synthetic key, NPIs and bodies only.
 */
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPlatformEvent } from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { createWebhookPayloadCipher } from "@chartwarden/shared";
import { registerPlatformJob, withPlatformContext } from "@chartwarden/tenancy";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCsrfProtection } from "../src/bootstrap/plugins/csrf";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  type ClaimMdPlatformRunner,
  buildClaimMdReceiptStore,
} from "../src/modules/23-billing-medicare/claimmd-webhook/receipt-store";
import { registerClaimMdWebhookRoutes } from "../src/modules/23-billing-medicare/claimmd-webhook/routes";
import { M23_CLAIMMD_WEBHOOK_JOB_ID } from "../src/modules/23-billing-medicare/wiring";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-claimmd";
const KEY = "SYNTH99999_k#ey*not-real";
const NPI = "1111111112";
const URL_TEST = "/api/v1/webhooks/claimmd/test";

const sign = (body: string) =>
  createHmac("sha256", Buffer.from(KEY, "latin1")).update(body).digest("base64");
const enroll = (eventid: string) => ({
  eventid,
  event_type: "enroll",
  event_time: "2026-11-05 12:00:00",
  event_data: {
    enroll: {
      enrollid: "77",
      event: "enrolled",
      enroll_type: "era",
      prov_npi: NPI,
      prov_taxid: "000000001",
      payerid: "SYN01",
    },
  },
});
const delivery = (events: unknown[]) =>
  JSON.stringify({ UTCTime: "2026-11-05 12:00:00", acct_number: "99999", events });

describe.skipIf(!DB_URL)("M23 Claim.MD webhook intake - LIVE Postgres", () => {
  let admin: Client;
  let platform: ReturnType<typeof createDbClient>;
  let tenant: Client;
  let app: FastifyInstance;
  const cipher = createWebhookPayloadCipher(Buffer.alloc(32, 5), "claimmd-webhook-v1");
  const logs: { event: string; detail: Record<string, unknown> }[] = [];

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

  const rows = async () =>
    (await admin.query("SELECT * FROM claimmd_webhook_event ORDER BY event_id")).rows as Record<
      string,
      unknown
    >[];

  const post = (
    body: string,
    headers: Record<string, string> = { "auth-signature-base64": sign(body) },
  ) =>
    app.inject({
      method: "POST",
      url: URL_TEST,
      payload: body,
      headers: { "content-type": "application/json", ...headers },
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
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
    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    tenant = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await tenant.connect();
    registerPlatformJob(M23_CLAIMMD_WEBHOOK_JOB_ID);

    const runner: ClaimMdPlatformRunner = (fn) =>
      withPlatformContext(
        platform.db,
        { jobId: M23_CLAIMMD_WEBHOOK_JOB_ID, reason: "live suite", crossTenant: true },
        async (tx, event) => {
          await auditPlatformEvent(tx, {
            eventType: "platform.bypass_invoked",
            resourceKind: "tenant",
            outcome: "success",
            severity: event.severity,
            correlationId: `platform-bypass:${event.jobId}`,
            context: { jobId: event.jobId, reason: event.reason },
          });
        },
        fn,
      );
    app = Fastify();
    applyErrorHandler(app);
    applyCsrfProtection(app, { secure: false });
    registerClaimMdWebhookRoutes(app, {
      usage: "test",
      binding: {
        usage: "test",
        accountKey: KEY,
        receive: buildClaimMdReceiptStore({
          runner,
          cipher,
          log: (event, detail) => logs.push({ event, detail }),
        }),
      },
    });
    await app.ready();
  }, 600_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE claimmd_webhook_event");
    logs.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await tenant?.end();
    await platform?.close();
    await admin?.end();
  });

  it("answers 503 and stores nothing while unconfigured", async () => {
    const off = Fastify();
    applyErrorHandler(off);
    registerClaimMdWebhookRoutes(off, { usage: null, binding: null });
    for (const url of [URL_TEST, "/api/v1/webhooks/claimmd/production"]) {
      const body = delivery([enroll("1")]);
      const res = await off.inject({
        method: "POST",
        url,
        payload: body,
        headers: { "auth-signature-base64": sign(body) },
      });
      expect(res.statusCode).toBe(503);
    }
    await off.close();
    expect(await rows()).toHaveLength(0);
  });

  it("refuses every bad signature with the same 401 and stores nothing", async () => {
    const body = delivery([enroll("1")]);
    for (const headers of [
      {},
      { "auth-signature-base64": "" },
      { "auth-signature-base64": `${sign(body).slice(0, 42)}A=` },
      { "auth-signature-base64": sign(`${body} `) },
      { "auth-signature-base64": `${sign(body)}=` },
    ]) {
      const res = await post(body, headers);
      expect(res.statusCode).toBe(401);
      expect(JSON.stringify(res.json())).toContain("INVALID_SIGNATURE");
    }
    expect(await rows()).toHaveLength(0);
  });

  it("stores a signed batch encrypted, without needing a CSRF token even with a session cookie", async () => {
    const body = delivery([enroll("1"), enroll("2"), { ...enroll("3"), event_type: "brand_new" }]);
    const res = await post(body, {
      "auth-signature-base64": sign(body),
      cookie: "better-auth.session_token=synthetic",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 3 });
    const stored = await rows();
    expect(stored.map((r) => r.event_id)).toEqual(["1", "2", "3"]);
    for (const r of stored) {
      expect(r.processed_at).toBeNull();
      expect(r.signature_verified_at).not.toBeNull();
      expect(String(r.payload_cipher)).not.toContain(NPI);
      expect(String(r.payload_cipher)).not.toContain("000000001");
      expect(cipher.decrypt(String(r.payload_cipher))).toContain(NPI);
    }
    expect(stored[2]?.event_type).toBe("brand_new"); // an undocumented type is kept for the sweep to settle
  });

  it("dedupes a redelivery on (usage, acct_number, eventid) and still answers 200", async () => {
    const body = delivery([enroll("1"), enroll("2")]);
    expect((await post(body)).statusCode).toBe(200);
    const again = delivery([enroll("2"), enroll("1"), enroll("2")]);
    const res = await post(again);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 3 });
    expect(await rows()).toHaveLength(2);
  });

  it("settles a test event terminal on receipt and logs usage and account only", async () => {
    const body = delivery([
      {
        eventid: "t1",
        event_type: "test",
        event_time: "x",
        event_data: { test: { event: "test" } },
      },
    ]);
    expect((await post(body)).statusCode).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({ processing_outcome: "test_ack" });
    expect(row?.processed_at).not.toBeNull();
    expect(logs).toEqual([
      { event: "claimmd.webhook.test_received", detail: { usage: "test", acctNumber: "99999" } },
    ]);
  });

  it("stores an unsplittable signed body as one malformed row instead of refusing it", async () => {
    const body = '{"acct_number":"99999","events":"not-a-list"}';
    expect((await post(body)).statusCode).toBe(200);
    const [row] = await rows();
    expect(row?.event_id).toMatch(/^body:[0-9a-f]{64}$/);
    expect(row?.processing_outcome).toBe("malformed");
  });

  it("stores the whole batch or nothing: one failing row fails the delivery with a 5xx", async () => {
    await admin.query(`
      CREATE OR REPLACE FUNCTION claimmd_live_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_id = 'poison' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER claimmd_live_poison BEFORE INSERT ON claimmd_webhook_event
        FOR EACH ROW EXECUTE FUNCTION claimmd_live_poison();`);
    try {
      const res = await post(delivery([enroll("1"), enroll("poison"), enroll("3")]));
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(await rows()).toHaveLength(0);
    } finally {
      await admin.query("DROP TRIGGER claimmd_live_poison ON claimmd_webhook_event");
    }
  });

  it("answers 413 above 1 MiB and stores nothing", async () => {
    const big = delivery([{ ...enroll("1"), pad: "x".repeat(1024 * 1024) }]);
    expect((await post(big)).statusCode).toBe(413);
    expect(await rows()).toHaveLength(0);
  });

  it("is invisible to the tenant role, and every receipt is an audited platform entry", async () => {
    expect((await post(delivery([enroll("1")]))).statusCode).toBe(200);
    await expect(tenant.query("SELECT count(*) FROM claimmd_webhook_event")).rejects.toThrow(
      /permission denied/,
    );
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND context->>'jobId' = $1",
      [M23_CLAIMMD_WEBHOOK_JOB_ID],
    );
    expect(audited.rows[0]?.n).toBeGreaterThan(0);
    // The row write is audited too, without the cipher.
    const written = await admin.query(
      "SELECT after FROM audit_event WHERE event_type = 'claimmd_webhook_event.insert' ORDER BY created_at DESC LIMIT 1",
    );
    expect(written.rows[0]?.after).toMatchObject({ event_id: "1", usage: "test" });
    expect(JSON.stringify(written.rows[0]?.after)).not.toContain(
      String((await rows())[0]?.payload_cipher),
    );
  });
});
