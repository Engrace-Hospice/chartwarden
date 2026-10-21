import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { searchTimeoutToError } from "../src/modules/36-messaging/message-search-service-db";

// S2: the 5 s statement timeout surfaces as a typed 503 with the standard envelope, not an opaque 500.
describe("searchTimeoutToError", () => {
  it("maps SQLSTATE 57014, also when wrapped as a cause, to a 503 SEARCH_TIMEOUT", () => {
    for (const raw of [{ code: "57014" }, new Error("wrapped", { cause: { code: "57014" } })]) {
      const mapped = searchTimeoutToError(raw);
      expect(mapped).toBeInstanceOf(ChartWardenError);
      expect(mapped).toMatchObject({ code: "SEARCH_TIMEOUT", statusCode: 503 });
    }
  });
  it("leaves every other error alone", () => {
    const other = new Error("boom");
    expect(searchTimeoutToError(other)).toBe(other);
    expect(searchTimeoutToError({ code: "23505" })).toEqual({ code: "23505" });
  });
});
