// apps/backend/__tests__/bereavement-no-mailings.test.ts — ADR-0109 D10: the `no_mailings` opt-out. The contact STAYS
// active and keeps its calls; only the mailed kinds are re-modalized to phone (a floor contact is never dropped), the
// preference raises `contact_mailing_preference_changed` (never `contact_opted_out`), and nothing that counts full opt-outs
// ever sees it.
import { MAILING_OUTREACH_KINDS } from "@chartwarden/bereavement";
import type { BereavementOutreachKind } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  BereavementStateError,
  decidePlanCloseOnRoster,
  effectiveAllowedKinds,
  generateOutreachSchedule,
  transitionBereavedContact,
} from "../src/modules/16-bereavement/lifecycle/index";

const AT = "2026-11-05T12:00:00.000Z" as never;
const NO_MAILINGS = [{ optOutKind: "no_mailings" as const }];

describe("effectiveAllowedKinds", () => {
  it("is a pass-through without an open no_mailings row (unstated stays unstated)", () => {
    expect(effectiveAllowedKinds(undefined, [])).toBeUndefined();
    expect(effectiveAllowedKinds([], [])).toEqual([]);
    expect(effectiveAllowedKinds(["phone_call", "sympathy_letter"], [])).toEqual([
      "phone_call",
      "sympathy_letter",
    ]);
    // a full / channel / pause row is not a mailing preference (their semantics are a separate ticket)
    expect(
      effectiveAllowedKinds(undefined, [
        { optOutKind: "full" },
        { optOutKind: "channel_specific" },
        { optOutKind: "pause_temporarily" },
      ]),
    ).toBeUndefined();
  });

  it("strips every mailed kind from a stated preference", () => {
    expect(
      effectiveAllowedKinds(
        ["phone_call", "sympathy_letter", "email", "anniversary_letter"],
        NO_MAILINGS,
      ),
    ).toEqual(["phone_call", "email"]);
  });

  it("an unstated preference becomes the contactable kinds — never a mailed one, never a referral", () => {
    const kinds = effectiveAllowedKinds(undefined, NO_MAILINGS) ?? [];
    expect(kinds).toEqual(
      expect.arrayContaining(["phone_call", "in_person_visit", "email", "portal_message"]),
    );
    for (const mailed of MAILING_OUTREACH_KINDS) expect(kinds).not.toContain(mailed);
    expect(kinds).not.toContain("external_referral");
    expect(effectiveAllowedKinds([], NO_MAILINGS)).toEqual(kinds);
  });

  it("a contact who allowed ONLY mailed kinds is still reachable by phone", () => {
    expect(effectiveAllowedKinds(["sympathy_letter", "sympathy_card"], NO_MAILINGS)).toEqual([
      "phone_call",
    ]);
  });

  it("does not mutate its inputs", () => {
    const prefs: BereavementOutreachKind[] = ["sympathy_letter", "phone_call"];
    effectiveAllowedKinds(prefs, NO_MAILINGS);
    expect(prefs).toEqual(["sympathy_letter", "phone_call"]);
  });
});

describe("a no_mailings contact's schedule", () => {
  const deathDate = "2026-11-01";

  it("re-modalizes every mailed floor item to a phone call and drops none", () => {
    const base = generateOutreachSchedule(deathDate, { riskTier: "low" });
    const stripped = generateOutreachSchedule(deathDate, {
      riskTier: "low",
      allowedKinds: effectiveAllowedKinds(undefined, NO_MAILINGS) ?? [],
    });
    expect(stripped.map((r) => r.mark)).toEqual(base.map((r) => r.mark));
    expect(stripped.map((r) => r.dueAt)).toEqual(base.map((r) => r.dueAt));
    for (const row of stripped) {
      expect(MAILING_OUTREACH_KINDS).not.toContain(row.kind);
    }
    const letters = base.filter((r) => MAILING_OUTREACH_KINDS.includes(r.kind));
    expect(letters.length).toBeGreaterThan(0);
    for (const letter of letters) {
      const after = stripped.find((r) => r.mark === letter.mark);
      expect(after?.kind).toBe("phone_call");
      expect(after?.preferenceSubstituted).toBe(true);
    }
    // a call that was already a call is untouched
    for (const call of base.filter((r) => r.kind === "phone_call")) {
      expect(stripped.find((r) => r.mark === call.mark)?.kind).toBe("phone_call");
    }
  });
});

