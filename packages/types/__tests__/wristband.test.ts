// packages/types/__tests__/wristband.test.ts -- GAP-020: the patient wristband payload codec (pure, shared by
// the M5 issuer/verifier, the M13 bedside scan and the web print/scan UI).
import { describe, expect, it } from "vitest";
import {
  WRISTBAND_PAYLOAD_LENGTH,
  WRISTBAND_PAYLOAD_VERSION,
  crc16,
  formatWristbandPayload,
  parseWristbandPayload,
} from "../src/wristband";

const BYTES = Uint8Array.from({ length: 16 }, (_, i) => (i * 17 + 3) & 0xff);

describe("crc16 (CRC-16/CCITT-FALSE)", () => {
  it("matches the published check vector for '123456789'", () => {
    expect(crc16("123456789")).toBe("29B1");
  });
  it("is four upper-case hex digits, zero padded", () => {
    expect(crc16("")).toBe("FFFF");
    expect(crc16("A")).toMatch(/^[0-9A-F]{4}$/);
  });
});

describe("formatWristbandPayload", () => {
  it("renders WXB1.<26 base32>.<4 hex> = 36 chars", () => {
    const p = formatWristbandPayload(BYTES);
    expect(p).toHaveLength(WRISTBAND_PAYLOAD_LENGTH);
    expect(p).toMatch(/^WXB1\.[0-9A-HJKMNP-TV-Z]{26}\.[0-9A-F]{4}$/);
    expect(p.startsWith(`${WRISTBAND_PAYLOAD_VERSION}.`)).toBe(true);
  });
  it("is deterministic and distinguishes different entropy", () => {
    const other = Uint8Array.from(BYTES);
    other[15] = 0xff;
    expect(formatWristbandPayload(BYTES)).toBe(formatWristbandPayload(BYTES));
    expect(formatWristbandPayload(BYTES)).not.toBe(formatWristbandPayload(other));
  });
  it("refuses anything but exactly 16 bytes (128 bits of entropy)", () => {
    expect(() => formatWristbandPayload(new Uint8Array(15))).toThrow();
    expect(() => formatWristbandPayload(new Uint8Array(17))).toThrow();
  });
});

describe("parseWristbandPayload", () => {
  const good = formatWristbandPayload(BYTES);
  it("round-trips and returns the token the digest is taken over (checksum excluded)", () => {
    const r = parseWristbandPayload(good);
    expect(r).toEqual({ ok: true, token: good.slice(0, good.lastIndexOf(".")) });
  });
  it("accepts scanner wedge whitespace and a typed lower-case fallback", () => {
    expect(parseWristbandPayload(`  ${good}\r\n`).ok).toBe(true);
    expect(parseWristbandPayload(good.toLowerCase()).ok).toBe(true);
  });
  it("flags a damaged checksum as bad_checksum, not malformed", () => {
    const bad = `${good.slice(0, -4)}${good.endsWith("0000") ? "0001" : "0000"}`;
    expect(parseWristbandPayload(bad)).toEqual({ ok: false, reason: "bad_checksum" });
  });
  it.each([
    ["empty", ""],
    ["free text (the legacy textbox)", "sha256:patient-a"],
    ["wrong version", good.replace("WXB1", "WXB2")],
    ["too short", good.slice(0, 30)],
    ["too long", `${good}0`],
    ["forbidden Crockford letter U", good.replace(/^(WXB1\.)./, "$1U")],
    ["internal whitespace", `${good.slice(0, 10)} ${good.slice(10)}`],
    ["scanner prefix", `]Q1${good}`],
    ["missing separators", good.replaceAll(".", "")],
  ])("rejects %s as malformed", (_label, raw) => {
    const r = parseWristbandPayload(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("malformed");
  });
});
