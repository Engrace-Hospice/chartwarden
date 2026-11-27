import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROWS,
  assertRlsEnforcedRole,
  runVisitPairingReconciliation,
} from "../../../scripts/lib/visit-pairing-run";
import {
  PAIRING_RECONCILED_AUDIT_EVENT,
  PairingPlanTooLargeError,
  applyVisitPairingRestampsForOrg,
  planVisitPairingsForOrg,
} from "../src/modules/17-scheduling/visit-pairing-reconcile";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

/**
 * CW-PI-04 — older visits whose stamped discipline pairing today's rules refuse: detect (ids only), dry run,
 * cap refusal, restamp, audit and tenant isolation, proven as the NOBYPASSRLS `chartwarden_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/<fresh db> \
 *     bun run test:m17:visit-pairing-reconcile:live
 * Private container only (never the shared cluster); start Postgres with `-c max_locks_per_transaction=1024`.
 * Synthetic data only: invented ids, `@x.test` addresses, no names.
 */
const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const PATIENT = "44444444-4444-4444-8444-444444444444";
const ADMISSION = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "99999999-9999-4999-8999-999999999999";
const HOUR = 3_600_000;
const BASE_MS = Date.parse("2026-12-15T08:00:00Z");
const MIGRATION_TIMEOUT_MS = 240_000;

/** Every key a report may carry: ids and codes, never a name or free text. */
const ALLOWED_KEYS = new Set([
  "mode",
  "runId",
  "maxRows",
  "plannedRestamps",
  "reviewQueue",
  "exceedsCap",
  "refused",
  "organizations",
  "applied",
  "organizationId",
  "affected",
  "counts",
  "restamp",
  "review",
  "historical",
  "visitId",
  "purpose",
  "stampedDiscipline",
  "toDiscipline",
  "status",
  "reason",
  "changed",
  "skippedStale",
]);

function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  }
  return into;
}

type Staff = { alice: string; bob: string; carol: string; dave: string; frank: string };
type Ids = {
  restampPublished: string;
  restampProposed: string;
  noLegalHeld: string;
  notCredentialed: string;
  ambiguous: string;
  inProgress: string;
  inactiveAssignee: string;
  completed: string;
  legal: string;
  orgBRestamp: string;
};

