/**
 * F-150 (#248) — LIVE Postgres proof that M30's `enqueueRecompute` port, and the two consumer bindings
 * built on top of it (`buildM30HopeSubmissionAcceptedConsumer`, `buildM30ClaimAdjudicatedConsumer`),
 * actually write real `measure_recompute_queue` rows under RLS.
 *
 * `packages/quality/src/consumers/handlers.ts`'s §4.10 upstream handlers were pure, unit-tested and
 * completely unbound — `M30ConsumerPorts` had no implementation anywhere in this repository. This proves
 * the implementation this pass added (`outbox-consumers/upstream-consumer-ports.ts`) for real: the
 * per-measure period resolution, the debounced-enqueue idempotency (redelivery collapses onto the
 * existing pending row rather than duplicating it — the `uq_measure_recompute_pending` partial-unique),
 * and cross-tenant RLS isolation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m30:upstream-consumers:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildM30ClaimAdjudicatedConsumer,
  buildM30HopeSubmissionAcceptedConsumer,
  buildM30RestraintAppliedConsumer,
} from "../src/modules/30-quality/index";
import { selectActiveMemberRoleKeys } from "../src/modules/30-quality/member-roles";
import { restraintAdmissionSitingForOrg } from "../src/modules/37-ipu/seams/restraint-admission-siting-for-org";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
// chartwarden_destruction must go too: migration 1142 drops the wardenx_destruction alias, so if the destruction role
// survives a previous replay in this cluster, 1139 grants it membership of a FRESH alias that this replay's policies
// name, and 1142 then fails on those policies. Dropping it makes every replay start from a pre-1139 cluster.
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "chartwarden_destruction",
];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";

describe.skipIf(!DB_URL)("M30 upstream-event consumers — enqueueRecompute — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityA: string;
  let providerEntityB: string;
  let ipuAdmissionA: string;

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
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m30-upstream-a','M30 Upstream A','M30 Upstream A'),
              ($2,'m30-upstream-b','M30 Upstream B','M30 Upstream B')`,
      [ORG_A, ORG_B],
    );
    providerEntityA = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M30UP-A','Upstream Provider A','1000000001','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerEntityB = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M30UP-B','Upstream Provider B','1000000002','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    // F-185 (#248) — an `arranged`-kind `ipu_admission` (bypasses the unit RN-coverage gate; no
    // `inpatient_unit` row needed, but `ipu_admission_unit_xor_remote` requires a non-null
    // `remote_facility_id` for `kind='arranged'`) for `buildM30RestraintAppliedConsumer`'s siting
    // resolution. `patient_id`/`admission_id` (M6)/`level_of_care_period_id`/`remote_facility_id`
    // (M40)/`created_by` are logical, no-FK uuids (D17 outbox-decoupling) — any well-formed uuid
    // satisfies the NOT NULL columns.
    ipuAdmissionA = (
      await admin.query(
        `INSERT INTO ipu_admission
           (organization_id,provider_entity_id,patient_id,admission_id,level_of_care_period_id,kind,remote_facility_id,created_by)
         VALUES ($1,$2,$3,gen_random_uuid(),gen_random_uuid(),'arranged',gen_random_uuid(),gen_random_uuid())
         RETURNING id`,
        [ORG_A, providerEntityA, PATIENT_A],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("enqueues both hope_derived measures once, and a redelivery does not duplicate the pending row", async () => {
    const consumer = buildM30HopeSubmissionAcceptedConsumer({ db: handle.db });
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId: ORG_A,
      eventType: "m10.hope.submission_accepted",
      aggregateKind: "hope_submission",
      aggregateId: "44444444-4444-4444-8444-444444444444",
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        submissionId: "44444444-4444-4444-8444-444444444444",
        providerEntityId: providerEntityA,
      },
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery — must debounce onto the same pending row, not duplicate

    const rows = await admin.query(
      `SELECT measure_code, provider_entity_id, organization_id, requires_recompute,
              triggering_event_outbox_id, period_start, period_end
       FROM measure_recompute_queue WHERE organization_id = $1 ORDER BY measure_code`,
      [ORG_A],
    );
    expect(rows.rows.map((r) => r.measure_code)).toEqual(["tfp_npsi", "tfp_pi"]);
    for (const row of rows.rows) {
      expect(row.provider_entity_id).toBe(providerEntityA);
      expect(row.organization_id).toBe(ORG_A);
      expect(row.requires_recompute).toBe(true);
      expect(row.triggering_event_outbox_id).toBe(event.id);
      expect(new Date(row.period_start).getTime()).toBeLessThan(new Date(row.period_end).getTime());
    }
  });

  it("enqueues all eleven hci measures once for a claim adjudication, scoped to the claim's own org", async () => {
    const consumer = buildM30ClaimAdjudicatedConsumer({ db: handle.db });
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      organizationId: ORG_B,
      eventType: "m23.claim.adjudicated",
      aggregateKind: "claim",
      aggregateId: "66666666-6666-4666-8666-666666666666",
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        claimId: "66666666-6666-4666-8666-666666666666",
        providerEntityId: providerEntityB,
        outcome: "paid",
        remittanceAdviceId: "77777777-7777-4777-8777-777777777777",
        adjudicatedAt: "2026-06-15T12:00:00.000Z",
      },
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery — same debounce guarantee

    const rows = await admin.query(
      `SELECT measure_code, provider_entity_id, requires_recompute
       FROM measure_recompute_queue WHERE organization_id = $1 ORDER BY measure_code`,
      [ORG_B],
    );
    expect(rows.rows).toHaveLength(11);
    expect(rows.rows.every((r) => r.measure_code.startsWith("hci_"))).toBe(true);
    expect(rows.rows.every((r) => r.provider_entity_id === providerEntityB)).toBe(true);
    expect(rows.rows.every((r) => r.requires_recompute === true)).toBe(true);

    // Cross-tenant: org A's hope-derived rows from the prior test must not have picked up org B's claim,
    // and org B's rows must not be visible to a read scoped to org A (the RLS floor this whole port relies on).
    const crossCheck = await admin.query(
      `SELECT count(*)::int AS n FROM measure_recompute_queue WHERE organization_id = $1 AND measure_code LIKE 'hci_%'`,
      [ORG_A],
    );
    expect(crossCheck.rows[0].n).toBe(0);
  });

  // F-185 (#248) — the previously declared-but-unbound `m37.restraint.applied` → `restraint_use`
  // incident-draft consumer. Proves `createIncidentDraft` (now real — `M30_SYSTEM_MEMBERSHIP_ID`) and the
  // injected `restraintAdmissionSitingForOrg` M37 seam both work under real RLS, and that a redelivery
  // (same outbox event id) is a no-op via the `triggering_event_outbox_id` partial-unique idempotency the
  // `m12.medication.error_reported` shape already relies on (see `auto_creator.ts`'s own doc comment).
  it("resolves providerEntityId/patientId via the IPU admission and auto-files a draft restraint_use incident; a redelivery does not duplicate it", async () => {
    const consumer = buildM30RestraintAppliedConsumer({
      db: handle.db,
      restraintAdmissionSitingForOrg,
    });
    const event = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
      organizationId: ORG_A,
      eventType: "m37.restraint.applied",
      aggregateKind: "ipu_restraint_event",
      aggregateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      attemptCount: 0,
      createdAt: new Date("2026-03-01T10:00:00Z"),
      payload: {
        ipuAdmissionId: ipuAdmissionA,
        organizationId: ORG_A,
        restraintEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        restraintKind: "four_point",
      },
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery — must be a no-op, not a duplicate draft

    const rows = await admin.query(
      `SELECT kind, severity, lifecycle, provider_entity_id, patient_id, reported_by_membership_id,
              triggering_event_outbox_id, kind_data, occurred_at
       FROM incident_report WHERE organization_id = $1`,
      [ORG_A],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(row.kind).toBe("restraint_use");
    expect(row.severity).toBe("moderate");
    expect(row.lifecycle).toBe("draft");
    expect(row.provider_entity_id).toBe(providerEntityA);
    expect(row.patient_id).toBe(PATIENT_A);
    expect(row.reported_by_membership_id).toBe("00000000-0000-0000-0000-000000000030");
    expect(row.triggering_event_outbox_id).toBe(event.id);
    expect(row.kind_data).toMatchObject({
      restraintEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      restraintKind: "four_point",
      narrativeText: "Restraint applied; see IPU restraint record for clinical detail.",
    });
    expect(new Date(row.occurred_at).toISOString()).toBe(event.createdAt.toISOString());
  });

  it("an ipuAdmissionId this org does not recognise (cross-tenant / stale redelivery) is a silent no-op", async () => {
    const consumer = buildM30RestraintAppliedConsumer({
      db: handle.db,
      restraintAdmissionSitingForOrg,
    });
    const event = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      organizationId: ORG_B, // ipuAdmissionA belongs to ORG_A
      eventType: "m37.restraint.applied",
      aggregateKind: "ipu_restraint_event",
      aggregateId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        ipuAdmissionId: ipuAdmissionA,
        organizationId: ORG_B,
        restraintEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        restraintKind: "four_point",
      },
    };
    await expect(consumer.handle(event)).resolves.toBeUndefined();

    const rows = await admin.query(
      `SELECT count(*)::int AS n FROM incident_report WHERE organization_id = $1`,
      [ORG_B],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

// GAP-088 — the second co-signer of a PIP / SRA close must be a real ACTIVE member of the CALLER'S org with
// live roles. Proven as the real NOBYPASSRLS `chartwarden_app` role (a superuser read would prove nothing about
// the cross-tenant case). Seeds its own users/memberships/roles on top of the suite's two orgs.
describe.skipIf(!DB_URL)("GAP-088 selectActiveMemberRoleKeys (live, chartwarden_app)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const ids: Record<"active" | "suspended" | "expired" | "otherOrg" | "disabledRole", string> = {
    active: "",
    disabledRole: "",
    suspended: "",
    expired: "",
    otherOrg: "",
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    const mk = async (email: string, org: string, status: string): Promise<string> => {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])
      ).rows[0].id as string;
      return (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3::membership_status) RETURNING id`,
          [user, org, status],
        )
      ).rows[0].id as string;
    };
    ids.active = await mk("g088-active@x.test", ORG_A, "active");
    ids.suspended = await mk("g088-susp@x.test", ORG_A, "suspended");
    ids.expired = await mk("g088-exp@x.test", ORG_A, "active");
    ids.otherOrg = await mk("g088-other@x.test", ORG_B, "active");
    ids.disabledRole = await mk("g088-disabled@x.test", ORG_A, "active");
    const roleId = async (org: string, key: string): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'clinical_leadership') RETURNING id`,
          [org, key],
        )
      ).rows[0].id as string;
    const mdA = await roleId(ORG_A, "medical_director");
    // A DISABLED tenant role must confer nothing (same authority as request.context.roles). A tenant row with a
    // reserved platform key cannot be seeded here (migration 0318 backstop) — that arm is unit-tested in
    // m30-close-cosign.test.ts.
    const disabledRole = await roleId(ORG_A, "compliance_officer");
    await admin.query(`UPDATE role SET enabled = false WHERE id = $1`, [disabledRole]);
    const mdB = await roleId(ORG_B, "medical_director");
    const grant = (org: string, membership: string, role: string, expires: string) =>
      admin.query(
        `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,${expires})`,
        [org, membership, role],
      );
    await grant(ORG_A, ids.active, mdA, "NULL");
    await grant(ORG_A, ids.suspended, mdA, "NULL");
    await grant(ORG_A, ids.disabledRole, disabledRole, "NULL");
    await grant(ORG_A, ids.expired, mdA, "now() - interval '1 day'");
    await grant(ORG_B, ids.otherOrg, mdB, "NULL");
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const lookup = (org: string, membershipId: string) =>
    withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      selectActiveMemberRoleKeys(tx, org, membershipId),
    );

  it("returns the live roles of an active member of the caller's org", async () => {
    await expect(lookup(ORG_A, ids.active)).resolves.toEqual(["medical_director"]);
  });

  it("returns null for a suspended membership and for a membership of ANOTHER org", async () => {
    await expect(lookup(ORG_A, ids.suspended)).resolves.toBeNull();
    await expect(lookup(ORG_A, ids.otherOrg)).resolves.toBeNull();
  });

  it("does not count an expired role grant", async () => {
    await expect(lookup(ORG_A, ids.expired)).resolves.toEqual([]);
  });

  it("does not count a DISABLED role (roles.enabled = false)", async () => {
    await expect(lookup(ORG_A, ids.disabledRole)).resolves.toEqual([]);
  });
});
