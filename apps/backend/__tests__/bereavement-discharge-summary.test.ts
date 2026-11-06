// apps/backend/__tests__/bereavement-discharge-summary.test.ts — ADR-0109 D9: the pure assembly of the internal discharge summary from
// the rows a closure reads. Offered versus delivered per contact and cadence mark; the assessment checkpoints; unreachable contacts with
// their attempt count and last attempt; opt-out and mailing scope; tier trajectory; the closure facts. The payload has NO field for a
// contact note, a care goal, a risk-factor vector or substance-use data, so the assembly cannot carry one.
import { assertBereavementDischargeSummaryRenderPayload } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type DischargeSummaryRows,
  buildDischargeSummaryPayload,
} from "../src/modules/16-bereavement/render-payloads/discharge-summary";

const D = (iso: string) => new Date(iso);
const PLAN_ANCHOR = D("2025-10-01T00:00:00.000Z");

const rows = (over: Partial<DischargeSummaryRows> = {}): DischargeSummaryRows => ({
  deathDate: "2025-10-01",
  closure: {
    closedAt: D("2026-11-05T08:00:00.000Z"),
    reason: "thirteen_month_completion",
    closeKind: "auto",
  },
  contacts: [
    {
      id: "c1",
      relationship: "spouse",
      status: "active",
      unreachableAt: null,
      createdAt: D("2025-10-01T09:00:00.000Z"),
    },
    {
      id: "c2",
      relationship: "child",
      status: "unreachable",
      unreachableAt: D("2026-01-21T00:00:00.000Z"),
      createdAt: D("2025-10-01T09:05:00.000Z"),
    },
  ],
  outreach: [
    {
      contactId: "c1",
      cadenceMark: "closeout_letter",
      kind: "sympathy_letter",
      anniversaryMark: null,
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2026-10-26T00:00:00.000Z"),
      status: "cancelled",
      completedAt: null,
    },
    {
      contactId: "c1",
      cadenceMark: "condolence_letter",
      kind: "sympathy_letter",
      anniversaryMark: null,
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2025-10-03T00:00:00.000Z"),
      status: "completed",
      completedAt: D("2025-10-03T15:00:00.000Z"),
    },
    {
      contactId: "c1",
      cadenceMark: "initial_outreach",
      kind: "phone_call",
      anniversaryMark: null,
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2025-10-29T00:00:00.000Z"),
      status: "declined",
      completedAt: D("2025-10-29T14:00:00.000Z"),
    },
    {
      contactId: "c1",
      cadenceMark: "three_month",
      kind: "phone_call",
      anniversaryMark: "three_month",
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2025-12-30T00:00:00.000Z"),
      status: "missed",
      completedAt: null,
    },
    {
      contactId: "c1",
      cadenceMark: "six_month",
      kind: "phone_call",
      anniversaryMark: "six_month",
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2026-03-30T00:00:00.000Z"),
      status: "no_response",
      completedAt: null,
    },
    {
      contactId: "c1",
      cadenceMark: "nine_month",
      kind: "phone_call",
      anniversaryMark: "nine_month_high_risk_only",
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2026-06-28T00:00:00.000Z"),
      status: "scheduled",
      completedAt: null,
    },
    // a row written before `cadence_mark` existed: classified by `inferLegacyMark`
    {
      contactId: "c2",
      cadenceMark: null,
      kind: "phone_call",
      anniversaryMark: "three_month",
      deathAnchorAt: PLAN_ANCHOR,
      dueAt: D("2025-12-30T00:00:00.000Z"),
      status: "no_response",
      completedAt: null,
    },
  ],
  tasks: [
    {
      contactId: "c1",
      taskKind: "midpoint_reassessment",
      status: "missed",
      dueAt: D("2026-03-30T00:00:00.000Z"),
      completedAt: null,
    },
    {
      contactId: "c1",
      taskKind: "initial_assessment",
      status: "completed",
      dueAt: D("2025-10-29T00:00:00.000Z"),
      completedAt: D("2025-10-30T10:00:00.000Z"),
    },
  ],
  optOuts: [
    {
      contactId: "c1",
      optOutKind: "no_mailings",
      channelKinds: [],
      optedOutAt: D("2026-02-01T00:00:00.000Z"),
      rescindedAt: null,
    },
    {
      contactId: "c1",
      optOutKind: "channel_specific",
      channelKinds: ["phone_call"],
      optedOutAt: D("2025-11-01T00:00:00.000Z"),
      rescindedAt: D("2025-11-15T00:00:00.000Z"), // history, not scope
    },
  ],
  scores: [
    { contactId: null, assessedAt: D("2025-10-01T09:00:00.000Z"), tier: "low" },
    { contactId: null, assessedAt: D("2025-12-01T09:00:00.000Z"), tier: "low" },
    { contactId: null, assessedAt: D("2026-01-12T09:00:00.000Z"), tier: "moderate" },
    { contactId: "c1", assessedAt: D("2025-10-01T09:00:01.000Z"), tier: "moderate" },
  ],
  failedAttempts: [
    { contactId: "c2", contactAt: D("2025-12-30T17:00:00.000Z") },
    { contactId: "c2", contactAt: D("2026-01-20T17:30:00.000Z") },
    { contactId: "c2", contactAt: D("2026-01-05T17:00:00.000Z") },
  ],
  ...over,
});

