import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// GAP-207: the `wx-*` list chrome lives in ONE shared stylesheet that every app imports; an app-local
// copy would re-create the drift (admin/portal rendering the shared list components unstyled).
const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const SHARED = "packages/ui/src/web/styles/list-chrome.css";
const SHARED_IMPORT = /@import "\.\.\/\.\.\/\.\.\/packages\/ui\/src\/web\/styles\/list-chrome\.css";/;
const LIST_CHROME_SELECTORS = [
  ".wx-kpi-strip > *",
  ".wx-data-table-scroll",
  ".wx-work-filters",
  ".wx-work-table >",
  ".wx-list-toolbar {",
  ".wx-list-state {",
  ".wx-list-table-wrap {",
  ".wx-list-table {",
  ".wx-list-table-static tbody tr",
];

describe("shared list-chrome stylesheet (GAP-207)", () => {
  const shared = read(SHARED);

  it("defines the list chrome inside the components layer", () => {
    expect(shared).toContain("@layer components {");
    for (const selector of LIST_CHROME_SELECTORS) expect(shared).toContain(selector);
  });

  it("defines no design tokens (arch:design-tokens reads them from each app)", () => {
    expect(shared).not.toMatch(/@theme|:root\s*\{|--color-[a-z-]+:\s*#/);
  });

  for (const app of ["web", "admin", "portal"]) {
    it(`apps/${app} imports it right after tailwindcss`, () => {
      const css = read(`apps/${app}/src/index.css`);
      expect(css).toMatch(SHARED_IMPORT);
      expect(css.indexOf('@import "tailwindcss"')).toBeLessThan(css.search(SHARED_IMPORT));
    });
  }

  it("apps/web no longer carries its own copy of the moved rules", () => {
    const web = read("apps/web/src/index.css");
    for (const selector of LIST_CHROME_SELECTORS) {
      expect(web, `app-local copy of ${selector}`).not.toContain(`\n  ${selector}`);
    }
  });

  it("admin and portal supply the tokens the shared chrome reads", () => {
    for (const app of ["admin", "portal"]) {
      const css = read(`apps/${app}/src/index.css`);
      expect(css).toContain("--color-card-border:");
      expect(css).toContain("--color-focus-ring:");
    }
  });
});
