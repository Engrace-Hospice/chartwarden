import { describe, expect, it } from "vitest";
import {
  alarmKeyId,
  alarmPayloadDigest,
  alarmSignatureMatches,
  effectiveAlarmSeverity,
  inAlarmReplayWindow,
  newAlarmSecret,
  parseAlarmKeyId,
  signAlarmRequest,
} from "./alarm-ingest-core";

const ORG = "11111111-1111-4111-8111-111111111111";
const SRC = "22222222-2222-4222-8222-222222222222";
const input = (over: Partial<Parameters<typeof signAlarmRequest>[0]> = {}) => ({
  secret: "wxas_secret",
  keyId: alarmKeyId(ORG, SRC),
  timestamp: "1790000000",
  rawBody: '{"eventId":"e1","alarmKind":"bed_exit"}',
  ...over,
});

describe("alarm ingest core", () => {
  it("a signature verifies for the exact secret, key id, timestamp and body, and for nothing else", () => {
    const sig = signAlarmRequest(input());
    expect(alarmSignatureMatches(input(), sig)).toBe(true);
    for (const over of [
      { secret: "wxas_other" },
      { keyId: alarmKeyId(SRC, ORG) },
      { timestamp: "1790000001" },
      { rawBody: '{"eventId":"e2","alarmKind":"bed_exit"}' },
    ]) {
      expect(alarmSignatureMatches(input(over), sig)).toBe(false);
    }
  });

  it("a malformed signature never matches (and never throws)", () => {
    for (const bad of [
      undefined,
      "",
      "v1=",
      "v1=zz",
      "v2=" + "0".repeat(64),
      "0".repeat(64),
      5,
      null,
    ]) {
      expect(alarmSignatureMatches(input(), bad)).toBe(false);
    }
  });

  it("the key id parses only as <uuid>.<uuid>", () => {
    expect(parseAlarmKeyId(alarmKeyId(ORG, SRC))).toEqual({ organizationId: ORG, sourceId: SRC });
    for (const bad of [undefined, "", ORG, `${ORG}.${SRC}.x`, `${ORG}:${SRC}`, "a.b", 7]) {
      expect(parseAlarmKeyId(bad)).toBeNull();
    }
  });

  it("the replay window is +-300 s on epoch seconds and nothing looser", () => {
    const now = 1_790_000_000_000;
    expect(inAlarmReplayWindow("1790000000", now)).toBe(true);
    expect(inAlarmReplayWindow("1789999700", now)).toBe(true);
    expect(inAlarmReplayWindow("1789999699", now)).toBe(false);
    expect(inAlarmReplayWindow("1790000301", now)).toBe(false);
    for (const bad of [
      undefined,
      "",
      "1790000000.5",
      "-1790000000",
      "2026-10-23T00:00:00Z",
      "1790000000000",
      " 1790000000",
    ]) {
      expect(inAlarmReplayWindow(bad, now)).toBe(false);
    }
  });

  it("severity is the request capped at the ceiling: never raised, never critical", () => {
    expect(effectiveAlarmSeverity(undefined, "warn")).toBe("info");
    expect(effectiveAlarmSeverity("info", "warn")).toBe("info");
    expect(effectiveAlarmSeverity("warn", "warn")).toBe("warn");
    expect(effectiveAlarmSeverity("critical", "warn")).toBe("warn");
    expect(effectiveAlarmSeverity("critical", "info")).toBe("info");
    expect(effectiveAlarmSeverity("warn", "info")).toBe("info");
  });

  it("secrets are 256-bit and unique; the digest is a hex sha256", () => {
    const a = newAlarmSecret();
    expect(a).toMatch(/^wxas_[A-Za-z0-9_-]{43}$/);
    expect(newAlarmSecret()).not.toBe(a);
    expect(alarmPayloadDigest("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
