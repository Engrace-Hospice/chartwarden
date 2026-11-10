// Source guards for the tenant wizard (the house pattern: a grep over the module's own files). They hold the policy decisions that a
// later edit could undo without any behaviour test noticing.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WIZARD_DIR = __dirname;
const MODULE_DIR = join(__dirname, "..");
const CSS_FILES = [
  join(__dirname, "../../../../../../packages/ui/src/web/styles/list-chrome.css"),
  join(__dirname, "../../../../../../packages/ui/src/web/styles/app-shell.css"),
];

const isTest = (name: string): boolean => /\.test\.tsx?$/.test(name) || name === "test-support.tsx";
const sourceFiles = (dir: string): { name: string; text: string }[] =>
  readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !isTest(name))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

// The wizard's own files plus the Agency setup screen that shares its forms.
const files = [
  ...sourceFiles(WIZARD_DIR),
  { name: "agency-setup.tsx", text: readFileSync(join(MODULE_DIR, "agency-setup.tsx"), "utf8") },
];

describe("the tenant wizard never grants a role", () => {
  it("makes no POST to a membership's roles: ChartWarden alone binds the compliance officer role (separation of duties)", () => {
    const offenders = files.filter((f) => /\.POST\(\s*["'`]\/api\/v1\/memberships/.test(f.text));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });
});

describe("wizard drafts go through the scoped store only", () => {
  const KIT_DRAFT_STORES = [
    "stashStepUpDraft",
    "useStepUpDraft",
    "stashStepUpMemoryDraft",
    "useStepUpMemoryDraft",
    "peekStepUpDraft",
    "peekStepUpMemoryDraft",
  ];

  it("imports none of the kit's step-up draft stores (fixed keys, no org or user, not cleared by sign-out)", () => {
    const offenders = files.filter((f) => {
      const imports = [
        ...f.text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@chartwarden\/ui"/g),
      ];
      return imports.some((m) =>
        KIT_DRAFT_STORES.some((name) => new RegExp(`\\b${name}\\b`).test(m[1] ?? "")),
      );
    });
    expect(offenders.map((f) => f.name)).toEqual([]);
  });

  it("never touches Web Storage", () => {
    const offenders = files.filter((f) => /\b(?:session|local)Storage\b/.test(f.text));
    expect(offenders.map((f) => f.name)).toEqual([]);
  });
});

describe("the wizard's class names exist in the shared stylesheets", () => {
  const css = CSS_FILES.map((f) => readFileSync(f, "utf8")).join("\n");
  it("styles every wx-* class it uses", () => {
    const used = new Set<string>();
    for (const f of files) {
      for (const m of f.text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const token of (m[1] ?? m[2] ?? "").split(/\s+/))
          if (token.startsWith("wx-")) used.add(token);
      }
    }
    const missing = [...used].filter((token) => !new RegExp(`\\.${token}(?![\\w-])`).test(css));
    expect(missing).toEqual([]);
    expect(used.has("wx-form-narrow")).toBe(true); // Agency setup's forms keep their 28rem width
  });
});
