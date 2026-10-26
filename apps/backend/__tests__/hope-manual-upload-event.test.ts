// "Mark uploaded" emitted `{submissionId, transportMode, submittedAt}`, which the catalog schema for
// `m10.hope.submission_transmitted` refuses (it requires transmittedAt + envelopeSha256), so the route
// 500'd against a real publisher. The in-memory slice never validated the payload, which is why this was
// invisible: assert the payload against the REAL catalog schema.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/events-by-m10";
import {
  manualUploadTransmittedPayload,
  settledBatchEvent,
} from "../src/modules/10-hope/hope-submission-result";

const schemaOf = (name: string) =>
  M10_OUTBOX_EVENTS.find((e) => e.eventName === name)?.payloadSchema;
const schema = schemaOf("m10.hope.submission_transmitted");

describe("manual iQIES upload event payload", () => {
  it("satisfies the catalog schema for m10.hope.submission_transmitted", () => {
    const payload = manualUploadTransmittedPayload("sub-1", "ab".repeat(32), new Date());
    expect(schema).toBeDefined();
    expect(Value.Check(schema as never, payload)).toBe(true);
  });

  it("refuses to emit without a package hash", () => {
    expect(() => manualUploadTransmittedPayload("sub-1", null, new Date())).toThrow(/package hash/);
  });
});

describe("settled batch event payloads", () => {
  it("accepted satisfies the catalog schema", () => {
    const { eventName, payload } = settledBatchEvent(
      "sub-1",
      "pe-1",
      { acceptedCount: 2, rejectedCount: 0 },
      [],
    );
    expect(eventName).toBe("m10.hope.submission_accepted");
    expect(Value.Check(schemaOf(eventName) as never, payload)).toBe(true);
  });

  it("rejected satisfies the catalog schema and groups findings by CMS code", () => {
    const { eventName, payload } = settledBatchEvent(
      "sub-1",
      "pe-1",
      { acceptedCount: 0, rejectedCount: 3 },
      [
        { assessmentId: "a", status: "rejected", code: "-3027" },
        { assessmentId: "b", status: "rejected", code: "-3027" },
        { assessmentId: "c", status: "rejected", itemCode: "A0800" },
      ],
    );
    expect(eventName).toBe("m10.hope.submission_rejected");
    expect(Value.Check(schemaOf(eventName) as never, payload)).toBe(true);
    expect(payload).toMatchObject({
      findings: [
        { ruleId: "-3027", count: 2 },
        { ruleId: "A0800", count: 1 },
      ],
    });
  });

  it("rejected with no rejected rows in this report still reports the batch's rejections", () => {
    const { eventName, payload } = settledBatchEvent(
      "sub-1",
      "pe-1",
      { acceptedCount: 1, rejectedCount: 1 },
      [{ assessmentId: "a", status: "accepted" }],
    );
    expect(Value.Check(schemaOf(eventName) as never, payload)).toBe(true);
  });
});
