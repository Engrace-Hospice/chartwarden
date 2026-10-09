import { describe, expect, it } from "vitest";
import type { IdgMeetingStatus } from "@wardenx/types";
import {
  type IdgMeetingWriteOperation,
  assertMeetingWriteAllowed,
} from "../src/modules/14-idg/routes/meeting-write-policy";

const STATUSES: readonly IdgMeetingStatus[] = [
  "scheduled",
  "packets_building",
  "packets_ready",
  "live",
  "adjourned",
  "cancelled",
  "rescheduled",
];

const allowed = (
  operation: IdgMeetingWriteOperation,
  permitted: readonly IdgMeetingStatus[],
): void => {
  for (const status of STATUSES) {
    if (permitted.includes(status)) {
      expect(() => assertMeetingWriteAllowed(status, operation)).not.toThrow();
    } else {
      expect(() => assertMeetingWriteAllowed(status, operation)).toThrow();
    }
  }
};

describe("IDG child-write policy by meeting phase", () => {
  it("allows preparation/live attendance and agenda edits, then freezes them", () => {
    const phases: readonly IdgMeetingStatus[] = [
      "scheduled",
      "packets_building",
      "packets_ready",
      "live",
    ];
    allowed("attendance", phases);
    allowed("agenda", phases);
  });

  it("allows decisions and action-item creation/removal only while live", () => {
    allowed("decision", ["live"]);
    allowed("action_item_create", ["live"]);
    allowed("action_item_remove", ["live"]);
  });

  it("keeps action-item execution open after adjournment, but not after cancellation/replacement", () => {
    allowed("action_item_follow_up", ["live", "adjourned"]);
  });
});
