import {
  type AlertNewEvent,
  MESSAGING_SERVER_EVENTS,
  type MessageNewEvent,
  accountRoom,
  careTeamRoom,
  computeRoomSet,
  fieldSafetyRoom,
  orgRoom,
  userRoom,
} from "@chartwarden/messaging";
// M36-T08 — Socket.IO room-set computation + event-contract invariants (M36 spec §4.3, §7.9).
//
// Accept: `computeRoomSet` is pure (sorted, de-duplicated), every user joins user+org, channel
// rooms are EARNED per membership/role, a null-subject channel contributes no cross-patient room,
// and the sanitized event types keep PHI optional (`message.new.bodyPreview`) / sanitizer-only
// (`alert.new.summary`) per §4.3.
import { describe, expect, it } from "vitest";

const ORG = "org_a";

describe("M36-T08 computeRoomSet (§4.3)", () => {
  it("every authenticated user joins user + org, even with no memberships", () => {
    expect(computeRoomSet({ userId: "u1", orgId: ORG, channels: [] })).toEqual([
      accountRoom("u1"),
      orgRoom(ORG),
      userRoom(ORG, "u1"),
    ]);
  });

  it("scopes the personal room to the org, so one person's two orgs never share a room", () => {
    expect(userRoom("org_a", "u1")).not.toBe(userRoom("org_b", "u1"));
    expect(computeRoomSet({ userId: "u1", orgId: "org_b", channels: [] })).not.toContain(
      userRoom("org_a", "u1"),
    );
  });

  it("derives subject-backed channel rooms by kind", () => {
    const rooms = computeRoomSet({
      userId: "rn_1",
      orgId: ORG,
      channels: [
        { channelId: "c1", kind: "care_team", subjectId: "patient_x" },
        { channelId: "c2", kind: "location", subjectId: "loc_1" },
        { channelId: "c3", kind: "discipline", subjectId: "rn" },
      ],
    });
    expect(rooms).toContain(careTeamRoom("patient_x"));
    expect(rooms).toContain("location:loc_1");
    expect(rooms).toContain(`discipline:${ORG}:rn`);
  });

  it("never builds a channel room for a null-subject (DM/announcement) channel", () => {
    const rooms = computeRoomSet({
      userId: "u1",
      orgId: ORG,
      channels: [
        { channelId: "dm1", kind: "dm", subjectId: null },
        { channelId: "an1", kind: "announcement", subjectId: null },
      ],
    });
    expect(rooms).toEqual([accountRoom("u1"), orgRoom(ORG), userRoom(ORG, "u1")]);
  });

  it("joins role/assignment rooms (on-call, billing, field-safety supervisor, IDG)", () => {
    const rooms = computeRoomSet({
      userId: "sup_1",
      orgId: ORG,
      channels: [],
      onCallProviderEntityIds: ["pe_1"],
      billingProviderEntityIds: ["pe_2"],
      defaultLocationIds: ["loc_9"],
      isFieldSafetySupervisor: true,
      isIdgAttendee: true,
    });
    expect(rooms).toContain("oncall:pe_1");
    expect(rooms).toContain("billing:pe_2");
    expect(rooms).toContain(fieldSafetyRoom(ORG));
    expect(rooms).toContain("location:loc_9");
    expect(rooms).toContain("idg:loc_9");
  });

  it("is pure: sorted, de-duplicated, deterministic across runs", () => {
    const input = {
      userId: "u1",
      orgId: ORG,
      channels: [
        { channelId: "c1", kind: "location" as const, subjectId: "loc_1" },
        { channelId: "c2", kind: "location" as const, subjectId: "loc_1" }, // duplicate room
      ],
      defaultLocationIds: ["loc_1"], // also yields location:loc_1
    };
    const a = computeRoomSet(input);
    const b = computeRoomSet(input);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    expect(a.filter((r) => r === "location:loc_1")).toHaveLength(1);
  });
});

describe("M36-T08 event contract (§4.3)", () => {
  it("message.new carries no body when the recipient is unentitled (bodyPreview optional)", () => {
    const unentitled: MessageNewEvent = {
      correlationId: "corr_1",
      messageId: "m1",
      channelId: "c1",
      channelKind: "care_team",
      authorUserId: "rn_1",
      createdAt: "2026-06-15T12:00:00Z",
      hasAttachments: false,
    };
    expect(unentitled.bodyPreview).toBeUndefined();
  });

  it("alert.new.summary is the sanitizer output (PHI-free by construction)", () => {
    const alert: AlertNewEvent = {
      correlationId: "corr_2",
      alertId: "a1",
      eventType: "visit.late",
      category: "operational",
      severity: "warn",
      summary: "A scheduled visit is running late.",
      deepLink: "/alerts/a1",
    };
    expect(alert.summary).not.toMatch(/patient|mrn|dob/i);
    expect(MESSAGING_SERVER_EVENTS.alertNew).toBe("alert.new");
  });
});
