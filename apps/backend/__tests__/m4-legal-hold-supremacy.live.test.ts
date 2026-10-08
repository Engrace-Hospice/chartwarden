/**
 * M4 legal-hold supremacy at the destruction point, LIVE Postgres (GAP-008).
 *
 * The production composition: the REAL destruction sweep (`runDestructionSweepForOrg`) reads the audit rows through
 * the tenant `wardenx_app` handle, vets each row-group against the org's ACTIVE `legal_hold` rows through the REAL
 * Drizzle eraser ports, and deletes through a separate destruction-granted client. Before this fix a hold whose only
 * selector was a `dateRange` or `resourceKinds` named no id, matched nothing, and the rows were erased.
 *
 * What it proves (assertions on `audit_event` and `destruction_certificate` rows):
 *   - a resourceKinds-only hold keeps that kind's rows; an unheld kind in the same certificate is still erased;
 *   - a dateRange-only hold keeps rows whose span overlaps it, and not rows wholly outside it;
 *   - a hold applied AFTER the certificate was approved is honoured at execution;
 *   - a fully held certificate lands `held` and touches nothing; a released hold lets the next sweep erase;
 *   - the DELETE is bounded to the span the hold was checked against (a same-resource row outside the certificate's
 *     range survives);
 *   - tenant isolation: another org's hold does not protect this org's rows, nor vice versa.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://... bun run test:m4:legal-hold-supremacy:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleAuditEraserPorts } from "../src/modules/04-audit/erasers/audit-eraser";
import { runDestructionSweepForOrg } from "../src/modules/04-audit/jobs/audit-job-ops";
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
const ORG_A = "77777777-7777-4777-8777-777777771001";
const ORG_B = "88888888-8888-4888-8888-888888881002";
const MARCH = { start: "2026-03-01T00:00:00Z", end: "2026-03-31T23:59:59Z" };

describe.skipIf(!DB_URL)("M4 legal-hold supremacy at destruction, LIVE Postgres", () => {
  let admin: Client;
  let app: ReturnType<typeof createDbClient>;
  let destruction: ReturnType<typeof createDbClient>;

  const seedEvent = async (
    org: string,
    resourceKind: string,
    createdAt: string,
    resourceId = randomUUID(),
  ) => {
    await admin.query(
      `INSERT INTO audit_event (organization_id, actor_kind, event_type, resource_kind, resource_id, outcome,
                                severity, correlation_id, retention_class, created_at)
       VALUES ($1,'system','test.event',$2,$3,'success','info',$4,'compliance',$5)`,
      [org, resourceKind, resourceId, randomUUID(), createdAt],
    );
    return resourceId;
  };
  const survives = async (resourceId: string) =>
    ((await admin.query("SELECT 1 FROM audit_event WHERE resource_id=$1", [resourceId])).rowCount ??
      0) > 0;

  const approvedCertificate = async (org: string, range = MARCH) =>
    (
      await admin.query(
        `INSERT INTO destruction_certificate (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
         VALUES ($1,'audit_event.compliance',0,$2,$3,'secure_delete','approved') RETURNING id`,
        [org, range.start, range.end],
      )
    ).rows[0].id as string;
  const certStatus = async (id: string) =>
    (await admin.query("SELECT status FROM destruction_certificate WHERE id=$1", [id])).rows[0]
      .status as string;
  const hold = (org: string, criteria: object, status = "active") =>
    admin.query(
      "INSERT INTO legal_hold (organization_id, name, criteria, status, reason) VALUES ($1,'h',$2::jsonb,$3,'litigation hold for the test')",
      [org, JSON.stringify(criteria), status],
    );
  const sweep = (org: string) =>
    runDestructionSweepForOrg(
      {
        db: app.db,
        listOrgs: async () => [{ organizationId: org }],
        eraserPorts: createDrizzleAuditEraserPorts(app.db, { destructionDb: destruction.db }),
      },
      org,
    );

  beforeAll(async () => {
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
    for (const [id, slug] of [
      [ORG_A, "m4h-a"],
      [ORG_B, "m4h-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [id, slug],
      );
    }
    app = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    // Stands in for the separately pooled destruction credential (wardenx_admin in production).
    destruction = createDbClient({ connectionString: DB_URL as string });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await destruction?.close();
    await admin?.end();
  });

  it("a resourceKinds-only hold keeps that kind's rows while an unheld kind in the same certificate is erased", async () => {
    const held = await seedEvent(ORG_A, "patient_address", "2026-03-10T00:00:00Z");
    const free = await seedEvent(ORG_A, "login_attempt", "2026-03-10T00:00:00Z");
    await hold(ORG_A, { resourceKinds: ["patient_address"] });
    const cert = await approvedCertificate(ORG_A);
    await sweep(ORG_A);
    expect(await survives(held)).toBe(true);
    expect(await survives(free)).toBe(false);
    expect(await certStatus(cert)).toBe("partial_refused");
  });

  it("a fully held certificate lands 'held' and touches nothing; releasing the hold lets the next sweep erase", async () => {
    await admin.query("DELETE FROM legal_hold WHERE organization_id=$1", [ORG_A]);
    const only = await seedEvent(ORG_A, "patient_address", "2026-03-12T00:00:00Z");
    await hold(ORG_A, { resourceKinds: ["patient_address"] });
    const cert = await approvedCertificate(ORG_A);
    await sweep(ORG_A);
    expect(await survives(only)).toBe(true);
    expect(await certStatus(cert)).toBe("held");

    await admin.query(
      "UPDATE legal_hold SET status='released', released_at=now() WHERE organization_id=$1",
      [ORG_A],
    );
    await admin.query("UPDATE destruction_certificate SET status='approved' WHERE id=$1", [cert]);
    await sweep(ORG_A);
    expect(await survives(only)).toBe(false);
    expect(await certStatus(cert)).toBe("executed");
  });

  it("a dateRange-only hold keeps rows whose span overlaps it, and not rows wholly outside it", async () => {
    await admin.query("DELETE FROM legal_hold WHERE organization_id=$1", [ORG_A]);
    const inside = await seedEvent(ORG_A, "note", "2026-03-20T00:00:00Z");
    const outside = await seedEvent(ORG_A, "note", "2026-03-02T00:00:00Z");
    await hold(ORG_A, { dateRange: { from: "2026-03-15T00:00:00Z", to: "2026-03-31T00:00:00Z" } });
    await approvedCertificate(ORG_A);
    await sweep(ORG_A);
    expect(await survives(inside)).toBe(true);
    expect(await survives(outside)).toBe(false);
  });

  it("a hold applied AFTER the certificate was approved is honoured at execution", async () => {
    await admin.query("DELETE FROM legal_hold WHERE organization_id=$1", [ORG_A]);
    await admin.query("DELETE FROM audit_event WHERE event_type='test.event'"); // earlier cases' survivors
    const row = await seedEvent(ORG_A, "consent_form", "2026-03-08T00:00:00Z");
    const cert = await approvedCertificate(ORG_A);
    await hold(ORG_A, { resourceKinds: ["consent_form"] }); // after approval
    await sweep(ORG_A);
    expect(await survives(row)).toBe(true);
    expect(await certStatus(cert)).toBe("held");
  });

  it("the DELETE is bounded to the vetted span: a same-resource row outside the certificate's range survives", async () => {
    await admin.query("DELETE FROM legal_hold WHERE organization_id=$1", [ORG_A]);
    await admin.query(
      "UPDATE destruction_certificate SET status='executed' WHERE organization_id=$1",
      [ORG_A],
    );
    const resourceId = randomUUID();
    await seedEvent(ORG_A, "chart_note", "2026-03-10T00:00:00Z", resourceId);
    const outsideRange = await seedEvent(ORG_A, "chart_note", "2026-05-10T00:00:00Z", resourceId);
    const cert = await approvedCertificate(ORG_A);
    await sweep(ORG_A);
    const remaining = (
      await admin.query("SELECT created_at FROM audit_event WHERE resource_id=$1", [outsideRange])
    ).rows;
    expect(remaining).toHaveLength(1); // only the May row is left
    expect(new Date(remaining[0].created_at).getUTCMonth()).toBe(4);
    expect(await certStatus(cert)).toBe("executed");
  });

  it("tenant isolation: another org's hold does not protect this org's rows", async () => {
    await admin.query("DELETE FROM legal_hold");
    await admin.query("UPDATE destruction_certificate SET status='executed'");
    const mine = await seedEvent(ORG_A, "patient_address", "2026-03-10T00:00:00Z");
    const theirs = await seedEvent(ORG_B, "patient_address", "2026-03-10T00:00:00Z");
    await hold(ORG_B, { resourceKinds: ["patient_address"] });
    await approvedCertificate(ORG_A);
    await approvedCertificate(ORG_B);
    await sweep(ORG_A);
    await sweep(ORG_B);
    expect(await survives(mine)).toBe(false); // ORG_A has no hold of its own
    expect(await survives(theirs)).toBe(true); // ORG_B's hold protects ORG_B
  });
});
