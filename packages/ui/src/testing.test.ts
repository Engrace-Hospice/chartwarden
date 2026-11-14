// The shared stub client: dispatches on method + typed path, records every call, and a path with no handler is a loud 500.
import { describe, expect, it } from "vitest";
import { idempotencyKeyOf, ifMatchOf, ok, refused, stubClient } from "./testing";

describe("stubClient", () => {
  it("answers by method and path and records the call", async () => {
    const client = stubClient({ GET: { "/a": () => ok({ n: 1 }) } });
    expect(await client.GET("/a")).toEqual({ data: { n: 1 }, response: { status: 200 } });
    expect(client.GET).toHaveBeenCalledTimes(1);
    expect((await client.POST("/a")).response?.status).toBe(500);
  });

  it("builds the standard error envelope", () => {
    expect(refused(409, "X", "no", [{ field: "f" }]).error).toEqual({
      error: { code: "X", message: "no", correlationId: "corr-test", details: [{ field: "f" }] },
    });
  });

  it("reads the Idempotency-Key and If-Match from a typed header or the headers option", () => {
    expect(idempotencyKeyOf(["/p", { params: { header: { "Idempotency-Key": "k1" } } }])).toBe(
      "k1",
    );
    expect(
      idempotencyKeyOf(["/p", { headers: { "Idempotency-Key": "k2", "If-Match": "4" } }]),
    ).toBe("k2");
    expect(ifMatchOf(["/p", { headers: { "If-Match": "4" } }])).toBe("4");
    expect(ifMatchOf(["/p", {}])).toBeUndefined();
  });
});