describe("the contact machine", () => {
  const optOut = (over: Record<string, unknown> = {}) =>
    transitionBereavedContact("active", {
      type: "optOut",
      at: AT,
      optOutKind: "no_mailings",
      source: "portal_self_service",
      reason: "Stop the mailings",
      ...over,
    } as never);

  it("keeps the contact active and raises the mailing-preference event, not contact_opted_out", () => {
    const t = optOut();
    expect(t.to).toBe("active");
    const kinds = t.effects.map((e) => e.kind);
    expect(kinds).toContain("insert_opt_out");
    expect(t.effects).toContainEqual({
      kind: "outbox",
      event: "m16.bereavement.contact_mailing_preference_changed",
    });
    expect(t.effects).not.toContainEqual({
      kind: "outbox",
      event: "m16.bereavement.contact_opted_out",
    });
    // nothing is cancelled and no timestamp marks the contact opted out
    expect(kinds).not.toContain("cancel_future_outreach");
    expect(kinds).not.toContain("set_timestamp");
    expect(kinds).not.toContain("alert");
  });

  it("names no channels, and a reason is still required", () => {
    expect(() => optOut({ channelKinds: ["email"] })).toThrow(BereavementStateError);
    expect(() => optOut({ reason: "  " })).toThrow(BereavementStateError);
  });

  it.each(["proposed", "opted_out", "unreachable", "deceased", "ineligible_post_review"] as const)(
    "is illegal from %s (409)",
    (from) => {
      expect(() =>
        transitionBereavedContact(from, {
          type: "optOut",
          at: AT,
          optOutKind: "no_mailings",
          source: "portal_self_service",
          reason: "x",
        } as never),
      ).toThrow(/cannot optOut/);
    },
  );

  it("rescinding it keeps the contact active, is not bound by the 90-day window, and raises the event", () => {
    const longAgo = "2025-01-01T00:00:00.000Z" as never;
    const t = transitionBereavedContact("active", {
      type: "rescindOptOut",
      at: AT,
      optedOutAt: longAgo,
      byCounselor: false,
      optOutKind: "no_mailings",
    } as never);
    expect(t.to).toBe("active");
    expect(t.effects).toContainEqual({ kind: "rescind_opt_out", at: AT });
    expect(t.effects).toContainEqual({
      kind: "outbox",
      event: "m16.bereavement.contact_mailing_preference_changed",
    });
    expect(t.effects.map((e) => e.kind)).not.toContain("regenerate_schedule");
  });

  it("an ACTIVE contact cannot rescind a non-mailing opt-out (only opted_out can)", () => {
    expect(() =>
      transitionBereavedContact("active", {
        type: "rescindOptOut",
        at: AT,
        optedOutAt: AT,
        byCounselor: true,
        optOutKind: "full",
      } as never),
    ).toThrow(BereavementStateError);
  });

  it("the full opt-out and its rescind are unchanged", () => {
    const t = optOut({ optOutKind: "full" });
    expect(t.to).toBe("opted_out");
    expect(t.effects).toContainEqual({
      kind: "outbox",
      event: "m16.bereavement.contact_opted_out",
    });
    const back = transitionBereavedContact("opted_out", {
      type: "rescindOptOut",
      at: AT,
      optedOutAt: AT,
      byCounselor: false,
      optOutKind: "full",
    } as never);
    expect(back.to).toBe("active");
    expect(back.effects.map((e) => e.kind)).toContain("regenerate_schedule");
  });
});

describe("D6 — the all-contacts-opted-out closure never sees a no_mailings row", () => {
  it("a roster whose every contact stopped mailings is a roster of ACTIVE contacts, so the plan stays open", () => {
    // a no_mailings contact keeps status `active` (the machine above), and D6 counts statuses only
    expect(decidePlanCloseOnRoster("active", ["active", "active", "active"])).toBe(false);
  });
});
