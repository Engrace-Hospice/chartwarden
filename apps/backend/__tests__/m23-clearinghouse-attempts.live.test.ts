/**
 * M23 (ADR-0053 D4) — the durable `SubmissionAttemptStore` over `clearinghouse_submission_attempt`.
 *
 * Runs the package's framework-free ATTEMPT_STORE_CONTRACT against the real table as the NOBYPASSRLS `wardenx_app`
 * role (so a cross-tenant leak or a missing grant fails here, not in prod), then proves what only Postgres can:
 * RLS isolation, the immutable-identity / final-status guard, and that the app role cannot delete history.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:clearinghouse-attempts:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ATTEMPT_STORE_CONTRACT,
  type AttemptStoreContractIds,
  attemptReservationFixture,
} from "@wardenx/x12-837-client";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleAttemptStore } from "../src/modules/23-billing-medicare/clearinghouse-attempt-store";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const IDS: AttemptStoreContractIds = {
  orgA: "11111111-1111-4111-8111-1111ca7ea001",
  orgB: "22222222-2222-4222-8222-2222ca7eb002",
  providerEntityA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  providerEntityB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
};

describe.skipIf(!DB_URL)("M23 durable clearinghouse attempt store — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

  const countAs = (organizationId: string) =>
    withOrgContext(handle.db, { organizationId, userId: "" }, async (tx) => {
      const res = (await (tx as unknown as typeof handle.db).execute(
        sql`SELECT count(*)::int AS n FROM clearinghouse_submission_attempt`,
      )) as unknown as { rows: { n: number }[] };
      return res.rows[0]?.n ?? -1;
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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'ca7e-a','A','A','active'),($2,'ca7e-b','B','B','active')",
      [IDS.orgA, IDS.orgB],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  });

  beforeEach(async () => {
    await admin.query("TRUNCATE clearinghouse_submission_attempt");
  });

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  for (const c of ATTEMPT_STORE_CONTRACT) {
    it(`${c.id}: ${c.title}`, async () => {
      await c.run(async () => createDrizzleAttemptStore(handle.db), IDS);
    });
  }

  it("a tenant reads none of another tenant's attempts, even by a direct select", async () => {
    await createDrizzleAttemptStore(handle.db).reserve(attemptReservationFixture(IDS));
    expect(await countAs(IDS.orgA)).toBe(1);
    expect(await countAs(IDS.orgB)).toBe(0);
  });

  it("refuses to change a row's identity or to reopen a final row", async () => {
    const store = createDrizzleAttemptStore(handle.db);
    await store.reserve(attemptReservationFixture(IDS));
    await expect(
      admin.query(
        "UPDATE clearinghouse_submission_attempt SET control_number='CHANGED' WHERE idempotency_key='idem-1'",
      ),
    ).rejects.toThrow(/immutable/);
    await store.complete(
      IDS.orgA,
      `scope-${IDS.orgA}`,
      "idem-1",
      "ch-1",
      "2026-10-11T10:20:00.000Z",
    );
    await expect(
      admin.query(
        "UPDATE clearinghouse_submission_attempt SET status='released', clearinghouse_submission_id=NULL, received_at=NULL WHERE idempotency_key='idem-1'",
      ),
    ).rejects.toThrow(/final/);
  });

  it("the app role cannot delete an attempt", async () => {
    await createDrizzleAttemptStore(handle.db).reserve(attemptReservationFixture(IDS));
    await expect(
      withOrgContext(handle.db, { organizationId: IDS.orgA, userId: "" }, (tx) =>
        (tx as unknown as typeof handle.db).execute(
          sql`DELETE FROM clearinghouse_submission_attempt`,
        ),
      ),
    ).rejects.toThrow();
  });
});
