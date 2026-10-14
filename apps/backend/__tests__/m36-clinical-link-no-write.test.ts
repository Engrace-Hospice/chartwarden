// WP 3.2 - a link to a record CANNOT modify it. Static guard over every M36 clinical-link file and the one route file:
// they may import and call only the read contract (`ClinicalLinkSource.linkSummary`), never a write method of a source
// seam, and the resolve route is GET only.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const M36 = join(__dirname, "../src/modules/36-messaging");
const FILES = [
  ...readdirSync(join(M36, "clinical-link"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(M36, "clinical-link", f)),
  join(M36, "routes/clinical-link-routes.ts"),
  join(M36, "routes/clinical-link-typebox.ts"),
];
const WRITE_VERBS =
  /\.(create|update|upsert|delete|remove|insert|save|set|put|post|patch|sign|cancel|discontinue|activate|complete|approve|reject|submit|transition|record|write|publish|enqueue|emit|send|prescribe|order)[A-Za-z]*\(/;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("WP 3.2 clinical links are read-only toward the source modules", () => {
  it("scans the files it means to", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(5);
  });

  it("only ever reaches a source seam through getSeam(...) as a ClinicalLinkSource, and calls only linkSummary", () => {
    for (const file of FILES) {
      const src = strip(readFileSync(file, "utf8"));
      const seamCalls = [...src.matchAll(/getSeam\(([^)]*)\)/g)];
      if (file.endsWith("link-sources.ts")) {
        expect(seamCalls).toHaveLength(1);
        // Typed as the read-only ClinicalLinkSource, with no cast that could widen it to a write-capable seam type.
        expect(src).toContain("): ClinicalLinkSource =>");
        expect(src).not.toContain("as unknown as");
      } else {
        expect(seamCalls, file).toHaveLength(0);
      }
    }
  });

  it("imports no other module: only link-sources.ts touches the bootstrap seam registry", () => {
    for (const file of FILES) {
      const src = strip(readFileSync(file, "utf8"));
      expect(src, file).not.toMatch(/from "\.\.\/\.\.\/\d\d-/);
      if (!file.endsWith("link-sources.ts"))
        expect(src, file).not.toMatch(/bootstrap\/(index|seams)/);
    }
  });

  it("calls no write-shaped method on the source ports or any seam", () => {
    for (const file of FILES) {
      const src = strip(readFileSync(file, "utf8"));
      // The only method calls on ports / sources are `.summary(` and `.linkSummary(`.
      for (const m of src.matchAll(
        /\b(ports|sources|deps\.sources|sourceOf\([^)]*\))\.([A-Za-z]+)\(/g,
      )) {
        expect(["summary", "linkSummary"], `${file}: ${m[0]}`).toContain(m[2]);
      }
      // The store writes M36's OWN clinical_link table (tx.insert/delete); it holds no seam, checked above.
      if (file.endsWith("clinical-link-store-db.ts")) continue;
      expect(src.match(WRITE_VERBS)?.[0] ?? null, file).toBeNull();
    }
  });

  it("registers no mutating route for clinical links", () => {
    const routes = strip(readFileSync(join(M36, "routes/clinical-link-routes.ts"), "utf8"));
    expect(routes).toMatch(/app\.get\(\s*"\/api\/v1\/messaging\/clinical-links\/:linkId\/resolve"/);
    expect(routes).not.toMatch(/app\.(post|put|patch|delete)\(/);
  });

  it("the source port type has no write member", () => {
    const src = readFileSync(join(M36, "clinical-link/clinical-link-service.ts"), "utf8");
    const block = src.slice(src.indexOf("export interface ClinicalLinkSourcePorts"));
    const members = [...block.slice(0, block.indexOf("\n}")).matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map(
      (m) => m[1],
    );
    expect(members).toEqual(["summary"]);
  });
});
