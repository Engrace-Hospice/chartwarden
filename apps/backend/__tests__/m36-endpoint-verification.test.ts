// GAP-166 — endpoint verification must check the issued code (constant-time, TTL, attempt cap).
import { describe, expect, it } from "vitest";
import {
  MAX_VERIFICATION_ATTEMPTS,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_TTL_MS,
  checkVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
} from "../src/modules/36-messaging/endpoint-verification";

const EP = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-10-06T12:00:00Z");

function issued(code: string, overrides: { attempts?: number; ageMs?: number } = {}) {
  return {
    endpointId: EP,
    tokenHash: hashVerificationCode(EP, code),
    expiresAt: new Date(NOW.getTime() - (overrides.ageMs ?? 0) + VERIFICATION_CODE_TTL_MS),
    attempts: overrides.attempts ?? 0,
  };
}

describe("endpoint verification code (GAP-166)", () => {
  it("generates a zero-padded numeric code of the configured length", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVerificationCode()).toMatch(new RegExp(`^\\d{${VERIFICATION_CODE_LENGTH}}$`));
    }
  });

  it("accepts the issued code", () => {
    expect(checkVerificationCode(issued("123456"), "123456", NOW)).toBe("ok");
  });

  it("rejects a wrong token (previously any token verified the endpoint)", () => {
    expect(checkVerificationCode(issued("123456"), "000000", NOW)).toBe("mismatch");
    expect(checkVerificationCode(issued("123456"), "", NOW)).toBe("mismatch");
  });

  it("salts the hash with the endpoint id", () => {
    expect(hashVerificationCode(EP, "123456")).not.toBe(hashVerificationCode("other", "123456"));
  });

  it("reports not_issued when no code was ever issued", () => {
    const state = { endpointId: EP, tokenHash: null, expiresAt: null, attempts: 0 };
    expect(checkVerificationCode(state, "123456", NOW)).toBe("not_issued");
  });

  it("rejects an expired code even when it matches", () => {
    const state = issued("123456", { ageMs: VERIFICATION_CODE_TTL_MS + 1 });
    expect(checkVerificationCode(state, "123456", NOW)).toBe("expired");
  });

  it("locks after the attempt cap even for the correct code", () => {
    const state = issued("123456", { attempts: MAX_VERIFICATION_ATTEMPTS });
    expect(checkVerificationCode(state, "123456", NOW)).toBe("locked");
  });
});
