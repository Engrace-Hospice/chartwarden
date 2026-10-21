// wardenx -> chartwarden Valkey rename, release A: the suggestion-banner key pair (dual-write itself is proven in the live suite).
import { describe, expect, it } from "vitest";
import { bannerKeys } from "./m9-assessment-significant-change";

describe("m11 suggestion banner keys", () => {
  it("yields the legacy and new key for a patient", () => {
    expect(bannerKeys("p1")).toEqual({
      legacyKey: "wardenx:m11:orders:suggestion:p1",
      newKey: "chartwarden:m11:orders:suggestion:p1",
    });
  });
});
