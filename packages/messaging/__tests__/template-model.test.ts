// M36 WP 2.8 - template write validation, the platform floor an overlay can never loosen, and effective resolution.
import { describe, expect, it } from "vitest";
import {
  type PlatformTemplate,
  TEMPLATE_LIMITS,
  effectiveForOrg,
  overlayViolatesFloor,
  validateTemplateText,
} from "../src/templates/template-model";

const floor: PlatformTemplate = {
  id: "p1",
  templateKey: "general.after_hours_emergency",
  category: "general",
  title: "After hours",
  body: "If this is an emergency, call 911. Otherwise contact the on-call line.",
  requiredPhrases: ["call 911"],
};

const onField = (field: string) =>
  expect.objectContaining({ details: [expect.objectContaining({ field })] });

describe("validateTemplateText", () => {
  it("accepts a clean title and body and trims them", () => {
    expect(validateTemplateText({ title: "  Hello ", body: " Thanks, received. " })).toEqual({
      title: "Hello",
      body: "Thanks, received.",
    });
  });
  it("rejects empty and over-long text with VALIDATION_FAILED", () => {
    expect(() => validateTemplateText({ title: "", body: "x" })).toThrow(onField("title"));
    expect(() => validateTemplateText({ title: "t", body: "  " })).toThrow(onField("body"));
    expect(() =>
      validateTemplateText({ title: "t", body: "x".repeat(TEMPLATE_LIMITS.bodyMax + 1) }),
    ).toThrow(onField("body"));
    expect(() =>
      validateTemplateText({ title: "x".repeat(TEMPLATE_LIMITS.titleMax + 1), body: "b" }),
    ).toThrow(onField("title"));
  });
  it("rejects PHI in the title or the body with TEMPLATE_PHI_DETECTED and never echoes it", () => {
    for (const input of [
      { title: "Call 415-555-0134", body: "ok" },
      { title: "ok", body: "SSN 123-45-6789" },
    ]) {
      try {
        validateTemplateText(input);
        expect.unreachable();
      } catch (error) {
        const e = error as { code: string; statusCode: number; details?: unknown[] };
        expect(e.code).toBe("TEMPLATE_PHI_DETECTED");
        expect(e.statusCode).toBe(422);
        expect(JSON.stringify(e)).not.toMatch(/415-555|123-45/);
        expect((e.details ?? []).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("overlay floor", () => {
  it("an overlay body that drops a required phrase violates the floor", () => {
    expect(overlayViolatesFloor(floor, { body: "Please wait for a reply." })).toBe(true);
  });
  it("matches required phrases case- and whitespace-insensitively", () => {
    expect(overlayViolatesFloor(floor, { body: "In an emergency CALL   911 now." })).toBe(false);
  });
  it("no overlay body never violates", () => {
    expect(overlayViolatesFloor(floor, { body: null })).toBe(false);
  });
  it("invisible characters are stripped before matching", () => {
    expect(overlayViolatesFloor(floor, { body: "call 9​11" })).toBe(false);
  });
});

describe("effectiveForOrg", () => {
  const overlayOk = {
    templateId: "p1",
    title: "Our after hours",
    body: "Emergency? Call 911.",
    isEnabled: true,
  };
  it("applies an overlay that respects the floor", () => {
    const [view] = effectiveForOrg([floor], [overlayOk]);
    expect(view).toMatchObject({
      title: "Our after hours",
      body: "Emergency? Call 911.",
      customized: true,
    });
  });
  it("falls back to the platform text when a stored overlay no longer satisfies the floor", () => {
    const [view] = effectiveForOrg(
      [floor],
      [{ ...overlayOk, title: null, body: "No emergencies please." }],
    );
    expect(view).toMatchObject({ body: floor.body, customized: false });
  });
  it("falls back when a stored overlay now fails the PHI lint", () => {
    const [view] = effectiveForOrg(
      [floor],
      [{ ...overlayOk, title: null, body: "Call 911 or 415-555-0134" }],
    );
    expect(view).toMatchObject({ body: floor.body, customized: false });
  });
  it("omits a template the tenant disabled", () => {
    expect(effectiveForOrg([floor], [{ ...overlayOk, isEnabled: false }])).toEqual([]);
  });
  it("an overlay for an unknown template is ignored", () => {
    expect(effectiveForOrg([floor], [{ ...overlayOk, templateId: "zzz" }])).toHaveLength(1);
  });
});
