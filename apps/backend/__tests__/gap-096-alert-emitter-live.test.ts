/**
 * GAP-096 — M36's real AlertEmitter, proven end-to-end over real Postgres.
 *
 * Before this fix: `registerMessagingSeams` never received `emitter:`, so it always fell back to
 * `createInMemoryAlertEmitter()` — no alert/notification_delivery row was ever written, and
 * `PLATFORM_DEFAULT_ALERT_RULES` was never boot-populated into `alert_rule` at all (a second,
 * independently-inert gap: even a wired emitter would have had zero rules to route). This test drives
 * the REAL chain:
 *   1. `wireAlertRuleSeed` (migration 0193's SECURITY DEFINER function) populates the platform-default
 *      rules over the ordinary tenant pool — idempotent, no platform credential required.
 *   2. `getAlertEmitter().emit()` resolves real recipients (`role_set` over membership_role→role,
 *      `care_team` over the real GAP-059 seam) and persists real `alert`/`notification_delivery` rows.
 *   3. A tenant's own `alert_rule` row for an eventType REPLACES the platform default entirely (the
 *      `patchAlertRule` clone-on-first-edit model this mirrors), not a union.
 *   4. `disciplineMembers` refuses loudly rather than silently resolving to nobody.
 *   5. Vacation forwarding persists `forwarded_from_user_id` for real (migration 0192).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-096-alert-emitter-live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrizzleCareTeamStore, registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createDrizzleAlertEmitter,
  getAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "99999999-9999-9999-9999-999999999999";

describe.skipIf(!DB_URL)("GAP-096 — M36 AlertEmitter, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let orgAdminUserId: string;
  let billingManagerUserId: string;
  let clinicianUserId: string;
  let patientId: string;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function insertRole(key: string, name: string, category: string): Promise<string> {
    return (
      await admin.query(
        "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$3,$4) RETURNING id",
        [ORG, key, name, category],
      )
    ).rows[0].id as string;
  }
  async function insertMember(email: string, roleId: string): Promise<string> {
    const userId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])
    ).rows[0].id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
      [ORG, membershipId, roleId],
    );
    return userId;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap096','GAP-096','GAP-096')",
      [ORG],
    );
    const orgAdminRoleId = await insertRole("org_admin", "Org Admin", "admin_executive");
    const billingRoleId = await insertRole("billing_manager", "Billing Manager", "billing_finance");
    orgAdminUserId = await insertMember("gap096-orgadmin@x.test", orgAdminRoleId);
    billingManagerUserId = await insertMember("gap096-billing@x.test", billingRoleId);

    patientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-GAP096','Casey','Careteam','1970-05-05','M','active') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    clinicianUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, ["gap096-rn@x.test"])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [patientId, ORG, clinicianUserId],
    );

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    registerPatientSeams({
      db: handle.db,
      careTeam: { store: createDrizzleCareTeamStore(handle.db) },
    });
    registerMessagingSeams({ emitter: createDrizzleAlertEmitter(handle.db) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("wireAlertRuleSeed populates the platform-default rows and is idempotent on re-run", async () => {
    await wireAlertRuleSeed(handle.db);
    const { rows: firstRun } = await admin.query(
      "SELECT event_type, recipient_resolver, resolver_args, system_locked FROM alert_rule WHERE organization_id IS NULL ORDER BY event_type",
    );
    expect(firstRun.length).toBeGreaterThan(0);
    const claimDenied = firstRun.find((r) => r.event_type === "claim.denied");
    expect(claimDenied?.recipient_resolver).toBe("role_set");
    expect(claimDenied?.resolver_args.roleKeys).toEqual(["billing_manager", "biller"]);
    const sos = firstRun.find((r) => r.event_type === "field_safety.sos");
    expect(sos?.system_locked).toBe(true);

    await wireAlertRuleSeed(handle.db);
    const { rows: secondRun } = await admin.query(
      "SELECT count(*)::int AS n FROM alert_rule WHERE organization_id IS NULL",
    );
    expect(secondRun[0].n).toBe(firstRun.length);
  });

  it("emit() resolves real role_set recipients and persists real alert + notification_delivery rows", async () => {
    const result = await getAlertEmitter().emit(ORG, {
      eventType: "claim.denied",
      payload: { claimId: "claim-1" },
      severity: "warn",
      correlationId: "corr-gap096-1",
    });
    expect(result.resolvedRecipientCount).toBe(1);

    const { rows: alertRows } = await admin.query(
      "SELECT id, event_type, severity, payload, correlation_id FROM alert WHERE id = $1",
      [result.alertId],
    );
    expect(alertRows[0].event_type).toBe("claim.denied");
    expect(alertRows[0].payload.claimId).toBe("claim-1");
    expect(alertRows[0].correlation_id).toBe("corr-gap096-1");

    const { rows: deliveryRows } = await admin.query(
      "SELECT recipient_user_id, channel, status FROM notification_delivery WHERE alert_id = $1",
      [result.alertId],
    );
    expect(deliveryRows).toHaveLength(1);
    expect(deliveryRows[0].recipient_user_id).toBe(billingManagerUserId);
    expect(deliveryRows[0].channel).toBe("in_app");
    expect(deliveryRows[0].status).toBe("pending");
  });

  it("emit() dedupes alert fan-out by organization correlation id", async () => {
    const first = await getAlertEmitter().emit(ORG, {
      eventType: "claim.denied",
      payload: { claimId: "claim-dedup" },
      severity: "warn",
      correlationId: "corr-gap096-dedup",
    });
    const second = await getAlertEmitter().emit(ORG, {
      eventType: "claim.denied",
      payload: { claimId: "claim-dedup" },
      severity: "warn",
      correlationId: "corr-gap096-dedup",
    });

    expect(second.alertId).toBe(first.alertId);
    const { rows: alertRows } = await admin.query(
      "SELECT count(*)::int AS n FROM alert WHERE organization_id = $1 AND correlation_id = $2",
      [ORG, "corr-gap096-dedup"],
    );
    expect(alertRows[0].n).toBe(1);

    const { rows: deliveryRows } = await admin.query(
      "SELECT count(*)::int AS n FROM notification_delivery WHERE alert_id = $1",
      [first.alertId],
    );
    expect(deliveryRows[0].n).toBe(1);
  });

  it("a tenant's own alert_rule row REPLACES the platform default for that eventType, not a union", async () => {
    await admin.query(
      `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args, enabled)
       VALUES ($1,'claim.denied','administrative','warn','tenant_admins','{}',true)`,
      [ORG],
    );

    const result = await getAlertEmitter().emit(ORG, {
      eventType: "claim.denied",
      payload: { claimId: "claim-2" },
      severity: "warn",
      correlationId: "corr-gap096-2",
    });
    // Only the org_admin fires now (tenant_admins), NOT the billing_manager (the platform default) —
    // proves the org row shadows the platform row entirely rather than both firing.
    expect(result.resolvedRecipientCount).toBe(1);
    const { rows: deliveryRows } = await admin.query(
      "SELECT recipient_user_id FROM notification_delivery WHERE alert_id = $1",
      [result.alertId],
    );
    expect(deliveryRows.map((r) => r.recipient_user_id)).toEqual([orgAdminUserId]);
  });

  it("care_team resolver reaches the real GAP-059 CareTeamProvider seam", async () => {
    await admin.query(
      `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args, enabled)
       VALUES ($1,'test.gap096.care_team','clinical_urgent','warn','care_team','{"patientIdPath":"patientId"}',true)`,
      [ORG],
    );
    const result = await getAlertEmitter().emit(ORG, {
      eventType: "test.gap096.care_team",
      payload: { patientId },
      severity: "warn",
      correlationId: "corr-gap096-3",
    });
    expect(result.resolvedRecipientCount).toBe(1);
    const { rows: deliveryRows } = await admin.query(
      "SELECT recipient_user_id FROM notification_delivery WHERE alert_id = $1",
      [result.alertId],
    );
    expect(deliveryRows.map((r) => r.recipient_user_id)).toEqual([clinicianUserId]);
  });

  it("disciplineMembers refuses loudly rather than silently resolving to nobody", async () => {
    await admin.query(
      `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver, resolver_args, enabled)
       VALUES ($1,'test.gap096.discipline','operational','warn','discipline','{"disciplines":["rn"]}',true)`,
      [ORG],
    );
    await expect(
      getAlertEmitter().emit(ORG, {
        eventType: "test.gap096.discipline",
        payload: {},
        severity: "warn",
        correlationId: "corr-gap096-4",
      }),
    ).rejects.toThrow(/discipline vocabulary/);
  });

  it("vacation forwarding persists forwarded_from_user_id on the backup's delivery row", async () => {
    const backupRoleId = await insertRole("backup_admin", "Backup Admin", "admin_executive");
    const backupUserId = await insertMember("gap096-backup@x.test", backupRoleId);

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await admin.query(
      `INSERT INTO user_notification_preferences (user_id, organization_id, routing_map, vacation_forward_to_user_id, vacation_until)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        orgAdminUserId,
        ORG,
        JSON.stringify({ administrative: { warn: ["email"] } }),
        backupUserId,
        future,
      ],
    );

    const result = await getAlertEmitter().emit(ORG, {
      eventType: "claim.denied", // still tenant_admins-overridden from the earlier test
      payload: { claimId: "claim-3" },
      severity: "warn",
      correlationId: "corr-gap096-5",
    });

    const { rows: deliveryRows } = await admin.query(
      "SELECT recipient_user_id, forwarded_from_user_id, channel, status FROM notification_delivery WHERE alert_id = $1 ORDER BY channel",
      [result.alertId],
    );
    // in_app floor to the original (never forwarded) + the email channel forwarded to the backup.
    const inApp = deliveryRows.find((r) => r.channel === "in_app");
    expect(inApp?.recipient_user_id).toBe(orgAdminUserId);
    expect(inApp?.forwarded_from_user_id).toBeNull();

    const forwardedOriginal = deliveryRows.find(
      (r) => r.channel === "email" && r.status === "forwarded",
    );
    expect(forwardedOriginal?.recipient_user_id).toBe(orgAdminUserId);

    const backupDelivery = deliveryRows.find((r) => r.recipient_user_id === backupUserId);
    expect(backupDelivery?.forwarded_from_user_id).toBe(orgAdminUserId);
    expect(backupDelivery?.channel).toBe("email");
  });
});
