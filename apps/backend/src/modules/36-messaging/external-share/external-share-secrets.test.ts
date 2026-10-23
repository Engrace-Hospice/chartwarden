import { randomUUID } from "node:crypto";
import { EXTERNAL_PARTNER_NOTIFICATION_TEXT } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  PARTNER_TOKEN_RE,
  formatSessionToken,
  hashPartnerToken,
  hashVerificationCode,
  newPartnerToken,
  newVerificationCode,
  parseSessionToken,
  partnerNotificationText,
  verifyVerificationCode,
} from "./external-share-secrets";

describe("partner secrets", () => {
  it("tokens are 43 url-safe characters, unique, and hash to 64 hex characters", () => {
    const a = newPartnerToken();
    expect(a).toMatch(PARTNER_TOKEN_RE);
    expect(newPartnerToken()).not.toBe(a);
    expect(hashPartnerToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPartnerToken(a)).toBe(hashPartnerToken(a));
  });

  it("the code is eight digits (leading zeros kept) and verifies only against its own salted hash", () => {
    for (let i = 0; i < 50; i += 1) expect(newVerificationCode()).toMatch(/^\d{8}$/);
    const stored = hashVerificationCode("00012345");
    expect(stored).not.toContain("00012345");
    expect(verifyVerificationCode("00012345", stored)).toBe(true);
    expect(verifyVerificationCode("00012346", stored)).toBe(false);
    expect(verifyVerificationCode("12345", stored)).toBe(false);
    expect(verifyVerificationCode("00012345", "garbage")).toBe(false);
    expect(hashVerificationCode("00012345")).not.toBe(stored);
  });

  it("the session bearer round-trips and rejects anything malformed", () => {
    const org = randomUUID();
    const token = newPartnerToken();
    expect(parseSessionToken(formatSessionToken(org, token))).toEqual({
      organizationId: org,
      token,
    });
    for (const bad of [
      "",
      "x",
      `${org}.short`,
      `${org}x${token}`,
      `not-a-uuid-000000000000000000000.${token}`,
      `${org}.${token}.extra`,
    ]) {
      expect(parseSessionToken(bad), bad).toBeNull();
    }
  });

  it("the notification text is a constant with no digits, address or name hole", () => {
    expect(partnerNotificationText()).toBe(EXTERNAL_PARTNER_NOTIFICATION_TEXT);
    expect(partnerNotificationText.length).toBe(0); // takes no argument: no content can enter
    expect(partnerNotificationText()).not.toMatch(/[0-9@{}$]/);
  });
});
