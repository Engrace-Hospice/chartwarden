/**
 * CW-AC-24 — LIVE Postgres proof, as the real NOBYPASSRLS `chartwarden_app` role, that the claims-billing gate
 *   - enforces by default over the REAL M23 entitlement reader (nothing chosen and `outside` are refused, the platform
 *     env fallback org passes) and writes no finding while enforcing;
 *   - in log-only (`shadow`) lets the same work through and records what `enforce` would have blocked as ONE platform-scoped
 *     `m23.claims_billing_gate.would_block` audit row per org, site and reason, through the SECURITY DEFINER platform writer;
 *   - records the mode it booted with (`m23.claims_billing_gate.mode_bound`), with the operator's reason below `enforce`;
 *   - never lets a tenant read those rows (they are platform-scoped), and carries ids and codes only;
 *   - fails closed (503) on a real failed read in `enforce`, and in `shadow` records a would_fail_closed and goes ahead;
 *   - never blocks the work when the audit write itself fails.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:claims-billing:gate-audit:live
 * Run it against a private `chartwarden-postgres:dev` container on its own port, never the shared Docker cluster.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimsBillingVerdict,
  configureClaimsBillingGate,
} from "../src/bootstrap/claims-billing-gate";
import {
  GATE_MODE_BOUND_EVENT,
  GATE_WOULD_BLOCK_EVENT,
  createGateFindingSink,
  recordGateModeBound,
} from "../src/bootstrap/claims-billing-gate-audit";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { registerM23TenantClearinghouseSeams } from "../src/modules/23-billing-medicare/tenant-clearinghouse/register";
import { createDrizzleSubscriptionWorkBlockReader } from "../src/modules/35-subscription/addon/entitlement";
import {
  appRoleConnectionString,
  appRoleUrl,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_NOT_CHOSEN = "c1000000-0000-4000-8000-000000000001";
const ORG_OUTSIDE = "c1000000-0000-4000-8000-000000000002";
const ORG_FALLBACK = "c1000000-0000-4000-8000-000000000003";
const MEMBERSHIP = "e9000000-0000-4000-8000-0000000000e9";
const SUBMIT = { route: "POST /api/v1/claims/:id/submit" };
const REASON = "CW-AC-24 log-only until the rollout review";

interface AuditRow {
  readonly organization_id: string | null;
  readonly actor_kind: string;
  readonly event_type: string;
  readonly resource_kind: string;
  readonly resource_id: string | null;
  readonly outcome: string;
  readonly severity: string;
  readonly retention_class: string;
  readonly context: Record<string, unknown>;
}

describe.skipIf(!DB_URL)(
  "CW-AC-24 claims-billing gate — enforce, log-only findings, audit — LIVE Postgres",
  () => {
    let admin: Client;
    let pool: ReturnType<typeof createDbClient>;
    const logs: Array<[string, Record<string, unknown>]> = [];
    const log = (message: string, detail: Record<string, unknown>) => {
      logs.push([message, detail]);
    };

    /** Platform-scoped gate rows, read as the superuser (the app role cannot read a null-org row, asserted below). */
    const gateRows = async (eventType?: string): Promise<AuditRow[]> =>
      (
        await admin.query<AuditRow>(
          `SELECT organization_id, actor_kind, event_type, resource_kind, resource_id::text, outcome, severity,
                  retention_class, context
             FROM audit_event
            WHERE event_type LIKE 'm23.claims_billing_gate.%' AND ($1::text IS NULL OR event_type = $1)
            ORDER BY created_at, id`,
          [eventType ?? null],
        )
      ).rows;

    const bindRealReader = (db: ReturnType<typeof createDbClient>["db"]) => {
      registerSeam("SubscriptionWorkBlockReader", createDrizzleSubscriptionWorkBlockReader(db));
      registerM23TenantClearinghouseSeams({
        db,
        env: {
          CLEARINGHOUSE_VENDOR: "in_memory",
          CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS: ORG_FALLBACK,
        },
      });
    };

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await admin.query("CREATE SCHEMA IF NOT EXISTS public");
      await dropLiveRoles(admin);
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
      for (const [id, slug] of [
        [ORG_NOT_CHOSEN, "gate-not-chosen"],
        [ORG_OUTSIDE, "gate-outside"],
        [ORG_FALLBACK, "gate-fallback"],
      ] as const) {
        await admin.query(
          "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
          [id, slug],
        );
      }
      await admin.query(
        "INSERT INTO tenant_clearinghouse_config (organization_id, vendor, status, set_by_membership_id) VALUES ($1,'outside','active',$2)",
        [ORG_OUTSIDE, MEMBERSHIP],
      );
      pool = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      bindRealReader(pool.db);
    }, 300_000);

    afterAll(async () => {
      configureClaimsBillingGate({ mode: "enforce", log: () => {} });
      __resetSeamsForTest();
      await pool?.close();
      await admin?.end();
    });

    it("enforce (the default): nothing chosen and outside are refused with their reason, the env fallback org passes, and no finding is written", async () => {
      configureClaimsBillingGate({
        mode: "enforce",
        log,
        recordFinding: createGateFindingSink(pool.db),
      });
      expect(await claimsBillingVerdict(ORG_NOT_CHOSEN, SUBMIT)).toEqual({
        allow: false,
        reason: "clearinghouse_not_chosen",
      });
      expect(await claimsBillingVerdict(ORG_OUTSIDE, SUBMIT)).toEqual({
        allow: false,
        reason: "clearinghouse_outside",
      });
      expect(await claimsBillingVerdict(ORG_FALLBACK, SUBMIT)).toEqual({ allow: true });
      expect(await gateRows(GATE_WOULD_BLOCK_EVENT)).toEqual([]);
    });

    it("shadow: the same work goes ahead, and each refusal enforce would have made is ONE platform audit row", async () => {
      configureClaimsBillingGate({
        mode: "shadow",
        log,
        recordFinding: createGateFindingSink(pool.db),
      });
      for (let hit = 0; hit < 3; hit += 1) {
        expect(await claimsBillingVerdict(ORG_NOT_CHOSEN, SUBMIT)).toEqual({ allow: true });
        expect(await claimsBillingVerdict(ORG_OUTSIDE, SUBMIT)).toEqual({ allow: true });
        expect(await claimsBillingVerdict(ORG_FALLBACK, SUBMIT)).toEqual({ allow: true });
      }
      await claimsBillingVerdict(ORG_NOT_CHOSEN, { queue: "m23.claim.submit" }); // a worker site is another finding
      const rows = await gateRows(GATE_WOULD_BLOCK_EVENT);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          organization_id: null,
          actor_kind: "system",
          resource_kind: "organization",
          outcome: "success",
          severity: "warn",
          retention_class: "compliance",
        });
      }
      const byOrg = (org: string, site: string) =>
        rows.find((r) => r.resource_id === org && (r.context.route ?? r.context.queue) === site);
      expect(byOrg(ORG_NOT_CHOSEN, SUBMIT.route)?.context).toEqual({
        organizationId: ORG_NOT_CHOSEN,
        outcome: "would_deny",
        reason: "clearinghouse_not_chosen",
        route: SUBMIT.route,
      });
      expect(byOrg(ORG_OUTSIDE, SUBMIT.route)?.context).toMatchObject({
        reason: "clearinghouse_outside",
      });
      expect(byOrg(ORG_NOT_CHOSEN, "m23.claim.submit")?.context).toMatchObject({
        outcome: "would_deny",
        queue: "m23.claim.submit",
      });
      // the env fallback org would not be refused, so log-only has nothing to say about it
      expect(rows.some((r) => r.resource_id === ORG_FALLBACK)).toBe(false);
    });

    it("a tenant session reads none of the gate rows (they are platform-scoped), and the rows carry no value but ids and codes", async () => {
      // the superuser sees the rows, so a zero below is the policy, not an empty table (also when this test runs alone)
      if ((await gateRows(GATE_WOULD_BLOCK_EVENT)).length === 0) {
        configureClaimsBillingGate({
          mode: "shadow",
          log,
          recordFinding: createGateFindingSink(pool.db),
        });
        await claimsBillingVerdict(ORG_NOT_CHOSEN, SUBMIT);
      }
      expect((await gateRows(GATE_WOULD_BLOCK_EVENT)).length).toBeGreaterThan(0);
      const tenant = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await tenant.connect();
      try {
        await tenant.query("BEGIN");
        await tenant.query("SELECT set_config('app.org_id', $1, true)", [ORG_NOT_CHOSEN]);
        const { rows } = await tenant.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type LIKE 'm23.claims_billing_gate.%'",
        );
        await tenant.query("ROLLBACK");
        expect(rows[0]?.n).toBe(0);
      } finally {
        await tenant.end();
      }
      const allowed = new Set(["organizationId", "outcome", "reason", "route", "queue"]);
      for (const row of await gateRows(GATE_WOULD_BLOCK_EVENT)) {
        expect(Object.keys(row.context).filter((k) => !allowed.has(k))).toEqual([]);
      }
    });

    it("a real failed read: enforce fails closed with 503, shadow goes ahead and records a would_fail_closed", async () => {
      const broken = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      await broken.close(); // every read on this pool now fails, as a database outage would
      bindRealReader(broken.db);
      configureClaimsBillingGate({
        mode: "enforce",
        log,
        recordFinding: createGateFindingSink(pool.db),
      });
      await expect(claimsBillingVerdict(ORG_OUTSIDE, SUBMIT)).rejects.toMatchObject({
        statusCode: 503,
        code: "BILLING_ENTITLEMENT_UNAVAILABLE",
      });
      configureClaimsBillingGate({
        mode: "shadow",
        log,
        recordFinding: createGateFindingSink(pool.db),
      });
      expect(await claimsBillingVerdict(ORG_OUTSIDE, SUBMIT)).toEqual({ allow: true });
      const failed = (await gateRows(GATE_WOULD_BLOCK_EVENT)).filter(
        (r) => r.context.outcome === "would_fail_closed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.context).toMatchObject({
        organizationId: ORG_OUTSIDE,
        reason: "entitlement_unavailable",
        route: SUBMIT.route,
      });
      bindRealReader(pool.db);
    });

    it("a failed audit write is logged and never blocks the work", async () => {
      const dead = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      await dead.close();
      logs.length = 0;
      configureClaimsBillingGate({
        mode: "shadow",
        log,
        recordFinding: createGateFindingSink(dead.db),
      });
      expect(
        await claimsBillingVerdict(ORG_NOT_CHOSEN, { route: "POST /api/v1/eligibility" }),
      ).toEqual({ allow: true });
      expect(logs.some(([m]) => m === "claims-billing finding not recorded")).toBe(true);
      expect(
        (await gateRows(GATE_WOULD_BLOCK_EVENT)).some(
          (r) => r.context.route === "POST /api/v1/eligibility",
        ),
      ).toBe(false);
    });

    it("the boot records the mode: a warn row with the operator's reason below enforce, an info row when enforcing", async () => {
      await recordGateModeBound(pool.db, {
        mode: "shadow",
        logOnlyReason: REASON,
        processRole: "api",
        nodeEnv: "production",
      });
      await recordGateModeBound(pool.db, {
        mode: "enforce",
        processRole: "worker",
        nodeEnv: "production",
      });
      const rows = await gateRows(GATE_MODE_BOUND_EVENT);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        organization_id: null,
        actor_kind: "system",
        resource_kind: "claims_billing_gate",
        severity: "warn",
        retention_class: "compliance",
      });
      expect(rows[0]?.context).toEqual({
        mode: "shadow",
        processRole: "api",
        nodeEnv: "production",
        logOnlyReason: REASON,
      });
      expect(rows[1]).toMatchObject({ severity: "info" });
      expect(rows[1]?.context).toEqual({
        mode: "enforce",
        processRole: "worker",
        nodeEnv: "production",
      });
    });
  },
);
