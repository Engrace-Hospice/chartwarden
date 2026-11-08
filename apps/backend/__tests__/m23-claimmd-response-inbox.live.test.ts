import { randomUUID } from "node:crypto";
/**
 * Proves the unowned account-wide Claim.MD inbox is invisible to chartwarden_app and
 * serialized by PostgreSQL for competing capture workers. Run only on a private disposable PG:
 * CHARTWARDEN_TEST_DATABASE_URL=... bun run test:m23:claimmd-response-inbox:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
