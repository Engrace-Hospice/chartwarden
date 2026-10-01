// F-181 (#248) — `selectOutboundFeed`, the pure routing + MSH-identity rules of the outbound feed resolver.
import { describe, expect, it } from "vitest";
import {
  OUTBOUND_SENDING_APPLICATION,
  type OutboundFeedCandidateRow,
  selectOutboundFeed,
} from "../outbound/feed-resolver";

const ORG = "11111111-1111-1111-1111-111111111111";
const FX = "44444444-4444-4444-4444-444444444444";
const FY = "55555555-5555-5555-5555-555555555555";
const NOW = new Date("2026-09-29T12:00:00Z");

function feed(id: string, over: Partial<OutboundFeedCandidateRow> = {}): OutboundFeedCandidateRow {
  return {
    id,
    organizationId: ORG,
    host: "lab.example",
    port: 6000,
    protocol: "mllp_tls",
    channelCertPin: "a".repeat(64),
    rateLimitMsgPerSec: 50,
    inFlightLeaseSeconds: null,
    activeFrom: null,
    activeThrough: null,
    labDestinationFacilityId: null,
    mshSendingApplication: null,
    mshSendingFacility: "HOSPICE",
    mshReceivingApplication: "LAB-LIS",
    mshReceivingFacility: "LAB-MAIN",
    ...over,
  };
}

describe("selectOutboundFeed — routing", () => {
  it("routes to the feed linked to the requested facility, ignoring a sibling", () => {
    const r = selectOutboundFeed(
      [feed("a", { labDestinationFacilityId: FX }), feed("b", { labDestinationFacilityId: FY })],
      NOW,
      FY,
    );
    expect(r).toMatchObject({ kind: "resolved", feed: { id: "b" } });
  });

  it("two feeds linked to the SAME facility is ambiguous, never a silent pick", () => {
    const r = selectOutboundFeed(
      [feed("a", { labDestinationFacilityId: FX }), feed("b", { labDestinationFacilityId: FX })],
      NOW,
      FX,
    );
    expect(r).toEqual({
      kind: "unresolved",
      reason: "ambiguous_feed",
      candidateFeedIds: ["a", "b"],
    });
  });

  it("single-feed fallback: exactly one feed whose link is absent serves any (or no) destination", () => {
    expect(selectOutboundFeed([feed("a")], NOW, FX)).toMatchObject({
      kind: "resolved",
      feed: { id: "a" },
    });
    expect(selectOutboundFeed([feed("a")], NOW, null)).toMatchObject({
      kind: "resolved",
      feed: { id: "a" },
    });
  });

  it("no fallback for a single feed linked to a DIFFERENT facility", () => {
    const r = selectOutboundFeed([feed("a", { labDestinationFacilityId: FY })], NOW, FX);
    expect(r).toEqual({
      kind: "unresolved",
      reason: "no_feed_for_destination",
      candidateFeedIds: ["a"],
    });
  });

  it("no fallback when the request names no facility and the only feed is linked elsewhere", () => {
    const r = selectOutboundFeed([feed("a", { labDestinationFacilityId: FY })], NOW, null);
    expect(r).toMatchObject({ kind: "unresolved", reason: "no_feed_for_destination" });
  });

  it("no fallback across several feeds when none matches: ambiguous", () => {
    const r = selectOutboundFeed([feed("a"), feed("b")], NOW, FX);
    expect(r).toMatchObject({ kind: "unresolved", reason: "ambiguous_feed" });
  });

  it("no feeds, an expired/not-yet-active window, or a hostless row is no_active_feed", () => {
    expect(selectOutboundFeed([], NOW, FX)).toEqual({
      kind: "unresolved",
      reason: "no_active_feed",
    });
    expect(
      selectOutboundFeed([feed("a", { activeThrough: new Date("2026-01-01") })], NOW, null),
    ).toMatchObject({ reason: "no_active_feed" });
    expect(
      selectOutboundFeed([feed("a", { activeFrom: new Date("2027-01-01") })], NOW, null),
    ).toMatchObject({ reason: "no_active_feed" });
    expect(selectOutboundFeed([feed("a", { host: null })], NOW, null)).toMatchObject({
      reason: "no_active_feed",
    });
  });
});

describe("selectOutboundFeed — MSH identity", () => {
  it("uses the configured columns; MSH-3 defaults to the fixed platform identity", () => {
    const r = selectOutboundFeed([feed("a")], NOW, null);
    expect(r).toMatchObject({
      kind: "resolved",
      feed: {
        endpoint: {
          sendingApplication: OUTBOUND_SENDING_APPLICATION,
          sendingFacility: "HOSPICE",
          receivingApplication: "LAB-LIS",
          receivingFacility: "LAB-MAIN",
        },
      },
    });
    const overridden = selectOutboundFeed(
      [feed("a", { mshSendingApplication: "EHR-X" })],
      NOW,
      null,
    );
    expect(overridden).toMatchObject({ feed: { endpoint: { sendingApplication: "EHR-X" } } });
  });

  it("refuses (names FIELDS only) instead of falling back to any display name", () => {
    const r = selectOutboundFeed(
      [feed("a", { mshSendingFacility: null, mshReceivingFacility: null })],
      NOW,
      null,
    );
    expect(r).toEqual({
      kind: "unresolved",
      reason: "feed_identity_incomplete",
      feedId: "a",
      missingFields: ["mshSendingFacility", "mshReceivingFacility"],
    });
  });
});
