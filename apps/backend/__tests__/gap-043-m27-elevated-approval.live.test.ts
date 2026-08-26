/**
 * GAP-043 — M27's `cost_report_approver_for_provider` approver gate, LIVE Postgres.
 *
 * The PRODUCTION resolver (`buildDrizzleM27AbacResolver`, the one `registerM27AbacPredicates({ db })`
 * boots with whenever a database is present) hardcoded `async hasElevatedApproval() { return false; }`.
 * The predicate's final line calls it unconditionally, with no permission-based bypass — the
 * `cost_report.edit_any_provider` override only satisfies the SCOPE sub-check. So override_validation /
 * approve_for_submit / submit / submit_past_deadline / reopen_submitted were ALL unreachable for every
 * caller in every tenant: the CMS-1984-14 filing workflow the module exists for had no end state.
 *
 * The stub was honest about why — "a real read here would fabricate a fact M27 cannot resolve" — because
 * the per-tenant elevated-approval designation had no table, no column and no seam anywhere. Migration
 * 0204 is that fact (`membership_elevated_approval`, M2-owned), M2's `ElevatedApprovalReader` is how M27
 * reads it without touching another module's table, and M2's three `/elevated-approvals` routes are how a
 * tenant actually makes a designation — without which wiring the read would have left the gate denying
 * for a new reason instead of the old one.
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role, so a missing GRANT, policy or CHECK fails it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m27:elevated-approval:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  COST_REPORT_APPROVAL_KIND,
  createDrizzleElevatedApprovalStore,
  createElevatedApprovalReader,
  createElevatedApprovalService,
} from "../src/modules/02-identity/index";
import { buildM27AbacPredicates } from "../src/modules/27-cost-report/abac-predicates";
import { buildDrizzleM27AbacResolver } from "../src/modules/27-cost-report/abac-predicates";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111110043a1";
const ORG_B = "11111111-1111-4111-8111-1111110043a2";
const USER_SIGNATORY = "22222222-2222-4222-8222-2222220043b1";
const USER_EDITOR = "22222222-2222-4222-8222-2222220043b2";
const USER_ADMIN = "22222222-2222-4222-8222-2222220043b3";
const USER_B = "22222222-2222-4222-8222-2222220043b4";

const EDIT_ANY_PROVIDER_PERMISSION = "cost_report.edit_any_provider";

describe.skipIf(!DB_URL)("GAP-043 M27 elevated-approval approver gate — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createElevatedApprovalService>;
  let reader: ReturnType<typeof createElevatedApprovalReader>;
  let predicates: ReturnType<typeof buildM27AbacPredicates>;
  const providerOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};
  const reportOf: Record<string, string> = {};

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** An ABAC context shaped like the one `requireAbac` assembles (membershipId rides in `attributes`). */
  const ctx = (
    organizationId: string,
    userId: string,
    opts: { providerEntityIds?: readonly string[]; permissions?: readonly string[] } = {},
  ) => ({
    organizationId,
    userId,
    roles: [] as readonly string[],
    providerEntityIds: opts.providerEntityIds ?? ([] as readonly string[]),
    locationIds: [] as readonly string[],
    attributes: {
      membershipId: memberOf[`${organizationId}:${userId}`] ?? "",
      permissions: opts.permissions ?? [],
    } as Record<string, unknown>,
  });

  const designate = (organizationId: string, userId: string) =>
    service.grant({
      organizationId,
      membershipId: memberOf[`${organizationId}:${userId}`] ?? "",
      kind: COST_REPORT_APPROVAL_KIND,
      grantedByMembershipId: memberOf[`${organizationId}:${USER_ADMIN}`] ?? "",
      grantReason: "CFO, authorized signatory per board resolution 2026-04",
    });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'gap043-a','A','A','active'),($2,'gap043-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'sig@gap043.test'),($2,'ed@gap043.test'),($3,'adm@gap043.test'),($4,'b@gap043.test')`,
      [USER_SIGNATORY, USER_EDITOR, USER_ADMIN, USER_B],
    );
    for (const [org, users, ccn, npi] of [
      [ORG_A, [USER_SIGNATORY, USER_EDITOR, USER_ADMIN], "431001", "1234567893"],
      [ORG_B, [USER_B], "431002", "1000015838"],
    ] as const) {
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,'PE',$3,'x','12-31') RETURNING id`,
        [org, ccn, npi],
      );
      providerOf[org] = pe.rows[0].id;
      for (const u of users) {
        const m = await admin.query(
          // `default_provider_entity_id` is the RLS-backed scope supplement the editor/approver predicates
          // fall back to when the session context carries no provider scope.
          `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id)
           VALUES ($1,$2,'active',$3) RETURNING id`,
          [u, org, providerOf[org]],
        );
        memberOf[`${org}:${u}`] = m.rows[0].id;
      }
      const cr = await admin.query(
        `INSERT INTO cost_report (organization_id, provider_entity_id, fiscal_year_start_date, fiscal_year_end_date, state)
         VALUES ($1,$2,'2026-01-01','2026-12-31','draft') RETURNING id`,
        [org, providerOf[org]],
      );
      reportOf[org] = cr.rows[0].id;
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const store = createDrizzleElevatedApprovalStore(handle.db);
    service = createElevatedApprovalService(store);
    reader = createElevatedApprovalReader(store);
    // THE WIRING UNDER TEST: the real production resolver, with the seam resolved from M2's real store
    // instead of the boot registry (the registry needs a full boot; the reader is the same object).
    predicates = buildM27AbacPredicates({
      resolver: buildDrizzleM27AbacResolver(handle.db as never, () => reader),
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM membership_elevated_approval");
  });

  // ── the table's own invariants, as the NOBYPASSRLS app role ─────────────────────────────────────
  it("refuses a grant whose reason is too short (the migration-0204 CHECK, not just the route)", async () => {
    await expect(
      service.grant({
        organizationId: ORG_A,
        membershipId: memberOf[`${ORG_A}:${USER_SIGNATORY}`] ?? "",
        kind: COST_REPORT_APPROVAL_KIND,
        grantedByMembershipId: memberOf[`${ORG_A}:${USER_ADMIN}`] ?? "",
        grantReason: "because",
      }),
    ).rejects.toThrow();
  });

  it("allows at most one LIVE designation per (membership, kind)", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    // The partial unique index is what makes this a 409 rather than two live rows; `onConflictDoNothing`
    // returns zero rows and the service turns that into the conflict.
    await expect(designate(ORG_A, USER_SIGNATORY)).rejects.toThrow(/already holds/i);
  });

  it("is org-isolated under RLS — org B cannot see org A's designation", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    expect(
      await reader.hasElevatedApproval({
        organizationId: ORG_B,
        membershipId: memberOf[`${ORG_A}:${USER_SIGNATORY}`] ?? "",
        kind: COST_REPORT_APPROVAL_KIND,
      }),
    ).toBe(false);
  });

  it("writes an audit row for the designation (the trigger fires on the app-role write)", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind = 'membership_elevated_approval'",
    );
    expect(audits.rows[0].n).toBeGreaterThan(0);
  });

  // ── the predicate ───────────────────────────────────────────────────────────────────────────────
  it("DENIES an in-scope actor with no designation — the pre-GAP-043 behaviour, now for a real reason", async () => {
    const predicate = predicates.cost_report_approver_for_provider;
    expect(predicate).toBeDefined();
    expect(
      await predicate?.(ctx(ORG_A, USER_EDITOR), { costReportId: reportOf[ORG_A] ?? "" }),
    ).toBe(false);
  });

  it("ALLOWS the designated signatory — the outcome that was unreachable in every tenant", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    const predicate = predicates.cost_report_approver_for_provider;
    expect(
      await predicate?.(ctx(ORG_A, USER_SIGNATORY), { costReportId: reportOf[ORG_A] ?? "" }),
    ).toBe(true);
  });

  it("denies again the moment the designation is revoked", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    const predicate = predicates.cost_report_approver_for_provider;
    expect(
      await predicate?.(ctx(ORG_A, USER_SIGNATORY), { costReportId: reportOf[ORG_A] ?? "" }),
    ).toBe(true);
    await service.revoke({
      organizationId: ORG_A,
      membershipId: memberOf[`${ORG_A}:${USER_SIGNATORY}`] ?? "",
      kind: COST_REPORT_APPROVAL_KIND,
      revokedByMembershipId: memberOf[`${ORG_A}:${USER_ADMIN}`] ?? "",
      revokedReason: "no longer an officer of the agency",
    });
    expect(
      await predicate?.(ctx(ORG_A, USER_SIGNATORY), { costReportId: reportOf[ORG_A] ?? "" }),
    ).toBe(false);
  });

  it("cost_report.edit_any_provider does NOT substitute for the designation", async () => {
    const predicate = predicates.cost_report_approver_for_provider;
    // The org-scope override satisfies the SCOPE conjunct only. Widening WHICH providers you may act on
    // is not the same as being an authorized signatory, and collapsing the two would delete the control.
    expect(
      await predicate?.(ctx(ORG_A, USER_EDITOR, { permissions: [EDIT_ANY_PROVIDER_PERMISSION] }), {
        costReportId: reportOf[ORG_A] ?? "",
      }),
    ).toBe(false);
  });

  it("a designation does NOT substitute for provider scope either — both conjuncts must hold", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    const predicate = predicates.cost_report_approver_for_provider;
    // Org B's report: the signatory is designated in org A and its membership is scoped to org A's PE.
    expect(
      await predicate?.(ctx(ORG_A, USER_SIGNATORY), { costReportId: reportOf[ORG_B] ?? "" }),
    ).toBe(false);
  });

  it("fails closed with no resolvable report and with no active membership", async () => {
    await designate(ORG_A, USER_SIGNATORY);
    const predicate = predicates.cost_report_approver_for_provider;
    expect(await predicate?.(ctx(ORG_A, USER_SIGNATORY), {})).toBe(false);
    expect(
      await predicate?.(
        {
          organizationId: ORG_A,
          userId: USER_SIGNATORY,
          roles: [],
          providerEntityIds: [],
          locationIds: [],
          attributes: {}, // no membershipId on the session → nobody to check a designation for
        },
        { costReportId: reportOf[ORG_A] ?? "" },
      ),
    ).toBe(false);
  });

  it("the editor gate is unaffected — it never keyed on the designation", async () => {
    const predicate = predicates.cost_report_editor_for_provider;
    // An in-scope editor could always edit; GAP-043 was only ever about the approver plane.
    expect(
      await predicate?.(ctx(ORG_A, USER_EDITOR), { costReportId: reportOf[ORG_A] ?? "" }),
    ).toBe(true);
  });
});
