import { randomUUID } from "node:crypto";
/**
 * Proves the unowned account-wide Claim.MD inbox is invisible to chartwarden_app and
 * serialized by PostgreSQL for competing capture workers. Run only on a private disposable PG:
 * CHARTWARDEN_TEST_DATABASE_URL=... bun run test:m23:claimmd-response-inbox:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClaimMdEvidenceCipher } from "../src/modules/23-billing-medicare/claimmd-evidence/cipher";
import {
  createTenantClaimMdEvidence,
  tenantClaimMdAccountReference,
} from "../src/modules/23-billing-medicare/claimmd-evidence/store";
import { createClaimMdCandidateProvider } from "../src/modules/23-billing-medicare/claimmd-identity/candidate-provider";
import { readClaimMdEraSubmissionFacts } from "../src/modules/23-billing-medicare/claimmd-identity/era-evidence-reader";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");

describe.skipIf(!DB_URL)("M23 Claim.MD response inbox — LIVE Postgres", () => {
  let admin: Client;
  let app: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    app = new Client({ connectionString: await appRoleConnectionString(admin, DB_URL as string) });
    await app.connect();
  }, 300_000);

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("forces RLS and denies the tenant app role access to account-wide rows", async () => {
    const stream = await admin.query<{ id: string }>(
      `INSERT INTO claimmd_response_stream(account_reference,usage,cursor)
       VALUES ('synthetic-test-account','test','0') RETURNING id`,
    );
    expect(stream.rowCount).toBe(1);
    await expect(app.query("SELECT * FROM claimmd_response_stream")).rejects.toThrow();
    const flags = await admin.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c WHERE c.relname='claimmd_response_stream'`,
    );
    expect(flags.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("allows one concurrent capture lease winner and fences the losing worker", async () => {
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO claimmd_response_stream(account_reference,usage,cursor,lease_owner,lease_until)
       VALUES ('synthetic-concurrency-account','test','0',gen_random_uuid(),now() - interval '1 second') RETURNING id`,
    );
    const streamId = inserted.rows[0]?.id;
    if (!streamId) throw new Error("live fixture stream missing");
    const workers = await Promise.all([
      new Client({ connectionString: DB_URL }),
      new Client({ connectionString: DB_URL }),
    ]);
    try {
      await Promise.all(workers.map((worker) => worker.connect()));
      await Promise.all(workers.map((worker) => worker.query("SET ROLE claimmd_capture")));
      const results = await Promise.all(
        workers.map((worker) =>
          worker.query(
            `UPDATE claimmd_response_stream
             SET lease_owner=gen_random_uuid(), lease_until=now()+interval '90 seconds', generation=generation+1
             WHERE id=$1 AND lease_until < now() RETURNING generation`,
            [streamId],
          ),
        ),
      );
      expect(results.map((result) => result.rowCount).sort()).toEqual([0, 1]);
      const final = await admin.query<{ generation: string }>(
        "SELECT generation::text FROM claimmd_response_stream WHERE id=$1",
        [streamId],
      );
      expect(final.rows[0]?.generation).toBe("1");
    } finally {
      await Promise.all(workers.map((worker) => worker.end()));
    }
  });

  it("scopes immutable outbound evidence by tenant and stores receipt observations append-only", async () => {
    const orgs = await admin.query<{ id: string }>(
      `INSERT INTO organization(id,slug,legal_name,display_name) VALUES
       (gen_random_uuid(),'bil122a-'||gen_random_uuid()::text,'Synthetic A','Synthetic A'),
       (gen_random_uuid(),'bil122b-'||gen_random_uuid()::text,'Synthetic B','Synthetic B') RETURNING id`,
    );
    const orgA = orgs.rows[0]?.id;
    const orgB = orgs.rows[1]?.id;
    if (!orgA || !orgB) throw new Error("synthetic organizations were not created");
    const ids = [randomUUID(), randomUUID()];
    for (const [index, organizationId] of [orgA, orgB].entries()) {
      await admin.query(
        `INSERT INTO claimmd_submission_evidence
         (id,organization_id,provider_entity_id,claim_id,billing_module,submission_id,attempt_key,vendor,account_reference,usage,
          billing_npi,billing_tin_ciphertext,payer_id,claim_type,pcn,isa13,gs06,st02,payload_sha256,payload_format,outbound_reference,reserved_at)
         VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),'M23',gen_random_uuid(),$3,'claimmd','acct-synthetic','test',
          '1234567893',repeat('x',48),'payer-synthetic','81:A:3','PCN-SYNTHETIC','000000101','101','0101',
          repeat('a',64),'x12',$3,now())`,
        [ids[index], organizationId, `sub-attempt-${index}`],
      );
    }
    await app.query("SELECT set_config('app.org_id',$1,false)", [orgA]);
    const visible = await app.query<{ organization_id: string }>(
      "SELECT organization_id FROM claimmd_submission_evidence",
    );
    expect(visible.rows.map((row) => row.organization_id)).toEqual([orgA]);
    await expect(
      app.query("UPDATE claimmd_submission_evidence SET billing_npi='0000000000' WHERE id=$1", [
        ids[0],
      ]),
    ).rejects.toThrow();
    await expect(
      admin.query("UPDATE claimmd_submission_evidence SET billing_npi='0000000000' WHERE id=$1", [
        ids[0],
      ]),
    ).rejects.toThrow(/IMMUTABLE/);

    const receipt = {
      evidence_id: ids[0],
      organization_id: orgA,
      account_reference: "acct-synthetic",
      usage: "test",
      vendor: "claimmd",
      source_field: "fileid",
      identifier_namespace: "file",
      external_value: "file-synthetic",
      observation_source: "upload_response",
      observed_at: new Date(),
      source_reference: "attempt-synthetic",
    };
    await admin.query(
      `INSERT INTO claimmd_submission_receipt_observation
       (evidence_id,organization_id,account_reference,usage,vendor,source_field,identifier_namespace,external_value,observation_source,observed_at,source_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      Object.values(receipt),
    );
    const repeated = await admin.query(
      `INSERT INTO claimmd_submission_receipt_observation
       (evidence_id,organization_id,account_reference,usage,vendor,source_field,identifier_namespace,external_value,observation_source,observed_at,source_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      Object.values(receipt),
    );
    expect(repeated.rowCount).toBe(0);
  });

  it("a tenant's own Claim.MD account files evidence under its own org and tenant:<org>, immutable, org-scoped, and never matched by the platform readers", async () => {
    const orgs = await admin.query<{ id: string }>(
      `INSERT INTO organization(id,slug,legal_name,display_name) VALUES
       (gen_random_uuid(),'tenacct-'||gen_random_uuid()::text,'Synthetic Tenant','Synthetic Tenant'),
       (gen_random_uuid(),'tenother-'||gen_random_uuid()::text,'Synthetic Other','Synthetic Other') RETURNING id`,
    );
    const orgA = orgs.rows[0]?.id;
    const orgB = orgs.rows[1]?.id;
    if (!orgA || !orgB) throw new Error("synthetic organizations were not created");
    const key = Buffer.alloc(32, 7);
    const cipher = createClaimMdEvidenceCipher({
      dekForOrg: async () => ({ version: "1", key }),
      dekForOrgVersion: async () => ({ version: "1", key }),
    });
    const appDb = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const adminDb = createDbClient({ connectionString: DB_URL as string });
    try {
      // The real tenant store, on the real NOBYPASSRLS chartwarden_app pool (withOrgContext inside reserve()).
      const evidenceId = await createTenantClaimMdEvidence({ db: appDb.db, cipher })
        .submission(orgA, "test")
        .reserve({
          organizationId: orgA,
          providerEntityId: randomUUID(),
          locationId: null,
          claimId: randomUUID(),
          // M41 (a commercial claim on the tenant's own account): the ERA reader's M23 path also needs a claim_submission row.
          billingModule: "M41",
          submissionId: randomUUID(),
          attemptKey: "tenant-acct-attempt-1",
          accountReference: tenantClaimMdAccountReference(orgA),
          usage: "test",
          x12Claim: {
            billingNpi: "1234567893",
            billingTin: "000000001",
            payerId: "payer-synthetic",
            pcn: "PCN-TENANT-ACCT",
            claimType: "81:A:3",
            serviceFrom: null,
            serviceTo: null,
            isa13: "000000201",
            gs06: "201",
            st02: "0201",
          },
          payloadSha256: "b".repeat(64),
          outboundReference: "tenant-acct-attempt-1",
          reservedAt: new Date(),
        });

      // 1. Filed under the tenant's own org and its own account reference, and immutable.
      const row = await admin.query<{ organization_id: string; account_reference: string }>(
        "SELECT organization_id, account_reference FROM claimmd_submission_evidence WHERE id=$1",
        [evidenceId],
      );
      expect(row.rows).toEqual([{ organization_id: orgA, account_reference: `tenant:${orgA}` }]);
      await app.query("SELECT set_config('app.org_id',$1,false)", [orgA]);
      await expect(
        app.query("UPDATE claimmd_submission_evidence SET pcn='X' WHERE id=$1", [evidenceId]),
      ).rejects.toThrow();
      await expect(
        app.query("DELETE FROM claimmd_submission_evidence WHERE id=$1", [evidenceId]),
      ).rejects.toThrow();
      await expect(
        admin.query("UPDATE claimmd_submission_evidence SET pcn='X' WHERE id=$1", [evidenceId]),
      ).rejects.toThrow(/IMMUTABLE/);
      await expect(
        admin.query("DELETE FROM claimmd_submission_evidence WHERE id=$1", [evidenceId]),
      ).rejects.toThrow(/IMMUTABLE/);

      // 2. Invisible under another organization's app.org_id.
      await app.query("SELECT set_config('app.org_id',$1,false)", [orgB]);
      const asOther = await app.query("SELECT id FROM claimmd_submission_evidence WHERE id=$1", [
        evidenceId,
      ]);
      expect(asOther.rowCount).toBe(0);

      // 3. The platform readers (identity candidates, ERA facts), run cross-tenant as the platform does, never return it.
      const platformAccount = "acct-platform-synthetic";
      const openTin = (fact: {
        id: string;
        organizationId: string;
        providerEntityId: string;
        attemptKey: string;
        sealed: string;
      }) => cipher.open({ ...fact, evidenceId: fact.id });
      const eraFor = (accountReference: string) =>
        readClaimMdEraSubmissionFacts({
          tx: adminDb.db,
          accountReference,
          usage: "test",
          npis: ["1234567893"],
          pcns: ["PCN-TENANT-ACCT"],
          openTin,
        });
      expect((await eraFor(platformAccount)).facts).toEqual([]);
      // Positive control: the same query under the tenant's reference does find it, so the empty result is the account scope.
      expect((await eraFor(`tenant:${orgA}`)).facts.map((fact) => fact.id)).toEqual([evidenceId]);

      const provider = createClaimMdCandidateProvider({
        readSnapshot: (fn) => adminDb.db.transaction(fn),
        siteReader: {
          providerEntityOwners: async () => [],
          locationOwners: async () => [],
        },
        commercialSubmissionReader: async () => [],
        cipher,
        accountReference: platformAccount,
        usage: "test",
      });
      const event = {
        usage: "test" as const,
        responseId: null,
        claimMdClaimId: null,
        remoteClaimId: null,
        claimId: null,
        fileId: null,
        batchId: null,
        pcn: "PCN-TENANT-ACCT",
        billingNpi: "1234567893",
        billingTin: null,
        payerId: null,
        claimType: null,
        serviceFrom: null,
        serviceTo: null,
      };
      // A platform-account event carrying the tenant row's PCN matches nothing ...
      expect(
        await provider.findClaimMdSubmissionCandidates({
          ...event,
          accountReference: platformAccount,
        }),
      ).toEqual({ candidates: [], complete: true });
      // ... and an event naming the tenant's reference is refused by the platform provider outright.
      expect(
        await provider.findClaimMdSubmissionCandidates({
          ...event,
          accountReference: `tenant:${orgA}`,
        }),
      ).toEqual({ candidates: [], complete: true });
    } finally {
      await appDb.close();
      await adminDb.close();
    }
  });
});
