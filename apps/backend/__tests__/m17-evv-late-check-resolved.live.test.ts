/**
 * F-196 (#248) — LIVE Postgres proof that `buildM17EvvLateCheckResolvedConsumer`
 * (`m18.evv.late_check_resolved`) actually stamps a real `visit` row under RLS.
 *
 * M23 already has a live, bound consumer for this exact event (F-162,
 * `23-billing-medicare/outbox-consumers/m18-late-check-resolved.ts`), proving the fact genuinely fires in
 * production; nothing had ever bound M17's own side. Sat in `scripts/outbox-deferred-consumers.ts`'s m17
 * `handlers-unbound` group.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m17:evv-late-check-resolved:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM17EvvLateCheckResolvedConsumer } from "../src/modules/17-scheduling/outbox-consumers/m18-evv-late-check-resolved";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("F-196 — M17's EVV late-check-resolved consumer — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let peA: string;
  let locA: string;
  let memA: string;
  let peB: string;
  let locB: string;
  let memB: string;
  let visitSeedCounter = 0;
  let consumer: ReturnType<typeof buildM17EvvLateCheckResolvedConsumer>;

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

  async function seedOrgFixture(orgId: string, slug: string) {
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
      [orgId, `org-${slug}`, slug],
    );
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `M17-LCR-${slug}`, `Provider ${slug}`, slug === "a" ? "1300000001" : "1300000002"],
      )
    ).rows[0].id as string;
    const loc = (
      await admin.query(
        `INSERT INTO location
             (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `m17-lcr-${slug}@x.test`,
      ])
    ).rows[0].id as string;
    const mem = (
      await admin.query(
        `INSERT INTO membership
             (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
        [user, orgId, pe, JSON.stringify([loc])],
      )
    ).rows[0].id as string;
    return { pe, loc, mem };
  }

  async function seedVisit(opts: {
    organizationId: string;
    providerEntityId: string;
    locationId: string;
    assignedMembershipId: string;
  }): Promise<string> {
    const patientId = crypto.randomUUID();
    const admissionId = crypto.randomUUID();
    const offsetHours = visitSeedCounter++;
    const row = await admin.query(
      `INSERT INTO visit
           (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
            scheduled_started_at, scheduled_ended_at, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
                 now() + ($7 || ' hours')::interval, now() + ($7 || ' hours')::interval + interval '1 hour',
                 CURRENT_DATE, 'completed')
         RETURNING id`,
      [
        opts.organizationId,
        opts.providerEntityId,
        opts.locationId,
        patientId,
        admissionId,
        opts.assignedMembershipId,
        String(offsetHours * 2),
      ],
    );
    return row.rows[0].id as string;
  }

  async function visitRow(visitId: string) {
    const { rows } = await admin.query(
      `SELECT status, version, evv_missing_resolution_resolved_at, evv_missing_resolution_status,
                evv_missing_resolution_by_membership_id, evv_missing_resolution_reason
         FROM visit WHERE id = $1`,
      [visitId],
    );
    return rows[0];
  }

  async function auditRows(visitId: string) {
    const { rows } = await admin.query(
      `SELECT after FROM audit_event WHERE resource_kind = 'visit' AND resource_id = $1 ORDER BY created_at`,
      [visitId],
    );
    return rows;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    const a = await seedOrgFixture(ORG_A, "a");
    peA = a.pe;
    locA = a.loc;
    memA = a.mem;
    const b = await seedOrgFixture(ORG_B, "b");
    peB = b.pe;
    locB = b.loc;
    memB = b.mem;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    consumer = buildM17EvvLateCheckResolvedConsumer({ db: handle.db });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("stamps the missing-EVV resolution on a completed visit, without moving status", async () => {
    const visitId = await seedVisit({
      organizationId: ORG_A,
      providerEntityId: peA,
      locationId: locA,
      assignedMembershipId: memA,
    });
    const resolvedByMembershipId = memA;

    await consumer.handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      payload: {
        missingResolutionId: crypto.randomUUID(),
        visitId,
        resolvedByMembershipId,
        status: "clinician_attest",
        resolutionReason: "Clinician confirmed in-person visit; device signal lost mid-visit.",
      },
    });

    const row = await visitRow(visitId);
    expect(row.status).toBe("completed"); // unchanged — this is an informational stamp, not a transition
    expect(row.version).toBe(1);
    expect(row.evv_missing_resolution_resolved_at).not.toBeNull();
    expect(row.evv_missing_resolution_status).toBe("clinician_attest");
    expect(row.evv_missing_resolution_by_membership_id).toBe(resolvedByMembershipId);
    expect(row.evv_missing_resolution_reason).toBe(
      "Clinician confirmed in-person visit; device signal lost mid-visit.",
    );

    // The audit trigger denylists the free-text reason — the row keeps it, the audit diff does not.
    const audit = await auditRows(visitId);
    expect(audit.length).toBeGreaterThan(0);
    const last = audit[audit.length - 1].after;
    expect(last.evv_missing_resolution_reason).toBe("<changed>");
  });

  it("is idempotent on redelivery, and a no-op for a system resolution with a null actor", async () => {
    const visitId = await seedVisit({
      organizationId: ORG_A,
      providerEntityId: peA,
      locationId: locA,
      assignedMembershipId: memA,
    });

    await consumer.handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      payload: {
        missingResolutionId: crypto.randomUUID(),
        visitId,
        resolvedByMembershipId: null,
        status: "system",
        resolutionReason: "Auto-resolved: check-out arrived after the grace sweep ran.",
      },
    });
    const first = await visitRow(visitId);
    expect(first.evv_missing_resolution_by_membership_id).toBeNull();
    expect(first.evv_missing_resolution_status).toBe("system");
    expect(first.version).toBe(1);

    // Redelivery of the SAME (or a differently-worded) resolution must not overwrite the first stamp.
    await consumer.handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      payload: {
        missingResolutionId: crypto.randomUUID(),
        visitId,
        resolvedByMembershipId: memA,
        status: "supervisor_override",
        resolutionReason: "should never land",
      },
    });
    const after = await visitRow(visitId);
    expect(after.version).toBe(1);
    expect(after.evv_missing_resolution_status).toBe("system");
    expect(after.evv_missing_resolution_reason).toBe(
      "Auto-resolved: check-out arrived after the grace sweep ran.",
    );
  });

  it("cross-tenant isolation — org A's delivery never touches org B's visit", async () => {
    const orgBVisit = await seedVisit({
      organizationId: ORG_B,
      providerEntityId: peB,
      locationId: locB,
      assignedMembershipId: memB,
    });

    await consumer.handle({
      id: crypto.randomUUID(),
      organizationId: ORG_A,
      payload: {
        missingResolutionId: crypto.randomUUID(),
        visitId: orgBVisit,
        resolvedByMembershipId: memA,
        status: "clinician_attest",
        resolutionReason: "cross-tenant attempt",
      },
    });

    // Read back as an admin (bypasses RLS) to prove the row was never touched, not merely invisible.
    const { rows } = await admin.query(
      `SELECT version, evv_missing_resolution_resolved_at FROM visit WHERE id = $1`,
      [orgBVisit],
    );
    expect(rows[0].version).toBe(0);
    expect(rows[0].evv_missing_resolution_resolved_at).toBeNull();
  });
});
