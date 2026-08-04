// apps/backend/src/modules/29-external-interfaces/__tests__/m29-adapter-mandate.test.ts — M29-T09 (§8.5).
//
// The in-suite arm of the adapter-mandate compliance statement (ARCHITECTURE §25.14, M29 spec §8.5). The
// authoritative enforcement is the dependency-cruiser ruleset (`arch:boundaries`: no-m29-schema-import-from-
// other-modules, no-m29-import-of-cross-module-schemas, no-direct-xero-gusto-import-from-m29); this test is a
// fast, co-located guardrail that fails the module's own suite the moment a source file reaches across an
// adapter boundary — before the arch gate runs. It scans every M29 source file (never a test) for a
// forbidden import specifier:
//
//   1. §8.5.1 — no direct import of the M27-owned Xero / Gusto adapter packages (Phase-2 seam consumers).
//   2. §8.6   — no direct import of the Anthropic SDK: M29 invokes NO AI surface (the 5-level cascade is
//               deterministic by design; probabilistic matching is a Phase-2 M32 seam).
//   3. §8.5.4 — no deep import of another module's Drizzle schema: cross-module reads flow through the
//               published seams (PatientReader, etc.) and the M4 outbox, never a direct cross-schema SELECT.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every M29 source file (recursive), excluding the test suite itself. */
function m29SourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(MODULE_ROOT);
  return out;
}

/** import/from/require specifiers referenced by a source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import|require\()\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    if (m[1]) specs.push(m[1]);
    m = re.exec(source);
  }
  return specs;
}

describe("M29 adapter-mandate compliance (§8.5, ARCHITECTURE §25.14)", () => {
  const files = m29SourceFiles();

  it("scans a non-trivial M29 source surface (guards against an empty-glob false pass)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("§8.5.1 — no source imports the M27-owned Xero / Gusto adapter packages directly", () => {
    const offenders = files.filter((f) =>
      importSpecifiers(readFileSync(f, "utf8")).some(
        (s) => s === "@wardenx/xero-client" || s === "@wardenx/gusto-client",
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("§8.6 — no source imports the Anthropic SDK: M29 invokes no AI surface", () => {
    const offenders = files.filter((f) =>
      importSpecifiers(readFileSync(f, "utf8")).some((s) => s.startsWith("@anthropic-ai/")),
    );
    expect(offenders).toEqual([]);
  });

  it("§8.5.4 — no source deep-imports another module's Drizzle schema (seams + outbox only)", () => {
    // The db barrel (`@wardenx/db`, `@wardenx/db/schema`) is legal; a deep reach into a NAMED foreign
    // per-module schema dir is the adapter-mandate breach.
    const forbidden = /@wardenx\/db\/schema\/(?!external-interfaces)[a-z]/;
    const offenders = files.filter((f) =>
      importSpecifiers(readFileSync(f, "utf8")).some((s) => forbidden.test(s)),
    );
    expect(offenders).toEqual([]);
  });
});
