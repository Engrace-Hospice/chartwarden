import { type HttpRequestContext, UnauthorizedError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  InvalidCursorError,
  actorOf,
  configureCursorSigningKey,
  decodeCursor,
  encodeCursor,
  firstOrThrow,
  ifMatchVersionOf,
  isKeysetCursor,
  isUniqueViolation,
  membershipActorOf,
  pageQuery,
  rejectAiActor,
  requireIdempotencyKey,
  requireIfMatch,
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
    await expect(requireIdempotencyKey()(headers({ "idempotency-key": "k" }))).resolves.toBeUndefined();
  });
});

describe("route-kit actor", () => {
  it("reads the actor from the server context and 401s without one", () => {
    expect(actorOf(ctx())).toMatchObject({ organizationId: ORG_A, userId: "user-1", membershipId: "m-1" });
    expect(() => actorOf({})).toThrow(UnauthorizedError);
  });

  it("requires a membership for a write and maps it to userId for membership-attributed services", () => {
    expect(() => writeActorOf(ctx({ attributes: {} }))).toThrow(UnauthorizedError);
    expect(membershipActorOf(ctx())).toEqual({ organizationId: ORG_A, userId: "m-1", roles: ["rn"] });
  });

  it("refuses an ai_* principal", async () => {
    await expect(rejectAiActor()(ctx({ attributes: { actorKind: "ai_scribe" } }))).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(rejectAiActor()(ctx())).resolves.toBeUndefined();
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
