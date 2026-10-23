import { describe, expect, it } from "vitest";
import { classifyRead } from "../read-status";

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
