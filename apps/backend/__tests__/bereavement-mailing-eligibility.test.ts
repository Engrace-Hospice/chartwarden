// apps/backend/__tests__/bereavement-mailing-eligibility.test.ts — ADR-0109 D10: `decideMailingEligibility`, the pure rule that picks (and at
// confirm-mailed RE-picks) who a mailing goes to. It reads the contact's opt-out ROWS, not the contact's status.
import { BEREAVEMENT_MAILING_EXCLUSION_REASONS } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type MailingEligibilityFacts,
  decideMailingEligibility,
  preferredMailingChannel,
} from "../src/modules/16-bereavement/mailings/eligibility";

const FACTS: MailingEligibilityFacts = {
  planStatus: "active",
  contactStatus: "active",
  relationship: "spouse",
  openOptOuts: [],
  allowedKinds: undefined,
  hasMailingAddress: true,
  hasEmailAddress: false,
  audience: null,
  emailChannelAvailable: false,
};
const decide = (over: Partial<MailingEligibilityFacts>) =>
  decideMailingEligibility({ ...FACTS, ...over });
const reason = (over: Partial<MailingEligibilityFacts>) => {
  const d = decide(over);
  return d.eligible ? "eligible" : d.reason;
};

describe("decideMailingEligibility: who is written to", () => {
  it("an active contact of an active plan with a stored address gets the mailing by post", () => {
    expect(decide({})).toEqual({ eligible: true, channel: "postal" });
  });

  it("the plan must be active (a paused or closed plan sends nothing)", () => {
    for (const planStatus of [
      "eligible",
      "initiating",
      "paused",
      "closed_completed",
      "closed_early",
    ] as const) {
      expect(reason({ planStatus })).toBe("plan_not_active");
    }
  });

  it("a contact the program does not write to is excluded: unconfirmed, deceased, or referred out", () => {
    for (const contactStatus of ["proposed", "deceased", "ineligible_post_review"] as const) {
      expect(reason({ contactStatus })).toBe("contact_not_engageable");
    }
    // unreachable by phone is still reachable by post
    expect(reason({ contactStatus: "unreachable" })).toBe("eligible");
  });

  it("only the contact's own relationship passes a narrowed audience", () => {
    expect(reason({ audience: ["spouse", "child"] })).toBe("eligible");
    expect(reason({ audience: ["parent"] })).toBe("not_in_audience");
    expect(reason({ audience: [] })).toBe("not_in_audience");
  });
});

describe("decideMailingEligibility: opt-out ROWS decide, not the contact status", () => {
  it("a full opt-out blocks", () => {
    expect(
      reason({
        contactStatus: "opted_out",
        openOptOuts: [{ optOutKind: "full", channelKinds: null }],
      }),
    ).toBe("opted_out");
  });

  it("a temporary pause blocks", () => {
    expect(reason({ openOptOuts: [{ optOutKind: "pause_temporarily", channelKinds: null }] })).toBe(
      "opted_out",
    );
  });

  it("no_mailings blocks while the contact stays active (calls continue)", () => {
    expect(
      reason({
        contactStatus: "active",
        openOptOuts: [{ optOutKind: "no_mailings", channelKinds: null }],
      }),
    ).toBe("no_mailings");
  });

  it("no_mailings wins over a channel-specific row (the broader refusal is the one reported)", () => {
    expect(
      reason({
        openOptOuts: [
          { optOutKind: "channel_specific", channelKinds: ["phone_call"] },
          { optOutKind: "no_mailings", channelKinds: null },
        ],
      }),
    ).toBe("no_mailings");
  });

  it("a channel-specific opt-out of the PHONE does not stop the newsletter (the contact status says opted_out, the row says calls only)", () => {
    expect(
      reason({
        contactStatus: "opted_out",
        openOptOuts: [{ optOutKind: "channel_specific", channelKinds: ["phone_call"] }],
      }),
    ).toBe("eligible");
  });

  it("a channel-specific opt-out that names a mailed kind blocks post, and only post", () => {
    const row = { optOutKind: "channel_specific" as const, channelKinds: ["sympathy_letter"] };
    expect(reason({ contactStatus: "opted_out", openOptOuts: [row] })).toBe("channel_opted_out");
    // naming a mailed kind does not touch email: an email-preferring contact is judged on the email channel
    expect(
      reason({
        openOptOuts: [row],
        allowedKinds: ["email"],
        hasEmailAddress: true,
        emailChannelAvailable: true,
      }),
    ).toBe("eligible");
  });

  it("a channel-specific opt-out of email blocks an email-preferring contact", () => {
    expect(
      reason({
        allowedKinds: ["email"],
        hasEmailAddress: true,
        emailChannelAvailable: true,
        openOptOuts: [{ optOutKind: "channel_specific", channelKinds: ["email"] }],
      }),
    ).toBe("channel_opted_out");
  });
});

