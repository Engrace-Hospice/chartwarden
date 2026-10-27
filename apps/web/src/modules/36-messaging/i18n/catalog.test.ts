// M36 WP 6.4 - i18n mechanism: fallback is visible, never blank; unreviewed template translations are never offered.
import { describe, expect, it } from "vitest";
import { CATALOGS, type Catalog, EN, LOCALES, resolveLocale, translate } from "./catalog";
import {
  TEMPLATE_TRANSLATIONS,
  type TemplateTranslation,
  pickTemplateText,
} from "./template-translations";

describe("resolveLocale", () => {
  it("prefers the saved preference, then browser languages, else English", () => {
    expect(resolveLocale("es", ["en-US"])).toBe("es");
    expect(resolveLocale(null, ["fr-FR", "es-MX"])).toBe("es");
    expect(resolveLocale("xx", ["fr"])).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});

describe("translate", () => {
  it("returns the locale text with its own lang", () => {
    const t = translate("es", "picker.toggle");
    expect(t).toMatchObject({
      text: "Respuestas guardadas",
      lang: "es",
      fallback: false,
      provisional: true,
    });
  });
  it("falls back to English visibly (flagged, lang=en) when a key is missing or blank", () => {
    const catalogs = { en: EN, es: { "picker.toggle": "  " } as Catalog };
    const t = translate("es", "picker.toggle", {}, catalogs);
    expect(t).toMatchObject({ text: EN["picker.toggle"], lang: "en", fallback: true });
    expect(translate("es", "picker.none", {}, catalogs).text).not.toBe("");
  });
  it("English is never flagged as a fallback", () => {
    expect(translate("en", "picker.toggle").fallback).toBe(false);
  });
  it("interpolates variables", () => {
    expect(translate("es", "picker.count.other", { n: 3 }).text).toBe("3 respuestas guardadas");
  });
  it("every locale key exists in English", () => {
    for (const l of LOCALES) for (const k of Object.keys(CATALOGS[l])) expect(k in EN).toBe(true);
  });
});

describe("pickTemplateText", () => {
  const platform = {
    scope: "platform",
    templateKey: "confirmation.received",
    customized: false,
    title: "Message received",
    body: "Thanks.",
  };
  const reviewed: TemplateTranslation = {
    templateKey: "confirmation.received",
    locale: "es",
    title: "Mensaje recibido",
    body: "Gracias.",
    review: { state: "clinician_reviewed", reviewer: "RN Example", reviewedOn: "2026-10-01" },
  };
  it("never offers shipped (unreviewed) translations", () => {
    expect(TEMPLATE_TRANSLATIONS.every((t) => t.review.state === "unreviewed")).toBe(true);
    expect(pickTemplateText(platform, "es")).toMatchObject({
      body: "Thanks.",
      lang: "en",
      fallback: true,
    });
  });
  it("offers a clinician-reviewed translation", () => {
    expect(pickTemplateText(platform, "es", [reviewed])).toMatchObject({
      body: "Gracias.",
      lang: "es",
      fallback: false,
    });
  });
  it("ignores an unreviewed translation even when present", () => {
    expect(
      pickTemplateText(platform, "es", [{ ...reviewed, review: { state: "unreviewed" } }]).body,
    ).toBe("Thanks.");
  });
  it("leaves customized, org and personal text as written, untagged", () => {
    expect(pickTemplateText({ ...platform, customized: true }, "es", [reviewed])).toMatchObject({
      body: "Thanks.",
      fallback: false,
    });
    expect(pickTemplateText({ ...platform, scope: "org" }, "es", [reviewed]).fallback).toBe(false);
  });
  it("has no translation for the emergency-floor template", () => {
    expect(
      TEMPLATE_TRANSLATIONS.some((t) => t.templateKey === "general.after_hours_emergency"),
    ).toBe(false);
  });
});
