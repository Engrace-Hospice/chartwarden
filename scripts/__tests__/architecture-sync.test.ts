import { describe, expect, it } from "vitest";
import {
  type BridgeRoute,
  type Doc,
  type ManifestModule,
  checkAdrReflection,
  checkBuildOrderDeps,
  checkModuleCounts,
  checkModuleIds,
  checkRustMatrix,
  checkTableOwnership,
  parseBridgeRoutes,
  parseProductionRust,
} from "../lib/architecture-sync";

const doc = (text: string, file = "docs/architecture/X.md"): Doc => ({ file, text });
const mod = (id: number, dependsOn: number[], ownedTables: string[] = []): ManifestModule => ({
  id,
  dependsOn,
  ownedTables,
});
const rules = (fs: readonly { rule: string }[]): string[] => fs.map((f) => f.rule);
const messages = (fs: readonly { message: string }[]): string =>
  fs.map((f) => f.message).join("\n");

describe("checkModuleCounts", () => {
  it("flags a total-count claim that differs from the manifest", () => {
    const out = checkModuleCounts([doc("## 11. Module Catalog — All 40 Modules")], 41);
    expect(rules(out)).toEqual(["COUNT"]);
    expect(out[0]?.message).toContain("40");
  });

  it("accepts the right total, and ignores phase counts and estimates", () => {
    const text = [
      "Phase 1 module count: 29 of 41 modules",
      "**Phase 2 module count: 15 modules (some new)**",
      "the prior 26-module estimate",
      "## Modules (41)",
    ].join("\n");
    expect(checkModuleCounts([doc(text)], 41)).toEqual([]);
  });

  it("flags a stale README heading", () => {
    expect(rules(checkModuleCounts([doc("## Modules (40)")], 41))).toEqual(["COUNT"]);
  });
});

const ARCH = (catalog: string, build: string): Doc =>
  doc(
    `## 11. Module Catalog\n${catalog}\n## 12. Worker Services\n## 20. Build Sequence\n${build}\n**Critical scheduling notes:**`,
  );

describe("checkModuleIds", () => {
  const catalog = "#### Module 1 — A\n#### Module 2 — B\n";
  const build = "|1 |A|—|\n|2 |B|1|\n";

  it("passes when catalog and build rows are exactly the manifest ids", () => {
    expect(checkModuleIds(ARCH(catalog, build), new Set([1, 2]))).toEqual([]);
  });

  it("reports a module missing from both lists, and one the manifest lacks", () => {
    const text = messages(checkModuleIds(ARCH(catalog, build), new Set([1, 3])));
    expect(text).toMatch(/§11 catalog has no entry.*3/);
    expect(text).toMatch(/§20 build sequence lists module\(s\) 2/);
  });

  it("fails closed when a section marker has moved", () => {
    expect(rules(checkModuleIds(doc("no sections"), new Set([1])))).toEqual(["IDS", "IDS"]);
  });
});

describe("checkBuildOrderDeps", () => {
  const withRows = (rows: string, divergences = ""): Doc => ARCH("", `${rows}\n${divergences}`);

  it("treats the implicit M1 edge as agreement", () => {
    const out = checkBuildOrderDeps(withRows("|5 |P|2, 3|"), [mod(5, [1, 2, 3])]);
    expect(out).toEqual([]);
  });

  it("flags drift that no divergence row records", () => {
    const out = checkBuildOrderDeps(withRows("|17|S|5, 8|"), [mod(17, [1, 5, 8, 36])]);
    expect(rules(out)).toEqual(["DEPS"]);
    expect(out[0]?.message).toContain("[5,8,36]");
  });

  it("accepts drift recorded in the divergence table with the manifest's value", () => {
    const rows = "|9 |A|8, 38|";
    const div = "> | 9 Assessments | 8, 38 | 1, 38 | reason |";
    expect(checkBuildOrderDeps(withRows(rows, div), [mod(9, [1, 38])])).toEqual([]);
  });

  it("flags a stale divergence row once §20 and the manifest agree", () => {
    const rows = "|9 |A|38|";
    const div = "> | 9 Assessments | 8, 38 | 1, 38 | reason |";
    const out = checkBuildOrderDeps(withRows(rows, div), [mod(9, [1, 38])]);
    expect(messages(out)).toContain("stale divergence row");
  });

  it("flags a divergence row that cites outdated manifest deps", () => {
    const rows = "|9 |A|8, 38|";
    const div = "> | 9 Assessments | 8, 38 | 1, 36 | reason |";
    const out = checkBuildOrderDeps(withRows(rows, div), [mod(9, [1, 38])]);
    expect(messages(out)).toContain("cites manifest deps");
  });

  it("accepts a '(see manifest)' divergence and skips free-text cells", () => {
    const rows = "|35|B|34|\n|33|R|all clinical modules|";
    const div = "> | 35 Billing | 34 | (see manifest) | reason |";
    const out = checkBuildOrderDeps(withRows(rows, div), [mod(35, [1]), mod(33, [1, 5])]);
    expect(out).toEqual([]);
  });
});

