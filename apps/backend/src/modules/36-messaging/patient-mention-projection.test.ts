import { describe, expect, it } from "vitest";
import { hidePatientMentionNodes, projectPatientMentionBody } from "./messaging-message-hydration";

describe("patient references shown to a reader without chart access", () => {
  it("replaces the patient token and rebases following reference offsets", () => {
    const body = "Ask @Jane Doe and @Nurse Lee";
    const references = [
      { kind: "patient", entityId: "patient-1", start: 4, end: 13 },
      { kind: "staff", entityId: "nurse-1", start: 18, end: 28 },
    ];
    const projected = projectPatientMentionBody(body, references, new Set(["patient-1"]));
    expect(projected.body).toBe("Ask @Patient and @Nurse Lee");
    expect(projected.body.slice(projected.ranges[0]!.start, projected.ranges[0]!.end)).toBe(
      "@Patient",
    );
    expect(projected.body.slice(projected.ranges[1]!.start, projected.ranges[1]!.end)).toBe(
      "@Nurse Lee",
    );
  });

  it("removes the patient identity from nested rich mention nodes", () => {
    const doc = {
      doc: {
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", kind: "patient", entityId: "patient-1", label: "Jane Doe" },
            ],
          },
        ],
      },
    };
    const safe = hidePatientMentionNodes(doc, new Set(["patient-1"]));
    expect(JSON.stringify(safe)).not.toContain("patient-1");
    expect(JSON.stringify(safe)).not.toContain("Jane Doe");
    expect(JSON.stringify(safe)).toContain("Patient");
  });
});
