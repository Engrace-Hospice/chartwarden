/**
 * M25 ADR intake (hospice ADR/TPE/QIC PRD, milestone 2a) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 * Proves what the pure suites cannot: the due date is derived from the MAC rule in force and recorded on the
 * case, a rule edit never moves an existing case, scope and tenant isolation hold under RLS, a stale version is a
 * 409, a terminal case is frozen by the database, and the audit trigger writes a row.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:adr:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrizzleAdrService } from "../src/modules/25-remittance/routes/adr-service";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("M25 ADR intake - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId = "";
  let claimId = "";
  let membershipId = "";
  let userId = "";
  const svc = () => buildDrizzleAdrService(handle.db);
  const actor = () => ({
    organizationId: ORG,
    userId,
    membershipId,
    roles: ["billing_manager"],
    stepUpRecent: false,
  });
  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; statusCode?: number; status?: number }) => e,
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [org, slug] of [
      [ORG, "m25-adr"],
      [ORG_B, "m25-adr-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userId = (await admin.query(`INSERT INTO "user" (email) VALUES ('m25adr@x.test') RETURNING id`))
      .rows[0].id as string;
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-ADR','ADR','NPI-ADR','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    claimId = (
      await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: ORG,
          providerEntityId,
          patientId: randomUUID(),
          admissionId: randomUUID(),
          electionPeriodIdFrom: randomUUID(),
          electionPeriodIdTo: randomUUID(),
          patientPayerId: randomUUID(),
          tob: "811",
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
          claimControlNumber: "CCN-ADR-0001",
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 100_000,
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  const row = async (id: string) =>
    (await admin.query("SELECT * FROM adr_case WHERE id=$1", [id])).rows[0];

  it("derives the due date from the platform default and records it as unverified", async () => {
    const { id } = await svc().createAdr(actor(), {
      claimId,
      macName: "Palmetto GBA",
      reviewType: "adr",
      requestedOn: daysAgo(10),
    });
    const r = await row(id);
    expect(r.state).toBe("received");
    expect(r.window_days).toBe(45);
    expect(r.window_source).toBe("platform_default");
    expect(r.window_verified).toBe(false);
    expect(new Date(r.response_due_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("uses the organization's rule, verified, and a later rule edit does not move the case", async () => {
    await svc().upsertMacRule(actor(), {
      macName: "CGS",
      reviewType: "adr",
      responseDays: 30,
      sourceNote: "CGS ADR letter",
      verifiedOn: today(),
      effectiveFrom: daysAgo(30),
    });
    const { id } = await svc().createAdr(actor(), {
      claimId,
      macName: "cgs",
      reviewType: "adr",
      requestedOn: daysAgo(5),
    });
    const before = await row(id);
    expect(before.window_days).toBe(30);
    expect(before.window_source).toBe("org_rule");
    expect(before.window_verified).toBe(true);

    await svc().upsertMacRule(actor(), {
      macName: "CGS",
      reviewType: "adr",
      responseDays: 10,
      effectiveFrom: daysAgo(30),
    });
    const after = await row(id);
    expect(after.response_due_at).toEqual(before.response_due_at);
    const detail = await svc().getAdr(actor(), id);
    expect(detail?.windowDays).toBe(30);
    expect(detail?.events.map((e) => e.eventKind)).toEqual(["received"]);
  });

  it("refuses a future request date, an unknown claim, a blank MAC and a bad window", async () => {
    const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    expect(
      await refused(
        svc().createAdr(actor(), {
          claimId,
          macName: "CGS",
          reviewType: "adr",
          requestedOn: future,
        }),
      ),
    ).toMatchObject({ code: "REQUEST_DATE_IN_FUTURE" });
    expect(
      await refused(
        svc().createAdr(actor(), {
          claimId: randomUUID(),
          macName: "CGS",
          reviewType: "adr",
          requestedOn: daysAgo(1),
        }),
      ),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await refused(
        svc().createAdr(actor(), {
          claimId,
          macName: " ",
          reviewType: "adr",
          requestedOn: daysAgo(1),
        }),
      ),
    ).toMatchObject({ code: "INVALID_MAC" });
    expect(
      await refused(
        svc().upsertMacRule(actor(), { macName: "CGS", reviewType: "adr", responseDays: 0 }),
      ),
    ).toMatchObject({ code: "INVALID_WINDOW" });
  });

  it("refuses a date that is not on the calendar, and the history table is append-only", async () => {
    expect(
      await refused(
        svc().createAdr(actor(), {
          claimId,
          macName: "CGS",
          reviewType: "adr",
          requestedOn: "2026-02-31",
        }),
      ),
    ).toMatchObject({ code: "INVALID_REQUEST_DATE" });
    expect(
      await refused(
        svc().upsertMacRule(actor(), {
          macName: "CGS",
          reviewType: "adr",
          responseDays: 30,
          verifiedOn: "2026-13-01",
        }),
      ),
    ).toMatchObject({ code: "INVALID_RULE_DATE" });
    const grants = await admin.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name='adr_case_event' AND grantee='chartwarden_app'`,
    );
    expect(grants.rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("hides a claim outside the actor's provider-entity scope", async () => {
    const scoped = { ...actor(), providerEntityScope: [randomUUID()] };
    expect(
      await refused(
        svc().createAdr(scoped, {
          claimId,
          macName: "CGS",
          reviewType: "adr",
          requestedOn: daysAgo(1),
        }),
      ),
    ).toMatchObject({ statusCode: 404 });
    expect((await svc().listAdrs(scoped, {}, 50)).items).toHaveLength(0);
  });

  it("refuses a linked denial from another tenant, on another claim, or that does not exist", async () => {
    const mkDenial = async (org: string, pe: string, claim: string) =>
      (
        await admin.query(
          `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
             carc_code, category, source, state, dollar_value, taxonomy_status)
           VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','open',10,'mapped') RETURNING id`,
          [org, pe, claim, randomUUID()],
        )
      ).rows[0].id as string;
    const foreignPe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-ADR-B','B','NPI-ADR-B','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    const foreignDenial = await mkDenial(ORG_B, foreignPe, claimId);
    const otherClaimDenial = await mkDenial(ORG, providerEntityId, randomUUID());
    const base = { claimId, macName: "CGS", reviewType: "adr" as const, requestedOn: daysAgo(1) };
    for (const denialCaseId of [foreignDenial, otherClaimDenial, randomUUID()]) {
      expect(await refused(svc().createAdr(actor(), { ...base, denialCaseId }))).toMatchObject({
        statusCode: 404,
      });
    }
    const goodDenial = await mkDenial(ORG, providerEntityId, claimId);
    const { id } = await svc().createAdr(actor(), { ...base, denialCaseId: goodDenial });
    expect((await row(id)).denial_case_id).toBe(goodDenial);
  });

  it("walks assembly -> review, refuses a skip, and a stale version is a 409", async () => {
    const { id, version } = await svc().createAdr(actor(), {
      claimId,
      macName: "NGS",
      reviewType: "re_adr",
      requestedOn: daysAgo(2),
    });
    expect((await row(id)).window_days).toBe(20);
    const a = await svc().transitionAdr(actor(), id, "in_assembly", version);
    expect(await refused(svc().transitionAdr(actor(), id, "in_assembly", version))).toMatchObject({
      code: "INVALID_TRANSITION",
    });
    expect(await refused(svc().transitionAdr(actor(), id, "in_review", version))).toMatchObject({
      code: "VERSION_CONFLICT",
    });
    const b = await svc().transitionAdr(actor(), id, "in_review", a.version);
    expect(b.version).toBe(a.version + 1);
    const detail = await svc().getAdr(actor(), id);
    expect(detail?.events.map((e) => e.eventKind)).toEqual([
      "received",
      "in_assembly",
      "in_review",
    ]);
  });

  it("treats an out-of-scope case as absent and refuses a move from a terminal state", async () => {
    const { id, version } = await svc().createAdr(actor(), {
      claimId,
      macName: "NGS",
      reviewType: "adr",
      requestedOn: daysAgo(2),
    });
    const scoped = { ...actor(), providerEntityScope: [randomUUID()] };
    expect(await svc().getAdr(scoped, id)).toBeNull();
    expect(await refused(svc().transitionAdr(scoped, id, "in_assembly", version))).toMatchObject({
      statusCode: 404,
    });
    const w = await svc().transitionAdr(actor(), id, "withdrawn", version);
    expect(await refused(svc().transitionAdr(actor(), id, "in_assembly", w.version))).toMatchObject(
      {
        code: "INVALID_TRANSITION",
      },
    );
  });

  it("matches a MAC rule case-insensitively and keeps one row", async () => {
    const first = await svc().upsertMacRule(actor(), {
      macName: "WPS",
      reviewType: "adr",
      responseDays: 45,
    });
    const second = await svc().upsertMacRule(actor(), {
      macName: "wps",
      reviewType: "adr",
      responseDays: 40,
    });
    expect(second.id).toBe(first.id);
    const n = await admin.query(
      "SELECT count(*)::int AS n FROM mac_rule WHERE lower(mac_name)='wps'",
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("freezes a withdrawn case in the database", async () => {
    const { id, version } = await svc().createAdr(actor(), {
      claimId,
      macName: "NGS",
      reviewType: "adr",
      requestedOn: daysAgo(2),
    });
    await svc().transitionAdr(actor(), id, "withdrawn", version);
    await expect(
      admin.query("UPDATE adr_case SET adr_reference='x' WHERE id=$1", [id]),
    ).rejects.toThrow(/M25_ADR_TERMINAL_IMMUTABLE/);
  });

  it("isolates tenants and writes an audit row", async () => {
    const other = { organizationId: ORG_B, userId, roles: ["billing_manager"] };
    expect((await svc().listAdrs(other, {}, 50)).items).toHaveLength(0);
    expect((await svc().listMacRules(other)).items).toHaveLength(0);
    const audited = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_kind IN ('adr_case','mac_rule')",
    );
    expect(audited.rows[0].n).toBeGreaterThan(0);
  });

  it("increments a rule's version on a same-day edit", async () => {
    const first = await svc().upsertMacRule(actor(), {
      macName: "Novitas",
      reviewType: "adr",
      responseDays: 45,
    });
    const second = await svc().upsertMacRule(actor(), {
      macName: "Novitas",
      reviewType: "adr",
      responseDays: 40,
    });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version + 1);
  });
});
