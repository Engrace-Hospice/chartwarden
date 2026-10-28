// #848 — the bundle-size gate must fail closed: a base-prefixed asset URL resolves under outDir,
// a missing referenced asset is a hard error, and an empty/zero-byte measurement never passes.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureInitialBundle } from "../lib/bundle-size-gate";

function dist(html: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-gate-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const tag = (p: string) => `<script type="module" src="${p}"></script>`;

describe("measureInitialBundle", () => {
  it("strips the configured base before resolving under outDir", () => {
    const d = dist(tag("/portal/assets/a.js"), { "assets/a.js": "x".repeat(100) });
    expect(measureInitialBundle(d, "/portal").total).toBe(100);
  });
  it("resolves root-based builds with an empty base", () => {
    const d = dist(tag("/assets/a.js"), { "assets/a.js": "x".repeat(10) });
    expect(measureInitialBundle(d, "").total).toBe(10);
  });
  it("throws when a referenced asset is missing", () => {
    const d = dist(tag("/portal/assets/gone.js"), {});
    expect(() => measureInitialBundle(d, "/portal")).toThrow(/gone\.js/);
  });
  it("throws when the URL is not under the configured base", () => {
    const d = dist(tag("/assets/a.js"), { "assets/a.js": "x" });
    expect(() => measureInitialBundle(d, "/portal")).toThrow(/base/);
  });
  it("throws when index.html references no scripts", () => {
    expect(() => measureInitialBundle(dist("<html></html>", {}), "")).toThrow(/nothing to measure/);
  });
  it("throws on a zero-byte total", () => {
    const d = dist(tag("/assets/a.js"), { "assets/a.js": "" });
    expect(() => measureInitialBundle(d, "")).toThrow(/zero/);
  });
  it("throws on an external asset URL", () => {
    const d = dist(tag("https://cdn.example/a.js"), {});
    expect(() => measureInitialBundle(d, "")).toThrow(/base|external/);
  });
});
