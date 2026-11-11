// apps/web/src/modules/16-bereavement — the pure rules of the mailing screens (ADR-0109 D10): what a wording must hold, what a config
// form may send, and the guards that keep this slice's mirrored vocabulary (limits, keys, exclusion reasons, relationships) equal to
// the server's.
import {
  BEREAVEMENT_BUILT_MAILING_KEYS,
  BEREAVEMENT_MAILING_CONTENT_LIMITS,
  BEREAVEMENT_MAILING_EXCLUSION_REASONS,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { MailingConfig } from "./bereavement-api";
import { RELATIONSHIP_CODES } from "./bereavement-status";
import { buildBody, draftOf, sameDraft } from "./mailing-config-draft";
import {
  AUDIENCE_RELATIONSHIPS,
  BLANK_WORDING,
  CONFIGURABLE_MAILING_KEYS,
  CONTENT_LIMITS,
  contentForSave,
  exclusionLabel,
  failureLabel,
  isWordingComplete,
  sameWording,
  wordingProblems,
} from "./mailing-status";

const config = (over: Partial<MailingConfig> = {}): MailingConfig => ({
  mailingKey: "newsletter_quarterly",
  configured: true,
  enabled: true,
  leadDays: 14,
  schedule: {},
  audienceRelationships: null,
  content: {},
  version: 2,
  updatedAt: null,
  ...over,
});

describe("the vocabulary mirrors the server's", () => {
  it("offers exactly the built mailing keys, never the deferred birthday mailing", () => {
    expect([...CONFIGURABLE_MAILING_KEYS]).toEqual([...BEREAVEMENT_BUILT_MAILING_KEYS]);
    expect(CONFIGURABLE_MAILING_KEYS).not.toContain("decedent_birthday");
  });

  it("holds the server's wording limits", () => {
    expect(CONTENT_LIMITS).toEqual(BEREAVEMENT_MAILING_CONTENT_LIMITS);
  });

  it("has a plain-language label for every exclusion reason (none falls back to a humanized code)", () => {
    for (const reason of BEREAVEMENT_MAILING_EXCLUSION_REASONS) {
      const label = exclusionLabel(reason);
      expect(label).not.toBe("—");
      expect(label.toLowerCase()).not.toBe(reason.replace(/_/g, " "));
    }
  });

  it("offers every relationship the roster knows", () => {
    expect([...AUDIENCE_RELATIONSHIPS].sort()).toEqual([...RELATIONSHIP_CODES].sort());
  });

  it("says a failed run's code in words and an unknown code as itself", () => {
    expect(failureLabel("NO_RECIPIENTS")).toMatch(/Nobody was eligible/);
    expect(failureLabel("RENDER_TIMEOUT")).toContain("RENDER_TIMEOUT");
  });
});

describe("a mailing's wording", () => {
  const written = {
    title: " Winter ",
    greeting: "Dear {name},",
    paragraphs: [" One ", "  ", "Two"],
    signoff: " With care ",
  };

  it("is complete only with a title and a non-blank paragraph: no default fills a gap", () => {
    expect(isWordingComplete(BLANK_WORDING)).toBe(false);
    expect(isWordingComplete({ ...BLANK_WORDING, title: "Hello" })).toBe(false);
    expect(isWordingComplete({ ...BLANK_WORDING, paragraphs: ["Body"] })).toBe(false);
    expect(isWordingComplete({ ...BLANK_WORDING, title: "Hello", paragraphs: ["  "] })).toBe(false);
    expect(isWordingComplete(written)).toBe(true);
  });

  it("is sent trimmed with blank paragraphs dropped, and a blank page is sent as nothing written", () => {
    expect(contentForSave(written)).toEqual({
      en: {
        title: "Winter",
        greeting: "Dear {name},",
        paragraphs: ["One", "Two"],
        signoff: "With care",
      },
    });
    expect(contentForSave(BLANK_WORDING)).toEqual({});
    expect(contentForSave({ ...BLANK_WORDING, paragraphs: ["", "  "] })).toEqual({});
  });

  it("does not count whitespace or an empty extra paragraph as an edit", () => {
    expect(
      sameWording(written, { ...written, title: "Winter", paragraphs: ["One", "Two", ""] }),
    ).toBe(true);
    expect(sameWording(written, { ...written, title: "Spring" })).toBe(false);
  });

  it("says which limit is crossed", () => {
    expect(wordingProblems(written)).toEqual([]);
    const problems = wordingProblems({
      title: "t".repeat(201),
      greeting: "g".repeat(201),
      paragraphs: ["p".repeat(2001), ...Array.from({ length: 12 }, () => "ok")],
      signoff: "s".repeat(401),
    });
    expect(problems).toEqual([
      "The title is over 200 characters.",
      "The greeting is over 200 characters.",
      "The sign-off is over 400 characters.",
      "A letter has at most 12 paragraphs.",
      "Paragraph 1 is over 2000 characters.",
    ]);
  });
});

describe("the config form", () => {
  it("builds the body the server accepts: lead time as a number, audience null for everyone, no schedule for a floating holiday", () => {
    const { body, problems } = buildBody(
      "mothers_day",
      draftOf(config({ mailingKey: "mothers_day" })),
    );
    expect(problems).toEqual([]);
    expect(body).toEqual({ enabled: true, leadDays: 14, audienceRelationships: null, content: {} });
  });

  it("sends the schedule only for the two mailings that have one, and drops a blank override", () => {
    const newsletter = draftOf(config({ schedule: { monthDays: ["01-10", "04-10"] } }));
    expect(buildBody("newsletter_quarterly", newsletter).body?.schedule).toEqual({
      monthDays: ["01-10", "04-10"],
    });
    expect(
      buildBody("newsletter_quarterly", { ...newsletter, newsletterDates: "" }).body,
    ).not.toHaveProperty("schedule");
    expect(buildBody("fathers_day", newsletter).body).not.toHaveProperty("schedule");
    const december = draftOf(
      config({ mailingKey: "holiday_december", schedule: { monthDay: "12-20" } }),
    );
    expect(buildBody("holiday_december", december).body?.schedule).toEqual({ monthDay: "12-20" });
  });

  it("refuses what the server would: bad dates, too many dates, lead time out of range, an empty audience", () => {
    const base = draftOf(config());
    expect(
      buildBody("newsletter_quarterly", { ...base, newsletterDates: "13-01" }).body,
    ).toBeNull();
    expect(
      buildBody("newsletter_quarterly", { ...base, newsletterDates: "02-31" }).body,
    ).not.toBeNull(); // shape only: the server drops an impossible day
    expect(
      buildBody("newsletter_quarterly", {
        ...base,
        newsletterDates: Array.from({ length: 13 }, (_, i) => `01-${String(i + 10)}`).join(","),
      }).problems,
    ).toContain("Name at most 12 issue dates.");
    for (const leadDays of ["2", "61", "", "1.5", "-3", "ten"])
      expect(buildBody("newsletter_quarterly", { ...base, leadDays }).body).toBeNull();
    for (const leadDays of ["3", "60"])
      expect(buildBody("newsletter_quarterly", { ...base, leadDays }).body).not.toBeNull();
    expect(
      buildBody("newsletter_quarterly", { ...base, everyone: false, relationships: [] }).problems,
    ).toContain("Choose at least one relationship, or choose everyone.");
  });

  it("sends a chosen audience sorted and without duplicates", () => {
    const draft = {
      ...draftOf(config()),
      everyone: false,
      relationships: ["spouse", "child", "spouse"] as const,
    };
    expect(buildBody("newsletter_quarterly", draft).body?.audienceRelationships).toEqual([
      "child",
      "spouse",
    ]);
  });

  it("compares drafts by what they would send", () => {
    const base = draftOf(config({ audienceRelationships: ["spouse", "child"] }));
    expect(sameDraft(base, { ...base, relationships: ["child", "spouse"], leadDays: " 14 " })).toBe(
      true,
    );
    expect(sameDraft(base, { ...base, enabled: false })).toBe(false);
    expect(sameDraft(base, { ...base, everyone: true })).toBe(false);
  });
});
