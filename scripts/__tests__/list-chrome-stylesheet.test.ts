import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// GAP-207: the `wx-*` list chrome lives in ONE shared stylesheet that every app imports; an app-local
// copy would re-create the drift (admin/portal rendering the shared list components unstyled).
const ROOT = join(__dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const SHARED = "packages/ui/src/web/styles/list-chrome.css";
const SHARED_IMPORT =
  /@import "\.\.\/\.\.\/\.\.\/packages\/ui\/src\/web\/styles\/list-chrome\.css";/;
const LIST_CHROME_SELECTORS = [
  ".wx-kpi-strip > *",
  ".wx-data-table-scroll",
  ".wx-work-filters",
  ".wx-work-table >",
  ".wx-page-head {",
  ".wx-page-head > :first-child {",
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

  const ruleBody = (selector: string): string =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(
      shared,
    )?.[1] ?? "";

  it("spaces a fieldset card's legend with the card's grid gap, not a margin or a clear that would double it", () => {
    const legend = ruleBody("fieldset.wx-drawer-card > legend");
    expect(legend).toContain("float: left"); // keeps it out of the fieldset's border-cutting "rendered legend" slot
    expect(legend).not.toContain("margin-bottom");
    expect(shared).not.toContain("fieldset.wx-drawer-card > legend + *");
  });

  it("only makes a row title look clickable when it acts (button, link, or an interactive row's title)", () => {
    expect(ruleBody(".wx-row-title")).not.toContain("cursor");
    expect(ruleBody("button.wx-row-title,\n  a.wx-row-title")).toContain("cursor: pointer");
    expect(shared).toContain('tr[role="button"] .wx-row-title:hover');
    expect(shared).not.toContain("\n  .wx-row-title:hover");
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
