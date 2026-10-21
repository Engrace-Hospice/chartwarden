// packages/db/__tests__/client.live.test.ts — AUTH-T01 (ADR-0033) live-PG smoke.
// Skipped in the infra-free unit lane; runs when CHARTWARDEN_TEST_DATABASE_URL points at real Postgres
// (the rls-live env, or a local pg). Proves createDbClient actually opens a pooled connection.
// The dedicated auth/live CI lane that runs this end-to-end lands at AUTH-T06.
import { describe, expect, it } from "vitest";
import { createDbClient } from "../src/client";

const url = process.env.CHARTWARDEN_TEST_DATABASE_URL;

describe.skipIf(!url)("createDbClient — live Postgres connection (AUTH-T01)", () => {
  it("connects and runs SELECT 1", async () => {
    const handle = createDbClient({ connectionString: url as string });
    try {
      const res = await handle.pool.query("select 1 as ok");
      expect(res.rows[0]?.ok).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
