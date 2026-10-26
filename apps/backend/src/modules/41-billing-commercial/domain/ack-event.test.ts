import { describe, expect, it } from "vitest";
import { validateAckEvent } from "./ack-event";

const GOOD = {
  eventId: "evt-1",
  controlNumber: "260401-abc123",
  stage: "payer",
  disposition: "accepted",
  reasonCodes: ["A7:158", "STC.1"],
  occurredAt: "2026-10-25T12:00:00.000Z",
  payerClaimNumber: "ICN-77/1",
};

const withField = (patch: Record<string, unknown>) => ({ ...GOOD, ...patch });
const rejects = (raw: unknown, reason: RegExp) => {
  const v = validateAckEvent(raw);
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.reason).toMatch(reason);
};

describe("validateAckEvent", () => {
  it("accepts a well-formed event and rebuilds it from the known keys only", () => {
    const v = validateAckEvent({ ...GOOD, extra: "dropped", __proto_like: { x: 1 } });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(v.event).sort()).toEqual(
      [
        "controlNumber",
        "disposition",
        "eventId",
        "occurredAt",
        "payerClaimNumber",
        "reasonCodes",
        "stage",
      ].sort(),
    );
    expect(v.event.occurredAt?.toISOString()).toBe("2026-10-25T12:00:00.000Z");
  });

  it("accepts a bare ISO day, a missing time and no payer claim number", () => {
    const v = validateAckEvent(
      withField({ occurredAt: "2026-10-25", payerClaimNumber: undefined }),
    );
    expect(v.ok).toBe(true);
    const none = validateAckEvent(withField({ occurredAt: undefined }));
    expect(none.ok && none.event.occurredAt).toBeNull();
  });

  it.each([null, undefined, 7, "event", [GOOD]])("rejects a non-object (%j)", (raw) => {
    rejects(raw, /not an object/);
  });

  it.each([
    ["missing eventId", { eventId: undefined }],
    ["empty eventId", { eventId: "" }],
    ["numeric eventId", { eventId: 5 }],
    ["NUL in eventId", { eventId: "a\u0000b" }],
    ["oversized eventId", { eventId: "x".repeat(257) }],
  ])("rejects %s", (_n, patch) => {
    rejects(withField(patch), /eventId/);
  });

  it.each([
    ["missing", { controlNumber: undefined }],
    ["empty", { controlNumber: "" }],
    ["number", { controlNumber: 42 }],
    ["NUL", { controlNumber: "abc\u0000" }],
    ["spaces", { controlNumber: "a b" }],
    ["oversized", { controlNumber: "A".repeat(65) }],
  ])("rejects a %s controlNumber", (_n, patch) => {
    rejects(withField(patch), /controlNumber/);
  });

  it.each([
    [{ stage: "vendor" }, /stage/],
    [{ stage: undefined }, /stage/],
    [{ disposition: "maybe" }, /disposition/],
    [{ disposition: 1 }, /disposition/],
    [{ stage: "clearinghouse", disposition: "partial" }, /payer-stage only/],
  ])("rejects an unknown stage or disposition (%j)", (patch, reason) => {
    rejects(withField(patch), reason);
  });

  it.each([
    ["not an array", { reasonCodes: "A7" }],
    ["null", { reasonCodes: null }],
    ["a non-string code", { reasonCodes: [7] }],
    ["an empty code", { reasonCodes: [""] }],
    ["a code with a space", { reasonCodes: ["bad code"] }],
    ["a code with a NUL", { reasonCodes: ["A\u0000"] }],
    ["a free-text code", { reasonCodes: ["patient John Doe refused"] }],
    ["an oversized code", { reasonCodes: ["A".repeat(65)] }],
    ["more than 50 codes", { reasonCodes: Array.from({ length: 51 }, (_, i) => `C${i}`) }],
  ])("rejects reasonCodes that are %s", (_n, patch) => {
    rejects(withField(patch), /reason/i);
  });

  it.each([
    ["not a string", { occurredAt: 20261025 }],
    ["free text", { occurredAt: "yesterday" }],
    ["a non-existent day", { occurredAt: "2026-13-45T00:00:00Z" }],
    ["a NUL", { occurredAt: "2026-10-25T00:00:00Z\u0000" }],
    ["a date with no zone", { occurredAt: "2026-10-25T12:00:00" }],
  ])("rejects an occurredAt that is %s", (_n, patch) => {
    rejects(withField(patch), /occurredAt/);
  });

  it.each([
    ["a number", { payerClaimNumber: 5 }],
    ["with a space", { payerClaimNumber: "ICN 1" }],
    ["with a NUL", { payerClaimNumber: "ICN\u0000" }],
    ["oversized", { payerClaimNumber: "I".repeat(129) }],
  ])("rejects a payerClaimNumber %s", (_n, patch) => {
    rejects(withField(patch), /payerClaimNumber/);
  });

  it("hands the caller a usable id and control number for storage when only another field is bad", () => {
    const v = validateAckEvent(withField({ stage: "bogus" }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.eventId).toBe("evt-1");
    expect(v.controlNumber).toBe("260401-abc123");
    const noId = validateAckEvent(withField({ eventId: 9 }));
    expect(noId.ok === false && noId.eventId).toBeNull();
  });
});
