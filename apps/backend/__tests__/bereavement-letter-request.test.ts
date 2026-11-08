// apps/backend/__tests__/bereavement-letter-request.test.ts — ADR-0109 D2 / D9: which M22 template a started letter touchpoint renders under.
// The generic `bereavement_letter` covers the condolence, sympathy and anniversary letters; the day-390 `closeout_letter` floor item is a
// DIFFERENT letter (it closes the program) and renders under its own template and typed payload. Both stay family-facing, filed under the
// `bereavement_letter` aggregate type so the existing outreach back-ref stamps them.
import { assertBereavementCloseoutLetterRenderPayload } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { outreachLetterRequestOf } from "../src/modules/16-bereavement/render-payloads/outreach-letter";
import { renderPdfForTemplate } from "../src/modules/22-documents/render-pdf";
import { PLATFORM_TEMPLATE_TABLE } from "../src/modules/22-documents/seams/renderer";

const outreach = (over: Record<string, unknown> = {}) => ({
  kind: "sympathy_letter" as const,
  cadenceMark: "condolence_letter" as string | null,
  anniversaryMark: null,
  dueAt: new Date("2025-10-03T00:00:00.000Z"),
  ...over,
});
const plan = { deathDate: "2025-10-01" };

describe("outreachLetterRequestOf", () => {
  it("renders the condolence, anniversary and legacy (unmarked) letters through the generic letter template", () => {
    for (const cadenceMark of ["condolence_letter", "anniversary", null]) {
      const req = outreachLetterRequestOf(outreach({ cadenceMark }), plan);
      expect(req.templateKey).toBe("bereavement_letter");
      expect(req.payloadJsonb).toEqual({
        outreachKind: "sympathy_letter",
        anniversaryMark: null,
        deathDate: "2025-10-01",
        dueAt: "2025-10-03T00:00:00.000Z",
      });
    }
  });

  it("renders the day-390 closeout_letter floor item through its own closeout template with a typed payload", () => {
    const req = outreachLetterRequestOf(
      outreach({ cadenceMark: "closeout_letter", dueAt: new Date("2026-10-26T00:00:00.000Z") }),
      plan,
    );
    expect(req.templateKey).toBe("bereavement_closeout_letter");
    expect(assertBereavementCloseoutLetterRenderPayload(req.payloadJsonb)).toEqual({
      cadenceMark: "closeout_letter",
      outreachKind: "sympathy_letter",
      deathDate: "2025-10-01",
      dueAt: "2026-10-26T00:00:00.000Z",
    });
  });
});

describe("the closeout letter template", () => {
  it("is a published template, family-facing under the bereavement_letter aggregate type (the outreach back-ref routes it)", () => {
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_closeout_letter).toMatchObject({
      aggregateType: "bereavement_letter",
      retentionClass: "bereavement",
    });
    expect(PLATFORM_TEMPLATE_TABLE.bereavement_closeout_letter?.internalOnly).toBeUndefined();
  });

  it("renders a real PDF titled as a closeout letter", () => {
    const req = outreachLetterRequestOf(outreach({ cadenceMark: "closeout_letter" }), plan);
    const bytes = renderPdfForTemplate(
      "bereavement_closeout_letter",
      req.payloadJsonb,
      "Bereavement Closeout Letter",
    );
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).toContain("Bereavement Closeout Letter");
  });
});
