import { describe, expect, it } from "vitest";
import {
  enrolFailure,
  groupSetupKey,
  isCompleteCode,
  normaliseCode,
  parseTotpUri,
} from "../authenticator-setup";

// A made-up base32 secret: synthetic, belongs to no account.
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/ChartWarden:demo%40example.test?secret=${SECRET}&issuer=ChartWarden`;

describe("parseTotpUri", () => {
  it("reads the setup key out of a Better Auth otpauth URI and keeps the URI for the app link", () => {
    expect(parseTotpUri(URI)).toEqual({ otpauthUri: URI, setupKey: SECRET });
  });

  it("upper-cases the key and drops padding and spaces", () => {
    const parsed = parseTotpUri("otpauth://totp/x?secret=jbsw y3dp====&issuer=ChartWarden");
    expect(parsed?.setupKey).toBe("JBSWY3DP");
  });

  it.each([
    ["a javascript: URL", "javascript:alert(1)"],
    ["an https URL", `https://example.test/?secret=${SECRET}`],
    ["an HOTP URI", `otpauth://hotp/x?secret=${SECRET}`],
    ["a TOTP URI with no secret", "otpauth://totp/x?issuer=ChartWarden"],
    ["a TOTP URI with an empty secret", "otpauth://totp/x?secret="],
    ["a secret that is not base32", "otpauth://totp/x?secret=not-base32!"],
    ["an empty string", ""],
  ])("refuses %s", (_name, uri) => {
    expect(parseTotpUri(uri)).toBeNull();
  });
});

describe("groupSetupKey", () => {
  it("shows the key in blocks of four so it can be typed without losing the place", () => {
    expect(groupSetupKey("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });

  it("keeps a final short block", () => {
    expect(groupSetupKey("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});

describe("code entry", () => {
  it("accepts six digits, however the user spaced them", () => {
    expect(isCompleteCode("123456")).toBe(true);
    expect(isCompleteCode("123 456")).toBe(true);
    expect(isCompleteCode(" 123-456 ")).toBe(true);
  });

  it.each(["12345", "1234567", "12345a", "", "      "])("refuses %j", (raw) => {
    expect(isCompleteCode(raw)).toBe(false);
  });

  it("sends only the digits", () => {
    expect(normaliseCode(" 123 456 ")).toBe("123456");
    expect(normaliseCode("123-456")).toBe("123456");
  });
});

describe("enrolFailure", () => {
  it("names a wrong password, a wrong code and a lockout by Better Auth's stable code", () => {
    expect(enrolFailure({ code: "INVALID_PASSWORD" })).toBe("wrong-password");
    expect(enrolFailure({ code: "INVALID_CODE" })).toBe("wrong-code");
    expect(enrolFailure({ code: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE" })).toBe("too-many-attempts");
  });

  it("calls everything else a plain failure and never reads the message", () => {
    expect(enrolFailure({ code: "SOMETHING_NEW", message: "secret detail" })).toBe("failed");
    expect(enrolFailure({ message: "INVALID_PASSWORD" })).toBe("failed");
    expect(enrolFailure(null)).toBe("failed");
    expect(enrolFailure(undefined)).toBe("failed");
  });
});
