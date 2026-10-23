// apps/backend/__tests__/_m25-m7-fixture.ts - the shared LIVE-database fixture of the two milestone 7a-1 suites
// (m25-later-tiers.live.test.ts, m25-audit-request.live.test.ts): a throwaway database migrated end to end, two
// tenants, provider entities, real claims (through M23's repository) and a NOBYPASSRLS `chartwarden_app` handle.
// Not a suite itself (no `.live.test.ts` suffix).
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { appRoleConnectionString } from "./_live-app-role";

export const ORG = "11111111-1111-1111-1111-111111111111";
export const ORG_B = "22222222-2222-2222-2222-222222222222";
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];

export const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
export const daysAhead = (n: number) => daysAgo(-n);

export interface M7Fixture {
  readonly admin: Client;
  readonly handle: ReturnType<typeof createDbClient>;
  readonly migrationsDir: string;
  readonly pe1: string;
  readonly pe2: string;
  readonly peB: string;
  readonly userA: string;
  readonly memberA: string;
  readonly userB: string;
  readonly memberB: string;
  readonly claim1: string;
  readonly claim1b: string;
  readonly claim2: string;
  readonly claimB: string;
  actor(
    org?: string,
    scope?: readonly string[],
  ): {
    organizationId: string;
    userId: string;
    membershipId: string;
    roles: string[];
    stepUpRecent: boolean;
    providerEntityScope?: readonly string[];
  };
  refused(
    p: Promise<unknown>,
  ): Promise<{ code?: string; message?: string; statusCode?: number } | null>;
  dbMessage(p: Promise<unknown>): Promise<string>;
  asApp<T>(
    fn: (tx: Parameters<Parameters<typeof withOrgContext>[2]>[0]) => Promise<T>,
    org?: string,
  ): Promise<T>;
  ver(table: string, id: string): Promise<number>;
  mkDenial(claimId: string, pe: string, org?: string): Promise<string>;
  mkAppeal(over: {
    claimId: string;
    pe: string;
    tier: string;
    state?: string;
    deadline?: string;
    prior?: string | null;
    escalated?: boolean;
    org?: string;
  }): Promise<string>;
  close(): Promise<void>;
}

export async function setupM7Fixture(dbUrl: string, slug: string): Promise<M7Fixture> {
  const admin = new Client({ connectionString: dbUrl });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  for (const r of ROLES) {
    await admin.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
        `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
    );
  }
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  for (const [org, s] of [
    [ORG, slug],
    [ORG_B, `${slug}-b`],
  ] as const) {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
      [org, s],
    );
  }
  const mkUser = async (email: string) =>
    (await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [email])).rows[0]
      .id as string;
  const mkMember = async (user: string, org: string) =>
    (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;
  const userA = await mkUser(`${slug}-a@x.test`);
  const memberA = await mkMember(userA, ORG);
  const userB = await mkUser(`${slug}-b@x.test`);
  const memberB = await mkMember(userB, ORG_B);
  const mkPe = async (org: string, tag: string) =>
    (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
        [org, `CCN-${tag}`, `NPI-${tag}`],
      )
    ).rows[0].id as string;
  const pe1 = await mkPe(ORG, `${slug}1`);
  const pe2 = await mkPe(ORG, `${slug}2`);
  const peB = await mkPe(ORG_B, `${slug}B`);
  const handle = createDbClient({
    connectionString: await appRoleConnectionString(admin, dbUrl),
  });
  const mkClaim = async (org: string, pe: string, ccn: string) =>
    (
      await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: org,
          providerEntityId: pe,
          patientId: randomUUID(),
          admissionId: randomUUID(),
          electionPeriodIdFrom: randomUUID(),
          electionPeriodIdTo: randomUUID(),
          patientPayerId: randomUUID(),
          tob: "811",
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
          claimControlNumber: ccn,
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 100_000,
        }),
      )
    ).id;
  const claim1 = await mkClaim(ORG, pe1, `CCN-${slug}-0001`);
  const claim1b = await mkClaim(ORG, pe1, `CCN-${slug}-0002`);
  const claim2 = await mkClaim(ORG, pe2, `CCN-${slug}-0003`);
  const claimB = await mkClaim(ORG_B, peB, `CCN-${slug}-0004`);

  const fixture: M7Fixture = {
    admin,
    handle,
    migrationsDir: MIGRATIONS_DIR,
    pe1,
    pe2,
    peB,
    userA,
    memberA,
    userB,
    memberB,
    claim1,
    claim1b,
    claim2,
    claimB,
    actor: (org: string = ORG, scope?: readonly string[]) => ({
      organizationId: org,
      userId: org === ORG ? userA : userB,
      membershipId: org === ORG ? memberA : memberB,
      roles: ["billing_manager"],
      stepUpRecent: true,
      ...(scope ? { providerEntityScope: scope } : {}),
    }),
    refused: (p) =>
      p.then(
        () => null,
        (e: { code?: string; message?: string; statusCode?: number }) => e,
      ),
    // drizzle wraps the driver error, so the database's own message is on the cause
    dbMessage: (p) =>
      p.then(
        () => "",
        (e: { cause?: { message?: string }; message?: string }) =>
          e.cause?.message ?? e.message ?? "",
      ),
    asApp: (fn, org = ORG) =>
      withOrgContext(
        handle.db,
        { organizationId: org, userId: org === ORG ? userA : userB },
        fn as never,
      ) as Promise<never>,
    ver: async (table, id) =>
      Number((await admin.query(`SELECT version FROM ${table} WHERE id=$1`, [id])).rows[0].version),
    mkDenial: async (claimId, pe, org = ORG) =>
      (
        await admin.query(
          `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
             carc_code, category, source, state, dollar_value, taxonomy_status)
           VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','appealed',10,'mapped') RETURNING id`,
          [org, pe, claimId, randomUUID()],
        )
      ).rows[0].id as string,
    mkAppeal: async (o) => {
      const org = o.org ?? ORG;
      const denialId = await fixture.mkDenial(o.claimId, o.pe, org);
      return (
        await admin.query(
          `INSERT INTO appeal_case (organization_id, provider_entity_id, denial_case_id, claim_id, tier, state,
             tier_deadline_at, notice_dated_on, prior_tier_appeal_case_id, filed_by_escalation)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'2026-02-01',$8,$9) RETURNING id`,
          [
            org,
            o.pe,
            denialId,
            o.claimId,
            o.tier,
            o.state ?? "draft",
            o.deadline ?? "2099-01-01T00:00:00Z",
            o.prior ?? null,
            o.escalated ?? false,
          ],
        )
      ).rows[0].id as string;
    },
    close: async () => {
      await handle?.close?.();
      await admin?.end();
    },
  };
  return fixture;
}

export type { DbClient };
export { sql };