describe("checkTableOwnership", () => {
  const modules = [mod(4, [], ["state_retention_override"]), mod(39, [], ["consent_record"])];

  it("flags a table attributed to the wrong module", () => {
    const text = "`state_retention_override` is owned by Module 39.";
    expect(rules(checkTableOwnership([doc(text)], modules))).toEqual(["OWNERSHIP"]);
  });

  it("accepts the manifest owner and ignores tables the manifest does not list", () => {
    const text = "`state_retention_override` owned by **Module 4**\n`unknown_table` owned by M9";
    expect(checkTableOwnership([doc(text)], modules)).toEqual([]);
  });
});

describe("checkAdrReflection", () => {
  const adrs = [
    { number: "0001", accepted: true },
    { number: "0002", accepted: true },
    { number: "0003", accepted: false },
  ];
  const docs = [doc("see ADR-0001")];

  it("requires a new Accepted ADR to be cited or baselined", () => {
    const out = checkAdrReflection(adrs, docs, []);
    expect(out.map((f) => f.where)).toEqual(["ADR-0002"]);
  });

  it("passes when the uncited Accepted ADR is baselined (a Proposed ADR needs nothing)", () => {
    expect(checkAdrReflection(adrs, docs, ["0002"])).toEqual([]);
  });

  it("ratchets: a baseline entry that is now cited, or not Accepted, must be removed", () => {
    const cited = checkAdrReflection(adrs, docs, ["0001", "0002"]);
    expect(cited.map((f) => f.where)).toEqual(["ADR-0001"]);
    const proposed = checkAdrReflection(adrs, docs, ["0002", "0003"]);
    expect(proposed.map((f) => f.where)).toEqual(["ADR-0003"]);
  });
});

const CONFIG = `export const RUST_BRIDGE_ROUTES = {
  "me-permissions": { method: "GET", path: "/api/v1/me/permissions" },
} as const;`;
const COMPOSE_OFF = `      RUST_ROUTES: ""\n      RUST_ROUTE_MODE: shadow\n`;
const COMPOSE_SHADOW = `      RUST_ROUTES: "me-permissions"\n      RUST_ROUTE_MODE: shadow\n`;
const matrix = (row: string): Doc =>
  doc(
    `### 1.4 Bun/Rust API ownership matrix (CW-RUST-M02)\n\n| Route key | Request | Status | Production mode |\n|---|---|---|---|\n${row}\n\n---\n## 2. Next`,
  );
const ROW_OFF = "| `me-permissions` | GET /api/v1/me/permissions | tested | off |";
const routes = (): BridgeRoute[] => parseBridgeRoutes(CONFIG);
const off = () => parseProductionRust(COMPOSE_OFF);

describe("Rust ownership matrix", () => {
  it("reads the bridge's route table and the production literals", () => {
    expect(routes()).toEqual([
      { key: "me-permissions", method: "GET", path: "/api/v1/me/permissions" },
    ]);
    expect(parseProductionRust(COMPOSE_SHADOW)).toEqual({
      routes: ["me-permissions"],
      mode: "shadow",
    });
    expect(parseProductionRust("RUST_ROUTES: ${X}\n")).toBeNull();
  });

  it("passes when the matrix mirrors the bridge and production", () => {
    expect(checkRustMatrix(matrix(ROW_OFF), routes(), off())).toEqual([]);
  });

  it("flags a bridge route the matrix lacks, and a matrix row the bridge lacks", () => {
    expect(messages(checkRustMatrix(matrix(""), routes(), off()))).toContain("has no row");
    const extra = matrix(`${ROW_OFF}\n| \`orders-list\` | GET /api/v1/orders | planned | off |`);
    expect(messages(checkRustMatrix(extra, routes(), off()))).toContain(
      "orders-list is not a route",
    );
  });

  it("flags a matrix that understates production (live in compose, matrix says off)", () => {
    const out = checkRustMatrix(matrix(ROW_OFF), routes(), parseProductionRust(COMPOSE_SHADOW));
    expect(messages(out)).toContain('runs in mode "shadow"');
  });

  it("flags a status that contradicts the mode, and an unknown status", () => {
    const wrongPair = "| `me-permissions` | GET /api/v1/me/permissions | production-active | off |";
    expect(messages(checkRustMatrix(matrix(wrongPair), routes(), off()))).toContain(
      "production-active goes with",
    );
    const unknown = "| `me-permissions` | GET /api/v1/me/permissions | shipped | off |";
    expect(messages(checkRustMatrix(matrix(unknown), routes(), off()))).toContain(
      'status "shipped"',
    );
  });

  it("fails closed without the section, or when compose is not a literal", () => {
    expect(rules(checkRustMatrix(doc("nothing"), routes(), null))).toEqual(["RUST"]);
    expect(messages(checkRustMatrix(matrix(ROW_OFF), routes(), null))).toContain("not literals");
  });
});