describe.skipIf(!DB_URL)(
  "CW-PI-04 visit pairing reconcile — LIVE Postgres as chartwarden_app",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let superHandle: ReturnType<typeof createDbClient>;
    const staff = {} as Staff;
    const ids = {} as Ids;
    let erin = "";
    let slot = 0;

    async function seedVisit(
      org: string,
      membership: string,
      purpose: string,
      stamped: string,
      status: string,
    ): Promise<string> {
      const { pe, location } = (
        await admin.query(
          `SELECT pe.id AS pe, l.id AS location FROM provider_entity pe
           JOIN location l ON l.provider_entity_id = pe.id WHERE pe.organization_id = $1`,
          [org],
        )
      ).rows[0];
      const start = BASE_MS + ++slot * 2 * HOUR;
      return (
        await admin.query(
          `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
             assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
             scheduled_started_at, scheduled_ended_at, service_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'patient_home',$9,$10,'2026-12-15',$11) RETURNING id`,
          [
            org,
            pe,
            location,
            PATIENT,
            ADMISSION,
            membership,
            stamped,
            purpose,
            new Date(start).toISOString(),
            new Date(start + HOUR).toISOString(),
            status,
          ],
        )
      ).rows[0].id as string;
    }

    async function member(org: string, userN: number, roles: string[], creds: string[]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `pi04-${userN}@x.test`,
        ])
      ).rows[0].id as string;
      const membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      for (const key of roles) {
        const roleId = (
          await admin.query(`SELECT id FROM role WHERE organization_id=$1 AND key=$2`, [org, key])
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)`,
          [org, membership, roleId],
        );
      }
      for (const kind of creds) {
        await admin.query(
          `INSERT INTO membership_credential (organization_id, membership_id, credential_type, effective_at, granted_by_membership_id)
           VALUES ($1,$2,$3,'2020-01-01',$2)`,
          [org, membership, kind],
        );
      }
      return membership;
    }

    async function snapshot() {
      const visits = await admin.query(
        `SELECT id, assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, status, version, updated_at
           FROM visit ORDER BY id`,
      );
      const audits = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type = $1",
        [PAIRING_RECONCILED_AUDIT_EVENT],
      );
      const outbox = await admin.query("SELECT count(*)::int AS n FROM outbox_event");
      return { visits: visits.rows, audits: audits.rows[0].n, outbox: outbox.rows[0].n };
    }

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
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      for (const org of [ORG_A, ORG_B]) {
        const pe = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
            [
              org,
              `CCN-PI04-${org.slice(0, 4)}`,
              `PI04 ${org.slice(0, 4)}`,
              `NPI-PI04-${org.slice(0, 4)}`,
            ],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles')`,
          [pe],
        );
        for (const key of ["rn", "np", "lpn"]) {
          await admin.query(
            `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$3,'clinical_staff')`,
            [org, key, key.toUpperCase()],
          );
        }
      }
      staff.alice = await member(ORG_A, 1, ["rn", "np"], ["rn", "np"]);
      staff.bob = await member(ORG_A, 2, ["np"], ["np"]);
      staff.carol = await member(ORG_A, 3, ["rn"], []);
      staff.dave = await member(ORG_A, 4, ["rn", "lpn"], ["rn", "lpn"]);
      staff.frank = await member(ORG_A, 6, ["rn"], ["rn"]);
      await admin.query("UPDATE membership SET status = 'suspended' WHERE id = $1", [staff.frank]);
      erin = await member(ORG_B, 5, ["rn"], ["rn"]);

      ids.restampPublished = await seedVisit(ORG_A, staff.alice, "recert", "np", "published");
      ids.restampProposed = await seedVisit(ORG_A, staff.alice, "recert", "np", "proposed");
      ids.noLegalHeld = await seedVisit(ORG_A, staff.bob, "recert", "np", "published");
      ids.notCredentialed = await seedVisit(ORG_A, staff.carol, "recert", "np", "published");
      ids.ambiguous = await seedVisit(ORG_A, staff.dave, "routine_visit", "np", "published");
      ids.inProgress = await seedVisit(ORG_A, staff.alice, "recert", "np", "in_visit");
      ids.inactiveAssignee = await seedVisit(ORG_A, staff.frank, "recert", "np", "published");
      ids.completed = await seedVisit(ORG_A, staff.alice, "recert", "np", "completed");
      ids.legal = await seedVisit(ORG_A, staff.alice, "recert", "rn", "published");
      ids.orgBRestamp = await seedVisit(ORG_B, erin, "recert", "np", "published");

      const appUrl = await appRoleConnectionString(admin, DB_URL as string);
      handle = createDbClient({ connectionString: appUrl });
      superHandle = createDbClient({ connectionString: DB_URL as string });
    }, MIGRATION_TIMEOUT_MS);

    afterAll(async () => {
      await handle?.close();
      await superHandle?.close();
      if (admin) await admin.end();
    });

    it("runs only as an RLS-enforced role", async () => {
      await expect(assertRlsEnforcedRole(handle.db)).resolves.toBeUndefined();
      await expect(assertRlsEnforcedRole(superHandle.db)).rejects.toThrow(/NOBYPASSRLS/);
    });

    it("detects the affected visit ids per tenant and sorts each into restamp, review or history", async () => {
      const a = await planVisitPairingsForOrg(handle.db, ORG_A);
      expect(a.restamp.map((r) => r.visitId).sort()).toEqual(
        [ids.restampPublished, ids.restampProposed].sort(),
      );
      expect(a.restamp.every((r) => r.toDiscipline === "rn")).toBe(true);
      expect(Object.fromEntries(a.review.map((r) => [r.visitId, r.reason]))).toEqual({
        [ids.noLegalHeld]: "NO_LEGAL_DISCIPLINE_HELD",
        [ids.notCredentialed]: "LEGAL_DISCIPLINE_NOT_CREDENTIALED",
        [ids.ambiguous]: "AMBIGUOUS_LEGAL_DISCIPLINES",
        [ids.inProgress]: "VISIT_IN_PROGRESS",
        [ids.inactiveAssignee]: "ASSIGNEE_NOT_ACTIVE",
      });
      expect(Object.fromEntries(a.restamp.map((r) => [r.visitId, r.status]))).toEqual({
        [ids.restampPublished]: "published",
        [ids.restampProposed]: "proposed",
      });
      expect(a.historical.map((h) => h.visitId)).toEqual([ids.completed]);
      expect(JSON.stringify(a)).not.toContain(ids.legal);
    });

    it("keeps tenants apart: each plan sees only its own visits, and a foreign id in a plan changes nothing", async () => {
      const a = await planVisitPairingsForOrg(handle.db, ORG_A);
      const b = await planVisitPairingsForOrg(handle.db, ORG_B);
      expect(b.restamp.map((r) => r.visitId)).toEqual([ids.orgBRestamp]);
      expect(b.review).toEqual([]);
      expect(b.historical).toEqual([]);
      const aIds = [...a.restamp, ...a.review, ...a.historical].map((f) => f.visitId);
      expect(aIds).not.toContain(ids.orgBRestamp);

      // Org B's context handed org A's restamp entry: RLS and the org predicate leave A's visit alone.
      const forged = { ...b, restamp: a.restamp.slice(0, 1) };
      const before = await snapshot();
      const result = await applyVisitPairingRestampsForOrg(handle.db, forged, {
        maxRows: 5,
        runId: RUN_ID,
        operator: "ops-test",
      });
      expect(result.changed).toEqual([]);
      expect(result.skippedStale).toEqual([a.restamp[0]?.visitId]);
      expect(await snapshot()).toEqual(before);
    });

    it("dry run reports counts and ids and changes nothing (no visit, audit or outbox row)", async () => {
      const before = await snapshot();
      const { exitCode, summary } = await runVisitPairingReconciliation(
        handle.db,
        [ORG_A, ORG_B],
        { apply: false, maxRows: DEFAULT_MAX_ROWS, orgIds: null, operator: "" },
        RUN_ID,
      );
      expect(exitCode).toBe(0);
      expect(summary.mode).toBe("dry-run");
      expect(summary.plannedRestamps).toBe(3);
      expect(summary.reviewQueue).toBe(5);
      expect(summary.applied).toEqual([]);
      expect(await snapshot()).toEqual(before);
      for (const key of keysOf(summary)) expect(ALLOWED_KEYS.has(key)).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("@x.test");
    });

    it("refuses a plan bigger than --max-rows whole: nothing is written and the exit is non-zero", async () => {
      const before = await snapshot();
      const { exitCode, summary } = await runVisitPairingReconciliation(
        handle.db,
        [ORG_A, ORG_B],
        { apply: true, maxRows: 2, orgIds: null, operator: "ops-test" },
        RUN_ID,
      );
      expect(exitCode).toBe(3);
      expect(summary.refused).toBe(true);
      expect(summary.applied).toEqual([]);
      expect(await snapshot()).toEqual(before);

      const plan = await planVisitPairingsForOrg(handle.db, ORG_A);
      await expect(
        applyVisitPairingRestampsForOrg(handle.db, plan, {
          maxRows: 1,
          runId: RUN_ID,
          operator: "ops-test",
        }),
      ).rejects.toBeInstanceOf(PairingPlanTooLargeError);
      expect(await snapshot()).toEqual(before);
    });

    it("skips a visit that changed after the plan was read instead of overwriting it", async () => {
      const plan = await planVisitPairingsForOrg(handle.db, ORG_B);
      await admin.query("UPDATE visit SET version = version + 1 WHERE id = $1", [ids.orgBRestamp]);
      const before = await snapshot();
      const result = await applyVisitPairingRestampsForOrg(handle.db, plan, {
        maxRows: 5,
        runId: RUN_ID,
        operator: "ops-test",
      });
      expect(result.changed).toEqual([]);
      expect(result.skippedStale).toEqual([ids.orgBRestamp]);
      expect(await snapshot()).toEqual(before);
    });

    it("applies the unambiguous restamps, writes one audit event per changed visit and touches nothing else", async () => {
      const before = await snapshot();
      const { exitCode, summary } = await runVisitPairingReconciliation(
        handle.db,
        [ORG_A, ORG_B],
        { apply: true, maxRows: 3, orgIds: null, operator: "ops-test" },
        RUN_ID,
      );
      expect(exitCode).toBe(0);
      const changed = summary.applied.flatMap((a) => a.changed).sort();
      expect(changed).toEqual([ids.restampPublished, ids.restampProposed, ids.orgBRestamp].sort());

      const after = await snapshot();
      expect(after.visits.length).toBe(before.visits.length); // never deletes a visit
      for (const row of after.visits) {
        const was = before.visits.find((v) => v.id === row.id);
        if (changed.includes(row.id)) {
          expect(row.assigned_discipline_at_assignment).toBe("rn");
          expect(row.version).toBe(was.version + 1);
          expect(row.assigned_membership_id).toBe(was.assigned_membership_id);
          expect(row.visit_purpose).toBe(was.visit_purpose);
          expect(row.status).toBe(was.status);
        } else {
          expect(row).toEqual(was); // review, history and legal visits are untouched
        }
      }
      expect(after.outbox).toBe(before.outbox); // the assignee did not change: no event

      const audits = await admin.query(
        `SELECT organization_id, resource_kind, resource_id, actor_user_id, actor_kind, correlation_id,
                before, after, context
           FROM audit_event WHERE event_type = $1 ORDER BY resource_id`,
        [PAIRING_RECONCILED_AUDIT_EVENT],
      );
      expect(audits.rows.map((r) => r.resource_id).sort()).toEqual(changed);
      for (const row of audits.rows) {
        expect(row.resource_kind).toBe("visit");
        expect(row.actor_user_id).toBeNull();
        expect(row.actor_kind).toBe("system");
        expect(row.correlation_id).toBe(RUN_ID);
        expect(row.before).toEqual({ assignedDisciplineAtAssignment: "np" });
        expect(row.after).toEqual({ assignedDisciplineAtAssignment: "rn" });
        expect(row.context).toMatchObject({
          control: "CW-PI-04",
          reason: "RESTAMP_SINGLE_LEGAL_DISCIPLINE",
          visitPurpose: "recert",
          operator: "ops-test",
        });
        const expectedOrg = row.resource_id === ids.orgBRestamp ? ORG_B : ORG_A;
        expect(row.organization_id).toBe(expectedOrg);
      }
    });

    it("is idempotent: a second apply finds nothing to change and writes no further audit event", async () => {
      const before = await snapshot();
      const { exitCode, summary } = await runVisitPairingReconciliation(
        handle.db,
        [ORG_A, ORG_B],
        { apply: true, maxRows: 3, orgIds: null, operator: "ops-test" },
        RUN_ID,
      );
      expect(exitCode).toBe(0);
      expect(summary.plannedRestamps).toBe(0);
      expect(summary.applied).toEqual([]);
      // The review queue stays visible until a person resolves it.
      expect(summary.reviewQueue).toBe(5);
      expect(await snapshot()).toEqual(before);
    });

    it("RLS alone hides another tenant's visit from the app role", async () => {
      const countVisible = async (org: string, visitId: string): Promise<number> => {
        const result = (await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
          tx.execute(sql`SELECT count(*)::int AS n FROM visit WHERE id = ${visitId}`),
        )) as unknown as { rows: { n: number }[] };
        return result.rows[0]?.n ?? -1;
      };
      expect(await countVisible(ORG_A, ids.restampPublished)).toBe(1);
      expect(await countVisible(ORG_B, ids.restampPublished)).toBe(0);
      expect(await countVisible(ORG_A, ids.orgBRestamp)).toBe(0);
    });

    it("skips a visit whose status or stamp changed after the plan, even without a version bump", async () => {
      const cancelled = await seedVisit(ORG_B, erin, "recert", "np", "published");
      const restamped = await seedVisit(ORG_B, erin, "recert", "np", "proposed");
      try {
        const plan = await planVisitPairingsForOrg(handle.db, ORG_B);
        expect(plan.restamp.map((r) => r.visitId).sort()).toEqual([cancelled, restamped].sort());
        await admin.query("UPDATE visit SET status = 'cancelled' WHERE id = $1", [cancelled]);
        await admin.query(
          "UPDATE visit SET assigned_discipline_at_assignment = 'md' WHERE id = $1",
          [restamped],
        );
        const before = await snapshot();
        const result = await applyVisitPairingRestampsForOrg(handle.db, plan, {
          maxRows: 5,
          runId: RUN_ID,
          operator: "ops-test",
        });
        expect(result.changed).toEqual([]);
        expect([...result.skippedStale].sort()).toEqual([cancelled, restamped].sort());
        expect(await snapshot()).toEqual(before);
      } finally {
        await admin.query("DELETE FROM visit WHERE id = ANY($1::uuid[])", [[cancelled, restamped]]);
      }
    });

    it("rolls a tenant back when its audit write fails, keeps earlier tenants, exits 1 without row values, and resumes", async () => {
      const inA = await seedVisit(ORG_A, staff.alice, "recert", "np", "published");
      const inB = await seedVisit(ORG_B, erin, "recert", "np", "published");
      await admin.query(
        `CREATE OR REPLACE FUNCTION pi04_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.event_type = '${PAIRING_RECONCILED_AUDIT_EVENT}' AND NEW.organization_id = '${ORG_B}' THEN
             RAISE EXCEPTION 'forced audit failure';
           END IF;
           RETURN NEW;
         END $$`,
      );
      await admin.query(
        "CREATE TRIGGER pi04_fail_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION pi04_fail_audit()",
      );
      const args = { apply: true, maxRows: 5, orgIds: null, operator: "ops-test" };
      const stampOf = async (id: string) =>
        (
          await admin.query(
            "SELECT assigned_discipline_at_assignment AS d FROM visit WHERE id=$1",
            [id],
          )
        ).rows[0].d as string;
      try {
        const failed = await runVisitPairingReconciliation(handle.db, [ORG_A, ORG_B], args, RUN_ID);
        expect(failed.exitCode).toBe(1);
        expect(failed.summary.applied.flatMap((a) => a.changed)).toEqual([inA]);
        expect(failed.summary.error).toMatch(/\(SQLSTATE P0001\) while processing organization/);
        expect(failed.summary.error).not.toContain("forced audit failure");
        expect(await stampOf(inA)).toBe("rn"); // the earlier tenant stays committed
        expect(await stampOf(inB)).toBe("np"); // the failing tenant rolled back whole
        const auditedB = await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE event_type = $1 AND resource_id = $2",
          [PAIRING_RECONCILED_AUDIT_EVENT, inB],
        );
        expect(auditedB.rows[0].n).toBe(0);
      } finally {
        await admin.query("DROP TRIGGER IF EXISTS pi04_fail_audit ON audit_event");
      }
      const resumed = await runVisitPairingReconciliation(handle.db, [ORG_A, ORG_B], args, RUN_ID);
      expect(resumed.exitCode).toBe(0);
      expect(resumed.summary.applied.flatMap((a) => a.changed)).toEqual([inB]);
      expect(await stampOf(inB)).toBe("rn");
    });
  },
);
