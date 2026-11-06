import { ForbiddenError, type HttpRequestContext, UnauthorizedError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvalidCursorError,
  actorOf,
  clampLimit,
  configureCursorSigningKey,
  decodeCursor,
  encodeCursor,
  firstOrThrow,
  ifMatchVersionOf,
  isKeysetCursor,
  isUniqueViolation,
  membershipActorOf,
  membershipIdOf,
  optionalIfMatchVersionOf,
  pageQuery,
  rejectAiActor,
  rejectOffsetPagination,
  requireIdempotencyKey,
  requireIfMatch,
  targetStr,
  toCursorPage,
  uniqueViolationConstraint,
  writeActorOf,
} from "../src/route-kit";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

function ctx(over: Partial<HttpRequestContext> = {}): { context: HttpRequestContext } {
  return {
    context: {
      correlationId: "c",
      userId: "user-1",
      organizationId: ORG_A,
      providerEntityIds: [],
      locationIds: [],
      roles: ["rn"],
      attributes: { membershipId: "m-1" },
      ip: "",
      userAgent: "",
      startTime: 0,
      ...over,
    },
  };
}

const headers = (h: Record<string, string>) => ({ headers: h });

describe("route-kit concurrency", () => {
  it("answers 428 IF_MATCH_REQUIRED for a missing If-Match", async () => {
    await expect(requireIfMatch()(headers({}))).rejects.toMatchObject({
      statusCode: 428,
      code: "IF_MATCH_REQUIRED",
    });
  });

  it("parses bare, quoted and weak ETags and refuses a non-integer with 400", () => {
    expect(ifMatchVersionOf(headers({ "if-match": "3" }))).toBe(3);
    expect(ifMatchVersionOf(headers({ "if-match": 'W/"7"' }))).toBe(7);
    expect(() => ifMatchVersionOf(headers({ "if-match": "abc" }))).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("requires an Idempotency-Key of 1-128 chars", async () => {
    await expect(requireIdempotencyKey()(headers({}))).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      requireIdempotencyKey()(headers({ "idempotency-key": "x".repeat(129) })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REQUIRED" });
    await expect(
      requireIdempotencyKey()(headers({ "idempotency-key": "k" })),
    ).resolves.toBeUndefined();
  });
});

describe("route-kit actor", () => {
  it("reads the actor from the server context and 401s without one", () => {
    expect(actorOf(ctx())).toMatchObject({
      organizationId: ORG_A,
      userId: "user-1",
      membershipId: "m-1",
    });
    expect(() => actorOf({})).toThrow(UnauthorizedError);
  });

  it("requires a membership for a write and maps it to userId for membership-attributed services", () => {
    expect(() => writeActorOf(ctx({ attributes: {} }))).toThrow(ForbiddenError);
    expect(membershipActorOf(ctx())).toEqual({
      organizationId: ORG_A,
      userId: "m-1",
      roles: ["rn"],
    });
  });

  it("refuses an ai_* principal", async () => {
    await expect(
      rejectAiActor()(ctx({ attributes: { actorKind: "ai_scribe" } })),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(rejectAiActor()(ctx())).resolves.toBeUndefined();
  });
});

describe("route-kit optional If-Match", () => {
  it("is undefined when absent, the version when present, 400 when malformed", () => {
    expect(optionalIfMatchVersionOf(headers({}))).toBeUndefined();
    expect(optionalIfMatchVersionOf(headers({ "if-match": '"4"' }))).toBe(4);
    expect(() => optionalIfMatchVersionOf(headers({ "if-match": "x" }))).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});

describe("route-kit keyset envelope", () => {
  it("clamps a raw limit into the policy and defaults a missing one", () => {
    const policy = { defaultSize: 25, maxSize: 100 };
    expect(clampLimit(undefined, policy)).toBe(25);
    expect(clampLimit("500", policy)).toBe(100);
    expect(clampLimit(0, policy)).toBe(1);
  });

  it("slices limit + 1 rows into a page whose cursor decodes for the same org", () => {
    configureCursorSigningKey("k".repeat(32));
    const rows = [1, 2, 3].map((n) => ({ at: `2026-01-0${n}`, id: `r${n}` }));
    const page = toCursorPage(
      ORG_A,
      rows,
      2,
      (r) => ({ a: r.at, id: r.id }),
      (r) => r.id,
    );
    expect(page.data).toEqual(["r1", "r2"]);
    expect(page.has_more).toBe(true);
    expect(decodeCursor(ORG_A, page.next_cursor, isKeysetCursor)).toEqual({
      a: "2026-01-02",
      id: "r2",
    });
    expect(
      toCursorPage(
        ORG_A,
        rows,
        3,
        (r) => ({ a: r.at, id: r.id }),
        (r) => r.id,
      ).next_cursor,
    ).toBeNull();
  });

  it("refuses ?offset= with 400 OFFSET_PAGINATION_FORBIDDEN", async () => {
    await expect(rejectOffsetPagination()({ query: { offset: "10" } })).rejects.toMatchObject({
      statusCode: 400,
      code: "OFFSET_PAGINATION_FORBIDDEN",
    });
    await expect(rejectOffsetPagination()({ query: {} })).resolves.toBeUndefined();
  });
});

describe("route-kit signed cursor", () => {
  it("round-trips for the org that minted it and refuses another org or a tamper", () => {
    configureCursorSigningKey("k".repeat(32));
    const cursor = encodeCursor(ORG_A, { a: "2026-01-01", id: "x" });
    expect(decodeCursor(ORG_A, cursor, isKeysetCursor)).toEqual({ a: "2026-01-01", id: "x" });
    expect(() => decodeCursor(ORG_B, cursor, isKeysetCursor)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(ORG_A, `x${cursor}`, isKeysetCursor)).toThrow(InvalidCursorError);
    expect(decodeCursor(ORG_A, undefined, isKeysetCursor)).toBeNull();
  });

  it("refuses an unsigned legacy base64 cursor", () => {
    const legacy = Buffer.from(JSON.stringify({ a: "x", id: "y" })).toString("base64url");
    expect(() => decodeCursor(ORG_A, legacy, isKeysetCursor)).toThrow(InvalidCursorError);
  });
});

describe("route-kit schemas and formats", () => {
  it("caps ?limit= at 200 by default and honours an explicit max", () => {
    const q = Type.Object(pageQuery());
    expect(Value.Check(q, { limit: 200 })).toBe(true);
    expect(Value.Check(q, { limit: 201 })).toBe(false);
    expect(Value.Check(Type.Object(pageQuery({ max: 25 })), { limit: 26 })).toBe(false);
  });

  it("registers strict date, uri and email formats", () => {
    expect(Value.Check(Type.String({ format: "date" }), "2025-02-28")).toBe(true);
    expect(Value.Check(Type.String({ format: "date" }), "2025-02-30")).toBe(false);
    expect(Value.Check(Type.String({ format: "uri" }), "https://example.test/x")).toBe(true);
    expect(Value.Check(Type.String({ format: "uri" }), "not a uri")).toBe(false);
    expect(Value.Check(Type.String({ format: "email" }), "a@b.example")).toBe(true);
    expect(Value.Check(Type.String({ format: "email" }), "a@b")).toBe(false);
  });
});

describe("route-kit db helpers", () => {
  it("finds a unique violation through the Drizzle cause chain", () => {
    const pg = Object.assign(new Error("dup"), { code: "23505", constraint: "x_uq" });
    const wrapped = Object.assign(new Error("Failed query"), { cause: pg });
    expect(uniqueViolationConstraint(wrapped)).toBe("x_uq");
    expect(isUniqueViolation(wrapped, "x_uq")).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });

  it("firstOrThrow is a 500 on an empty result unless told otherwise", () => {
    expect(firstOrThrow([1], "m")).toBe(1);
    expect(() => firstOrThrow([], "m")).toThrow(expect.objectContaining({ statusCode: 500 }));
  });
});

describe("route-kit abac reads", () => {
  it("targetStr returns the first non-empty string field, else null", () => {
    expect(targetStr({ a: "", b: "x", c: "y" }, "a", "b", "c")).toBe("x");
    expect(targetStr({ a: 3 }, "a")).toBeNull();
    expect(targetStr({}, "a")).toBeNull();
  });

  it("membershipIdOf reads only a non-empty string attribute", () => {
    expect(membershipIdOf({ attributes: { membershipId: "m-1" } })).toBe("m-1");
    expect(membershipIdOf({ attributes: { membershipId: "" } })).toBeNull();
    expect(membershipIdOf({})).toBeNull();
  });
});
