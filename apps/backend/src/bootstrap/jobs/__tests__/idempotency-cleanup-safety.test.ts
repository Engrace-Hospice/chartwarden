import { DrizzleQueryError } from "drizzle-orm/errors";
// The sweeper's two safety properties.
//
// 1. It never deletes a LIVE claim. It selects the expired ids, then deletes them in a second statement; `putPending` can reclaim an
//    expired key in between (ON CONFLICT DO UPDATE ... WHERE expires_at <= now() resets the SAME row id to a fresh 24 h pending claim),
//    so a delete by id alone removes the live claim and a retry runs the handler twice. The DELETE carries its own expiry predicate
//    (and the org, defence in depth). The live suite proves the interleave against Postgres; this pins the statement's shape.
// 2. Its aggregate failure text carries no query parameters: a DrizzleQueryError's message includes them, and the text goes to the job's
//    failure record and the DLQ alert.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

const deletes: Array<{ sql: string; params: unknown[] }> = [];
const FINGERPRINT = "h1:0123abcd:credential-derived-fingerprint-9f8e7d";

vi.mock("@chartwarden/tenancy", () => ({
  registerPlatformJob: () => {},
  systemOrgContext: (organizationId: string) => ({ organizationId, userId: "" }),
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    if (ctx.organizationId === "org-dberr") {
      const pg = Object.assign(new Error("permission denied for table idempotency_key"), {
        code: "42501",
        severity: "ERROR",
      });
      throw new DrizzleQueryError(
        'select "id" from "idempotency_key" where "request_hash" = $1',
        [FINGERPRINT],
        pg,
      );
    }
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ id: "row-1" }, { id: "row-2" }] }) }),
      }),
      delete: () => ({
        where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const q = new PgDialect().sqlToQuery(condition);
          deletes.push({ sql: q.sql, params: q.params });
          return { returning: async () => [{ id: "row-1" }, { id: "row-2" }] };
        },
      }),
    };
    return fn(tx);
  },
}));

import { runIdempotencyCleanup } from "../idempotency-cleanup";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const deps = (orgs: string[]) => ({
  db: {} as never,
  activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  now: () => NOW,
});

describe("idempotency.cleanup never deletes a live claim", () => {
  it("the DELETE is by id AND still-expired AND this org, not by id alone", async () => {
    deletes.length = 0;
    await runIdempotencyCleanup(deps(["org-a"]));
    expect(deletes).toHaveLength(1);
    const { sql, params } = deletes[0] as { sql: string; params: unknown[] };
    expect(sql).toMatch(/"id" in/i);
    expect(sql).toMatch(/"expires_at" <=/i);
    expect(sql).toMatch(/"organization_id" =/i);
    expect(params).toContain("org-a");
    expect(
      params.some(
        (p) => p instanceof Date || (typeof p === "string" && p.startsWith("2026-10-06")),
      ),
    ).toBe(true);
  });
});

describe("idempotency.cleanup failure text", () => {
  it("carries the error class and the redacted message, never a bound parameter", async () => {
    const failure = await runIdempotencyCleanup(deps(["org-dberr"])).catch(
      (e: unknown) => e as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    const text = (failure as Error).message;
    expect(text).toContain("org-dberr");
    expect(text).not.toContain(FINGERPRINT);
    expect(text).not.toContain("credential-derived");
    expect(text).toContain("42501");
  });

  it("keeps a plain failure's message", async () => {
    const failure = await runIdempotencyCleanup(deps(["org-dberr", "org-ok"])).catch(
      (e: unknown) => e as Error,
    );
    expect((failure as Error).message).toMatch(/failed for 1 org/);
  });
});
