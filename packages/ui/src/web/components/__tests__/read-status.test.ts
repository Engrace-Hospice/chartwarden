import { describe, expect, it } from "vitest";
import { classifyRead, settleRead } from "../read-status";

describe("classifyRead", () => {
  it("is ok for a 2xx without an error", () => {
    expect(classifyRead({ error: undefined, response: { status: 200 } })).toBe("ok");
  });
  it("is denied for 403", () => {
    expect(classifyRead({ error: { code: "x" }, response: { status: 403 } })).toBe("denied");
  });
  it("is failed for 5xx and other 4xx", () => {
    expect(classifyRead({ error: {}, response: { status: 503 } })).toBe("failed");
    expect(classifyRead({ error: {}, response: { status: 500 } })).toBe("failed");
  });
  it("is failed for a bodiless error status and for an error with no status", () => {
    expect(classifyRead({ error: undefined, response: { status: 502 } })).toBe("failed");
    expect(classifyRead({ error: { message: "x" } })).toBe("failed");
  });
});

describe("settleRead", () => {
  it("turns a rejected request into a failed read instead of throwing", async () => {
    await expect(settleRead(Promise.reject(new Error("network")))).resolves.toEqual({
      status: "failed",
    });
  });
  it("returns the response only when ok", async () => {
    const ok = { data: 1, response: { status: 200 } };
    await expect(settleRead(Promise.resolve(ok))).resolves.toEqual({ status: "ok", res: ok });
    await expect(
      settleRead(Promise.resolve({ error: {}, response: { status: 403 } })),
    ).resolves.toEqual({ status: "denied" });
  });
  it("maps a 404 per caller meaning", async () => {
    const nf = { error: {}, response: { status: 404 } };
    expect((await settleRead(Promise.resolve(nf), "empty")).status).toBe("ok");
    expect((await settleRead(Promise.resolve(nf), "denied")).status).toBe("denied");
    expect((await settleRead(Promise.resolve(nf))).status).toBe("failed");
  });
});
