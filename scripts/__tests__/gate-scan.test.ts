import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ModuleDef } from "../../architecture/module-manifest";
import {
  moduleForPath,
  parseCreateTables,
  parsePgTables,
  stripSqlComments,
  walkFiles,
} from "../lib/gate-scan";

describe("walkFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "gate-scan-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "src", "dist"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "a.test.ts"), "");
  writeFileSync(join(root, "src", "deep", "b.ts"), "");
  writeFileSync(join(root, "src", "dist", "c.ts"), "");

  it("recurses, skips named dirs and filters files", () => {
    const files = walkFiles("src", {
      base: root,
      skipDirs: ["dist"],
      include: (name) => !name.includes(".test."),
    });
    expect(files.sort()).toEqual([join("src", "a.ts"), join("src", "deep", "b.ts")]);
  });

  it("treats a missing root as empty unless told it must exist", () => {
    expect(walkFiles(join(root, "nope"))).toEqual([]);
    expect(() => walkFiles(join(root, "nope"), { mustExist: true })).toThrow();
  });
});

describe("stripSqlComments", () => {
  it("lets whichever comment opens first win", () => {
    expect(stripSqlComments("a -- see /* x\nb */ c").replace(/\s+/g, " ")).toBe("a b */ c");
    expect(stripSqlComments("a /* -- */ b").replace(/\s+/g, " ")).toBe("a b");
  });
});

describe("parseCreateTables", () => {
  it("reads names, quotes, schemas and partition children", () => {
    const sql = `
      CREATE TABLE evt (id int) PARTITION BY RANGE (at);
      CREATE TABLE IF NOT EXISTS "Quoted" (id int);
      create table public.plain(id int);
      CREATE TABLE evt_2026 PARTITION OF evt FOR VALUES FROM (1) TO (2);`;
    expect(parseCreateTables(sql).map((t) => [t.name, t.isPartition])).toEqual([
      ["evt", false],
      ["Quoted", false],
      ["plain", false],
      ["evt_2026", true],
    ]);
  });
});

describe("parsePgTables", () => {
  it("reads exported pgTable definitions", () => {
    const src = `export const visits = pgTable("visit", {});\nconst hidden = pgTable('x', {});`;
    expect(parsePgTables(src)).toEqual([{ constName: "visits", sqlName: "visit" }]);
  });
});

describe("moduleForPath", () => {
  const mod = (id: number, codePaths: string[]): ModuleDef => ({
    id,
    name: `m${id}`,
    codePaths,
    dependsOn: [],
    ownedTables: [],
  });
  const modules = [mod(1, ["packages/db"]), mod(2, ["packages/db/src/special"])];

  it("matches on a path-segment boundary and prefers the most specific prefix", () => {
    expect(moduleForPath("packages/db/src/x.ts", modules)?.id).toBe(1);
    expect(moduleForPath("packages/db/src/special/x.ts", modules)?.id).toBe(2);
    expect(moduleForPath("packages/dbx/x.ts", modules)).toBeUndefined();
  });
});