describe("decideMailingEligibility: which channel, and is it stored", () => {
  it("no stated preference means post; any mailed kind in the stated preference means post", () => {
    expect(preferredMailingChannel(undefined)).toBe("postal");
    expect(preferredMailingChannel([])).toBe("postal");
    expect(preferredMailingChannel(["phone_call", "sympathy_card"])).toBe("postal");
    expect(preferredMailingChannel(["email", "anniversary_letter"])).toBe("postal");
  });

  it("email is preferred only when the stated kinds name email and no mailed kind", () => {
    expect(preferredMailingChannel(["email"])).toBe("email");
    expect(preferredMailingChannel(["phone_call", "email"])).toBe("email");
  });

  it("stated kinds that name neither a mailed kind nor email leave no channel", () => {
    expect(reason({ allowedKinds: ["phone_call"] })).toBe("channel_not_allowed");
    expect(reason({ allowedKinds: ["phone_call", "portal_message"] })).toBe("channel_not_allowed");
  });

  it("post needs a stored mailing address", () => {
    expect(reason({ hasMailingAddress: false })).toBe("no_mailing_address");
  });

  it("an email-preferring contact is mailed by email only when the tenant has the channel AND an address is stored", () => {
    const email = { allowedKinds: ["email" as const] };
    expect(decide({ ...email, hasEmailAddress: true, emailChannelAvailable: true })).toEqual({
      eligible: true,
      channel: "email",
    });
    expect(reason({ ...email, hasEmailAddress: true, emailChannelAvailable: false })).toBe(
      "email_channel_unavailable",
    );
    expect(reason({ ...email, hasEmailAddress: false, emailChannelAvailable: true })).toBe(
      "no_email_address",
    );
    // a stored postal address does NOT make an email-preferring contact a postal recipient (that would mail on paper against their preference)
    expect(
      reason({
        ...email,
        hasMailingAddress: true,
        hasEmailAddress: false,
        emailChannelAvailable: true,
      }),
    ).toBe("no_email_address");
  });

  it("every reason the rule can return is one the item CHECK admits", () => {
    const seen = new Set<string>();
    const cases: Partial<MailingEligibilityFacts>[] = [
      { planStatus: "paused" },
      { contactStatus: "deceased" },
      { audience: [] },
      { openOptOuts: [{ optOutKind: "no_mailings", channelKinds: null }] },
      { openOptOuts: [{ optOutKind: "full", channelKinds: null }] },
      { openOptOuts: [{ optOutKind: "channel_specific", channelKinds: ["sympathy_card"] }] },
      { allowedKinds: ["phone_call"] },
      { hasMailingAddress: false },
      { allowedKinds: ["email"], hasEmailAddress: true },
      { allowedKinds: ["email"], emailChannelAvailable: true },
    ];
    for (const c of cases) seen.add(reason(c));
    for (const r of seen)
      expect(BEREAVEMENT_MAILING_EXCLUSION_REASONS as readonly string[]).toContain(r);
    expect(seen.size).toBe(cases.length);
  });
});
