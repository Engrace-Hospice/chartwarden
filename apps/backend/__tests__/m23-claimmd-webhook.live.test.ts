/**
 * M23 Claim.MD webhook intake (ADR-0053 amendment D7/D8), LIVE Postgres on the REAL runtime roles.
 *
 * The receipt store runs on the BYPASSRLS `chartwarden_platform_login` built by `scripts/db/provision-runtime-roles.ts`
 * (executed here), through an allowlisted, audited withPlatformContext, so a missing production grant fails here. The
 * tenant role `chartwarden_app` is proved unable to read the receipts at all.
 *
 * Platform-verified NPI ownership (ADR-0053 amendment precondition 2, migration 1326): the sweep routes an enrollment only
 * to a provider entity whose CURRENT NPI has a live verification, written only by the platform login (audited, operator
 * attributed); the tenant role reads its own org's verifications and writes none.
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
import { type DbClient, createDbClient } from "@chartwarden/db";
import { createWebhookPayloadCipher } from "@chartwarden/shared";
import { registerPlatformJob, withPlatformContext } from "@chartwarden/tenancy";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { applyCsrfProtection } from "../src/bootstrap/plugins/csrf";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  type ClaimMdPlatformRunner,
  buildClaimMdReceiptStore,
} from "../src/modules/23-billing-medicare/claimmd-webhook/receipt-store";
import { registerClaimMdWebhookRoutes } from "../src/modules/23-billing-medicare/claimmd-webhook/routes";
import {
  type BillingEntitlementPort,
  CLAIMMD_KEY_FAULT_GRACE_DAYS,
  CLAIMMD_PAYLOAD_RETENTION_DAYS,
  CLAIMMD_SWEEP_BATCH,
  CLAIMMD_SWEEP_MAX_ATTEMPTS,
  type ClaimMdRecentFailedDetail,
  type ClaimMdSweepDeps,
  createRecentFailedAlerter,
  runClaimMdWebhookSweep,
} from "../src/modules/23-billing-medicare/claimmd-webhook/sweep";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import {
  type NpiVerificationService,
  buildDrizzleNpiVerificationService,
} from "../src/modules/23-billing-medicare/routes/npi-verification-service";
import {
  M23_CLAIMMD_WEBHOOK_JOB_ID,
  M23_NPI_VERIFICATION_JOB_ID,
} from "../src/modules/23-billing-medicare/wiring";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-claimmd";
const KEY = "SYNTH99999_k#ey*not-real";
const NPI = "1111111112";
const NPI_A = "1234567893";
const NPI_B = "1999999984";
const ORG_A = "00000000-0000-4000-8000-0000000322a1";
const ORG_B = "00000000-0000-4000-8000-0000000322b1";
const URL_TEST = "/api/v1/webhooks/claimmd/test";
const NPI_C = "1222222220";
const NPI_D = "1222222238";
const NPI_E = "1222222246";
const OPERATOR = "00000000-0000-4000-8000-0000000326f1";
const operator: M23WriteActor = {
  organizationId: "00000000-0000-4000-8000-0000000326f0",
  userId: "00000000-0000-4000-8000-0000000326f2",
  roles: ["platform_admin"],
  membershipId: OPERATOR,
  stepUpRecent: true,
  actorKind: "user",
};

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
  let runner: ClaimMdPlatformRunner;
  let npiAdmin: NpiVerificationService;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  let peA = "";
  let peB = "";
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

  const provision = (): void => {
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
  };

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
    provision();
    platform = createDbClient({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    tenant = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await tenant.connect();
    registerPlatformJob(M23_CLAIMMD_WEBHOOK_JOB_ID);
    publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    for (const [org, slug] of [
      [ORG_A, "cmd-a"],
      [ORG_B, "cmd-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
    }
    const provider = async (org: string, ccn: string, npi: string) =>
      (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,'Synthetic Hospice',$3,'\\x00','12-31') RETURNING id`,
          [org, ccn, npi],
        )
      ).rows[0].id as string;
    peA = await provider(ORG_A, "322001", NPI_A);
    peB = await provider(ORG_B, "322002", NPI_B);
    // A sent claim of org B under control number CN-B-1 (what an appeal's remote_claimid must carry).
    await admin.query(
      `INSERT INTO clearinghouse_submission_attempt (organization_id, provider_entity_id, scope, usage, idempotency_key,
         control_number, kind, identity, status, clearinghouse_submission_id, reserved_at, received_at)
       VALUES ($1,$2,'claimmd:test','test','idem-b-1','CN-B-1','claim',$3,'sent','file:1',now(),now())`,
      [ORG_B, peB, "a".repeat(64)],
    );

    runner = (fn) =>
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
    registerPlatformJob(M23_NPI_VERIFICATION_JOB_ID);
    npiAdmin = buildDrizzleNpiVerificationService({
      // This suite is about Claim.MD routing, not go-live; an explicit no-op change hook.
      onVerificationChanged: async () => undefined,
      runner: (fn) =>
        withPlatformContext(
          platform.db,
          { jobId: M23_NPI_VERIFICATION_JOB_ID, reason: "live suite", crossTenant: true },
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
        ),
    });
    // The sweep tests below route to A and B: platform staff have verified both NPIs.
    await npiAdmin.verify(operator, peA, {
      npi: NPI_A,
      evidence: "NPPES record matches CCN 322001",
    });
    await npiAdmin.verify(operator, peB, {
      npi: NPI_B,
      evidence: "NPPES record matches CCN 322002",
    });
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
    const cases: Record<string, string>[] = [
      {},
      { "auth-signature-base64": "" },
      { "auth-signature-base64": `${sign(body).slice(0, 42)}A=` },
      { "auth-signature-base64": sign(`${body} `) },
      { "auth-signature-base64": `${sign(body)}=` },
    ];
    for (const headers of cases) {
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

  // ── the sweep (slice 3): tenant resolution, entitlement, publish ──────────────────────────────────────────────
  const T0 = new Date("2026-11-05T12:00:00Z");
  const receiveAt = (at: Date) => buildClaimMdReceiptStore({ runner, cipher, now: () => at });
  const store = (events: unknown[], at = T0) =>
    receiveAt(at)({ usage: "test", rawBody: Buffer.from(delivery(events)) });
  const enrollFor = (eventid: string, npi: string, event = "enrolled") => ({
    ...enroll(eventid),
    event_data: { enroll: { ...enroll(eventid).event_data.enroll, prov_npi: npi, event } },
  });
  const appealFor = (eventid: string, remoteClaimId: string) => ({
    eventid,
    event_type: "appeal",
    event_time: "2026-11-05 12:00:00",
    event_data: {
      appeal: {
        appealid: "A-9",
        event: "created",
        event_detail: "free text <b>",
        claimid: "123",
        remote_claimid: remoteClaimId,
        appeal_type: "electronic",
      },
    },
  });
  const sweep = (
    entitlement: BillingEntitlementPort = { isEntitled: async () => true },
    at = T0,
    extra: Partial<ClaimMdSweepDeps> = {},
  ) =>
    runClaimMdWebhookSweep({
      runner,
      cipher,
      entitlement,
      outbox: {
        publish: (tx, input) => publisher.publish(tx as never, { ...input, callerModule: "m23" }),
      },
      now: () => at,
      ...extra,
    });
  const outbox = async (eventType: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload FROM outbox_event WHERE event_type = $1 ORDER BY created_at",
        [eventType],
      )
    ).rows as { organization_id: string; payload: Record<string, unknown> }[];
  const outcome = async (eventId: string) =>
    (await admin.query("SELECT * FROM claimmd_webhook_event WHERE event_id = $1", [eventId]))
      .rows[0];

  describe("sweep", () => {
    beforeEach(async () => {
      await admin.query("DELETE FROM outbox_event WHERE event_type LIKE 'm23.clearinghouse.%'");
    });

    it("resolves an enrollment by the unique NPI and publishes one PHI-free report to that tenant only", async () => {
      await store([enrollFor("e1", NPI_A)]);
      expect((await sweep()).outcomes).toEqual({ published: 1 });
      const [ev, ...rest] = await outbox("m23.clearinghouse.enrollment_reported");
      expect(rest).toHaveLength(0);
      expect(ev?.organization_id).toBe(ORG_A);
      expect(ev?.payload).toMatchObject({
        sourceEventKey: "test:99999:e1",
        providerEntityId: peA,
        vendorStatus: "enrolled",
        enrollType: "era",
        clearinghousePayerId: "SYN01",
        vendorEnrollId: "77",
      });
      expect(JSON.stringify(ev?.payload)).not.toContain("000000001"); // the TIN never leaves the receipt
      expect(await outcome("e1")).toMatchObject({
        processing_outcome: "published",
        derived_organization_id: ORG_A,
        derived_provider_entity_id: peA,
      });
      // Org B's tenant connection sees nothing of org A's report.
      await tenant.query("BEGIN");
      await tenant.query(`SELECT set_config('app.org_id', '${ORG_B}', true)`);
      const seen = await tenant.query(
        "SELECT count(*)::int AS n FROM outbox_event WHERE event_type LIKE 'm23.clearinghouse.%'",
      );
      await tenant.query("COMMIT");
      expect(seen.rows[0]?.n).toBe(0);
    });

    it("settles an unknown NPI, an unknown claim and an undocumented type terminal, publishing nothing", async () => {
      await store([
        enrollFor("e2", "1000000004"),
        appealFor("a0", "CN-NOPE"),
        { ...enroll("u1"), event_type: "brand_new" },
      ]);
      expect((await sweep()).outcomes).toEqual({
        unroutable_npi: 1,
        unroutable_claim: 1,
        unsupported_type: 1,
      });
      expect(await outbox("m23.clearinghouse.enrollment_reported")).toHaveLength(0);
      expect(await outbox("m23.clearinghouse.appeal_reported")).toHaveLength(0);
    });

    it("resolves an appeal by the platform-unique control number (remote_claimid), with a bounded status word", async () => {
      await store([appealFor("a1", "CN-B-1")]);
      expect((await sweep()).outcomes).toEqual({ published: 1 });
      const [ev] = await outbox("m23.clearinghouse.appeal_reported");
      expect(ev?.organization_id).toBe(ORG_B);
      expect(ev?.payload).toMatchObject({
        controlNumber: "CN-B-1",
        providerEntityId: peB,
        vendorStatus: "created",
        vendorAppealId: "A-9",
      });
      expect(JSON.stringify(ev?.payload)).not.toContain("free text");
    });

    it("parks an event for an org without the Billing add-on, then back-fills it once the add-on is granted", async () => {
      let entitled = false;
      const port: BillingEntitlementPort = {
        isEntitled: async (org) => (org === ORG_A ? entitled : true),
      };
      await store([enrollFor("e3", NPI_A)]);
      expect((await sweep(port)).outcomes).toEqual({ awaiting_entitlement: 1 });
      expect(await outcome("e3")).toMatchObject({
        processing_outcome: "awaiting_entitlement",
        processed_at: null,
      });
      expect(String((await outcome("e3")).payload_cipher)).toMatch(/^v1\./); // still encrypted, still there
      entitled = true;
      expect((await sweep(port, new Date(T0.getTime() + 5 * 60_000))).seen).toBe(0); // re-checked hourly, not every minute
      expect((await sweep(port, new Date(T0.getTime() + 61 * 60_000))).outcomes).toEqual({
        published: 1,
      });
      expect(await outbox("m23.clearinghouse.enrollment_reported")).toHaveLength(1);
    });

    it("leaves a row untouched when the entitlement reader fails, and publishes it on the next sweep", async () => {
      await store([enrollFor("e4", NPI_A)]);
      const failing: BillingEntitlementPort = {
        isEntitled: async () => Promise.reject(new Error("down")),
      };
      expect((await sweep(failing)).outcomes).toEqual({ entitlement_unavailable: 1 });
      expect(await outcome("e4")).toMatchObject({
        processing_outcome: null,
        attempt_count: 0,
        last_error_class: "entitlement_unavailable",
      });
      expect((await sweep()).outcomes).toEqual({ published: 1 });
    });

    it("never publishes a row twice: a second sweep finds nothing to do", async () => {
      await store([enrollFor("e5", NPI_B)]);
      await sweep();
      expect((await sweep()).seen).toBe(0);
      expect(await outbox("m23.clearinghouse.enrollment_reported")).toHaveLength(1);
    });

    it("gives up on a poison row after five attempts without blocking the others", async () => {
      await store([enrollFor("p1", NPI_A), enrollFor("e6", NPI_B)]);
      // p1's publish always fails (a per-row fault that a retry cannot fix).
      const poisoned: ClaimMdSweepDeps["outbox"] = {
        publish: async (tx, input) => {
          if (String(input.payload.sourceEventKey).endsWith(":p1")) throw new Error("poison");
          await publisher.publish(tx as never, { ...input, callerModule: "m23" });
        },
      };
      const alerts: Array<Record<string, unknown>> = [];
      const onFailed: ClaimMdSweepDeps["onFailed"] = (detail) => alerts.push({ ...detail });
      const first = await sweep(undefined, T0, { onFailed, outbox: poisoned });
      expect(first.outcomes).toEqual({ retry: 1, published: 1 });
      for (let i = 0; i < 4; i += 1) await sweep(undefined, T0, { onFailed, outbox: poisoned });
      expect(await outcome("p1")).toMatchObject({ processing_outcome: "failed", attempt_count: 5 });
      expect((await outcome("p1")).processed_at).not.toBeNull();
      // Claim.MD already got its 200, so a terminal failure raises an ops alert once, with ids only.
      expect(alerts).toEqual([
        { usage: expect.any(String), eventId: "p1", attempts: 5, errorClass: expect.any(String) },
      ]);
    });

    it("spends no attempt on a payload it cannot decrypt (a key fault), alerts once per sweep, and recovers", async () => {
      await store([enrollFor("k1", NPI_A), enrollFor("k2", NPI_B)]);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      const alerts: Array<Record<string, unknown>> = [];
      const onUndecryptable: ClaimMdSweepDeps["onUndecryptable"] = (detail) =>
        alerts.push({ ...detail });
      for (let i = 0; i < CLAIMMD_SWEEP_MAX_ATTEMPTS + 1; i += 1) {
        const r = await sweep(undefined, T0, { cipher: wrongKey, onUndecryptable });
        expect(r.outcomes).toEqual({ payload_undecryptable: 2 });
      }
      for (const id of ["k1", "k2"]) {
        expect(await outcome(id)).toMatchObject({
          processing_outcome: null,
          attempt_count: 0,
          last_error_class: "payload_undecryptable",
        });
      }
      // One alert per sweep (not one per row), ids-free.
      expect(alerts).toHaveLength(CLAIMMD_SWEEP_MAX_ATTEMPTS + 1);
      expect(alerts[0]).toEqual({ count: 2, errorClass: expect.any(String) });
      // The key is fixed: the next sweep publishes both.
      expect((await sweep()).outcomes).toEqual({ published: 2 });
    });

    it("refuses a ciphertext moved from another row (its digest no longer matches), spending no attempt", async () => {
      await store([enrollFor("s1", NPI_A), enrollFor("s2", NPI_B)]);
      await admin.query(
        `UPDATE claimmd_webhook_event SET payload_cipher = (SELECT payload_cipher FROM claimmd_webhook_event WHERE event_id = 's1')
          WHERE event_id = 's2'`,
      );
      expect((await sweep()).outcomes).toEqual({ published: 1, payload_undecryptable: 1 });
      expect(await outcome("s2")).toMatchObject({ processing_outcome: null, attempt_count: 0 });
      const published = await outbox("m23.clearinghouse.enrollment_reported");
      expect(published.map((e) => e.organization_id)).toEqual([ORG_A]);
    });

    it("clears ciphers after the retention window and closes out entitlement waits", async () => {
      const old = new Date(T0.getTime() - (CLAIMMD_PAYLOAD_RETENTION_DAYS + 1) * 86_400_000);
      await store([enrollFor("r1", NPI_A), enrollFor("r2", NPI_A)], old);
      await sweep({ isEntitled: async () => true }, old); // r1 and r2 published at `old`
      await store([enrollFor("r3", NPI_A)], old);
      await sweep({ isEntitled: async () => false }, old); // r3 waits
      await sweep({ isEntitled: async () => false }, T0);
      for (const id of ["r1", "r2"]) {
        expect(await outcome(id)).toMatchObject({
          processing_outcome: "published",
          payload_cipher: null,
          payload_key_ref: null,
        });
      }
      expect(await outcome("r3")).toMatchObject({
        processing_outcome: "expired_not_entitled",
        payload_cipher: null,
      });
      expect((await outcome("r3")).payload_sha256).toMatch(/^[0-9a-f]{64}$/); // the digest stays as evidence
    });

    // ── key faults are bounded: a wrong key id is refused early, bad rows cannot starve fresh ones, none lives for ever ──
    const DAY = 86_400_000;

    it("refuses a receipt sealed under another key id BEFORE any decrypt, then recovers under the right id", async () => {
      await store([enrollFor("m1", NPI_A)]);
      // The SAME key bytes under a different id: if the sweep tried to decrypt it would succeed, so only the key-id check refuses it.
      const rotated = createWebhookPayloadCipher(Buffer.alloc(32, 5), "claimmd-webhook-v2");
      const r = await sweep(undefined, T0, { cipher: rotated });
      expect(r.outcomes).toEqual({ payload_key_mismatch: 1 });
      expect(await outcome("m1")).toMatchObject({
        processing_outcome: null,
        attempt_count: 0,
        last_error_class: "payload_key_mismatch",
      });
      expect((await sweep()).outcomes).toEqual({ published: 1 });
    });

    it("does not let a backlog of failed receipts starve a fresh one (fresh rows sort first)", async () => {
      await admin.query(
        `INSERT INTO claimmd_webhook_event (usage, acct_number, event_id, event_type, received_at, signature_verified_at,
           payload_sha256, payload_cipher, payload_key_ref, last_error_class)
         SELECT 'test', '99999', 'bad-' || g, 'enroll', $1::timestamptz - interval '1 hour', $1::timestamptz - interval '1 hour',
           repeat('0', 64), 'v1.x.y.z', 'claimmd-webhook-v1', 'payload_undecryptable'
         FROM generate_series(1, ${CLAIMMD_SWEEP_BATCH + 5}) g`,
        [T0.toISOString()],
      );
      await store([enrollFor("fresh1", NPI_A)]);
      const r = await sweep();
      expect(r.seen).toBe(CLAIMMD_SWEEP_BATCH);
      expect(r.outcomes.published).toBe(1);
      expect(await outcome("fresh1")).toMatchObject({ processing_outcome: "published" });
    });

    it("makes a receipt that stays unreadable past the grace window terminal `failed` (alerted once, no attempt spent)", async () => {
      await store([enrollFor("g1", NPI_A)]);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      const alerts: Array<Record<string, unknown>> = [];
      const onFailed: ClaimMdSweepDeps["onFailed"] = (detail) => alerts.push({ ...detail });
      const grace = new Date(T0.getTime() + CLAIMMD_KEY_FAULT_GRACE_DAYS * DAY);
      const justBefore = new Date(grace.getTime() - 1);
      expect((await sweep(undefined, justBefore, { cipher: wrongKey, onFailed })).outcomes).toEqual(
        { payload_undecryptable: 1 },
      );
      expect((await sweep(undefined, grace, { cipher: wrongKey, onFailed })).outcomes).toEqual({
        failed: 1,
      });
      expect(await outcome("g1")).toMatchObject({
        processing_outcome: "failed",
        attempt_count: 0,
        last_error_class: "payload_undecryptable",
      });
      expect((await outcome("g1")).processed_at).not.toBeNull();
      expect(alerts).toEqual([
        { usage: "test", eventId: "g1", attempts: 0, errorClass: "payload_undecryptable" },
      ]);
      // Terminal: the next sweep no longer selects it.
      expect((await sweep(undefined, grace, { cipher: wrongKey })).seen).toBe(0);
    });

    it("clears the cipher of ANY receipt older than the retention window from received_at, settled or not", async () => {
      const old = new Date(T0.getTime() - (CLAIMMD_PAYLOAD_RETENTION_DAYS + 1) * DAY);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      // u2 settled, but its processed_at is recent while received_at is old; u4 never settles (unreadable).
      await store([enrollFor("u2", NPI_A)], old);
      await sweep(undefined, old);
      await store([enrollFor("u4", NPI_A)], old);
      await sweep(undefined, old, { cipher: wrongKey });
      await admin.query(
        "UPDATE claimmd_webhook_event SET processed_at = $1 WHERE event_id = 'u2'",
        [T0.toISOString()],
      );
      const alerts: Array<Record<string, unknown>> = [];
      const onFailed: ClaimMdSweepDeps["onFailed"] = (detail) => alerts.push({ ...detail });
      await sweep(undefined, T0, { onFailed });
      expect(await outcome("u2")).toMatchObject({ payload_cipher: null, payload_key_ref: null });
      expect((await outcome("u2")).payload_cleared_at).not.toBeNull();
      expect(await outcome("u4")).toMatchObject({
        processing_outcome: "failed",
        payload_cipher: null,
      });
      expect(alerts).toEqual([
        { usage: "test", eventId: "u4", attempts: 0, errorClass: "payload_undecryptable" },
      ]);
    });

    // ── alerts are raised AFTER the sweep's transaction commits, and a sink can never fail a row ───────────────────────
    /** A runner that records when the transaction has committed, so a sink can prove it was called only after. */
    const committedProbe = () => {
      const state = { committed: false };
      const probed: ClaimMdSweepDeps["runner"] = async (fn) => {
        const result = await runner(fn);
        state.committed = true;
        return result;
      };
      return { state, probed };
    };

    it("raises onFailed only after the transaction commits; a throwing sink leaves the row terminal and the others published", async () => {
      // s1 is good, s2's ciphertext is another row's (digest mismatch: a key-fault row), aged past the grace window.
      await store([enrollFor("t1", NPI_A), enrollFor("t2", NPI_B)]);
      await admin.query(
        `UPDATE claimmd_webhook_event SET payload_cipher = (SELECT payload_cipher FROM claimmd_webhook_event WHERE event_id = 't1')
          WHERE event_id = 't2'`,
      );
      const grace = new Date(T0.getTime() + CLAIMMD_KEY_FAULT_GRACE_DAYS * DAY);
      const { state, probed } = committedProbe();
      const sinkCalls: boolean[] = [];
      const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
      const onFailed: ClaimMdSweepDeps["onFailed"] = () => {
        sinkCalls.push(state.committed); // true only if the transaction had already committed
        throw new Error("the ops sink is down");
      };
      const r = await sweep(undefined, grace, {
        runner: probed,
        onFailed,
        log: (event, detail) => logs.push({ event, detail }),
      });
      expect(r.outcomes).toEqual({ published: 1, failed: 1 });
      expect(sinkCalls).toEqual([true]); // called once, after the commit
      // The sink threw, yet the failed row stayed terminal (processed_at set), and the good row was published.
      expect(await outcome("t2")).toMatchObject({ processing_outcome: "failed", attempt_count: 0 });
      expect((await outcome("t2")).processed_at).not.toBeNull();
      expect(await outcome("t1")).toMatchObject({ processing_outcome: "published" });
      expect(await outbox("m23.clearinghouse.enrollment_reported")).toHaveLength(1);
      // The failed sink is reported by name and error class only, never its message.
      expect(logs.filter((l) => l.event === "claimmd.webhook.alert_sink_failed")).toEqual([
        {
          event: "claimmd.webhook.alert_sink_failed",
          detail: { sink: "onFailed", errorClass: "Error" },
        },
      ]);
      // A later sweep does not repeat the alert: the row is terminal and gone from the pending set.
      expect((await sweep(undefined, grace, { onFailed })).seen).toBe(0);
    });

    it("a throwing sink on the retention path does not fail the sweep either", async () => {
      const old = new Date(T0.getTime() - (CLAIMMD_PAYLOAD_RETENTION_DAYS + 1) * DAY);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      await store([enrollFor("w1", NPI_A)], old);
      await sweep(undefined, old, { cipher: wrongKey }); // never settles
      await store([enrollFor("w2", NPI_B)]);
      const { state, probed } = committedProbe();
      const sinkCalls: boolean[] = [];
      const r = await sweep(undefined, T0, {
        runner: probed,
        onFailed: () => {
          sinkCalls.push(state.committed);
          throw new Error("the ops sink is down");
        },
      });
      expect(sinkCalls).toEqual([true]);
      expect(r.outcomes).toEqual({ published: 1 });
      expect(await outcome("w1")).toMatchObject({
        processing_outcome: "failed",
        payload_cipher: null,
      });
      expect(await outcome("w2")).toMatchObject({ processing_outcome: "published" });
    });

    it("a rolled-back sweep raises no alert: it fires only for rows that are durable", async () => {
      const old = new Date(T0.getTime() - (CLAIMMD_PAYLOAD_RETENTION_DAYS + 1) * DAY);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      await store([enrollFor("x1", NPI_A)], old);
      await sweep(undefined, old, { cipher: wrongKey });
      const calls: string[] = [];
      const failingRunner: ClaimMdSweepDeps["runner"] = async (fn) =>
        runner(async (tx) => {
          await fn(tx);
          throw new Error("the transaction rolls back after the sweep body");
        });
      await expect(
        sweep(undefined, T0, { runner: failingRunner, onFailed: (d) => calls.push(d.eventId) }),
      ).rejects.toThrow("rolls back");
      expect(calls).toEqual([]); // nothing was committed, nothing was announced
      expect(await outcome("x1")).toMatchObject({ processing_outcome: null }); // still unsettled: the retention rolled back too
    });

    // ── rotation with unsettled receipts is visible before the grace window runs out ───────────────────────────────────
    it("warns every sweep, with counts and the oldest receipt time only, while receipts wait under another key id", async () => {
      await store([enrollFor("o1", NPI_A), enrollFor("o2", NPI_B)]);
      await sweep({ isEntitled: async () => false }); // both wait as awaiting_entitlement under the current key id
      const rotated = createWebhookPayloadCipher(Buffer.alloc(32, 5), "claimmd-webhook-v2");
      const warns: Array<{ event: string; detail: Record<string, unknown> }> = [];
      await sweep(undefined, T0, {
        cipher: rotated,
        warn: (event, detail) => warns.push({ event, detail }),
      });
      expect(warns).toEqual([
        {
          event: "claimmd.webhook.unsettled_under_other_key",
          detail: {
            count: 2,
            oldestReceivedAt: T0.toISOString(),
            graceDays: CLAIMMD_KEY_FAULT_GRACE_DAYS,
          },
        },
      ]);
      // No ids and no payload in the warning.
      expect(JSON.stringify(warns)).not.toMatch(/o1|o2/);
      // Under the right key id there is nothing to warn about.
      const quiet: string[] = [];
      await sweep(undefined, T0, { warn: (event) => quiet.push(event) });
      expect(quiet).toEqual([]);
    });

    it("warns every sweep for 24 hours about receipts that went terminal `failed`, so an alert lost to a crash is still visible", async () => {
      await store([enrollFor("l1", NPI_A)]);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      const grace = new Date(T0.getTime() + CLAIMMD_KEY_FAULT_GRACE_DAYS * DAY);
      const warns: Array<{ event: string; detail: Record<string, unknown> }> = [];
      const warn = (event: string, detail: Record<string, unknown>) =>
        warns.push({ event, detail });
      // The receipt goes `failed` here; its onFailed alert never arrives (the sink is down).
      await sweep(undefined, grace, {
        cipher: wrongKey,
        warn,
        onFailed: () => {
          throw new Error("the ops sink is down");
        },
      });
      const expected = {
        event: "claimmd.webhook.recent_failed_receipts",
        detail: { count: 1, oldestProcessedAt: grace.toISOString(), windowHours: 24 },
      };
      expect(warns).toEqual([expected]);
      // Hours later the row is terminal and not selected, but the durable count still shows it (counts and times only).
      const later = new Date(grace.getTime() + 20 * 3_600_000);
      await sweep(undefined, later, { warn });
      expect(warns).toEqual([expected, expected]);
      expect(JSON.stringify(warns)).not.toMatch(/l1/);
      // After the window it stops.
      const beyond = new Date(grace.getTime() + 25 * 3_600_000);
      await sweep(undefined, beyond, { warn });
      expect(warns).toHaveLength(2);
    });

    // A warning count that FAILS in Postgres aborts the transaction it ran in. The counts run in savepoints, so the sweep's own
    // settlements (the receipt published below) are kept and the sweep still answers.
    const failingCount = (pattern: RegExp): ClaimMdSweepDeps["runner"] => {
      const dialect = new PgDialect();
      const wrap = (target: DbClient): DbClient =>
        new Proxy(target, {
          get(real, prop) {
            if (prop === "execute") {
              return (query: SQL) =>
                pattern.test(dialect.sqlToQuery(query).sql)
                  ? real.execute(sql`SELECT 1 / 0`) // a real Postgres error: the transaction (or savepoint) is aborted
                  : real.execute(query);
            }
            if (prop === "transaction") {
              return (run: (sp: DbClient) => Promise<unknown>) =>
                real.transaction((sp) => run(wrap(sp as unknown as DbClient)));
            }
            const value = Reflect.get(real, prop, real);
            return typeof value === "function" ? value.bind(real) : value;
          },
        });
      return (fn) => runner((tx) => fn(wrap(tx as unknown as DbClient)));
    };

    it.each([
      [
        "recent-failed",
        /processing_outcome = 'failed' AND processed_at >=/,
        "claimmd.webhook.recent_failed_count_failed",
      ],
      ["other-key", /payload_key_ref IS DISTINCT FROM/, "claimmd.webhook.unsettled_count_failed"],
    ])(
      "a %s count that fails in Postgres keeps the sweep's settlements and says so by error class",
      async (_label, pattern, event) => {
        await store([enrollFor("c1", NPI_A)]);
        const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
        const result = await sweep(undefined, T0, {
          runner: failingCount(pattern),
          warn: (e, detail) => logs.push({ event: e, detail }),
        });
        expect(result.outcomes).toEqual({ published: 1 });
        expect(await outcome("c1")).toMatchObject({ processing_outcome: "published" }); // not rolled back
        expect(
          (await outbox("m23.clearinghouse.enrollment_reported")).length,
        ).toBeGreaterThanOrEqual(1);
        expect(logs).toHaveLength(1);
        expect(logs[0]?.event).toBe(event);
        expect(Object.keys(logs[0]?.detail ?? {})).toEqual(["errorClass"]);
        expect(JSON.stringify(logs)).not.toMatch(/c1|division/);
      },
    );

    it("sends ONE summary through the alert sink when failed receipts first appear, not one per sweep, and keeps the warn line", async () => {
      await store([enrollFor("s1", NPI_A)]);
      const wrongKey = createWebhookPayloadCipher(Buffer.alloc(32, 9), "claimmd-webhook-v1");
      const grace = new Date(T0.getTime() + CLAIMMD_KEY_FAULT_GRACE_DAYS * DAY);
      const sent: ClaimMdRecentFailedDetail[] = [];
      const warns: string[] = [];
      const onRecentFailedCount = createRecentFailedAlerter((d) => sent.push(d));
      const run = (at: Date, extra: Partial<ClaimMdSweepDeps> = {}) =>
        sweep(undefined, at, { onRecentFailedCount, warn: (e) => warns.push(e), ...extra });
      await run(T0, { cipher: wrongKey }); // unreadable but inside the grace window: still pending, nothing failed, no summary
      expect(sent).toEqual([]);
      await run(grace, { cipher: wrongKey }); // the receipt goes terminal `failed` here
      await run(new Date(grace.getTime() + 60_000));
      await run(new Date(grace.getTime() + 120_000));
      expect(sent).toEqual([{ count: 1, oldestProcessedAt: grace.toISOString(), windowHours: 24 }]);
      expect(warns.filter((e) => e === "claimmd.webhook.recent_failed_receipts")).toHaveLength(3); // the log line stays
      expect(JSON.stringify(sent)).not.toMatch(/s1/);
    });

    it("the retention clear is served by the partial received_at index of migration 1462, the failed count by 1463's", async () => {
      const { rows: failedIx } = await admin.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'claimmd_webhook_event_failed_ix'",
      );
      expect(failedIx).toHaveLength(1);
      expect(failedIx[0].indexdef).toMatch(
        /\(processed_at\) WHERE \(processing_outcome = 'failed'/,
      );
    });

    it("the retention clear is served by the partial received_at index of migration 1462", async () => {
      const { rows } = await admin.query(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'claimmd_webhook_event_cipher_age_ix'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/\(received_at\) WHERE \(payload_cipher IS NOT NULL\)/);
    });
  });

  // ── platform-verified NPI ownership (ADR-0053 amendment precondition 2) ─────────────────────────────────────────
  describe("NPI verification", () => {
    let peC = "";
    const asTenant = async <T>(org: string, fn: () => Promise<T>): Promise<T> => {
      await tenant.query("BEGIN");
      try {
        await tenant.query("SELECT set_config('app.org_id', $1, true)", [org]);
        return await fn();
      } finally {
        await tenant.query("ROLLBACK");
      }
    };

    beforeAll(async () => {
      peC = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'322003','Synthetic Hospice C',$2,'\\x00','12-31') RETURNING id`,
          [ORG_A, NPI_C],
        )
      ).rows[0].id as string;
    });

    beforeEach(async () => {
      await admin.query("DELETE FROM outbox_event WHERE event_type LIKE 'm23.clearinghouse.%'");
    });

    it("lets a tenant read only its own org's verifications and write none", async () => {
      const seen = await asTenant(ORG_A, async () =>
        (await tenant.query("SELECT provider_entity_id FROM provider_npi_verification")).rows.map(
          (r) => r.provider_entity_id,
        ),
      );
      expect(seen).toContain(peA);
      expect(seen).not.toContain(peB); // org B's verification is invisible to org A
      for (const write of [
        `INSERT INTO provider_npi_verification (organization_id, provider_entity_id, npi, evidence, verified_by_membership_id)
         VALUES ('${ORG_A}', '${peC}', '${NPI_C}', 'self-verified', '${OPERATOR}')`,
        "UPDATE provider_npi_verification SET evidence = 'tampered'",
        "DELETE FROM provider_npi_verification",
      ]) {
        await expect(asTenant(ORG_A, () => tenant.query(write))).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it("routes an enrollment only while the entity's current NPI has a live verification", async () => {
      await store([enrollFor("v1", NPI_C)]);
      expect((await sweep()).outcomes).toEqual({ unroutable_npi: 1 }); // registered, never verified

      await npiAdmin.verify(operator, peC, { npi: NPI_C, evidence: "called the CCN contact" });
      await store([enrollFor("v2", NPI_C)]);
      expect((await sweep()).outcomes).toEqual({ published: 1 });
      const [ev] = await outbox("m23.clearinghouse.enrollment_reported");
      expect(ev?.organization_id).toBe(ORG_A);
      expect(ev?.payload).toMatchObject({ providerEntityId: peC });

      // The tenant changes the entity's NPI: the verification was for the old value, so the new one is unroutable.
      await admin.query("UPDATE provider_entity SET npi = $1 WHERE id = $2", [NPI_D, peC]);
      await store([enrollFor("v3", NPI_D), enrollFor("v4", NPI_C)]);
      expect((await sweep()).outcomes).toEqual({ unroutable_npi: 2 });
      expect((await npiAdmin.list()).find((r) => r.providerEntityId === peC)).toMatchObject({
        npi: NPI_D,
        state: "unverified",
      });

      // Re-verifying the new NPI closes the stale live row; a revoke makes it unroutable again.
      await npiAdmin.verify(operator, peC, { npi: NPI_D, evidence: "NPPES record matches" });
      await store([enrollFor("v5", NPI_D)]);
      expect((await sweep()).outcomes).toEqual({ published: 1 });
      const revoked = await npiAdmin.revoke(operator, peC);
      expect(revoked).toMatchObject({ state: "revoked", revokedByMembershipId: OPERATOR });
      await store([enrollFor("v6", NPI_D)]);
      expect((await sweep()).outcomes).toEqual({ unroutable_npi: 1 });
      expect(await outbox("m23.clearinghouse.enrollment_reported")).toHaveLength(2);
    });

    it("closes another entity's stale live verification of an NPI when that NPI is verified elsewhere", async () => {
      // peA (org A) was verified for NPI_A in beforeAll. It moves off NPI_A; org B's new entity takes it and is verified.
      await admin.query("UPDATE provider_entity SET npi = $1 WHERE id = $2", [NPI_E, peA]);
      const peE = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'322004','Synthetic Hospice E',$2,'\\x00','12-31') RETURNING id`,
          [ORG_B, NPI_A],
        )
      ).rows[0].id as string;
      await npiAdmin.verify(operator, peE, { npi: NPI_A, evidence: "NPPES record matches" });
      // Org B vacates NPI_A and org A takes it back: org A's old verification must not revive.
      await admin.query("DELETE FROM provider_entity WHERE id = $1", [peE]);
      await admin.query("UPDATE provider_entity SET npi = $1 WHERE id = $2", [NPI_A, peA]);
      await store([enrollFor("s1", NPI_A)]);
      expect((await sweep()).outcomes).toEqual({ unroutable_npi: 1 });
      await npiAdmin.verify(operator, peA, {
        npi: NPI_A,
        evidence: "re-checked after the NPI moved",
      });
    });

    it("refuses a stale NPI, a double verify and a revoke of nothing", async () => {
      await expect(
        npiAdmin.verify(operator, peB, { npi: NPI_A, evidence: "wrong number" }),
      ).rejects.toMatchObject({ code: "NPI_CHANGED" });
      await expect(
        npiAdmin.verify(operator, peB, { npi: NPI_B, evidence: "again" }),
      ).rejects.toMatchObject({ code: "ALREADY_VERIFIED" });
      await expect(npiAdmin.revoke(operator, peC)).rejects.toMatchObject({ code: "NOT_VERIFIED" });
      await expect(
        npiAdmin.verify(operator, "00000000-0000-4000-8000-00000000dead", {
          npi: NPI_A,
          evidence: "nobody",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("lists every tenant's entities with their state, and audits each write with the operator", async () => {
      const list = await npiAdmin.list();
      expect(list.find((r) => r.providerEntityId === peB)).toMatchObject({
        organizationId: ORG_B,
        organizationName: "cmd-b",
        legalName: "Synthetic Hospice",
        npi: NPI_B,
        state: "verified",
        verifiedByMembershipId: OPERATOR,
      });
      const audit = await admin.query(
        `SELECT event_type, after FROM audit_event WHERE resource_kind = 'provider_npi_verification'
         ORDER BY created_at`,
      );
      const inserts = audit.rows.filter((r) => r.event_type === "provider_npi_verification.insert");
      expect(inserts.length).toBeGreaterThanOrEqual(4);
      for (const r of inserts) expect(r.after.verified_by_membership_id).toBe(OPERATOR);
      expect(
        audit.rows.some(
          (r) =>
            r.event_type === "provider_npi_verification.update" &&
            r.after.revoked_by_membership_id === OPERATOR,
        ),
      ).toBe(true);
      const bypass = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND context->>'jobId' = $1",
        [M23_NPI_VERIFICATION_JOB_ID],
      );
      expect(bypass.rows[0]?.n).toBeGreaterThan(0);
    });
  });

  // The platform carrier may UPDATE only the columns the sweep and the verification service write, and a re-provision
  // takes back an earlier table-wide UPDATE grant.
  it("lets the platform login update only the written columns, even after an older table-wide grant", async () => {
    for (const table of ["provider_npi_verification", "claimmd_webhook_event"]) {
      await admin.query(`GRANT UPDATE ON "${table}" TO chartwarden_platform`);
    }
    provision();
    const login = new Client({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    await login.connect();
    try {
      const denied = async (stmt: string) =>
        expect(login.query(stmt)).rejects.toThrow(/permission denied/);
      await denied("UPDATE provider_npi_verification SET npi = npi WHERE false");
      await denied("UPDATE provider_npi_verification SET evidence = evidence WHERE false");
      await denied("UPDATE claimmd_webhook_event SET payload_sha256 = payload_sha256 WHERE false");
      await denied("UPDATE claimmd_webhook_event SET event_type = event_type WHERE false");
      await login.query(
        "UPDATE provider_npi_verification SET revoked_at = revoked_at, revoked_by_membership_id = revoked_by_membership_id, updated_at = updated_at WHERE false",
      );
      await login.query(
        `UPDATE claimmd_webhook_event SET derived_organization_id = derived_organization_id,
           derived_provider_entity_id = derived_provider_entity_id, last_error_class = last_error_class,
           processing_outcome = processing_outcome, entitlement_checked_at = entitlement_checked_at,
           processed_at = processed_at, attempt_count = attempt_count, payload_cipher = payload_cipher,
           payload_key_ref = payload_key_ref, payload_cleared_at = payload_cleared_at WHERE false`,
      );
    } finally {
      await login.end();
    }
  });
});
