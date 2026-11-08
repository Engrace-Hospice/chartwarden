import { describe, expect, it } from "vitest";
import {
  MASS_DELETE_FLOOR,
  alertBody,
  assertScheduleEnv,
  massDeleteRefusal,
  xmlUnescape,
} from "../object-store-copy";

describe("object-store copy", () => {
  it("unescapes a SeaweedFS continuation token (the raw last key, XML-escaped)", () => {
    expect(xmlUnescape("a&amp;b=c#d?e&lt;&gt;&quot;&apos;&#38;&#x26;")).toBe(`a&b=c#d?e<>"'&&`);
    expect(xmlUnescape("&bogus;")).toBe("&bogus;");
  });

  it("refuses to empty a copy from an empty source, and caps deletions", () => {
    expect(massDeleteRefusal(0, 1003, 1003)).toMatch(/source bucket is empty/);
    expect(massDeleteRefusal(900, 1000, 100)).toBeNull();
    expect(massDeleteRefusal(899, 1000, 101)).toMatch(/101 of 1000/);
    expect(massDeleteRefusal(5, 5 + MASS_DELETE_FLOOR, MASS_DELETE_FLOOR)).toBeNull();
    expect(massDeleteRefusal(0, 0, 0)).toBeNull();
  });
});

describe("scheduled second copy", () => {
  const ok = {
    OPS_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
    TARGET_S3_ENDPOINT: "https://replica.example.test",
  };

  it("refuses to run without an https pager or with a plaintext cross-host target", () => {
    expect(() => assertScheduleEnv(ok)).not.toThrow();
    expect(() => assertScheduleEnv({ ...ok, OPS_ALERT_WEBHOOK_URL: undefined })).toThrow(/https/);
    expect(() =>
      assertScheduleEnv({ ...ok, OPS_ALERT_WEBHOOK_URL: "http://alerts.example.test" }),
    ).toThrow(/OPS_ALERT_WEBHOOK_URL/);
    expect(() => assertScheduleEnv({ ...ok, TARGET_S3_ENDPOINT: "http://10.0.0.2:9000" })).toThrow(
      /TARGET_S3_ENDPOINT/,
    );
    expect(() =>
      assertScheduleEnv({
        ...ok,
        TARGET_S3_ENDPOINT: "http://10.0.0.2:9000",
        OBJECT_COPY_ALLOW_PLAINTEXT_TARGET: "1",
      }),
    ).not.toThrow();
  });

  it("alerts with counts and a bounded failure sample, never more", () => {
    const failed = Array.from({ length: 30 }, (_, i) => ({
      bucket: "tenant-x",
      key: `documents/${i}`,
      reason: "HTTP 500",
    }));
    const body = JSON.parse(
      alertBody(
        { buckets: 3, copied: 1, unchanged: 2, deleted: 0, failed },
        null,
        new Date("2026-11-05T00:00:00Z"),
      ),
    );
    expect(body).toMatchObject({
      kind: "object_copy.failed",
      occurredAt: "2026-11-05T00:00:00.000Z",
    });
    expect(body.summary).toMatch(/30 failure\(s\) over 3 bucket/);
    expect(body.details.failed).toHaveLength(20);
    expect(
      JSON.parse(alertBody(null, new Error("ListBuckets answered HTTP 403"), new Date())).summary,
    ).toMatch(/aborted: ListBuckets answered HTTP 403/);
  });
});
