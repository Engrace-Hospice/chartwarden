// packages/db/__tests__/client.test.ts — AUTH-T01 (ADR-0033) smoke for the prod DB client factory.
// Infra-free: the pg Pool is lazy, so we construct a client and close it without opening a connection.
import { EventEmitter } from "node:events";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDbClient } from "../src/client";

describe("createDbClient (AUTH-T01) — production pg + Drizzle factory", () => {
  it("constructs a pooled Drizzle client without connecting", async () => {
    const handle = createDbClient({
      connectionString: "postgres://u:p@localhost:5432/none",
      max: 3,
    });
    expect(handle.db).toBeTruthy();
    expect(handle.pool).toBeTruthy();
    expect(handle.pool.options.max).toBe(3);
    await handle.close(); // ends the never-connected pool — no network I/O
  });

  it("fails closed on a missing connection string", () => {
    expect(() => createDbClient({ connectionString: "" })).toThrow(/DATABASE_URL/);
  });

  it("reports an idle-pool error with SQLSTATE and message only", async () => {
    const onConnectionError = vi.fn();
    const handle = createDbClient({
      connectionString: "postgres://u:p@localhost:5432/none",
      onConnectionError,
    });
    const error = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      query: "select secret from patient",
      values: ["phi"],
    });

    handle.pool.emit("error", error, {} as PoolClient);

    expect(onConnectionError).toHaveBeenCalledWith({
      source: "pool",
      sqlState: "57P01",
      message: "terminating connection due to administrator command",
    });
    expect(JSON.stringify(onConnectionError.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(onConnectionError.mock.calls)).not.toContain("phi");
    await handle.close();
  });

  it("covers a checked-out client only until it is released", async () => {
    const onConnectionError = vi.fn();
    const handle = createDbClient({
      connectionString: "postgres://u:p@localhost:5432/none",
      onConnectionError,
    });
    const client = new EventEmitter() as PoolClient;

    handle.pool.emit("acquire", client);
    expect(client.listenerCount("error")).toBe(1);
    client.emit("error", new Error("connection terminated unexpectedly"));
    expect(onConnectionError).toHaveBeenCalledWith({
      source: "checked_out_client",
      sqlState: null,
      message: "connection terminated unexpectedly",
    });

    handle.pool.emit("release", undefined as unknown as Error, client);
    expect(client.listenerCount("error")).toBe(0);
    await handle.close();
  });

  it("does not rethrow when the configured error sink fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const handle = createDbClient({
      connectionString: "postgres://u:p@localhost:5432/none",
      onConnectionError: () => {
        throw new Error("logger unavailable");
      },
    });

    expect(() =>
      handle.pool.emit("error", new Error("database restarted"), {} as PoolClient),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Postgres connection error (configured sink failed)", {
      source: "pool",
      sqlState: null,
      message: "database restarted",
    });
    warn.mockRestore();
    await handle.close();
  });
});
