/**
 * CW-MON-01 — the scheduled review of the audit trail, LIVE Postgres as the real NOBYPASSRLS `chartwarden_app` role (org lane)
 * and the BYPASSRLS `chartwarden_platform_login` (org-less authentication lane). Proves on a real database:
 *   1. events in → alert out → a review record written (org lane), the alert carrying ids and codes only;
 *   2. a second run raises nothing again (fingerprint dedupe) and resumes from the first run's window;
 *   3. a FAILED delivery is recorded, the cursor does not move, and the next run retries it; "no destination configured" is a
 *      terminal, visible outcome (never a silent drop);
 *   4. bulk record access is aggregated in SQL (120 distinct patients flagged, 99 not);
 *   5. the platform lane reads ONLY org-less rows (a tenant's identical event types are not evaluated there), writes its record
 *      through the platform writer, and every entry is an audited `platform.bypass_invoked`;
 *   6. why the platform lane exists, and how narrow it is (migration 1566): a tenant context cannot read org-less rows, and the
 *      platform login holds NO SELECT on `audit_event` — a direct read of any column is refused — only EXECUTE on three
 *      SECURITY DEFINER readers, owned by a NOLOGIN role that is itself confined by row security to org-less rows;
 *   6b. the readers return exactly the rules' inputs (seven values, org-less rows, no tenant row, no free text), and every bound
 *      (event types, window, age, row cap) is refused with 22023, tied to the review's own constants;
 *   7. tenant isolation: org B's review neither reads nor alerts on org A's events, and org A's review rows are invisible to B;
 *   8. a tick over both lanes fails (AggregateError) when an alert cannot be delivered, after the record is committed.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m4:security-review:live
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_CATCH_UP_MS,
  MAX_SIGNAL_ROWS,
  type SecurityAlert,
  type SecurityAlertSink,
  type SecurityReviewResult,
  auditPlatformEvent,
} from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  resetPlatformJobRegistry,
  systemOrgContext,
  withOrgContext,
} from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M4_SECURITY_REVIEW_PLATFORM_JOB_ID,
  type SecurityReviewDeps,
  runSecurityReviewForOrg,
  runSecurityReviewForPlatform,
  runSecurityReviewTick,
} from "../src/modules/04-audit/jobs/security-review-job";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const PLATFORM_PASSWORD = "platform-live-password-m4-review";

const ORG_A = "00000000-0000-4000-8000-0000000004a1";
const ORG_B = "00000000-0000-4000-8000-0000000004b1";
const USER_1 = "00000000-0000-4000-8000-0000000004c1"; // the actor of the authz denials and the break-glass
const USER_BULK = "00000000-0000-4000-8000-0000000004c2"; // 120 distinct records
const USER_BELOW = "00000000-0000-4000-8000-0000000004c3"; // 99 distinct records
const USER_TRAVEL = "00000000-0000-4000-8000-0000000004c4"; // signs in from three networks
const USER_B = "00000000-0000-4000-8000-0000000004c5";

const MINUTE = 60_000;
const BULK_BUCKET = 15 * MINUTE;
const BREAK_GLASS = "m3.breakglass.invoked";
const COMPLETED = "m4.security_review.completed";
const RAISED = "m4.security_review.alert_raised";

describe.skipIf(!DB_URL)("M4 security review of the audit trail — LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let platform: ReturnType<typeof createDbClient>;
  let correlation = 0;

  // The REAL clock, on purpose: the review's own rows are stamped by the database (`created_at` defaults to now()), and the
  // dedupe look-up compares them with the review's `now`, so an injected clock that ran ahead of the database would hide them.
  const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE).toISOString();

  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

  const auditBypass: PlatformBypassAuditor<typeof platform.db> = async (tx, event) => {
    await auditPlatformEvent(tx, {
      eventType: "platform.bypass_invoked",
      resourceKind: "tenant",
      outcome: "success",
      severity: event.severity,
      correlationId: `platform-bypass:${event.jobId}`,
      context: { jobId: event.jobId, reason: event.reason },
    });
  };

  const collect = (): { alerts: SecurityAlert[]; sink: SecurityAlertSink } => {
    const alerts: SecurityAlert[] = [];
    return {
      alerts,
      sink: async (alert) => {
        alerts.push(alert);
        return "delivered";
      },
    };
  };
  /** The result of a review that actually ran (a skipped one is a test failure here). */
  const ran = (result: SecurityReviewResult): Extract<SecurityReviewResult, { skipped: false }> => {
    if (result.skipped)
      throw new Error("the review was skipped: another run held the scope's lock");
    return result;
  };
  const failing: SecurityAlertSink = async () => "failed";
  const noDestination: SecurityAlertSink = async () => "no_destination";

  const deps = (sink: SecurityAlertSink, orgs = [ORG_A, ORG_B]): SecurityReviewDeps => ({
    db: app.db,
    platformDb: platform.db,
    auditBypass,
    listOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
    sink,
    now: () => new Date(),
    newCorrelationId: () => `m4-review-live-${++correlation}`,
  });

  /** One audit row as the superuser (the trail is append-only for the app role). */
  async function seed(input: {
    organizationId: string | null;
    actorUserId?: string | null;
    eventType: string;
    at: string;
    context?: Record<string, unknown>;
    resourceKind?: string;
    resourceId?: string | null;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
         correlation_id, outcome, severity, context, retention_class, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'success','info',$8::jsonb,'compliance',$9::timestamptz)`,
      [
        input.organizationId,
        input.actorUserId ?? null,
        input.actorUserId ? "user" : "system",
        input.eventType,
        input.resourceKind ?? "session",
        input.resourceId ?? null,
        `seed-${input.eventType}`,
        JSON.stringify(input.context ?? {}),
        input.at,
      ],
    );
  }

  /**
   * The SQLSTATE of a statement run as the platform login (Drizzle wraps the driver error; the code is on its cause), or "ok" when
   * it succeeded. An error that carries no SQLSTATE (a dropped connection, a timeout) is rethrown: it must never read as success.
   */
  const sqlState = async (query: ReturnType<typeof sql>): Promise<string> => {
    try {
      await platform.db.execute(query);
      return "ok";
    } catch (error) {
      const code = ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string }))
        .code;
      if (code === undefined) throw error;
      return code;
    }
  };

  const reviewRows = async (organizationId: string | null, eventType: string) =>
    (
      await admin.query(
        `SELECT context, actor_kind, actor_user_id, severity FROM audit_event
          WHERE ${organizationId === null ? "organization_id IS NULL" : "organization_id = $1"} AND event_type = $${organizationId === null ? 1 : 2}
          ORDER BY created_at, id`,
        organizationId === null ? [eventType] : [organizationId, eventType],
      )
    ).rows as {
      context: Record<string, unknown>;
      actor_kind: string;
      actor_user_id: string | null;
      severity: string;
    }[];

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
    // The platform carrier + login: migration 1561 grants the carrier its columns only where the carrier already exists,
    // so provisioning AFTER the migrations is exactly what a fresh database goes through (and re-grants on every run).
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
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerPlatformJob(M4_SECURITY_REVIEW_PLATFORM_JOB_ID);
    for (const [org, slug] of [
      [ORG_A, "m4rev-a"],
      [ORG_B, "m4rev-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
    }
    for (const [i, id] of [USER_1, USER_BULK, USER_BELOW, USER_TRAVEL, USER_B].entries()) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
        id,
        `m4rev${i}@example.test`,
      ]);
    }
  }, 300_000);

  afterAll(async () => {
    resetPlatformJobRegistry();
    await app?.close();
    await platform?.close();
    await admin?.end();
  });

  it("org lane: events in, alert out, a review record written — ids and codes only, this org only", async () => {
    await seed({ organizationId: ORG_A, actorUserId: USER_1, eventType: BREAK_GLASS, at: ago(5) });
    await seed({ organizationId: ORG_B, actorUserId: USER_B, eventType: BREAK_GLASS, at: ago(5) });
    for (let i = 0; i < 10; i += 1) {
      await seed({
        organizationId: ORG_A,
        actorUserId: USER_1,
        eventType: "m3.authz.denied",
        at: ago(8 - i * 0.3),
      });
    }
    const { alerts, sink } = collect();
    const { run, raised } = ran(await runSecurityReviewForOrg(deps(sink), ORG_A));

    expect(alerts.map((a) => a.ruleId).sort()).toEqual([
      "access.authorization_denial_burst",
      "access.break_glass_invoked",
    ]);
    expect(alerts.every((a) => a.organizationId === ORG_A && a.lane === "org")).toBe(true);
    expect(raised.every((r) => r.delivery === "delivered")).toBe(true);
    const burst = alerts.find((a) => a.ruleId === "access.authorization_denial_burst");
    expect(burst).toMatchObject({
      count: 10,
      severity: "warn",
      subject: { kind: "actor", ref: USER_1 },
    });
    // ids and codes only: nothing in an alert but the documented keys
    expect(Object.keys(burst as SecurityAlert).sort()).toEqual(
      [
        "controls",
        "count",
        "fingerprint",
        "kind",
        "lane",
        "organizationId",
        "ruleId",
        "rulesVersion",
        "runbook",
        "sampleEventIds",
        "severity",
        "subject",
        "title",
        "windowFrom",
        "windowTo",
      ].sort(),
    );

    expect(run).toMatchObject({
      status: "ok",
      lane: "org",
      findings: 2,
      newAlerts: 2,
      delivered: 2,
      failed: 0,
      noDestination: 0,
      deferred: 0,
    });
    const records = await reviewRows(ORG_A, COMPLETED);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      actor_kind: "system",
      actor_user_id: null,
      severity: "info",
    });
    expect(records[0]?.context).toMatchObject({
      status: "ok",
      lane: "org",
      newAlerts: 2,
      windowTo: expect.any(String),
    });
    const alertRows = await reviewRows(ORG_A, RAISED);
    expect(alertRows).toHaveLength(2);
    expect(alertRows.every((r) => r.context.delivery === "delivered")).toBe(true);
    expect(alertRows.find((r) => r.context.ruleId === "access.break_glass_invoked")?.severity).toBe(
      "critical",
    );
  });

  it("raises nothing twice, and the next run resumes from the last clean window", async () => {
    const first = (await reviewRows(ORG_A, COMPLETED))[0]?.context.windowTo as string;
    const { alerts, sink } = collect();
    const { run } = ran(await runSecurityReviewForOrg(deps(sink), ORG_A));
    expect(alerts).toEqual([]);
    expect(run).toMatchObject({ status: "ok", newAlerts: 0, windowFrom: first });
    expect(await reviewRows(ORG_A, COMPLETED)).toHaveLength(2);
    expect(await reviewRows(ORG_A, RAISED)).toHaveLength(2);
  });

  it("a failed delivery is recorded, holds the cursor, and is retried by the next run", async () => {
    await seed({ organizationId: ORG_A, actorUserId: USER_1, eventType: BREAK_GLASS, at: ago(0) });
    const lastOk = (await reviewRows(ORG_A, COMPLETED)).at(-1)?.context.windowTo as string;

    const failedRun = ran(await runSecurityReviewForOrg(deps(failing), ORG_A));
    expect(failedRun.run).toMatchObject({ status: "delivery_failed", failed: 1, delivered: 0 });
    const rows = await reviewRows(ORG_A, RAISED);
    expect(rows.at(-1)?.context.delivery).toBe("failed");
    expect((await reviewRows(ORG_A, COMPLETED)).at(-1)).toMatchObject({ severity: "warn" });

    const { alerts, sink } = collect();
    const retry = ran(await runSecurityReviewForOrg(deps(sink), ORG_A));
    expect(retry.run.windowFrom).toBe(lastOk); // the failed run did not move the cursor
    expect(alerts.map((a) => a.ruleId)).toEqual(["access.break_glass_invoked"]);
    expect(retry.run).toMatchObject({ status: "ok", delivered: 1 });

    const again = collect();
    await runSecurityReviewForOrg(deps(again.sink), ORG_A);
    expect(again.alerts).toEqual([]);
  });

  it("with no destination configured an alert is recorded `no_destination` (terminal and visible), not dropped", async () => {
    await seed({ organizationId: ORG_A, actorUserId: USER_1, eventType: BREAK_GLASS, at: ago(0) });
    const { run, raised } = ran(await runSecurityReviewForOrg(deps(noDestination), ORG_A));
    expect(raised.map((r) => r.delivery)).toEqual(["no_destination"]);
    expect(run).toMatchObject({ status: "ok", noDestination: 1, delivered: 0 });
    expect((await reviewRows(ORG_A, RAISED)).at(-1)?.context.delivery).toBe("no_destination");
    const again = collect();
    await runSecurityReviewForOrg(deps(again.sink), ORG_A);
    expect(again.alerts).toEqual([]);
  });

  it("one run per scope at a time: a run that finds the scope's lock taken is skipped, reads nothing and writes no record", async () => {
    const before = (await reviewRows(ORG_A, COMPLETED)).length;
    await admin.query("BEGIN");
    try {
      // another run of org A (a second replica, an overlapping tick) holds the transaction-scoped advisory lock
      await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `m4.security_review:${ORG_A}`,
      ]);
      const { alerts, sink } = collect();
      const result = await runSecurityReviewForOrg(deps(sink), ORG_A);
      expect(result).toEqual({ skipped: true, run: null, raised: [] });
      expect(alerts).toEqual([]);
    } finally {
      await admin.query("ROLLBACK");
    }
    expect((await reviewRows(ORG_A, COMPLETED)).length).toBe(before);
    // released with the other run's transaction: the scope is reviewed again
    expect(ran(await runSecurityReviewForOrg(deps(collect().sink), ORG_A)).run.status).toBe("ok");
  });

  it("is not blinded by a forged cursor: a 'reviewed up to next week' row, and one stamped in the future, do not move the review past now", async () => {
    // Two rows appended by someone who can write the audit trail (the review's cursor is an audit row, so this is the threat).
    const nextWeek = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    for (const createdAt of ["now()", "now() + interval '1 hour'"]) {
      await admin.query(
        `INSERT INTO audit_event (organization_id, actor_kind, event_type, resource_kind, correlation_id, outcome, severity,
           context, retention_class, created_at)
         VALUES ($1,'system',$2,'security_review','forged-cursor','success','info',$3::jsonb,'compliance', ${createdAt})`,
        [ORG_A, COMPLETED, JSON.stringify({ status: "ok", lane: "org", windowTo: nextWeek })],
      );
    }
    await seed({ organizationId: ORG_A, actorUserId: USER_1, eventType: BREAK_GLASS, at: ago(0) });
    const { alerts, sink } = collect();
    const { run } = ran(await runSecurityReviewForOrg(deps(sink), ORG_A));
    expect(alerts.map((a) => a.ruleId)).toEqual(["access.break_glass_invoked"]); // still seen: the cursor is clamped to the clock
    expect(Date.parse(run.windowFrom)).toBeLessThanOrEqual(Date.now());
  });

  it("flags bulk record access from the SQL aggregate: 120 distinct records fire, 99 do not", async () => {
    // All of one actor's reads at one instant inside the current fixed bucket (a fixed bucket is the rule's stated limit, so the
    // fixture stays clear of an edge): one second ago, or the bucket's own start when the bucket is younger than that.
    const now = Date.now();
    const at = new Date(
      Math.max(now - 1000, Math.floor(now / BULK_BUCKET) * BULK_BUCKET),
    ).toISOString();
    for (const [actor, count] of [
      [USER_BULK, 120],
      [USER_BELOW, 99],
    ] as const) {
      await admin.query(
        `INSERT INTO audit_event (organization_id, actor_user_id, actor_kind, event_type, resource_kind, resource_id,
           correlation_id, outcome, severity, context, retention_class, created_at)
         SELECT $1, $2, 'user', 'patient.viewed', 'patient', gen_random_uuid(), 'bulk-' || g, 'success', 'info', '{}'::jsonb,
                'compliance', $3::timestamptz
           FROM generate_series(1, $4::int) g`,
        [ORG_A, actor, at, count],
      );
    }
    const { alerts, sink } = collect();
    await runSecurityReviewForOrg(deps(sink), ORG_A);
    const bulk = alerts.filter((a) => a.ruleId === "access.bulk_record_access");
    expect(bulk).toHaveLength(1);
    expect(bulk[0]).toMatchObject({ count: 120, subject: { kind: "actor", ref: USER_BULK } });
  });

  it("platform lane: reads only org-less rows, writes through the platform writer, and every entry is audited", async () => {
    for (let i = 0; i < 15; i += 1) {
      await seed({
        organizationId: null,
        eventType: "m2.auth.login_failed",
        at: ago(8 - i * 0.4),
        context: { ipPrefix: "192.0.2.0/24", emailHash: `a${i}`.padEnd(32, "0") },
      });
    }
    // three networks, all in the RFC 5737 documentation ranges
    for (const [i, prefix] of ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24"].entries()) {
      await seed({
        organizationId: null,
        eventType: "m2.auth.login_succeeded",
        at: ago(6 - i),
        context: { userId: USER_TRAVEL, ipPrefix: prefix },
      });
    }
    // The SAME event type and a flood of it, but in a tenant: the platform lane must not evaluate it.
    for (let i = 0; i < 20; i += 1) {
      await seed({
        organizationId: ORG_A,
        eventType: "m2.auth.login_failed",
        at: ago(7 - i * 0.2),
        context: { ipPrefix: "203.0.113.0/24", emailHash: "f".repeat(32) },
      });
    }
    const { alerts, sink } = collect();
    const { run } = ran(await runSecurityReviewForPlatform(deps(sink)));
    expect(alerts.map((a) => a.ruleId).sort()).toEqual([
      "auth.brute_force_by_network",
      "auth.rapid_origin_change",
    ]);
    expect(alerts.every((a) => a.organizationId === null && a.lane === "platform")).toBe(true);
    expect(alerts.find((a) => a.ruleId === "auth.brute_force_by_network")).toMatchObject({
      count: 15,
      subject: { kind: "ip_prefix", ref: "192.0.2.0/24" },
    });
    expect(alerts.find((a) => a.ruleId === "auth.rapid_origin_change")).toMatchObject({
      count: 3,
      subject: { kind: "actor", ref: USER_TRAVEL },
    });
    expect(alerts.some((a) => JSON.stringify(a).includes("203.0.113."))).toBe(false);
    expect(run).toMatchObject({ status: "ok", lane: "platform", newAlerts: 2, delivered: 2 });

    const records = await reviewRows(null, COMPLETED);
    expect(records.at(-1)?.context).toMatchObject({ lane: "platform", status: "ok" });
    expect(
      (await reviewRows(null, RAISED)).filter((r) => r.context.delivery === "delivered"),
    ).toHaveLength(2);
    const bypass = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type = 'platform.bypass_invoked' AND context->>'jobId' = $1",
      [M4_SECURITY_REVIEW_PLATFORM_JOB_ID],
    );
    expect(bypass.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("why a platform lane exists, and how narrow it is: the platform login has no SELECT on audit_event or any of its partitions", async () => {
    // a tenant context cannot see org-less rows at all (so the tenant pool could never review sign-in failures) …
    const visibleToTenant = await withOrgContext(app.db, systemOrgContext(ORG_A), (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_event WHERE organization_id IS NULL`,
      ),
    );
    expect(visibleToTenant.rows[0]?.n).toBe(0);
    // … and the platform login holds no SELECT on audit_event, directly or inherited (migration 1566 removed 1561's column grant,
    // and the provisioner that ran after the migrations did not put it back)
    const columnGrants = await admin.query(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'audit_event' AND grantee = 'chartwarden_platform' AND privilege_type = 'SELECT'`,
    );
    expect(columnGrants.rows).toEqual([]);
    const login = await admin.query(
      `SELECT has_any_column_privilege('chartwarden_platform_login', 'audit_event', 'SELECT') AS can_select`,
    );
    expect(login.rows[0].can_select).toBe(false);
    // … nor on any partition (a partition's privileges are its own; reading through the parent checks the parent only, but a
    // direct read of `audit_event_2026_11` or the default partition would check the partition)
    const partitionGrants = await admin.query(
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit_event'::regclass
          AND has_any_column_privilege('chartwarden_platform_login', c.oid, 'SELECT')`,
    );
    expect(partitionGrants.rows).toEqual([]);
    // so a direct read of ANY column is refused, the six the old grant covered included (the BYPASSRLS login is not the bound)
    for (const read of [
      sql`SELECT event_type, context FROM audit_event LIMIT 1`,
      sql`SELECT id FROM audit_event LIMIT 1`,
      sql`SELECT count(*) FROM audit_event`,
      sql`SELECT before FROM audit_event LIMIT 1`,
      sql`SELECT user_agent FROM audit_event LIMIT 1`,
    ]) {
      expect(await sqlState(read)).toBe("42501");
    }
  });

  it("applied over a database that still carries 1561's column grant (the production upgrade), 1566 revokes it, grants EXECUTE, and a second application changes nothing", async () => {
    const migration = readFileSync(
      join(MIGRATIONS_DIR, "1566_m4_security_review_platform_audit_reader.sql"),
      "utf8",
    );
    const readers = [
      "m4_review_platform_signals(text[], timestamptz, timestamptz, integer, boolean)",
      "m4_review_platform_cursor()",
      "m4_review_platform_raised_alerts(timestamptz, text[])",
    ];
    // the state migration 1561 and the old provisioner left behind: the six-column grant, and no EXECUTE on the readers
    await admin.query(
      `GRANT SELECT ("id", "created_at", "organization_id", "actor_user_id", "event_type", "context") ON "audit_event" TO chartwarden_platform`,
    );
    for (const fn of readers)
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM chartwarden_platform`);
    expect(await sqlState(sql`SELECT event_type, context FROM audit_event LIMIT 1`)).toBe("ok"); // the old door is open …
    expect(await sqlState(sql`SELECT * FROM public.m4_review_platform_cursor()`)).toBe("42501"); // … the new one is not yet

    for (const application of [1, 2]) {
      await admin.query(migration);
      expect(
        await sqlState(sql`SELECT event_type, context FROM audit_event LIMIT 1`),
        `application ${application}`,
      ).toBe("42501");
      expect(
        await sqlState(sql`SELECT * FROM public.m4_review_platform_cursor()`),
        `application ${application}`,
      ).toBe("ok");
    }
  });

  it("the readers: a NOLOGIN owner, EXECUTE for the platform carrier only, a fixed search_path — and the tenant pool cannot call them", async () => {
    const fns = await admin.query(
      `SELECT p.proname,
              pg_get_userbyid(p.proowner) AS owner,
              p.prosecdef AS definer,
              (SELECT substr(c, length('search_path=') + 1) FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS search_path,
              (SELECT array_agg(g ORDER BY g)
                 FROM (SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS g
                         FROM aclexplode(p.proacl) a) s) AS grantees,
              has_function_privilege('chartwarden_app', p.oid, 'EXECUTE') AS app_can,
              has_function_privilege('chartwarden_platform_login', p.oid, 'EXECUTE') AS login_can
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'm4\\_review\\_platform\\_%'
        ORDER BY p.proname`,
    );
    expect(fns.rows.map((r) => r.proname)).toEqual([
      "m4_review_platform_cursor",
      "m4_review_platform_raised_alerts",
      "m4_review_platform_signals",
    ]);
    for (const fn of fns.rows) {
      expect(fn).toMatchObject({
        owner: "chartwarden_audit_reviewer",
        definer: true,
        search_path: "pg_catalog, pg_temp",
        // never PUBLIC, never the tenant role: the owner and the platform carrier
        grantees: ["chartwarden_audit_reviewer", "chartwarden_platform"],
        app_can: false,
        login_can: true, // through the carrier it inherits
      });
    }
    // the owner is a plain NOLOGIN role: no BYPASSRLS, not a superuser, nobody is a member of it, and the carrier's only member is the platform login
    const owner = await admin.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls,
              (SELECT count(*)::int FROM pg_auth_members WHERE roleid = r.oid) AS members_of,
              (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS member_of
         FROM pg_roles r WHERE rolname = 'chartwarden_audit_reviewer'`,
    );
    expect(owner.rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      members_of: 0,
      member_of: 0,
    });
    const carrierMembers = await admin.query(
      `SELECT array_agg(m.rolname::text ORDER BY m.rolname) AS members
         FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member
        WHERE am.roleid = 'chartwarden_platform'::regrole`,
    );
    expect(carrierMembers.rows[0].members).toEqual(["chartwarden_platform_login"]);
    // the tenant pool (the real NOBYPASSRLS chartwarden_app) is refused every one of them
    for (const call of [
      sql`SELECT * FROM public.m4_review_platform_cursor()`,
      sql`SELECT * FROM public.m4_review_platform_raised_alerts(now() - interval '1 hour', ARRAY['delivered']::text[])`,
      sql`SELECT * FROM public.m4_review_platform_signals(ARRAY['m2.auth.login_failed']::text[], now() - interval '1 hour', now(), 10, false)`,
    ]) {
      const state = await withOrgContext(app.db, systemOrgContext(ORG_A), async (tx) => {
        await tx.execute(sql`SAVEPOINT probe`);
        try {
          await tx.execute(call);
          return undefined;
        } catch (error) {
          return ((error as { cause?: { code?: string } }).cause ?? (error as { code?: string }))
            .code;
        } finally {
          await tx.execute(sql`ROLLBACK TO SAVEPOINT probe`);
        }
      });
      expect(state).toBe("42501");
    }
  });

  it("the reader's owner is confined by row security to org-less rows, whatever a function body says", async () => {
    // the database-side floor under the function bodies: a session AS the owner role sees no tenant row and none of the columns
    // the readers do not use, so a defect in a body could not widen the read
    const asSuperuser = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id IS NOT NULL",
    );
    expect(asSuperuser.rows[0].n).toBeGreaterThan(0); // the seeded tenant rows exist, so a zero below means something
    const owner = new Client({ connectionString: DB_URL });
    await owner.connect();
    try {
      await owner.query("SET ROLE chartwarden_audit_reviewer");
      const tenantRows = await owner.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id IS NOT NULL",
      );
      expect(tenantRows.rows[0].n).toBe(0);
      const orgLessRows = await owner.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id IS NULL",
      );
      expect(orgLessRows.rows[0].n).toBeGreaterThan(0);
      for (const column of [
        "before",
        '"after"',
        "source_ip",
        "user_agent",
        "resource_id",
        "correlation_id",
      ]) {
        await expect(
          owner.query(`SELECT ${column} FROM audit_event LIMIT 1`),
        ).rejects.toMatchObject({
          code: "42501",
        });
      }
    } finally {
      await owner.end();
    }
  });

  describe("the readers' rows and bounds", () => {
    const SIGNALS = "public.m4_review_platform_signals";
    const stateOfSignals = (args: {
      types?: string;
      from: string;
      to: string;
      limit?: number;
    }): Promise<string> =>
      sqlState(
        sql.raw(
          `SELECT * FROM ${SIGNALS}(${args.types ?? "ARRAY['m2.auth.login_failed']::text[]"}, '${args.from}'::timestamptz, '${args.to}'::timestamptz, ${args.limit ?? 10}, false)`,
        ),
      );
    const HOUR = 60 * MINUTE;
    const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

    it("the signals reader returns exactly the rules' inputs for org-less rows: seven values, no tenant row, no free text", async () => {
      // three org-less sign-in failures, four hours back, with context keys the rules do not read (free text, a patient id) …
      for (let i = 0; i < 3; i += 1) {
        await seed({
          organizationId: null,
          eventType: "m2.auth.login_failed",
          at: ago(240 - i),
          context: {
            userId: USER_1,
            ipPrefix: "198.51.100.0/24",
            emailHash: `b${i}`.padEnd(32, "0"),
            reason: "synthetic free text the rules never read",
            patientId: USER_BELOW,
          },
        });
      }
      // … a sign-in in a tenant in the same window, and an org-less row of another event type
      await seed({
        organizationId: ORG_A,
        eventType: "m2.auth.login_failed",
        at: ago(240),
        context: { ipPrefix: "203.0.113.0/24", emailHash: "e".repeat(32) },
      });
      await seed({
        organizationId: null,
        eventType: "m3.breakglass.invoked",
        at: ago(240),
        context: { ipPrefix: "203.0.113.0/24" },
      });
      const read = await platform.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM public.m4_review_platform_signals(
              ARRAY['m2.auth.login_failed', 'm2.auth.account_locked', 'm2.auth.login_succeeded']::text[],
              ${ago(245)}::timestamptz, ${ago(235)}::timestamptz, 100, false)`,
      );
      expect(read.rows).toHaveLength(3);
      expect(Object.keys(read.rows[0] ?? {}).sort()).toEqual(
        [
          "account_hash",
          "actor_id",
          "context_user_id",
          "event_id",
          "event_kind",
          "ip_prefix",
          "occurred_at",
        ].sort(),
      );
      expect(read.rows.map((r) => [r.event_kind, r.ip_prefix, r.context_user_id])).toEqual(
        Array(3).fill(["m2.auth.login_failed", "198.51.100.0/24", USER_1]),
      );
      const everything = JSON.stringify(read.rows);
      for (const absent of ["free text", USER_BELOW, "203.0.113.", ORG_A, "breakglass"]) {
        expect(everything).not.toContain(absent);
      }
      // oldest first, or newest first on request; the row cap holds
      const oldest = await platform.db.execute<{ occurred_at: Date }>(
        sql`SELECT occurred_at FROM public.m4_review_platform_signals(ARRAY['m2.auth.login_failed']::text[],
              ${ago(245)}::timestamptz, ${ago(235)}::timestamptz, 2, false)`,
      );
      const newest = await platform.db.execute<{ occurred_at: Date }>(
        sql`SELECT occurred_at FROM public.m4_review_platform_signals(ARRAY['m2.auth.login_failed']::text[],
              ${ago(245)}::timestamptz, ${ago(235)}::timestamptz, 2, true)`,
      );
      expect(oldest.rows).toHaveLength(2);
      expect(newest.rows).toHaveLength(2);
      expect(new Date(oldest.rows[0]?.occurred_at as Date).getTime()).toBeLessThan(
        new Date(newest.rows[0]?.occurred_at as Date).getTime(),
      );
    });

    it("refuses an event type, window or row limit outside its bounds (22023), and accepts the review's own", async () => {
      // an event type other than the three org-less sign-in events — alone, mixed, or none
      for (const types of [
        "ARRAY['m3.breakglass.invoked']::text[]",
        "ARRAY['m2.auth.login_failed', 'm3.breakglass.invoked']::text[]",
        "ARRAY[]::text[]",
        "NULL::text[]",
      ]) {
        expect(await stateOfSignals({ types, from: iso(-HOUR), to: iso(0) })).toBe("22023");
      }
      // a window longer than 25 hours, older than 48 hours, or more than ten minutes ahead of the clock; a backwards one
      expect(
        await stateOfSignals({ from: iso(-26 * HOUR), to: iso(-26 * HOUR + 25 * HOUR + MINUTE) }),
      ).toBe("22023");
      expect(await stateOfSignals({ from: iso(-49 * HOUR), to: iso(-48 * HOUR) })).toBe("22023");
      expect(await stateOfSignals({ from: iso(-HOUR), to: iso(11 * MINUTE) })).toBe("22023");
      expect(await stateOfSignals({ from: iso(0), to: iso(-HOUR) })).toBe("22023");
      // a row limit of zero, and one past the review's own read cap (+1 for the extra row it fetches to detect a truncation)
      expect(await stateOfSignals({ from: iso(-HOUR), to: iso(0), limit: 0 })).toBe("22023");
      expect(
        await stateOfSignals({ from: iso(-HOUR), to: iso(0), limit: MAX_SIGNAL_ROWS + 2 }),
      ).toBe("22023");
      // the review's own largest read is inside every bound: a full catch-up day, at the row cap
      expect(
        await stateOfSignals({
          from: iso(-MAX_CATCH_UP_MS),
          to: iso(0),
          limit: MAX_SIGNAL_ROWS + 1,
        }),
      ).toBe("ok");
      // the alert memory: never further back than 48 hours, always with a delivery status to look for
      const raised = (since: string, deliveries: string) =>
        sqlState(
          sql.raw(
            `SELECT * FROM public.m4_review_platform_raised_alerts('${since}'::timestamptz, ${deliveries})`,
          ),
        );
      expect(await raised(iso(-49 * HOUR), "ARRAY['delivered']::text[]")).toBe("22023");
      expect(await raised(iso(-HOUR), "ARRAY[]::text[]")).toBe("22023");
      expect(await raised(iso(-HOUR), "NULL::text[]")).toBe("22023");
      expect(await raised(iso(-HOUR), "ARRAY['delivered', 'no_destination']::text[]")).toBe("ok");
    });

    it("the alert memory returns the five keys of org-less alert rows only, and the cursor only a clean org-less run", async () => {
      await seed({
        organizationId: null,
        eventType: RAISED,
        at: ago(20),
        context: {
          fingerprint: "f".repeat(32),
          ruleId: "auth.brute_force_by_network",
          subject: { kind: "ip_prefix", ref: "192.0.2.0/24", note: "never returned" },
          windowTo: ago(20),
          delivery: "delivered",
          count: 15,
        },
      });
      await seed({
        organizationId: ORG_A,
        eventType: RAISED,
        at: ago(20),
        context: { fingerprint: "9".repeat(32), ruleId: "tenant.rule", delivery: "delivered" },
      });
      await seed({
        organizationId: null,
        eventType: RAISED,
        at: ago(20),
        context: { fingerprint: "8".repeat(32), ruleId: "failed.one", delivery: "failed" },
      });
      const memory = await platform.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM public.m4_review_platform_raised_alerts(${ago(30)}::timestamptz, ARRAY['delivered', 'no_destination']::text[])`,
      );
      const marked = memory.rows.filter((r) => r.fingerprint === "f".repeat(32));
      expect(marked).toHaveLength(1);
      expect(Object.keys(marked[0] ?? {}).sort()).toEqual(
        ["fingerprint", "rule_id", "subject_kind", "subject_ref", "window_to"].sort(),
      );
      expect(memory.rows.map((r) => r.fingerprint)).not.toContain("9".repeat(32)); // a tenant's row
      expect(memory.rows.map((r) => r.fingerprint)).not.toContain("8".repeat(32)); // a failed delivery is not memory
      expect(JSON.stringify(memory.rows)).not.toContain("never returned");

      const cursor = await platform.db.execute<{ window_to: string; row_at: Date }>(
        sql`SELECT * FROM public.m4_review_platform_cursor()`,
      );
      expect(cursor.rows).toHaveLength(1);
      const newestClean = (await reviewRows(null, COMPLETED))
        .filter((r) => r.context.status === "ok")
        .at(-1);
      expect(cursor.rows[0]?.window_to).toBe(newestClean?.context.windowTo);
    });
  });

  it("holds a sustained attack to one alert: an earlier window of the same pattern inside the cooldown raises nothing, another network still does", async () => {
    // Thirty minutes ago: before the alert the platform lane raised for 192.0.2.0/24 (a different window, a new fingerprint),
    // and inside the one-hour cooldown. The same shape from 198.51.100.0/24 has no earlier alert.
    for (const prefix of ["192.0.2.0/24", "198.51.100.0/24"]) {
      for (let i = 0; i < 15; i += 1) {
        await seed({
          organizationId: null,
          eventType: "m2.auth.login_failed",
          at: ago(30 - i * 0.3),
          context: { ipPrefix: prefix, emailHash: `c${i}${prefix.length}`.padEnd(32, "0") },
        });
      }
    }
    const { alerts, sink } = collect();
    const { run } = ran(await runSecurityReviewForPlatform(deps(sink)));
    expect(alerts.map((a) => `${a.ruleId}:${a.subject.ref}`)).toEqual([
      "auth.brute_force_by_network:198.51.100.0/24",
    ]);
    expect(run.findings).toBeGreaterThanOrEqual(3); // both new windows and the one already raised were seen
  });

  it("tenant isolation: org B's review sees only org B, and org A's review rows are invisible to B", async () => {
    const { alerts, sink } = collect();
    await runSecurityReviewForOrg(deps(sink), ORG_B);
    expect(alerts.map((a) => a.ruleId)).toEqual(["access.break_glass_invoked"]);
    expect(alerts.every((a) => a.organizationId === ORG_B)).toBe(true);
    const seenByB = await withOrgContext(app.db, systemOrgContext(ORG_B), (tx) =>
      tx.execute<{ org: string; n: number }>(
        sql`SELECT organization_id::text AS org, count(*)::int AS n FROM audit_event WHERE event_type LIKE 'm4.security_review.%' GROUP BY 1`,
      ),
    );
    expect(seenByB.rows.map((r) => r.org)).toEqual([ORG_B]);
  });

  it("a tick over both lanes fails (after committing the record) when an alert cannot be delivered, and is green when it can", async () => {
    await seed({ organizationId: ORG_B, actorUserId: USER_B, eventType: BREAK_GLASS, at: ago(0) });
    await expect(runSecurityReviewTick(deps(failing))).rejects.toThrow(/M4_SECURITY_REVIEW/);
    const failed = await reviewRows(ORG_B, COMPLETED);
    expect(failed.at(-1)?.context.status).toBe("delivery_failed");

    const { alerts, sink } = collect();
    await expect(runSecurityReviewTick(deps(sink))).resolves.toEqual({ orgs: 2 });
    expect(alerts.map((a) => `${a.organizationId}:${a.ruleId}`)).toEqual([
      `${ORG_B}:access.break_glass_invoked`,
    ]);
    expect((await reviewRows(ORG_B, COMPLETED)).at(-1)?.context.status).toBe("ok");
  });
});
