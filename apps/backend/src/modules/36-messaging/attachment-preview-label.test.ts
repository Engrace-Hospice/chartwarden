import { describe, expect, it } from "vitest";
import { attachmentPreviewLabel } from "./attachment-preview-label";

describe("attachmentPreviewLabel", () => {
  it("is generic when the viewer sees no file, names one, counts several, and truncates a long name", () => {
    expect(attachmentPreviewLabel([])).toBe("\u{1F4CE} Attachment");
    expect(attachmentPreviewLabel([{ fileName: "report.pdf" }])).toBe("\u{1F4CE} report.pdf");
    expect(attachmentPreviewLabel([{ fileName: "a" }, { fileName: "b" }])).toBe(
      "\u{1F4CE} 2 attachments",
    );
    expect(attachmentPreviewLabel([{ fileName: "x".repeat(200) }]).length).toBeLessThan(90);
  });
});
