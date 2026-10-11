// ADR-0001: hospice claims carry NO HIPPS rate code. The per-diem class code (`derivePerDiemClassCode`) is an INTERNAL
// placeholder that is persisted for reproducibility and never transmitted. This guards both halves of that statement:
//   1. no outbound claim document / 837I segment builder / claim-line row mentions HIPPS or the per-diem class code;
//   2. the `hipps` name is gone from the billing package and the M23 schema (migration 1069 rename).
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..");
const BILLING_SRC = join(__dirname, "..", "src");
const DB_BILLING_SCHEMA = join(REPO_ROOT, "packages", "db", "src", "schema", "billing");
const X12_837_SRC = join(REPO_ROOT, "packages", "x12-837-client", "src");
const BACKEND_M23_SRC = join(REPO_ROOT, "apps", "backend", "src", "modules", "23-billing-medicare");
const WEB_SRC = join(REPO_ROOT, "apps", "web", "src");
const BACKEND_ROOT_FILES = [
  join(REPO_ROOT, "apps", "backend", "src", "m23-override-audit.ts"),
  join(REPO_ROOT, "apps", "backend", "src", "index.ts"),
];

/** Hand-picked billing builders that shape outbound bytes (kept in addition to the auto-discovered x12 client). */
const OUTBOUND_FILES = [
  join(BILLING_SRC, "claim-codes", "x12-segments.ts"),
  join(BILLING_SRC, "claim-codes", "admission-codes.ts"),
  join(BILLING_SRC, "claim-codes", "discharge-codes.ts"),
  join(BILLING_SRC, "transfer-notice", "document.ts"),
  join(BILLING_SRC, "claim-lines", "claim-snapshot.ts"),
  join(BILLING_SRC, "claim-lines", "physician-npis.ts"),
];

/**
 * The only non-test files allowed to spell the legacy `hipps` identifiers: the read-side aliases for append-only
 * history persisted before migration 1069 (history is never rewritten, so the old spellings must still be recognised).
 */
const LEGACY_ALIAS_FILES = new Set([
  join(BILLING_SRC, "legacy-stored-aliases.ts"),
  join(WEB_SRC, "modules", "23-billing-medicare", "validation-remediation.ts"),
]);

const PER_DIEM_CLASS_NAME = /hipps|per[_-]?diem[_-]?class/i;
const HIPPS_NAME = /hipps/i;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const isSource = (f: string) => /\.(ts|tsx)$/.test(f);
const isTestFile = (f: string) =>
  /(__tests__|__fixtures__|\.test\.|\.dom\.test\.|\/testing\.ts$)/.test(f);

/**
 * The text of every identifier, string / template literal and regex literal in a source file - comments are trivia
 * and never appear, but a string literal that merely CONTAINS `//` or `/*` (a URL, a glob) is not mistaken for one,
 * which a regex comment-stripper would get wrong and thereby hide the rest of the line.
 */
function code(path: string): string {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const parts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) parts.push(node.text);
    else if (ts.isStringLiteralLike(node)) parts.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      parts.push(node.text);
    else if (ts.isRegularExpressionLiteral(node)) parts.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parts.join("\n");
}

const rel = (f: string) => relative(REPO_ROOT, f);

describe("the code() helper keeps string literals and drops comments", () => {
  it("sees a HIPPS string after a `//` inside a string, and ignores comment prose", () => {
    const dir = mkdtempSync(join(tmpdir(), "no-hipps-"));
    const file = join(dir, "fixture.ts");
    writeFileSync(
      file,
      'const u = "http://x"; const k = "HIPPS"; // HIPPS in a comment\n/* HIPPS */\n',
    );
    try {
      const text = code(file);
      expect(text).toContain("HIPPS");
      expect(text.match(/HIPPS/g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hospice claims never carry a HIPPS / per-diem class code", () => {
  const x12Files = walk(X12_837_SRC).filter((f) => isSource(f) && !isTestFile(f));

  it("auto-discovers the outbound x12 client builders", () => {
    expect(x12Files.length).toBeGreaterThan(5);
    expect(x12Files.some((f) => f.endsWith(join("claims", "build-837i-claim.ts")))).toBe(true);
  });

  it.each([...OUTBOUND_FILES, ...x12Files].map((f) => [rel(f), f]))(
    "outbound builder %s names neither HIPPS nor the internal per-diem class code",
    (_name, file) => {
      expect(code(file as string)).not.toMatch(PER_DIEM_CLASS_NAME);
    },
  );

  it("the claim_line table has no per-diem class / HIPPS column", () => {
    expect(code(join(DB_BILLING_SCHEMA, "claim-line.ts"))).not.toMatch(PER_DIEM_CLASS_NAME);
  });

  it("the claim table has no per-diem class / HIPPS column", () => {
    expect(code(join(DB_BILLING_SCHEMA, "claim.ts"))).not.toMatch(PER_DIEM_CLASS_NAME);
  });

  it("the `hipps` name no longer appears in billing source, the M23 schema, the backend module or the web app (migration 1069)", () => {
    const roots = [BILLING_SRC, DB_BILLING_SCHEMA, BACKEND_M23_SRC, WEB_SRC];
    const offenders = [...roots.flatMap(walk), ...BACKEND_ROOT_FILES]
      .filter((f) => isSource(f) && !isTestFile(f) && !LEGACY_ALIAS_FILES.has(f))
      .filter((f) => HIPPS_NAME.test(code(f)) || HIPPS_NAME.test(f));
    expect(offenders.map(rel)).toEqual([]);
  });
});
