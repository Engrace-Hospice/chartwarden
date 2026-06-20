// packages/db/__tests__/client.test.ts — AUTH-T01 (ADR-0033) smoke for the prod DB client factory.
// Infra-free: the pg Pool is lazy, so we construct a client and close it without opening a connection.
import { describe, expect, it } from "vitest";
import { createDbClient } from "../src/client";

describe("createDbClient (AUTH-T01) — production pg + Drizzle factory", () => {
  it("constructs a pooled Drizzle client without connecting", async () => {
    const handle = createDbClient({ connectionString: "postgres://u:p@localhost:5432/none", max: 3 });
    expect(handle.db).toBeTruthy();
    expect(handle.pool).toBeTruthy();
    expect(handle.pool.options.max).toBe(3);
    await handle.close(); // ends the never-connected pool — no network I/O
  });

  it("fails closed on a missing connection string", () => {
    expect(() => createDbClient({ connectionString: "" })).toThrow(/DATABASE_URL/);
  });
});
