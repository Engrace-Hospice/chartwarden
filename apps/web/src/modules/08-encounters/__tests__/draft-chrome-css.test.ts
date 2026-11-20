// The visit-note draft chrome (ADR-0114): rules jsdom cannot lay out are asserted on the stylesheet itself.
//   - The drafted section's status line is a live region mounted from the first render so that its first message is announced. A region
//     taken out of the accessibility tree while empty (display: none) is a newly exposed region when it fills, and is not reliably announced.
//   - The empty-section region is a programmatic focus target (tabIndex -1), so it must show where focus is.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("packages/ui/src/web/styles/list-chrome.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declaration blocks of every rule whose selector list names `selectorPart`. */
function bodiesOf(selectorPart: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => (selectors ?? "").includes(selectorPart))
    .map(([, , body]) => body ?? "");
}

describe("the drafted section's status line", () => {
  it("is never removed from the accessibility tree while empty", () => {
    const bodies = bodiesOf(".wx-draft-status");
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toMatch(/display:\s*none/);
      expect(body).not.toMatch(/visibility:\s*hidden/);
    }
  });
});

describe("the empty drafted section", () => {
  it("shows a focus ring, because focus is moved to it", () => {
    const focusRules = bodiesOf(".wx-draft-empty:focus-visible");
    expect(focusRules.some((body) => /outline:/.test(body))).toBe(true);
  });
});
