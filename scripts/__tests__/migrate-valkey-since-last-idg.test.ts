import { describe, expect, it } from "vitest";
import { decideMigration, newKeyFor } from "../migrate-valkey-since-last-idg";

describe("migrate-valkey-since-last-idg decisions", () => {
  it("treats a missing or expiring legacy key as expired", () => {
    expect(decideMigration({ value: null, pttl: -2, newKeyExists: false })).toBe("expired");
    expect(decideMigration({ value: "{}", pttl: 0, newKeyExists: false })).toBe("expired");
  });
  it("leaves a legacy key with a chartwarden twin to be dropped, never copied over", () => {
    expect(decideMigration({ value: "{}", pttl: 5000, newKeyExists: true })).toBe("already-migrated");
  });
  it("copies a legacy-only key", () => {
    expect(decideMigration({ value: "{}", pttl: 5000, newKeyExists: false })).toBe("copy");
  });
  it("maps the legacy prefix to the chartwarden prefix", () => {
    expect(newKeyFor("wardenx:m14:idg:since-last-idg:p1")).toBe("chartwarden:m14:idg:since-last-idg:p1");
  });
});
