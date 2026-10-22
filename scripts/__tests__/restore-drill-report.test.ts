import { describe, expect, it } from "vitest";
import {
  type AttachmentExpectation,
  type ObjectFingerprint,
  type ReconcileFindings,
  compareCounts,
  compareObjects,
  objectId,
  parseRtoTargetMs,
  reconcileCheck,
  requireApplied,
  rtoCheck,
} from "../lib/restore-drill/report";

const row = (over: Partial<AttachmentExpectation> = {}): AttachmentExpectation => ({
  id: "att-1",
  bucket: "tenant-a",
  objectKey: "messaging/c/att-1",
  byteSize: 10,
  sha256Hex: "aa",
  completed: true,
  destroyed: false,
  ...over,
});
const good: ObjectFingerprint = { size: 10, sha256: "aa", etag: '"e1"' };
const id = objectId("tenant-a", "messaging/c/att-1");
const restored = (fp: ReadonlyMap<string, ObjectFingerprint>, stored: string[] = [id]) => ({
  fingerprints: fp,
  stored: new Set(stored),
});

describe("restore drill verdicts", () => {
  it("passes a restore whose objects match the rows and the backup manifest", () => {
    const checks = compareObjects([row()], new Map([[id, good]]), restored(new Map([[id, good]])));
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("fails when an object is missing", () => {
    const [objects] = compareObjects([row()], new Map([[id, good]]), restored(new Map(), []));
    expect(objects?.ok).toBe(false);
    expect(objects?.detail).toContain("MISSING");
  });

  it("fails on same-size different bytes (sha256) and on an etag drift", () => {
    const flipped = { ...good, sha256: "bb" };
    expect(
      compareObjects([row()], new Map([[id, good]]), restored(new Map([[id, flipped]])))[0]?.ok,
    ).toBe(false);
    const etagDrift = { ...good, etag: '"e2"' };
    expect(
      compareObjects([row()], new Map([[id, good]]), restored(new Map([[id, etagDrift]])))[0]?.ok,
    ).toBe(false);
  });

  it("fails when a destroyed row still has an object, and when an unreferenced object exists", () => {
    const checks = compareObjects(
      [row({ destroyed: true })],
      new Map(),
      restored(new Map([[id, good]]), [id, "tenant-a/stray"]),
    );
    expect(checks[1]?.ok).toBe(false);
    expect(checks[2]?.ok).toBe(false);
    expect(checks[2]?.detail).toContain("tenant-a/stray");
  });

  it("does not owe an object to an upload that never completed", () => {
    const [objects] = compareObjects(
      [row({ completed: false })],
      new Map(),
      restored(new Map(), []),
    );
    expect(objects?.ok).toBe(true);
  });

  it("compareCounts names the table that lost rows", () => {
    const check = compareCounts({ message: 5, channel: 2 }, { message: 4, channel: 2 });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("message: backup 5 != restored 4");
  });
});

const clean: ReconcileFindings = {
  messagesWithoutAudit: [],
  revisionsWithoutAudit: [],
  attachmentsWithoutAudit: [],
  attachmentsWithoutMessage: [],
  attachmentsCrossOrg: [],
  orphanAudit: [],
};

describe("restore drill reconcile and RTO verdicts", () => {
  it("passes a restored DB where message, attachment and audit agree", () => {
    expect(reconcileCheck(clean).ok).toBe(true);
  });

  it.each([
    ["messagesWithoutAudit", "messages with no message.insert audit event"],
    ["revisionsWithoutAudit", "message_revisions with no audit event"],
    ["attachmentsWithoutAudit", "attachments with no message_attachment.insert audit event"],
    ["attachmentsWithoutMessage", "attachments whose message row is missing"],
    ["attachmentsCrossOrg", "attachments in a different org than their message"],
    ["orphanAudit", "orphan audit events"],
  ] as const)("fails and names the problem when %s is non-empty", (key, label) => {
    const check = reconcileCheck({ ...clean, [key]: ["id-1", "id-2"] });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(label);
    expect(check.detail).toContain("id-1");
  });

  it("truncates long id lists but keeps the count", () => {
    const check = reconcileCheck({ ...clean, orphanAudit: ["a", "b", "c", "d", "e"] });
    expect(check.detail).toContain("5 (a, b, c, ...)");
  });

  it("rtoCheck passes at or under the target and fails over it", () => {
    expect(rtoCheck(12_500, 3_600_000).ok).toBe(true);
    expect(rtoCheck(3_600_000, 3_600_000).ok).toBe(true);
    expect(rtoCheck(3_600_001, 3_600_000).ok).toBe(false);
  });
});

describe("restore drill guards", () => {
  it("requireApplied throws when a fault changed no rows", () => {
    expect(() => requireApplied(0, "message-deleted")).toThrow(
      /fault did not apply: message-deleted/,
    );
    expect(() => requireApplied(null, "x")).toThrow(/fault did not apply/);
    expect(() => requireApplied(1, "x")).not.toThrow();
  });

  it("parseRtoTargetMs defaults to 1 h and accepts a positive number", () => {
    expect(parseRtoTargetMs(undefined)).toBe(3_600_000);
    expect(parseRtoTargetMs("")).toBe(3_600_000);
    expect(parseRtoTargetMs("90")).toBe(90_000);
  });

  it.each(["abc", "0", "-5", "Infinity", "NaN"])("parseRtoTargetMs rejects %s", (raw) => {
    expect(() => parseRtoTargetMs(raw)).toThrow(/WX_DRILL_RTO_TARGET_S must be a positive number/);
  });
});
