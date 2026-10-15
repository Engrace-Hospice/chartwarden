// WP 3.8 - the pure lifecycle-review rules: cause mapping, trigger reference, close mapping, allowed actions, the PHI-free
// correlation key.
import { REVIEW_CAUSES, TASK_CLOSE_REASONS, type TaskCloseReason } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import {
  REVIEW_LIST_DEFAULT,
  REVIEW_LIST_MAX,
  REVIEW_QUEUE_BATCH,
  allowedReviewActions,
  closeActionForReason,
  lifecycleCause,
  reviewCorrelationKey,
  triggerRefFor,
} from "../src/review";

const PATIENT = "00000000-0000-4000-8000-0000000000e1";
const ADMISSION = "00000000-0000-4000-8000-0000000000a9";

describe("lifecycleCause", () => {
  it("maps an M5 death record to death", () => {
    expect(lifecycleCause("m5.patient.deceased", undefined)).toBe("death");
  });
  it("maps an M6 discharge with reason death to death", () => {
    expect(lifecycleCause("m6.admission.discharged", "death")).toBe("death");
  });
  it("maps reason transfer to transfer", () => {
    expect(lifecycleCause("m6.admission.discharged", "transfer")).toBe("transfer");
  });
  it.each(["revocation", "for_cause", "moved_out_of_service_area", "no_longer_terminal", "other"])(
    "maps the M6 reason %s to discharge",
    (reason) => {
      expect(lifecycleCause("m6.admission.discharged", reason)).toBe("discharge");
    },
  );
  it("returns null for an event it does not review", () => {
    expect(lifecycleCause("m6.admission.activated", "death")).toBeNull();
  });
});

describe("triggerRefFor", () => {
  it("uses the patient id for death so the M6 and M5 copies converge", () => {
    expect(triggerRefFor("death", { patientId: PATIENT, admissionId: ADMISSION })).toBe(PATIENT);
    expect(triggerRefFor("death", { patientId: PATIENT })).toBe(PATIENT);
  });
  it.each(["discharge", "transfer"] as const)("uses the admission id for %s", (cause) => {
    expect(triggerRefFor(cause, { patientId: PATIENT, admissionId: ADMISSION })).toBe(ADMISSION);
  });
  it("is null when a discharge has no admission", () => {
    expect(triggerRefFor("discharge", { patientId: PATIENT })).toBeNull();
  });
});

describe("closeActionForReason", () => {
  it.each([
    ["action_taken", "complete"],
    ["handled_elsewhere", "complete"],
    ["no_action_needed", "cancel"],
    ["unable_to_complete", "cancel"],
    ["duplicate", "cancel"],
  ] as const)("maps %s to %s", (reason, action) => {
    expect(closeActionForReason(reason)).toBe(action);
  });
  it("covers every close reason", () => {
    for (const r of TASK_CLOSE_REASONS) {
      expect(["complete", "cancel"]).toContain(closeActionForReason(r as TaskCloseReason));
    }
  });
});

describe("allowedReviewActions", () => {
  it("offers both actions on an open, visible row with an active task", () => {
    expect(
      allowedReviewActions({ state: "open" }, { restricted: false, taskActive: true }),
    ).toEqual(["reassign", "close"]);
  });
  it.each([
    [{ state: "resolved" as const }, { restricted: false, taskActive: true }],
    [{ state: "open" as const }, { restricted: true, taskActive: true }],
    [{ state: "open" as const }, { restricted: false, taskActive: false }],
  ])("offers nothing for %j %j", (item, ctx) => {
    expect(allowedReviewActions(item, ctx)).toEqual([]);
  });
});

describe("reviewCorrelationKey", () => {
  it("is 32 hex chars, stable, and carries neither id", () => {
    const key = reviewCorrelationKey("patient_lifecycle", PATIENT);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(reviewCorrelationKey("patient_lifecycle", PATIENT)).toBe(key);
    expect(key).not.toContain(PATIENT.slice(0, 8));
  });
  it("differs by source and by trigger", () => {
    const a = reviewCorrelationKey("patient_lifecycle", PATIENT);
    expect(reviewCorrelationKey("care_team_change", PATIENT)).not.toBe(a);
    expect(reviewCorrelationKey("patient_lifecycle", ADMISSION)).not.toBe(a);
  });
});

describe("constants", () => {
  it("keeps the list bounds sane and every cause known", () => {
    expect(REVIEW_LIST_DEFAULT).toBeLessThanOrEqual(REVIEW_LIST_MAX);
    expect(REVIEW_QUEUE_BATCH).toBeGreaterThan(0);
    expect(REVIEW_CAUSES).toContain("death");
  });
});
