// WP 3.6 - an IDG discussion can never complete an IDG meeting or change the plan of care. Static guard: the IDG code
// (backend idg/, the one route + its schema, and any web idg-* file) imports no other module, writes nothing, calls no
// seam, publishes nothing, and no M36 source names the M14 command event. The behavioural twin is
// m36-idg-coordination.live.test.ts (before/after on the real tables and the outbox).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULES } from "../../../architecture/module-manifest";

const ROOT = join(__dirname, "../../..");
const M36 = join(ROOT, "apps/backend/src/modules/36-messaging");
const WEB = join(ROOT, "apps/web/src/modules/36-messaging");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const isSource = (f: string) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const backendFiles = [
  ...walk(join(M36, "idg")),
  join(M36, "routes/idg-discussion-routes.ts"),
  join(M36, "routes/idg-discussion-typebox.ts"),
].filter(isSource);
// Web files exist once the web slice lands; the rules apply to them from then on.
const webFiles = walk(WEB).filter((f) => /\/(use-)?idg-[^/]*$/.test(f) && isSource(f));
const files = [...backendFiles, ...webFiles].map((path) => ({
  path,
  raw: readFileSync(path, "utf8"),
  src: strip(readFileSync(path, "utf8")),
}));

describe("WP 3.6 IDG discussions are read-only toward M14 and M7", () => {
  it("scans the backend files it means to", () => {
    expect(backendFiles.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("$path imports no other module (rule a)", ({ src }) => {
    const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of specs) {
      expect(spec).not.toMatch(/\/modules\/(?!36-messaging)\d{2}-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(?!bootstrap)\d{2}-/);
      expect(spec).not.toMatch(/^@wardenx\/idg(\/|$)/);
    }
  });

  it.each(files)("$path performs no insert, update or delete (rule b)", ({ src }) => {
    expect(src).not.toMatch(/\.(insert|update|delete)\(/);
  });

  it.each(files)("$path calls no seam and publishes nothing (rule c, e)", ({ src }) => {
    expect(src).not.toMatch(/getSeam\(/);
    expect(src).not.toMatch(/\b(outbox|publisher)\b[\s\S]{0,40}\.publish\(/);
    expect(src).not.toMatch(/["'`](m14|m7|idg)\.[a-z_.]+["'`]/);
  });

  it.each(files)("$path never uses the banned wording or writes a header", ({ raw, src }) => {
    expect(raw.toLowerCase()).not.toContain("acknowledg");
    expect(src).not.toMatch(/request\.headers\[/);
  });

  it("the web IDG files only read: client.GET, never POST/PUT/PATCH/DELETE (rule d)", () => {
    for (const { src } of files.filter((f) => f.path.startsWith(WEB))) {
      expect(src).not.toMatch(/\.(POST|PUT|PATCH|DELETE)\(/);
    }
  });

  it("registers exactly one route and it is a GET", () => {
    const routes = strip(readFileSync(join(M36, "routes/idg-discussion-routes.ts"), "utf8"));
    expect([...routes.matchAll(/app\.(get|post|put|patch|delete)\(/g)].map((m) => m[1])).toEqual([
      "get",
    ]);
  });

  it("no M36 source names the M14 command event idg.decision_recorded (rule e)", () => {
    const all = [...walk(M36), ...walk(join(ROOT, "packages/messaging/src")), ...walk(WEB)].filter(
      isSource,
    );
    const offenders = all.filter((f) =>
      strip(readFileSync(f, "utf8")).includes("idg.decision_recorded"),
    );
    expect(offenders).toEqual([]);
  });

  it("the M36 manifest entry depends on neither M7 nor M14 (rule f)", () => {
    const m36 = MODULES.find((m) => m.id === 36);
    expect(m36).toBeDefined();
    expect(m36?.dependsOn).not.toContain(7);
    expect(m36?.dependsOn).not.toContain(14);
  });
});
