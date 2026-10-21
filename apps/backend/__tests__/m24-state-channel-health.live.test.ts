/**
 * M24 Billing — Medicaid — F-172 (#248, m1 group): the §4.9 `state-channel-health` cron, proven against
 * real Postgres. `M24_CRON_QUEUES.stateChannelHealth` was declared in the queue catalog with no worker,
 * no schedule, and no handler anywhere — genuinely unbuilt, not merely unwired. `runStateChannelHealth`
 * is driven directly (not through BullMQ — the queue/worker wrapper is a thin, untested-here shim; the
 * value under test is the real Drizzle reads under RLS + the real credential decrypt + the breaker/debounce
 * logic + the real catalog-shaped outbox publish) as the NOBYPASSRLS `wardenx_app` role.
 *
 * Gated on a live DB: CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run <this file>
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCredentialCipherPort } from "../src/modules/24-billing-medicaid/credential-crypto";
import {
  type StateChannelBreakerState,
  type StateChannelHealthProbePort,
  buildDrizzleActivePeStatesLister,
  buildDrizzleStateChannelCredentialResolver,
  runStateChannelHealth,
} from "../src/modules/24-billing-medicaid/jobs/state-channel-health-jobs";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

const TEST_KEK = Buffer.alloc(32, 9);

describe.skipIf(!DB_URL)(
  "M24 state-channel-health cron — LIVE Postgres (F-172, #248, m1 group)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peA: string;
    let peB: string;
    const cipher = buildCredentialCipherPort(TEST_KEK);

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    async function seedOrg(orgId: string, slug: string): Promise<string> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, slug],
      );
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'PE',$3,'enc','0930') RETURNING id`,
        [
          orgId,
          slug === "org-a" ? "111111" : "222222",
          // `provider_entity_npi_idx` is globally unique.
          slug === "org-a" ? "1234567890" : "1234567891",
        ],
      );
      return pe.rows[0].id;
    }

    /** Expire every currently-active credential for an org (a real credential-rotation shape) so each
     * test's `listActivePeStatesForOrg(orgId)` read — which is genuinely org-scoped, not per-test-scoped —
     * only ever sees the ONE credential the test just seeded, not every credential this file has ever
     * seeded for that org across earlier tests. */
    async function expireActiveCredentialsForOrg(orgId: string): Promise<void> {
      await admin.query(
        "UPDATE state_medicaid_trading_partner_credential SET active_to = now() - interval '1 hour' WHERE organization_id=$1 AND active_to IS NULL",
        [orgId],
      );
    }

    /** Seed one ACTIVE `state_medicaid_trading_partner_credential` row, secret sealed under the real
     * (test) KEK — so the resolver's decrypt path is genuinely exercised, not stubbed. */
    async function seedCredential(args: {
      readonly orgId: string;
      readonly providerEntityId: string;
      readonly serviceState: string;
      readonly channel: string;
      readonly portalUrl: string;
      readonly clientSecret: string;
    }): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO state_medicaid_trading_partner_credential
           (id, organization_id, provider_entity_id, service_state, channel, trading_partner_id,
            client_id, client_secret_cipher, portal_url, active_from,
            created_by_membership_id, updated_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'TP-1','client-1',$6,$7, now() - interval '1 day', $8, $8)`,
        [
          id,
          args.orgId,
          args.providerEntityId,
          args.serviceState,
          args.channel,
          cipher.seal(args.orgId, args.clientSecret),
          args.portalUrl,
          USER,
        ],
      );
      return id;
    }

    function fakeActiveOrgs(...orgIds: string[]) {
      return {
        async listActiveOrgs() {
          return orgIds.map((organizationId) => ({ organizationId }));
        },
      };
    }

    function fakeOutbox() {
      const published: Array<{
        eventName: string;
        organizationId: string;
        aggregateKind: string;
        aggregateId: string;
        payload: Record<string, unknown>;
      }> = [];
      return {
        published,
        port: {
          async publish(_tx: unknown, event: (typeof published)[number]) {
            published.push(event);
          },
        },
      };
    }

    /** A scripted probe: `answers` is consulted in order per call, `null` entries mean "no live gateway". */
    function scriptedProbe(
      answers: ReadonlyArray<{ ok: boolean } | null>,
    ): StateChannelHealthProbePort {
      let i = 0;
      const seenSecrets: string[] = [];
      return {
        seenSecrets,
        async probe(_state, credentials) {
          seenSecrets.push(credentials.clientSecret ?? "");
          const a = answers[Math.min(i, answers.length - 1)];
          i += 1;
          return a;
        },
      } as StateChannelHealthProbePort & { seenSecrets: string[] };
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m24statechannel@x.test')`, [
        USER,
      ]);
      peA = await seedOrg(ORG_A, "org-a");
      peB = await seedOrg(ORG_B, "org-b");
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("first probe seeds the breaker — no transition, no event, even on a failing first tick", async () => {
      await seedCredential({
        orgId: ORG_A,
        providerEntityId: peA,
        serviceState: "OR",
        channel: "direct_mmis",
        portalUrl: "https://oha.example.test",
        clientSecret: "secret-first-tick",
      });
      const outbox = fakeOutbox();
      const breaker = new Map<string, StateChannelBreakerState>();
      const probe = scriptedProbe([{ ok: false }]);

      await runStateChannelHealth(
        {
          db: handle.db,
          activeOrgs: fakeActiveOrgs(ORG_A),
          listPeStates: buildDrizzleActivePeStatesLister(),
          credentials: buildDrizzleStateChannelCredentialResolver(cipher),
          probe,
          outbox: outbox.port,
        },
        breaker,
      );

      expect(outbox.published).toHaveLength(0);
      expect((probe as unknown as { seenSecrets: string[] }).seenSecrets).toEqual([
        "secret-first-tick",
      ]);
    });

    it("three consecutive down probes report .unavailable exactly once, at the third tick (§7.8 debounce)", async () => {
      await expireActiveCredentialsForOrg(ORG_A);
      await seedCredential({
        orgId: ORG_A,
        providerEntityId: peA,
        serviceState: "T2",
        channel: "cco_clearinghouse",
        portalUrl: "https://cco.example.test",
        clientSecret: "secret-debounce",
      });
      const breaker = new Map<string, StateChannelBreakerState>();
      const deps = (
        outbox: ReturnType<typeof fakeOutbox>["port"],
        probe: StateChannelHealthProbePort,
      ) => ({
        db: handle.db,
        activeOrgs: fakeActiveOrgs(ORG_A),
        listPeStates: buildDrizzleActivePeStatesLister(),
        credentials: buildDrizzleStateChannelCredentialResolver(cipher),
        probe,
        outbox,
      });

      // Tick 1: seed.
      const o1 = fakeOutbox();
      await runStateChannelHealth(deps(o1.port, scriptedProbe([{ ok: false }])), breaker);
      expect(o1.published).toHaveLength(0);

      // Tick 2: still down, still inside the debounce window.
      const o2 = fakeOutbox();
      await runStateChannelHealth(deps(o2.port, scriptedProbe([{ ok: false }])), breaker);
      expect(o2.published).toHaveLength(0);

      // Tick 3: third consecutive failure — reports.
      const o3 = fakeOutbox();
      await runStateChannelHealth(deps(o3.port, scriptedProbe([{ ok: false }])), breaker);
      expect(o3.published).toHaveLength(1);
      expect(o3.published[0]).toMatchObject({
        eventName: "m24.medicaid_state_channel.unavailable",
        organizationId: ORG_A,
        aggregateKind: "medicaid_state_channel",
      });
      expect(o3.published[0]?.payload).toMatchObject({
        organizationId: ORG_A,
        state: "T2",
        channel: "cco_clearinghouse",
      });

      // Tick 4: still down — must NOT re-report.
      const o4 = fakeOutbox();
      await runStateChannelHealth(deps(o4.port, scriptedProbe([{ ok: false }])), breaker);
      expect(o4.published).toHaveLength(0);
    });

    it("recovery is reported on the very next successful probe — no debounce on the way up", async () => {
      await expireActiveCredentialsForOrg(ORG_A);
      await seedCredential({
        orgId: ORG_A,
        providerEntityId: peA,
        serviceState: "T3",
        channel: "direct_mmis",
        portalUrl: "https://recovery.example.test",
        clientSecret: "secret-recovery",
      });
      const breaker = new Map<string, StateChannelBreakerState>();
      const deps = (
        outbox: ReturnType<typeof fakeOutbox>["port"],
        probe: StateChannelHealthProbePort,
      ) => ({
        db: handle.db,
        activeOrgs: fakeActiveOrgs(ORG_A),
        listPeStates: buildDrizzleActivePeStatesLister(),
        credentials: buildDrizzleStateChannelCredentialResolver(cipher),
        probe,
        outbox,
      });

      const seed = fakeOutbox();
      await runStateChannelHealth(deps(seed.port, scriptedProbe([{ ok: false }])), breaker);
      const down2 = fakeOutbox();
      await runStateChannelHealth(deps(down2.port, scriptedProbe([{ ok: false }])), breaker);
      const down3 = fakeOutbox();
      await runStateChannelHealth(deps(down3.port, scriptedProbe([{ ok: false }])), breaker);
      expect(down3.published).toHaveLength(1);
      expect(down3.published[0]?.eventName).toBe("m24.medicaid_state_channel.unavailable");
      const downedAt = down3.published[0]?.payload.downedAt as string;

      const recovered = fakeOutbox();
      await runStateChannelHealth(deps(recovered.port, scriptedProbe([{ ok: true }])), breaker);
      expect(recovered.published).toHaveLength(1);
      expect(recovered.published[0]).toMatchObject({
        eventName: "m24.medicaid_state_channel.recovered",
        organizationId: ORG_A,
      });
      expect(recovered.published[0]?.payload).toMatchObject({
        state: "T3",
        channel: "direct_mmis",
        downedAt, // the recovery event reports the SAME outage-start instant the down event reported
      });

      // Same aggregate id on both events for this (org, state, channel) — a real state-page consumer
      // needs the pair to key onto the same component.
      expect(recovered.published[0]?.aggregateId).toBe(down3.published[0]?.aggregateId);
    });

    it("a state with no live gateway configured (probe returns null) is silent forever, never reported down", async () => {
      await expireActiveCredentialsForOrg(ORG_A);
      await seedCredential({
        orgId: ORG_A,
        providerEntityId: peA,
        serviceState: "WA", // no live gateway for WA (Phase-1 deny-stub)
        channel: "direct_mmis",
        portalUrl: "https://wa.example.test",
        clientSecret: "secret-no-gateway",
      });
      const outbox = fakeOutbox();
      const breaker = new Map<string, StateChannelBreakerState>();
      const nullProbe: StateChannelHealthProbePort = { probe: async () => null };

      for (let i = 0; i < 5; i += 1) {
        await runStateChannelHealth(
          {
            db: handle.db,
            activeOrgs: fakeActiveOrgs(ORG_A),
            listPeStates: buildDrizzleActivePeStatesLister(),
            credentials: buildDrizzleStateChannelCredentialResolver(cipher),
            probe: nullProbe,
            outbox: outbox.port,
          },
          breaker,
        );
      }

      expect(outbox.published).toHaveLength(0);
    });

    it("cross-tenant isolation: org A's down transition never reports for org B, and org B's own credential resolves independently under its own RLS scope", async () => {
      await expireActiveCredentialsForOrg(ORG_A);
      await expireActiveCredentialsForOrg(ORG_B);
      await seedCredential({
        orgId: ORG_A,
        providerEntityId: peA,
        serviceState: "T5",
        channel: "direct_mmis",
        portalUrl: "https://iso-a.example.test",
        clientSecret: "secret-iso-a",
      });
      await seedCredential({
        orgId: ORG_B,
        providerEntityId: peB,
        serviceState: "T5",
        channel: "direct_mmis",
        portalUrl: "https://iso-b.example.test",
        clientSecret: "secret-iso-b",
      });
      const breaker = new Map<string, StateChannelBreakerState>();
      // Org A always fails, org B always succeeds — the probe discriminates by portalUrl so each org's
      // own resolved (decrypted) credential drives its own outcome.
      const probe: StateChannelHealthProbePort = {
        async probe(_state, credentials) {
          return { ok: credentials.portalUrl !== "https://iso-a.example.test" };
        },
      };
      const deps = (outbox: ReturnType<typeof fakeOutbox>["port"]) => ({
        db: handle.db,
        activeOrgs: fakeActiveOrgs(ORG_A, ORG_B),
        listPeStates: buildDrizzleActivePeStatesLister(),
        credentials: buildDrizzleStateChannelCredentialResolver(cipher),
        probe,
        outbox,
      });

      await runStateChannelHealth(deps(fakeOutbox().port), breaker); // seed
      await runStateChannelHealth(deps(fakeOutbox().port), breaker); // tick 2
      const o3 = fakeOutbox();
      await runStateChannelHealth(deps(o3.port), breaker); // tick 3 — org A crosses the threshold

      expect(o3.published).toHaveLength(1);
      expect(o3.published[0]?.organizationId).toBe(ORG_A);
      expect(o3.published.some((p) => p.organizationId === ORG_B)).toBe(false);
    });
  },
);
