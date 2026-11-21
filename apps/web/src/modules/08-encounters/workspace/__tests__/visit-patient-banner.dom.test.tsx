import { readFileSync } from "node:fs";
// Workflow 09, WP1 — the patient banner's name opens the chart, and nothing else on the banner says so (the "Open chart" button is gone),
// so the link must look like one. jsdom cannot lay the link out: the class is asserted on the element and the rules on the stylesheet.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { VisitPatientBanner } from "../visit-patient-banner";

const css = readFileSync(
  "apps/web/src/modules/08-encounters/workspace/visit-context.css",
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every rule whose selector is exactly `selector`. */
function declarationsOf(selector: string): string {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => (selectors ?? "").trim() === selector)
    .map(([, , body]) => body ?? "")
    .join("\n");
}

const patient = { firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" };

describe("the patient name link", () => {
  it("opens the patient's chart and carries the link class, with no inline style that removes its underline", () => {
    render(
      <MemoryRouter>
        <VisitPatientBanner patient={patient} patientId="patient-1" />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Ada Lovelace" });
    expect(link.getAttribute("href")).toBe("/patients/patient-1");
    expect(link.className).toContain("wx-visit-patient-link");
    expect(link.getAttribute("style") ?? "").not.toMatch(/text-decoration/);
  });

  it("is underlined at rest and shows a focus ring when focused from the keyboard", () => {
    expect(declarationsOf(".wx-visit-patient-link")).toMatch(/text-decoration:\s*underline/);
    expect(declarationsOf(".wx-visit-patient-link:focus-visible")).toMatch(/outline:\s*2px solid/);
  });

  it("is plain text when the encounter's patient is not known", () => {
    render(
      <MemoryRouter>
        <VisitPatientBanner patient={patient} patientId={null} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });
});
