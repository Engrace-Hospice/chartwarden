/**
 * GAP-099 (#248) — LIVE Postgres proof that M1's PLATFORM-scoped consumer for M33's replica-lag probe
 * (`buildM1LagProbeStatusConsumer`) actually flips the shared `system_status` row, for real, as the
 * NOBYPASSRLS `chartwarden_app` role (`system_status` carries no RLS at all — this proves the role's plain
 * GRANT is sufficient, not that a policy predicate scopes it).
 *
 * `m33.lag.exceeded`/`.recovered` are emitted with `organizationId: null` (`m33-jobs.ts`) — the dispatcher
 * routes an org-less row through its SEPARATE `pollPlatform()` path (`platformConsumers`, GAP-099), which
 * has had zero live bindings anywhere in the codebase until this one.
 *
 * Proves: `.exceeded` upserts the `database_replication` component to `degraded` with a headline/details
 * built from the sampled lag; `.recovered` flips it back to `operational` with a null headline; a second
 * `.exceeded` delivery overwrites the row rather than erroring (`ON CONFLICT DO UPDATE`); an unrelated
 * `system_status` row (a different component id) is untouched.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m1:lag-probe-status:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM1LagProbeStatusConsumer } from "../src/bootstrap/outbox-consumers/m33-lag-probe";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

describe.skipIf(!DB_URL)("GAP-099 — M1's lag-probe system-status consumer — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let consumer: ReturnType<typeof buildM1LagProbeStatusConsumer>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    consumer = buildM1LagProbeStatusConsumer({ db: handle.db });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  async function statusRow(id: string) {
    const [row] = await handle.db
      .select()
      .from(schema.systemStatus)
      .where(eq(schema.systemStatus.id, id));
    return row ?? null;
  }

  it("flips database_replication to degraded on .exceeded, then back to operational on .recovered", async () => {
    await consumer.handle({
      id: "eeeeeeee-0000-4000-8000-000000000001",
      eventType: "m33.lag.exceeded",
      aggregateKind: "replica_lag_probe",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { lagSeconds: 42.3, threshold: 30, sampledAt: "2026-09-28T12:00:00.000Z" },
      attemptCount: 1,
      createdAt: new Date(),
    });

    const degraded = await statusRow("database_replication");
    expect(degraded?.status).toBe("degraded");
    expect(degraded?.headline).toBe("Database replication lag above threshold");
    expect(degraded?.details).toContain("42.3s exceeds the 30.0s threshold");

    await consumer.handle({
      id: "eeeeeeee-0000-4000-8000-000000000002",
      eventType: "m33.lag.recovered",
      aggregateKind: "replica_lag_probe",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { lagSeconds: 2.1, durationDownSeconds: 180 },
      attemptCount: 1,
      createdAt: new Date(),
    });

    const recovered = await statusRow("database_replication");
    expect(recovered?.status).toBe("operational");
    expect(recovered?.headline).toBeNull();
    expect(recovered?.details).toContain("2.1s after 180s degraded");
  });

  it("overwrites on a second .exceeded delivery rather than erroring", async () => {
    await consumer.handle({
      id: "eeeeeeee-0000-4000-8000-000000000003",
      eventType: "m33.lag.exceeded",
      aggregateKind: "replica_lag_probe",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { lagSeconds: 55, threshold: 30, sampledAt: "2026-09-28T13:00:00.000Z" },
      attemptCount: 1,
      createdAt: new Date(),
    });
    await consumer.handle({
      id: "eeeeeeee-0000-4000-8000-000000000004",
      eventType: "m33.lag.exceeded",
      aggregateKind: "replica_lag_probe",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { lagSeconds: 61, threshold: 30, sampledAt: "2026-09-28T13:05:00.000Z" },
      attemptCount: 1,
      createdAt: new Date(),
    });

    const row = await statusRow("database_replication");
    expect(row?.status).toBe("degraded");
    expect(row?.details).toContain("61.0s exceeds");
  });

  it("does not touch an unrelated system_status component", async () => {
    await handle.db.insert(schema.systemStatus).values({
      id: "dosespot",
      status: "operational",
      headline: null,
      details: null,
      updatedAt: new Date("2020-01-01T00:00:00Z"),
    });

    await consumer.handle({
      id: "eeeeeeee-0000-4000-8000-000000000005",
      eventType: "m33.lag.exceeded",
      aggregateKind: "replica_lag_probe",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { lagSeconds: 99, threshold: 30, sampledAt: "2026-09-28T14:00:00.000Z" },
      attemptCount: 1,
      createdAt: new Date(),
    });

    const dosespot = await statusRow("dosespot");
    expect(dosespot?.status).toBe("operational");
    expect(new Date(dosespot?.updatedAt).getUTCFullYear()).toBe(2020);
  });
});
