/**
 * M23 (migration 1269) — the per-(provider entity, route) EDI profile over the real table, as the NOBYPASSRLS
 * `chartwarden_app` role. Proves what only Postgres can: tenant isolation, the table CHECKs, the compare-and-set
 * upsert (first insert, update, stale 412, missing If-Match 428), no DELETE for the app role, and that the write lands
 * an audit event.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:edi-profile:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { createDrizzleSiteAdminRepository } from "../src/bootstrap/site-admin-repository";
import type { M23WriteActor } from "../src/modules/23-billing-medicare/routes/actor";
import { buildDrizzleEdiProfileService } from "../src/modules/23-billing-medicare/routes/edi-profile-service";
import type { UpsertEdiProfileBody } from "../src/modules/23-billing-medicare/routes/edi-profile-typebox";
import {
  billingAddressFrom,
  buildDrizzleEdiProfileReader,
} from "../src/modules/23-billing-medicare/services/claim-837i-parties";
import { buildPayerNameByX12IdReader } from "../src/modules/40-mdm";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

const ORG_A = "11111111-1111-4111-8111-1111ed1a0001";
const ORG_B = "22222222-2222-4222-8222-2222ed1b0002";
const USER_ID = "33333333-3333-4333-8333-3333ed1c0003";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-4444ed1d0004";
const PE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const actorFor = (organizationId: string): M23WriteActor => ({
  organizationId,
  userId: USER_ID,
  roles: [],
  membershipId: MEMBERSHIP_ID,
  stepUpRecent: true,
  actorKind: "user",
});

const BODY: UpsertEdiProfileBody = {
  submitterName: "Test Hospice LLC",
  submitterId: "SUB123",
  submitterContactName: "Billing Office",
  submitterContactPhone: "5035550100",
  receiverName: "Test Clearinghouse",
  receiverId: "RECV456",
  receiverApplicationCode: "TESTRECV",
};

describe.skipIf(!DB_URL)("M23 EDI profile — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const service = () => buildDrizzleEdiProfileService(handle.db);
  const key = { providerEntityId: PE_A, routeKey: "claim_md" };

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let text = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        text = text.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        text = text.replace(/\bvector\(\d+\)/g, "text");
        text = text.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(text);
    }
  }

  const asApp = <T>(organizationId: string, fn: (tx: typeof handle.db) => Promise<T>) =>
    withOrgContext(handle.db, { organizationId, userId: USER_ID }, (tx) =>
      fn(tx as unknown as typeof handle.db),
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'ed1-a','A','A','active'),($2,'ed1-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'op@ed1.test')`, [USER_ID]);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  });

  beforeEach(async () => {
    await admin.query("TRUNCATE billing_edi_profile");
    await admin.query("DELETE FROM payer");
    await admin.query("DELETE FROM provider_entity");
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("creates a profile on the first upsert and lists it", async () => {
    const res = await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    expect(res.created).toBe(true);
    expect(res.profile).toMatchObject({ ...BODY, routeKey: "claim_md", version: 1 });
    const list = await service().listProfiles(actorFor(ORG_A), PE_A);
    expect(list.map((p) => p.routeKey)).toEqual(["claim_md"]);
  });

  it("updates with the current version and bumps it", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    const res = await service().upsertProfile(
      actorFor(ORG_A),
      key,
      { ...BODY, receiverId: "RECV999" },
      1,
    );

    expect(res.created).toBe(false);
    expect(res.profile).toMatchObject({ receiverId: "RECV999", version: 2 });
  });

  it("refuses an update with no If-Match (428) and a stale one (412)", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    await expect(
      service().upsertProfile(actorFor(ORG_A), key, BODY, undefined),
    ).rejects.toMatchObject({ code: "IF_MATCH_REQUIRED", statusCode: 428 });
    await expect(service().upsertProfile(actorFor(ORG_A), key, BODY, 7)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 412,
    });
  });

  it("refuses an If-Match for a profile that does not exist (412)", async () => {
    await expect(service().upsertProfile(actorFor(ORG_A), key, BODY, 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      statusCode: 412,
    });
  });

  it("isolates tenants: another organization sees nothing and its insert never touches org A's row", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    expect(await service().listProfiles(actorFor(ORG_B), PE_A)).toEqual([]);
    const b = await service().upsertProfile(actorFor(ORG_B), key, BODY, undefined);
    expect(b.created).toBe(true);
    expect(await service().listProfiles(actorFor(ORG_A), PE_A)).toHaveLength(1);
  });

  it("rejects a row written for another organization (RLS WITH CHECK)", async () => {
    await expect(
      asApp(ORG_A, (tx) =>
        tx.execute(sql`INSERT INTO billing_edi_profile
          (organization_id, provider_entity_id, route_key, submitter_name, submitter_id, submitter_contact_name,
           submitter_contact_phone, receiver_name, receiver_id, receiver_application_code, set_by_membership_id)
          VALUES (${ORG_B}, ${PE_A}, 'stedi', 'n', 'i', 'c', '5035550100', 'r', 'ri', 'AB', ${MEMBERSHIP_ID})`),
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["a phone that is not 10 digits", { submitterContactPhone: "503-555-0100" }],
    ["an application code that is too short", { receiverApplicationCode: "A" }],
    ["a blank submitter id", { submitterId: "   " }],
  ])("the table CHECK refuses %s", async (_name, patch) => {
    const bad = { ...BODY, ...patch };

    await expect(service().upsertProfile(actorFor(ORG_A), key, bad, undefined)).rejects.toThrow();
  });

  it("the table CHECK refuses a route key that is not a lowercase vendor token", async () => {
    await expect(
      service().upsertProfile(actorFor(ORG_A), { ...key, routeKey: "Claim MD" }, BODY, undefined),
    ).rejects.toThrow();
  });

  it("the app role cannot delete a profile", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    await expect(
      asApp(ORG_A, (tx) => tx.execute(sql`DELETE FROM billing_edi_profile`)),
    ).rejects.toThrow();
  });

  it("the loader's profile reader returns the stored parties on the caller's tx, and nothing across tenants", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);
    const read = buildDrizzleEdiProfileReader();

    const own = await asApp(ORG_A, (tx) => read(tx, ORG_A, PE_A, "claim_md"));
    const other = await asApp(ORG_B, (tx) => read(tx, ORG_A, PE_A, "claim_md"));
    const wrongRoute = await asApp(ORG_A, (tx) => read(tx, ORG_A, PE_A, "stedi"));

    expect(own).toEqual({
      submitter: {
        name: BODY.submitterName,
        id: BODY.submitterId,
        contactName: BODY.submitterContactName,
        contactPhone: BODY.submitterContactPhone,
      },
      receiver: {
        name: BODY.receiverName,
        id: BODY.receiverId,
        applicationCode: BODY.receiverApplicationCode,
      },
    });
    expect(other).toBeNull();
    expect(wrongRoute).toBeNull();
  });

  it("reads a provider entity's sealed billing facts and an active payer's name as the app role", async () => {
    await admin.query(
      `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,'ABC123','Test Hospice LLC','1234567893','v2.1.n.t.c','1231')`,
      [PE_A, ORG_A],
    );
    await admin.query(
      `INSERT INTO payer (kind, payer_id, name, status) VALUES ('medicare','MAC01','Test MAC','active'),('medicare','MAC02','Old MAC','deactivated')`,
    );

    const facts = await asApp(ORG_A, (tx) =>
      buildFoundationSiteReader().providerEntityBillingFacts(tx, ORG_A, PE_A),
    );
    const otherTenant = await asApp(ORG_B, (tx) =>
      buildFoundationSiteReader().providerEntityBillingFacts(tx, ORG_B, PE_A),
    );
    const payerName = buildPayerNameByX12IdReader();

    expect(facts).toMatchObject({
      legalName: "Test Hospice LLC",
      npi: "1234567893",
      taxIdSealed: "v2.1.n.t.c",
    });
    expect(otherTenant).toBeNull();
    expect(await asApp(ORG_A, (tx) => payerName(tx, "MAC01"))).toBe("Test MAC");
    expect(await asApp(ORG_A, (tx) => payerName(tx, "MAC02"))).toBeNull();
    expect(await asApp(ORG_A, (tx) => payerName(tx, "NOPE"))).toBeNull();
  });

  it("the M2 billing address write lands in the shape the 837I parties adapter reads, keeping later addresses", async () => {
    await admin.query(
      `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end, addresses)
       VALUES ($1,$2,'ABC123','Test Hospice LLC','1234567893','v2.1.n.t.c','1231', '[{"line1":"old","city":"Old","state":"WA","postalCode":"98001"},{"line1":"second","city":"S","state":"OR","postalCode":"97301"}]'::jsonb)`,
      [PE_A, ORG_A],
    );
    const repo = createDrizzleSiteAdminRepository(handle.db);

    const updated = await repo.updateProviderEntity(ORG_A, PE_A, {
      billingAddress: {
        line1: "1 Main St",
        line2: null,
        city: "Portland",
        state: "OR",
        postalCode: "97201",
      },
    });

    const stored = (
      await admin.query("SELECT addresses FROM provider_entity WHERE id = $1", [PE_A])
    ).rows[0].addresses;
    expect(updated?.billingAddress).toEqual({
      line1: "1 Main St",
      line2: null,
      city: "Portland",
      state: "OR",
      postalCode: "97201",
    });
    expect(billingAddressFrom(stored)).toEqual({
      line1: "1 Main St",
      city: "Portland",
      state: "OR",
      postalCode: "97201",
    });
    expect(stored).toHaveLength(2);
    expect(stored[1].line1).toBe("second");
    expect(await repo.updateProviderEntity(ORG_B, PE_A, { legalName: "x" })).toBeNull();
  });

  it("records the write in the audit trail", async () => {
    await service().upsertProfile(actorFor(ORG_A), key, BODY, undefined);

    const res = await admin.query(
      "SELECT event_type FROM audit_event WHERE resource_kind = 'billing_edi_profile'",
    );
    expect(res.rows.map((r) => r.event_type)).toContain("billing_edi_profile.insert");
  });
});
