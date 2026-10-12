import { describe, expect, it } from "vitest";
import {
  type AttachmentExpectation,
  type ObjectFingerprint,
  compareCounts,
  compareObjects,
  objectId,
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