describe("buildDischargeSummaryPayload", () => {
  const payload = buildDischargeSummaryPayload(rows());

  it("produces a payload the M22 schema accepts", () => {
    expect(() => assertBereavementDischargeSummaryRenderPayload(payload)).not.toThrow();
  });

  it("states the closure facts", () => {
    expect(payload).toMatchObject({
      deathDate: "2025-10-01",
      closedAt: "2026-11-05T08:00:00.000Z",
      closureReason: "thirteen_month_completion",
      closeKind: "auto",
    });
  });

  it("lists offered versus delivered per contact and cadence mark, in due order", () => {
    const [pat] = payload.contacts;
    expect(pat?.touchpoints.map((t) => [t.cadenceMark, t.status])).toEqual([
      ["condolence_letter", "completed"],
      ["initial_outreach", "declined"],
      ["three_month", "missed"],
      ["six_month", "no_response"],
      ["nine_month", "scheduled"],
      ["closeout_letter", "cancelled"],
    ]);
    expect(pat?.touchpoints[0]).toMatchObject({
      kind: "sympathy_letter",
      dueAt: "2025-10-03T00:00:00.000Z",
      completedAt: "2025-10-03T15:00:00.000Z",
    });
    expect(pat?.touchpoints[2]?.completedAt).toBeNull();
  });

  it("classifies a row with no stored mark through inferLegacyMark", () => {
    expect(payload.contacts[1]?.touchpoints.map((t) => t.cadenceMark)).toEqual(["three_month"]);
  });

  it("totals: delivered is completed or declined, missed includes unanswered, outstanding is scheduled or in progress", () => {
    expect(payload.totals).toEqual({
      offered: 7,
      delivered: 2,
      missed: 3,
      cancelled: 1,
      outstanding: 1,
    });
  });

  it("states the checkpoints done and missed, in due order", () => {
    expect(payload.contacts[0]?.assessmentTasks.map((t) => [t.taskKind, t.status])).toEqual([
      ["initial_assessment", "completed"],
      ["midpoint_reassessment", "missed"],
    ]);
  });

  it("states an unreachable contact's attempt count and the LAST attempt, whatever order the log arrives in", () => {
    expect(payload.contacts[0]?.unreachable).toBeNull();
    expect(payload.contacts[1]?.unreachable).toEqual({
      attemptCount: 3,
      lastAttemptAt: "2026-01-20T17:30:00.000Z",
      markedUnreachableAt: "2026-01-21T00:00:00.000Z",
    });
  });

  it("states OPEN opt-outs only, and mailings stopped only by an open no_mailings", () => {
    expect(payload.contacts[0]?.optOuts).toEqual([
      { optOutKind: "no_mailings", channelKinds: [], optedOutAt: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(payload.contacts[0]?.mailingsAllowed).toBe(false);
    expect(payload.contacts[1]?.mailingsAllowed).toBe(true);
  });

  it("collapses the tier trajectory to its changes, plan-level and per contact", () => {
    expect(payload.planTierTrajectory).toEqual([
      { at: "2025-10-01T09:00:00.000Z", tier: "low" },
      { at: "2026-01-12T09:00:00.000Z", tier: "moderate" },
    ]);
    expect(payload.contacts[0]?.tierTrajectory).toEqual([
      { at: "2025-10-01T09:00:01.000Z", tier: "moderate" },
    ]);
    expect(payload.contacts[1]?.tierTrajectory).toEqual([]);
  });

  it("names the contact and relationship and nothing else about them (no channels, no notes, no goals)", () => {
    const keys = Object.keys(payload.contacts[0] ?? {}).sort();
    expect(keys).toEqual(
      [
        "assessmentTasks",
        "label",
        "mailingsAllowed",
        "optOuts",
        "relationship",
        "status",
        "tierTrajectory",
        "touchpoints",
        "unreachable",
      ].sort(),
    );
  });

  it("an empty roster is a valid summary with zero totals", () => {
    const empty = buildDischargeSummaryPayload(
      rows({ contacts: [], outreach: [], tasks: [], optOuts: [], scores: [], failedAttempts: [] }),
    );
    expect(empty.contacts).toEqual([]);
    expect(empty.totals).toEqual({
      offered: 0,
      delivered: 0,
      missed: 0,
      cancelled: 0,
      outstanding: 0,
    });
    expect(() => assertBereavementDischargeSummaryRenderPayload(empty)).not.toThrow();
  });
});
