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
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/gap-096-alert-emitter-live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { createAlertPayloadRegistry } from "@chartwarden/messaging";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMembershipsHoldingPermissionReader } from "../src/modules/03-authorization/index";
import { createDrizzleCareTeamStore, registerPatientSeams } from "../src/modules/05-patient/index";
import { M14_ALERT_PAYLOADS } from "../src/modules/14-idg/index";
import {
  buildIdgAlertConsumers,
  buildIdgCarryForwardComplianceConsumer,
  createDrizzleAlertEmitter,
  createDrizzleIdgAttendeeLookup,
  createDrizzleMembershipUserLookup,
  getAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
    // The emitter re-checks the final audience for an active membership, so a real clinician needs one.
    const clinicianRoleId = await insertRole("rn", "RN", "clinical_staff");
    clinicianUserId = await insertMember("gap096-rn@x.test", clinicianRoleId);
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

  it("care_team resolver drops an assigned clinician who has no active membership", async () => {
    const otherPatientId = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-GAP096-B','Drew','Departed','1971-06-06','F','active') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    const departedUserId = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        "gap096-gone@x.test",
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn',CURRENT_DATE)`,
      [otherPatientId, ORG, departedUserId],
    );
    const result = await getAlertEmitter().emit(ORG, {
      eventType: "test.gap096.care_team",
      payload: { patientId: otherPatientId },
      severity: "warn",
      correlationId: "corr-gap096-3b",
    });
    const { rows: deliveryRows } = await admin.query(
      "SELECT recipient_user_id FROM notification_delivery WHERE alert_id = $1",
      [result.alertId],
    );
    expect(deliveryRows).toEqual([]);
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

  // ── M14 §2.7/D8 — the carry-forward COMPLIANCE alert through the REAL emitter + RLS as chartwarden_app ──────────
  it("m14.action_item.carry_forward (the crossing) raises ONE critical typed alert to the real compliance/supervisor/admin/coordinator audience, tenant-isolated, PHI-free, idempotent on redelivery", async () => {
    const ORG2 = "88888888-8888-8888-8888-888888888888";
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-gap096-b','B','B')",
      [ORG2],
    );
    const seedUser = async (
      org: string,
      email: string,
      roleKey: string | null,
    ): Promise<{ userId: string; membershipId: string }> => {
      const userId = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])
      ).rows[0].id as string;
      const membershipId = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [userId, org],
        )
      ).rows[0].id as string;
      if (roleKey !== null) {
        const existing = await admin.query(
          "SELECT id FROM role WHERE organization_id=$1 AND key=$2",
          [org, roleKey],
        );
        const roleId =
          existing.rows[0]?.id ??
          (
            await admin.query(
              "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
              [org, roleKey],
            )
          ).rows[0].id;
        await admin.query(
          "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
          [org, membershipId, roleId],
        );
      }
      return { userId, membershipId };
    };
    const compliance = await seedUser(ORG, "idg-compliance@x.test", "compliance_officer");
    const supervisor = await seedUser(ORG, "idg-supervisor@x.test", "clinical_supervisor");
    const coordinator = await seedUser(ORG, "idg-coordinator@x.test", null); // no role: reached ONLY via coordinatorUserId
    const bystander = await seedUser(ORG, "idg-bystander@x.test", "billing_manager");
    const otherOrgCompliance = await seedUser(
      ORG2,
      "idg-b-compliance@x.test",
      "compliance_officer",
    );

    await wireAlertRuleSeed(handle.db);
    const registry = createAlertPayloadRegistry();
    registry.register(M14_ALERT_PAYLOADS);
    registry.assertValid();
    const consumer = buildIdgCarryForwardComplianceConsumer({
      alerts: createDrizzleAlertEmitter(handle.db),
      catalog: registry.build(),
      membershipUserId: createDrizzleMembershipUserLookup(handle.db),
    });
    const itemId = "7e57ed17-0000-4000-8000-00000000c0de";
    const event = (payload: Record<string, unknown>) => ({
      id: "evt-cf-1",
      eventType: "m14.action_item.carry_forward",
      aggregateKind: "idg_action_item",
      aggregateId: itemId,
      organizationId: ORG,
      attemptCount: 0,
      createdAt: new Date(),
      payload,
    });
    const crossing = {
      priorActionItemId: itemId,
      newAgendaItemId: "agd-1",
      carryForwardCount: 3,
      isComplianceAlert: true,
      coordinatorMembershipId: coordinator.membershipId,
    };

    // A non-crossing carry raises nothing.
    await consumer.handle(event({ ...crossing, carryForwardCount: 2, isComplianceAlert: false }));
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM alert WHERE event_type='m14.action_item.carry_forward.compliance'",
        )
      ).rows[0].n,
    ).toBe(0);

    await consumer.handle(event(crossing));
    await consumer.handle(event(crossing)); // relay redelivery
    await consumer.handle(event({ ...crossing, newAgendaItemId: "agd-2" })); // dipped below 3 and re-crossed
    const { rows: alerts } = await admin.query(
      "SELECT id, organization_id, severity, payload, correlation_id FROM alert WHERE event_type='m14.action_item.carry_forward.compliance'",
    );
    expect(alerts).toHaveLength(1); // one alert per action item, ever
    expect(alerts[0].organization_id).toBe(ORG);
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].correlation_id).toBe(`m14.carry_forward.compliance:${itemId}`);
    expect(Object.keys(alerts[0].payload).sort()).toEqual(
      [
        "bodyTemplate",
        "carryForwardCount",
        "coordinatorUserId",
        "organizationId",
        "priorActionItemId",
        "recipients",
        "severity",
      ].sort(),
    );
    expect(JSON.stringify(alerts[0].payload)).not.toMatch(/patient|title|http/i);

    const { rows: deliveries } = await admin.query(
      "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1 AND channel='in_app'",
      [alerts[0].id],
    );
    const got = deliveries.map((r) => r.recipient_user_id).sort();
    // compliance_officer + clinical_supervisor + org_admin (seeded earlier in this ORG) + the coordinator; NOT the
    // billing_manager bystander, and NOTHING from the other tenant.
    expect(got).toEqual(
      [compliance.userId, supervisor.userId, coordinator.userId, orgAdminUserId].sort(),
    );
    expect(got).not.toContain(bystander.userId);
    expect(got).not.toContain(otherOrgCompliance.userId);
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM alert WHERE organization_id=$1", [ORG2]))
        .rows[0].n,
    ).toBe(0);
  });

  // ── M14 §4.10 — the REMAINING typed IDG alerts through the REAL emitter + RLS as chartwarden_app ────────────────
  it("m14 typed alerts (packets ready / action item / non-quorate / review clock / override): real derived attendee roster + tiered audience, tenant-isolated, idempotent, PHI-free", async () => {
    const P = "77777777-7777-7777-7777-777777777777"; // primary tenant for this test (fresh: no roles from earlier tests)
    const O = "66666666-6666-6666-6666-666666666666"; // the OTHER tenant (isolation twin)
    const LOC = "10c00000-0000-4000-8000-000000000001";
    const OTHER_LOC = "10c00000-0000-4000-8000-000000000002";
    for (const [id, slug] of [
      [P, "org-gap096-p"],
      [O, "org-gap096-o"],
    ]) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const k of ["idg.attend", "idg.coordinate"]) {
      await admin.query(
        "INSERT INTO permission (key,resource,action,category) VALUES ($1,'idg_meeting','x','clinical') ON CONFLICT DO NOTHING",
        [k],
      );
    }
    const roleIn = async (org: string, key: string, perms: string[]): Promise<string> => {
      const existing = await admin.query(
        "SELECT id FROM role WHERE organization_id=$1 AND key=$2",
        [org, key],
      );
      const roleId: string =
        existing.rows[0]?.id ??
        (
          await admin.query(
            "INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'admin_executive') RETURNING id",
            [org, key],
          )
        ).rows[0].id;
      for (const k of perms) {
        await admin.query(
          "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [org, roleId, k],
        );
      }
      return roleId;
    };
    const member = async (
      org: string,
      email: string,
      opts: {
        role?: string | null;
        perms?: string[];
        locations?: string[];
        status?: string;
        expired?: boolean;
      } = {},
    ): Promise<{ userId: string; membershipId: string }> => {
      const userId = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])
      ).rows[0].id as string;
      const membershipId = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status, default_location_ids) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
          [userId, org, opts.status ?? "active", JSON.stringify(opts.locations ?? [])],
        )
      ).rows[0].id as string;
      if (opts.role) {
        const roleId = await roleIn(org, opts.role, opts.perms ?? []);
        await admin.query(
          "INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)",
          [org, membershipId, roleId, opts.expired ? new Date(Date.now() - 3600_000) : null],
        );
      }
      return { userId, membershipId };
    };
    const rn = await member(P, "idg2-rn@x.test", {
      role: "rn",
      perms: ["idg.attend"],
      locations: [LOC],
    });
    const md = await member(P, "idg2-md@x.test", {
      role: "md",
      perms: ["idg.coordinate"],
      locations: [LOC, OTHER_LOC],
    });
    const coordinator = await member(P, "idg2-coord@x.test", { locations: [LOC] }); // no role: coordinator id only
    const wrongLocation = await member(P, "idg2-wrongloc@x.test", {
      role: "rn",
      perms: ["idg.attend"],
      locations: [OTHER_LOC],
    });
    const noIdgKey = await member(P, "idg2-nokey@x.test", {
      role: "billing_manager",
      locations: [LOC],
    });
    const revoked = await member(P, "idg2-revoked@x.test", {
      role: "rn",
      perms: ["idg.attend"],
      locations: [LOC],
      status: "revoked",
    });
    const expiredRole = await member(P, "idg2-expired@x.test", {
      role: "lapsed_rn",
      perms: ["idg.attend"],
      locations: [LOC],
      expired: true,
    });
    const assignee = await member(P, "idg2-assignee@x.test");
    const supervisor = await member(P, "idg2-sup@x.test", { role: "clinical_supervisor" });
    const compliance = await member(P, "idg2-comp@x.test", { role: "compliance_officer" });
    const orgAdmin = await member(P, "idg2-admin@x.test", { role: "org_admin" });
    // a twin in ANOTHER tenant holding every key for the same location id: must never be reached
    const other = await member(O, "idg2-c-rn@x.test", {
      role: "rn",
      perms: ["idg.attend"],
      locations: [LOC],
    });
    const otherCompliance = await member(O, "idg2-c-comp@x.test", {
      role: "compliance_officer",
    });

    await wireAlertRuleSeed(handle.db);
    const registry = createAlertPayloadRegistry();
    registry.register(M14_ALERT_PAYLOADS);
    registry.assertValid();
    const consumers = buildIdgAlertConsumers({
      alerts: createDrizzleAlertEmitter(handle.db),
      catalog: registry.build(),
      membershipUserId: createDrizzleMembershipUserLookup(handle.db),
      meetingAttendees: createDrizzleIdgAttendeeLookup(
        handle.db,
        createMembershipsHoldingPermissionReader(handle.db),
      ),
    });
    const by = (name: string) => consumers.find((c) => c.eventTypes[0] === name)!;
    const ev = (eventType: string, payload: Record<string, unknown>, id: string) => ({
      id,
      eventType,
      aggregateKind: "x",
      aggregateId: "agg",
      organizationId: P,
      attemptCount: 0,
      createdAt: new Date(),
      payload,
    });
    const alertsOf = async (type: string) =>
      (
        await admin.query(
          "SELECT id, organization_id, severity, payload, correlation_id FROM alert WHERE event_type=$1",
          [type],
        )
      ).rows;
    const recipientsOf = async (alertId: string): Promise<string[]> =>
      (
        await admin.query(
          "SELECT DISTINCT recipient_user_id FROM notification_delivery WHERE alert_id=$1 AND channel='in_app'",
          [alertId],
        )
      ).rows
        .map((r) => r.recipient_user_id as string)
        .sort();
    const MTG = "e7700000-0000-4000-8000-000000000001";

    // 1. packets ready — the derived roster (idg.attend / idg.coordinate + location scope + active + unexpired) + coordinator
    const ready = {
      meetingId: MTG,
      builtPacketCount: 3,
      scheduledAttendees: 0,
      locationId: LOC,
      scheduledStart: "2026-10-01T15:00:00.000Z",
      coordinatorMembershipId: coordinator.membershipId,
    };
    await by("m14.packets.ready").handle(ev("m14.packets.ready", ready, "e-ready-1"));
    await by("m14.packets.ready").handle(ev("m14.packets.ready", ready, "e-ready-1")); // redelivery
    await by("m14.packets.ready").handle(
      ev("m14.packets.ready", { ...ready, builtPacketCount: 7 }, "e-ready-2"),
    ); // per MEETING, not per packet / event
    const readyAlerts = await alertsOf("m14.packets.ready");
    expect(readyAlerts).toHaveLength(1);
    expect(readyAlerts[0].correlation_id).toBe(`m14.packets.ready:${MTG}`);
    expect(readyAlerts[0].severity).toBe("info");
    const readyGot = await recipientsOf(readyAlerts[0].id);
    expect(readyGot).toEqual([rn.userId, md.userId, coordinator.userId].sort());
    for (const nope of [wrongLocation, noIdgKey, revoked, expiredRole, other]) {
      expect(readyGot).not.toContain(nope.userId);
    }
    expect(readyAlerts[0].payload.recipients.attendeesByMembershipId.sort()).toEqual(
      [rn.membershipId, md.membershipId, coordinator.membershipId].sort(),
    );

    // 2. action item assigned — the assignee only
    const act = {
      actionItemId: "ac700000-0000-4000-8000-000000000001",
      meetingId: MTG,
      decisionId: null,
      patientId: null,
      assignedToMembershipId: assignee.membershipId,
      dueDate: "2026-10-08T00:00:00.000Z",
      linkedArtifactKind: null,
      linkedArtifactId: null,
    };
    await by("m14.action_item.created").handle(ev("m14.action_item.created", act, "e-act-1"));
    await by("m14.action_item.created").handle(ev("m14.action_item.created", act, "e-act-1"));
    const actAlerts = await alertsOf("m14.action_item.created");
    expect(actAlerts).toHaveLength(1);
    expect(await recipientsOf(actAlerts[0].id)).toEqual([assignee.userId]);

    // 3. non-quorate — a quorate decision raises nothing; the non-quorate one notifies the coordinator
    const dec = {
      decisionId: "dec00000-0000-4000-8000-000000000001",
      meetingId: MTG,
      patientId: "a7100000-0000-4000-8000-000000000001",
      decisionKind: "care_plan_update",
      wasQuorate: true,
      recordedByMembershipId: md.membershipId,
      recordedAt: "2026-10-01T15:00:00.000Z",
    };
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", dec, "e-d-0"));
    expect(await alertsOf("m14.decision.non_quorate")).toHaveLength(0);
    const nonQ = {
      ...dec,
      wasQuorate: false,
      coordinatorMembershipId: coordinator.membershipId,
      missingDisciplines: ["msw"],
    };
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", nonQ, "e-d-1"));
    await by("m14.decision.recorded_open").handle(ev("m14.decision.recorded_open", nonQ, "e-d-1"));
    const nqAlerts = await alertsOf("m14.decision.non_quorate");
    expect(nqAlerts).toHaveLength(1);
    expect(await recipientsOf(nqAlerts[0].id)).toEqual([coordinator.userId]);

    // 4. review clock — tiered audience, per (patient, tier, cycle)
    const clock = (stage: string, severity: string, floorAt = "2026-09-16T00:00:00.000Z") => ({
      admissionId: "ad700000-0000-4000-8000-000000000001",
      patientId: "a7100000-0000-4000-8000-000000000001",
      locationId: LOC,
      lastIdgReviewedAt: "2026-09-01T00:00:00.000Z",
      floorAt,
      stage,
      severity,
      coordinatorMembershipId: coordinator.membershipId,
    });
    for (const [stage, sev] of [
      ["t_minus_3", "clinical_routine"],
      ["t_zero", "critical"],
      ["t_plus_1", "critical"],
    ] as const) {
      await by("m14.review_clock.escalated").handle(
        ev("m14.review_clock.escalated", clock(stage, sev), `e-clk-${stage}`),
      );
      await by("m14.review_clock.escalated").handle(
        ev("m14.review_clock.escalated", clock(stage, sev), `e-clk-${stage}`),
      ); // redelivery
    }
    const clkAlerts = await alertsOf("m14.review_clock.escalated");
    expect(clkAlerts).toHaveLength(3);
    const tier = async (stage: string) =>
      recipientsOf(clkAlerts.find((a) => a.payload.stage === stage)!.id as string);
    expect(await tier("t_minus_3")).toEqual([coordinator.userId]);
    expect(await tier("t_zero")).toEqual([coordinator.userId, supervisor.userId].sort());
    expect(await tier("t_plus_1")).toEqual(
      [coordinator.userId, supervisor.userId, compliance.userId, orgAdmin.userId].sort(),
    );
    expect(clkAlerts.find((a) => a.payload.stage === "t_minus_3")!.severity).toBe("warn");
    expect(clkAlerts.find((a) => a.payload.stage === "t_plus_1")!.severity).toBe("critical");
    // a NEW clock cycle (a review moved the floor) for the same patient+tier alerts again
    await by("m14.review_clock.escalated").handle(
      ev(
        "m14.review_clock.escalated",
        clock("t_zero", "critical", "2026-10-20T00:00:00.000Z"),
        "e-clk-n",
      ),
    );
    expect(await alertsOf("m14.review_clock.escalated")).toHaveLength(4);

    // 5. review-floor override — compliance + supervisor (+ org_admin), the free-text reason never stored
    const ovr = {
      meetingId: MTG,
      actorMembershipId: md.membershipId,
      reason: "PHI-ish reason: family of Jane Doe",
      breachingPatients: [
        { patientId: "a7100000-0000-4000-8000-000000000001", floorAt: "2026-09-16T00:00:00.000Z" },
      ],
      overriddenAt: "2026-09-15T00:00:00.000Z",
    };
    await by("m14.review_floor.override_recorded").handle(
      ev("m14.review_floor.override_recorded", ovr, "e-ovr-1"),
    );
    await by("m14.review_floor.override_recorded").handle(
      ev("m14.review_floor.override_recorded", ovr, "e-ovr-1"),
    );
    const ovrAlerts = await alertsOf("m14.review_floor.override_recorded");
    expect(ovrAlerts).toHaveLength(1);
    expect(await recipientsOf(ovrAlerts[0].id)).toEqual(
      [compliance.userId, supervisor.userId, orgAdmin.userId].sort(),
    );
    expect(JSON.stringify(ovrAlerts[0].payload)).not.toMatch(/Jane|Doe|reason/);

    // tenant isolation + PHI-free across the whole family
    const all = await admin.query(
      "SELECT event_type, organization_id, payload FROM alert WHERE event_type LIKE 'm14.%' AND event_type <> 'm14.action_item.carry_forward.compliance'",
    );
    expect(all.rows.every((r) => r.organization_id === P)).toBe(true);
    const leaked = await admin.query(
      "SELECT count(*)::int AS n FROM notification_delivery WHERE recipient_user_id = ANY($1::uuid[])",
      [[other.userId, otherCompliance.userId]],
    );
    expect(leaked.rows[0].n).toBe(0);
    expect(
      (await admin.query("SELECT count(*)::int AS n FROM alert WHERE organization_id=$1", [O]))
        .rows[0].n,
    ).toBe(0);
    for (const r of all.rows)
      expect(JSON.stringify(r.payload)).not.toMatch(/Casey|Careteam|http|title/i);
  });
});
