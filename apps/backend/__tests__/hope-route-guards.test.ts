import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { signatureRequestFacts } from "../src/modules/10-hope/routes/hope-route-guards";

const SESSION_USER = "33333333-3333-4333-8333-333333333333";

const requestWith = (context: Record<string, unknown>): FastifyRequest =>
  ({ id: "req-7", context }) as unknown as FastifyRequest;

describe("signatureRequestFacts", () => {
  it("carries the request id, correlation id, address, user agent and the session user", () => {
    const facts = signatureRequestFacts(
      requestWith({
        userId: SESSION_USER,
        correlationId: "corr-1",
        ip: "203.0.113.7",
        userAgent: "agent/1.0",
      }),
    );

    expect(facts).toEqual({
      requestId: "req-7",
      correlationId: "corr-1",
      actorUserId: SESSION_USER,
      sourceIp: "203.0.113.7",
      userAgent: "agent/1.0",
    });
  });

  it.each([
    ["the system principal's literal id", "system"],
    ["an empty id", ""],
    ["a string that merely looks like a uuid", "33333333-3333-4333-8333-33333333333"],
    ["a non-string id", 42],
  ])("passes no actorUserId for %s (the audit column is a uuid)", (_label, userId) => {
    const facts = signatureRequestFacts(requestWith({ userId, ip: "203.0.113.7" }));

    expect(facts).not.toHaveProperty("actorUserId");
    expect(facts.requestId).toBe("req-7");
  });

  it("omits what the context does not have, rather than recording empty strings", () => {
    const facts = signatureRequestFacts(requestWith({ userId: SESSION_USER, userAgent: "" }));

    expect(facts).toEqual({ requestId: "req-7", actorUserId: SESSION_USER });
  });
});
