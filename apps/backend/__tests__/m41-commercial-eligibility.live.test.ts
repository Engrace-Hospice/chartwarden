/**
 * M41 Billing - Commercial, eligibility (270/271) and enrollment (issue #724) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Proves, against the real migrations and the real Drizzle store:
 *   - tenant B sees none of tenant A's enrollments or eligibility checks and cannot write into A (RLS is forced); the app role has
 *     no DELETE, a check can never be UPDATED, and an enrollment's anchor columns cannot be changed;
 *   - an enrollment must name an ACTIVE COMMERCIAL M40 payer; overlapping periods are refused, adjacent ones allowed;
 *   - a check cannot point at another tenant's plan (composite FK) and one idempotency key is one row;
 *   - the plan's staleness policy defaults to 'warn' / 30 days and its CHECKs hold;
 *   - NO column in either new table could hold a member id, name or birth date, and the audit trail records both tables;
 *   - end to end through the real service: unbound / not routed / not enrolled each refuse and the transport is NEVER called; an
 *     enrolled, routed plan sends exactly once with the transient member id, persists outcome and as-of date only, replays by
 *     idempotency key without a second send, and the member id appears in no stored row, view, error or log line.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m41:eligibility:live
 * (SUPERUSER to a THROWAWAY db on a PRIVATE pgvector/pgvector:pg18 - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { PatientCoverage } from "@chartwarden/types";
import type { ClearinghouseEligibilityRequest } from "@chartwarden/x12-837-client";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCommercialAdminService } from "../src/modules/41-billing-commercial/eligibility/admin-service";
import { createEligibilityService } from "../src/modules/41-billing-commercial/eligibility/service";
import { buildDrizzleEligibilityStore } from "../src/modules/41-billing-commercial/eligibility/store-drizzle";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "00000000-0000-4000-8000-000000004a01";
const ORG_B = "00000000-0000-4000-8000-000000004b01";
const USER = "00000000-0000-4000-8000-0000000000f1";
const PE = "00000000-0000-4000-8000-0000000000e1";
const PATIENT = "00000000-0000-4000-8000-0000000000a1";
const COVERAGE_ID = "00000000-0000-4000-8000-0000000000d1";
const MEMBER_ID = "SYNTH-MEMBER-LIVE-5150";

describe.skipIf(!DB_URL)("M41 commercial eligibility and enrollment - LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let handle: { db: DbClient; close?: () => Promise<void> };
  let commercialPayer: string;
  let medicarePayer: string;
  let planA: string;
  let planB: string;

  async function asOrg<T>(org: string, fn: () => Promise<T>): Promise<T> {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.org_id', $1, true)", [org]);
      const out = await fn();
      await app.query("COMMIT");
      return out;
    } catch (e) {
      await app.query("ROLLBACK");
      throw e;
    }
  }
  const failure = (p: Promise<unknown>) =>
    p.then(
      () => "",
      (e: { message?: string }) => e.message ?? "failed",
    );

  const enrollSql = `INSERT INTO commercial_payer_enrollment
    (organization_id, provider_entity_id, payer_id, clearinghouse_key, status, effective_from, effective_to)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`;
  const newEnrollment = (
    org: string,
    payer: string,
    ch = "in_memory",
    status = "enrolled",
    from = "2026-01-01",
    to: string | null = null,
    pe = PE,
  ) => asOrg(org, async () => (await app.query(enrollSql, [org, pe, payer, ch, status, from, to])).rows[0].id as string);

  const checkSql = `INSERT INTO commercial_eligibility_check
    (organization_id, provider_entity_id, patient_id, plan_id, patient_payer_id, clearinghouse_key, clearinghouse_payer_id,
     service_date, outcome, as_of_date, request_id, idempotency_key, checked_by_user_id)
    VALUES ($1,$2,$3,$4,$5,'in_memory','CH-9','2026-10-25',$6,'2026-10-25',$7,$8,$9) RETURNING id`;
  const newCheck = (org: string, plan: string, outcome = "active", key = randomUUID()) =>
    asOrg(org, async () =>
      (await app.query(checkSql, [org, PE, PATIENT, plan, COVERAGE_ID, outcome, randomUUID(), key, USER])).rows[0].id as string,
    );

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
    for (const [org, slug] of [
      [ORG_A, "m41e-a"],
      [ORG_B, "m41e-b"],
    ] as const) {
      await admin.query("INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')", [org, slug]);
    }
    // The write-audit trigger attributes rows to app.user_id, which is a foreign key to "user".
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m41-elig@example.test')`, [USER]);
    const mkPayer = async (kind: string, name: string) =>
      (
        await admin.query("INSERT INTO payer (kind, name, status) VALUES ($1::payer_kind,$2,'active') RETURNING id", [kind, name])
      ).rows[0].id as string;
    commercialPayer = await mkPayer("commercial", "Synthetic Commercial Health");
    medicarePayer = await mkPayer("medicare", "Synthetic Medicare");
    const mkPlan = async (org: string) =>
      (
        await admin.query(
          `INSERT INTO commercial_payer_plan (organization_id, payer_id, plan_name, claim_filing_indicator, effective_from)
           VALUES ($1,$2,'Synthetic PPO','CI','2026-01-01') RETURNING id`,
          [org, commercialPayer],
        )
      ).rows[0].id as string;
    planA = await mkPlan(ORG_A);
    planB = await mkPlan(ORG_B);
    await admin.query(
      `INSERT INTO commercial_payer_route (organization_id, plan_id, clearinghouse_key, clearinghouse_payer_id, effective_from)
       VALUES ($1,$2,'in_memory','CH-9','2026-01-01')`,
      [ORG_A, planA],
    );
    const conn = await appRoleConnectionString(admin, DB_URL as string);
    app = new Client({ connectionString: conn });
    await app.connect();
    handle = createDbClient({ connectionString: conn }) as unknown as typeof handle;
  }, 600_000);

  afterAll(async () => {
    await app?.end();
    await handle?.close?.();
    await admin?.end();
  });

  it("isolates tenants and forces RLS on both new tables", async () => {
    await newEnrollment(ORG_A, commercialPayer, "iso");
    await newCheck(ORG_A, planA);
    for (const t of ["commercial_payer_enrollment", "commercial_eligibility_check"]) {
      const own = await asOrg(ORG_A, () => app.query(`SELECT count(*)::int AS n FROM ${t}`));
      const other = await asOrg(ORG_B, () => app.query(`SELECT count(*)::int AS n FROM ${t}`));
      expect(own.rows[0].n).toBeGreaterThan(0);
      expect(other.rows[0].n).toBe(0);
      const flags = await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1", [t]);
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    expect(await failure(asOrg(ORG_B, () => app.query(enrollSql, [ORG_A, PE, commercialPayer, "x1", "enrolled", "2026-01-01", null])))).toMatch(
      /row-level security/,
    );
    expect(
      await failure(
        asOrg(ORG_B, () => app.query(checkSql, [ORG_A, PE, PATIENT, planA, COVERAGE_ID, "active", randomUUID(), randomUUID(), USER])),
      ),
    ).toMatch(/row-level security/);
  });

  it("gives the app role no DELETE, no UPDATE of a check, and no UPDATE of an enrollment's anchor", async () => {
    const enr = await newEnrollment(ORG_A, commercialPayer, "grants");
    const chk = await newCheck(ORG_A, planA);
    for (const sql of [
      ["DELETE FROM commercial_payer_enrollment WHERE id = $1", enr],
      ["DELETE FROM commercial_eligibility_check WHERE id = $1", chk],
      ["UPDATE commercial_eligibility_check SET outcome = 'inactive' WHERE id = $1", chk],
      ["UPDATE commercial_payer_enrollment SET payer_id = payer_id WHERE id = $1", enr],
      ["UPDATE commercial_payer_enrollment SET clearinghouse_key = 'other' WHERE id = $1", enr],
      ["UPDATE commercial_payer_enrollment SET provider_entity_id = provider_entity_id WHERE id = $1", enr],
    ] as const) {
      expect(await failure(asOrg(ORG_A, () => app.query(sql[0], [sql[1]]))), sql[0]).toMatch(/permission denied/);
    }
    const ok = await asOrg(ORG_A, () =>
      app.query("UPDATE commercial_payer_enrollment SET status = 'suspended', updated_at = now() WHERE id = $1", [enr]),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("requires an ACTIVE COMMERCIAL payer for an enrollment", async () => {
    expect(await failure(newEnrollment(ORG_A, medicarePayer, "medicare"))).toMatch(/M41_PLAN_PAYER_NOT_COMMERCIAL/);
  });

  it("refuses overlapping enrollment periods and allows adjacent ones", async () => {
    await newEnrollment(ORG_A, commercialPayer, "dates", "enrolled", "2025-01-01", "2025-06-30");
    expect(await failure(newEnrollment(ORG_A, commercialPayer, "dates", "enrolled", "2025-06-30", null))).toMatch(
      /exclusion|conflicting key/,
    );
    await expect(newEnrollment(ORG_A, commercialPayer, "dates", "enrolled", "2025-07-01", null)).resolves.toBeTruthy();
    // a different provider entity, payer-and-clearinghouse pair is independent
    await expect(
      newEnrollment(ORG_A, commercialPayer, "dates", "enrolled", "2025-01-01", null, "00000000-0000-4000-8000-0000000000e2"),
    ).resolves.toBeTruthy();
  });

  it("holds the enrollment CHECKs (status set, dates, clearinghouse key shape, opaque evidence reference)", async () => {
    expect(await failure(newEnrollment(ORG_A, commercialPayer, "chk1", "maybe"))).toMatch(/check/i);
    expect(await failure(newEnrollment(ORG_A, commercialPayer, "chk2", "enrolled", "2026-02-01", "2026-01-01"))).toMatch(/check/i);
    expect(await failure(newEnrollment(ORG_A, commercialPayer, "Bad Key!"))).toMatch(/check/i);
    expect(
      await failure(
        asOrg(ORG_A, () =>
          app.query(
            `INSERT INTO commercial_payer_enrollment (organization_id, provider_entity_id, payer_id, clearinghouse_key, status, effective_from, evidence_ref)
             VALUES ($1,$2,$3,'chk3','pending','2026-01-01','Jane Doe, DOB 1950-01-01')`,
            [ORG_A, PE, commercialPayer],
          ),
        ),
      ),
    ).toMatch(/check/i);
  });

  it("holds the eligibility CHECKs, the composite plan FK and one row per idempotency key", async () => {
    expect(await failure(newCheck(ORG_A, planA, "maybe"))).toMatch(/check/i);
    // tenant A cannot record a check against tenant B's plan
    expect(await failure(newCheck(ORG_A, planB))).toMatch(/foreign key/i);
    const key = randomUUID();
    await newCheck(ORG_A, planA, "active", key);
    expect(await failure(newCheck(ORG_A, planA, "active", key))).toMatch(/duplicate key|unique/i);
  });

  it("defaults a plan's staleness policy to warn / 30 days and holds its CHECKs", async () => {
    const row = (await admin.query("SELECT eligibility_staleness_policy AS p, eligibility_max_age_days AS d FROM commercial_payer_plan WHERE id = $1", [planA])).rows[0];
    expect(row).toEqual({ p: "warn", d: 30 });
    const set = (policy: string, days: number) =>
      asOrg(ORG_A, () =>
        app.query("UPDATE commercial_payer_plan SET eligibility_staleness_policy = $2, eligibility_max_age_days = $3, updated_at = now() WHERE id = $1", [planA, policy, days]),
      );
    expect((await set("block", 14)).rowCount).toBe(1);
    expect(await failure(set("off", 14))).toMatch(/check/i);
    expect(await failure(set("warn", 0))).toMatch(/check/i);
    expect(await failure(set("warn", 366))).toMatch(/check/i);
    await set("warn", 30);
  });

  it("has no column that could hold a member id, a name or a birth date, in either table", async () => {
    const cols = await admin.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('commercial_payer_enrollment','commercial_eligibility_check')`,
    );
    expect(cols.rows.length).toBeGreaterThan(20);
    for (const c of cols.rows) {
      expect(c.column_name, `${c.table_name}.${c.column_name}`).not.toMatch(/member|subscriber|mbi|ssn|name|dob|birth|payload|response|body|raw/i);
    }
  });

  it("records enrollment and check writes in the audit trail", async () => {
    const before = (await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE resource_kind IN ('commercial_payer_enrollment','commercial_eligibility_check')")).rows[0].n;
    await newEnrollment(ORG_A, commercialPayer, "audited");
    await newCheck(ORG_A, planA);
    const after = (await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE resource_kind IN ('commercial_payer_enrollment','commercial_eligibility_check')")).rows[0].n;
    expect(after - before).toBe(2);
  });

  describe("end to end through the real service and Drizzle store", () => {
    const calls: { payerId: string; req: ClearinghouseEligibilityRequest }[] = [];
    const logs: unknown[] = [];
    const coverage: PatientCoverage = {
      id: COVERAGE_ID,
      patientId: PATIENT,
      payerId: "",
      rank: 1,
      coverageKind: "commercial",
      subscriberId: MEMBER_ID,
      groupNumber: null,
      current: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    };

    const build = (vendor: string | null) => {
      const store = buildDrizzleEligibilityStore(handle.db);
      return createEligibilityService({
        store,
        coverage: { coveragesForPatient: async () => [{ ...coverage, payerId: commercialPayer }] },
        binding: {
          vendor,
          transport: {
            async checkEligibility(ctx, req) {
              calls.push({ payerId: ctx.payerId, req });
              return { ok: true as const, data: { outcome: "active" as const, asOfDate: "2026-10-25" } };
            },
          },
        },
        contexts: {
          contextFor: async (organizationId, providerEntityId, payerId) => ({
            organizationId,
            providerEntityId,
            payerId,
            correlationId: randomUUID(),
            usage: "test",
            billingNpi: "1234567893",
          }),
        },
        now: () => new Date("2026-10-25T12:00:00.000Z"),
        newRequestId: randomUUID,
        log: (e) => logs.push(e),
      });
    };
    const actorA = { organizationId: ORG_A, userId: USER };
    const args = (key: string) => ({ providerEntityId: PE, patientId: PATIENT, planId: planA, serviceDate: "2026-10-25", idempotencyKey: key });
    const codeOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { code?: string } | null)?.code;

    it("refuses unbound, then not enrolled, and never calls the transport", async () => {
      expect(await codeOf(build(null).check(actorA, args("e2e-0")))).toBe("CH_NOT_WIRED");
      // the in_memory route exists for plan A, but this provider entity has no 'in_memory' enrollment in effect on 2026-10-25
      expect(await codeOf(build("in_memory").check(actorA, args("e2e-1")))).toBe("COMMERCIAL_PROVIDER_NOT_ENROLLED");
      expect(calls).toHaveLength(0);
    });

    it("refuses a clearinghouse the plan has no route on, even when enrolled there", async () => {
      await newEnrollment(ORG_A, commercialPayer, "stedi", "enrolled", "2026-01-01", null);
      expect(await codeOf(build("stedi").check(actorA, args("e2e-2")))).toBe("COMMERCIAL_PAYER_NOT_ROUTED");
      expect(calls).toHaveLength(0);
    });

    it("sends once with the routed payer id, stores outcome and as-of date only, and replays by idempotency key", async () => {
      // end any open 'in_memory' enrollment from the earlier tests, then enroll cleanly
      await admin.query("DELETE FROM commercial_payer_enrollment WHERE clearinghouse_key = 'in_memory'");
      await newEnrollment(ORG_A, commercialPayer, "in_memory", "enrolled", "2026-01-01", null);
      const svc = build("in_memory");
      const first = await svc.check(actorA, args("e2e-3"));
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ payerId: "CH-9", req: { memberId: MEMBER_ID, serviceDate: "2026-10-25" } });
      expect(first).toMatchObject({ outcome: "active", asOfDate: "2026-10-25", replayed: false });

      const second = await svc.check(actorA, args("e2e-3"));
      expect(calls).toHaveLength(1);
      expect(second).toMatchObject({ id: first.id, replayed: true });

      const stored = (await admin.query("SELECT * FROM commercial_eligibility_check WHERE id = $1", [first.id])).rows[0];
      expect(stored).toMatchObject({ outcome: "active", clearinghouse_payer_id: "CH-9", patient_payer_id: COVERAGE_ID, checked_by_user_id: USER });
      expect(JSON.stringify([stored, first, second, logs])).not.toContain(MEMBER_ID);

      const audit = await admin.query(
        "SELECT before, after, context FROM audit_event WHERE resource_kind = 'commercial_eligibility_check' AND resource_id = $1",
        [first.id],
      );
      expect(audit.rowCount).toBe(1);
      expect(JSON.stringify(audit.rows)).not.toContain(MEMBER_ID);
    });

    it("reports freshness from the stored check under the plan policy", async () => {
      const latest = await build("in_memory").latest(actorA, { patientId: PATIENT, planId: planA });
      expect(latest.latest?.outcome).toBe("active");
      expect(latest.freshness.severity).toBe("pass");
      const none = await build("in_memory").latest(actorA, { patientId: "00000000-0000-4000-8000-0000000000a9", planId: planA });
      expect(none.freshness).toMatchObject({ status: "missing", severity: "warning" });
    });

    it("does not see another tenant's plan (404) and the admin service creates an enrollment through RLS", async () => {
      const e = (await build("in_memory").check({ organizationId: ORG_B, userId: USER }, args("e2e-4")).then(() => null, (x: unknown) => x)) as { code?: string };
      expect(e.code).toBe("NOT_FOUND");
      const admSvc = createCommercialAdminService(buildDrizzleEligibilityStore(handle.db));
      const row = await admSvc.createEnrollment(actorA, {
        providerEntityId: PE,
        payerId: commercialPayer,
        clearinghouseKey: "svc-created",
        status: "pending",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        evidenceRef: "ticket#4521",
      });
      expect(row.status).toBe("pending");
      const dup = await admSvc.createEnrollment(actorA, { providerEntityId: PE, payerId: commercialPayer, clearinghouseKey: "svc-created", status: "pending", effectiveFrom: "2026-06-01", effectiveTo: null, evidenceRef: null }).then(() => null, (x: unknown) => x);
      expect((dup as { code?: string }).code).toBe("CONFLICT");
      const patched = await admSvc.patchEnrollment(actorA, PE, row.id, { status: "enrolled" });
      expect(patched.status).toBe("enrolled");
      await expect(admSvc.patchEnrollment({ organizationId: ORG_B, userId: USER }, PE, row.id, { status: "suspended" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
