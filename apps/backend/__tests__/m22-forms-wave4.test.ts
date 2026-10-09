// GAP-033 Wave 4 - the operational documents whose producers already put the whole content on the wire: the
// caregiver visit-confirmation reminder (M17), the EVV verification record (M18), the DSAR export transmittal
// sheet and the tenant-export cover letter (M34). Proves each draws exactly its declared fields (an allow-list),
// fails closed on a payload missing what the document exists to state, keeps payload-derived titles, internal
// object keys and unknown keys off the page and out of file metadata, and is deterministic.
import { RenderPayloadError } from "@wardenx/types";
import { describe, expect, it } from "vitest";
import { COMPILED_FORMS } from "../src/modules/22-documents/render-pdf/forms";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf/registry";
import {
  DSAR_BUNDLE,
  EVV_VERIFICATION,
  SENTINEL_NAME,
  TENANT_EXPORT_COVER,
  VISIT_CONFIRMATION,
  WAVE4_FIXTURES,
} from "./_m22-form-fixtures";

const textOf = (doc: Parameters<typeof layoutDocument>[0]): string =>
  pageTexts(layoutDocument(doc)).flat().join("\n").replace(/\s+/g, " ");
const keys = Object.keys(WAVE4_FIXTURES) as Array<keyof typeof WAVE4_FIXTURES>;

describe("wave 4 forms are bespoke builders", () => {
  it.each(keys)("%s is a compiled form", (key) => {
    expect(Object.hasOwn(COMPILED_FORMS, key)).toBe(true);
  });
});

describe("visit_confirmation", () => {
  it("states the scheduled start and the delivery channel", () => {
    const text = textOf(COMPILED_FORMS.visit_confirmation(VISIT_CONFIRMATION));
    expect(text).toContain("2026-10-12");
    expect(text).toContain("15:30");
    expect(text).toContain("Text message");
    expect(text).toContain("11111111");
  });
  it("does not print the patient id (minimisation) and rejects an unknown channel", () => {
    expect(textOf(COMPILED_FORMS.visit_confirmation(VISIT_CONFIRMATION))).not.toContain("22222222");
    expect(() =>
      COMPILED_FORMS.visit_confirmation({ ...VISIT_CONFIRMATION, channel: "fax" }),
    ).toThrow(RenderPayloadError);
  });
});

describe("evv_verification", () => {
  it("states the submission, visit, state, aggregator transaction and acceptance instant", () => {
    const text = textOf(COMPILED_FORMS.evv_verification(EVV_VERIFICATION));
    expect(text).toContain("33333333");
    expect(text).toContain("11111111");
    expect(text).toContain("OR");
    expect(text).toContain("TXN-88-2041");
    expect(text).toContain("2026-10-12");
  });
  it("states an unassigned aggregator transaction rather than a blank", () => {
    const text = textOf(
      COMPILED_FORMS.evv_verification({ ...EVV_VERIFICATION, aggregatorTransactionId: null }),
    );
    expect(text).toContain("Not assigned by the aggregator");
  });
  it("makes no claim about geographic verification (the wire event carries none)", () => {
    expect(textOf(COMPILED_FORMS.evv_verification(EVV_VERIFICATION))).not.toMatch(/geo|map/i);
  });
});

describe("dsar_bundle", () => {
  it("draws the export reference, the digest and the Part 2 redaction statement", () => {
    const text = textOf(COMPILED_FORMS.dsar_bundle(DSAR_BUNDLE));
    expect(text).toContain("55555555");
    // A 64-character digest wraps inside its cell; it must survive intact once the wrap is undone.
    expect(text.replace(/ /g, "")).toContain(DSAR_BUNDLE.bundleSha256);
    expect(text).toMatch(/42 CFR Part 2/);
    expect(text).toMatch(/redaction was applied/i);
  });
  it("states that no Part 2 redaction was recorded when the flag is false", () => {
    const text = textOf(
      COMPILED_FORMS.dsar_bundle({ ...DSAR_BUNDLE, partTwoRedactionApplied: false }),
    );
    expect(text).toMatch(/no Part 2 redaction was recorded/i);
  });
  it("never prints the internal object key or the payload-derived title", () => {
    const text = textOf(COMPILED_FORMS.dsar_bundle(DSAR_BUNDLE));
    expect(text).not.toContain("ndjson");
    expect(text).not.toContain(SENTINEL_NAME);
    expect(text).not.toContain("DSAR export for Pat");
  });
  it("rejects a malformed digest (the sheet exists to prove integrity)", () => {
    expect(() => COMPILED_FORMS.dsar_bundle({ ...DSAR_BUNDLE, bundleSha256: "deadbeef" })).toThrow(
      RenderPayloadError,
    );
  });
});

describe("tenant_export_cover_letter", () => {
  it("draws the export reference and the digest to verify the archive against", () => {
    const text = textOf(COMPILED_FORMS.tenant_export_cover_letter(TENANT_EXPORT_COVER));
    expect(text).toContain("66666666");
    expect(text.replace(/ /g, "")).toContain(TENANT_EXPORT_COVER.bundleSha256);
    expect(text).toMatch(/SHA-256/);
  });
});

describe("every wave 4 form", () => {
  it.each(keys)(
    "%s: constant title, patient-independent header, unknown keys never drawn",
    (key) => {
      const doc = COMPILED_FORMS[key]({
        ...WAVE4_FIXTURES[key],
        mbi: "1EG4-TE5-MK73",
        patientName: SENTINEL_NAME,
      } as never);
      expect(doc.runningHeader).toBe(doc.title);
      const text = textOf(doc);
      expect(text).not.toContain("1EG4-TE5-MK73");
      expect(text).not.toContain(SENTINEL_NAME);
      expect(text).not.toContain("Medical record number");
    },
  );

  it.each(keys)("%s: fails closed on an id-only or hostile payload", (key) => {
    for (const payload of [null, undefined, "x", 7, [], {}, { aggregateId: "a" }]) {
      expect(() => COMPILED_FORMS[key](payload)).toThrow(RenderPayloadError);
    }
  });

  it.each(keys)("%s: renders a deterministic, valid PDF through the registry", (key) => {
    const a = renderPdfForTemplate(key, WAVE4_FIXTURES[key], key);
    const b = renderPdfForTemplate(key, WAVE4_FIXTURES[key], key);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).subarray(0, 5).toString()).toBe("%PDF-");
    const raw = Buffer.from(
      renderDocModelToPdf(COMPILED_FORMS[key](WAVE4_FIXTURES[key] as never)),
    ).toString("latin1");
    expect(raw).not.toContain(SENTINEL_NAME);
  });
});
