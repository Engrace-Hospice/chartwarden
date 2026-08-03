// Fitness-gate self-test (PHASE_0_SCAFFOLD_PLAN.md PR-0.5 — audit item #8).
// The kit's whole value is that the gates ENFORCE. For each gate we assert it goes RED
// on a planted single-violation fixture (scripts/__fixtures__/<gate>/) and stays GREEN on
// the real repo-root baseline. Fixtures live outside every gate's real scan set, so they
// never affect the baseline.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPTS = join(ROOT, "scripts");
const FIX = join(SCRIPTS, "__fixtures__");
const DEPCRUISE = join(ROOT, "node_modules", ".bin", "depcruise");
const CFG = join(ROOT, "architecture", ".dependency-cruiser.cjs");

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const gate = (script: string, cwd: string) => run("bun", ["run", join(SCRIPTS, script)], cwd);
const boundaries = (paths: string[], cwd: string) =>
  run(DEPCRUISE, [...paths, "--config", CFG], cwd);

describe("each gate goes RED on its planted violation", () => {
  it("tenancy — PHI table missing organization_id", () => {
    const r = gate("check-tenancy.ts", join(FIX, "tenancy"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/missing-organization_id/);
  });

  it("table-ownership — cross-module schema access", () => {
    const r = gate("check-table-ownership.ts", join(FIX, "table-ownership"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/medication_order/);
    // TASK-014/ARCH-017 — the `schema.<table>` namespace-binding style (`leak-namespace.ts`) must be
    // caught too, not just the named-import style (`leak.ts`): both files should be named.
    expect(r.out).toMatch(/leak\.ts/);
    expect(r.out).toMatch(/leak-namespace\.ts/);
  });

  it("ddl-legality — duplicate enum", () => {
    const r = gate("check-ddl-legality.ts", join(FIX, "ddl"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/duplicate-enum/);
  });

  it("fitness-gaps — event name without mN. prefix", () => {
    const r = gate("check-fitness-gaps.ts", join(FIX, "gaps"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/event-naming/);
  });

  it("fitness-gaps — seam consumed via an aliased getSeam cast, not registered anywhere (ARCH-018)", () => {
    // Same fixture root as above (the gate runs all three sub-checks together); this asserts the
    // seam-registry violation specifically. A module-local `M99_REQUIRED_SEAMS` array must NOT be
    // mistaken for the canonical registry, and `rawSeam("TotallyUnregisteredSeam")` (an alias-cast
    // call, not a literal `getSeam("...")`) must still be caught as consumed-but-unregistered.
    const r = gate("check-fitness-gaps.ts", join(FIX, "gaps"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/seam-unregistered/);
    expect(r.out).toMatch(/TotallyUnregisteredSeam/);
    expect(r.out).not.toMatch(/SomeSeamNobodyReallyRegisters/);
  });

  it("boundaries — domain leaf importing packages/db", () => {
    const r = boundaries(["packages"], join(FIX, "boundaries"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/domain-is-pure/);
  });

  // The M20-T06 hole: `openapi:check` only proves openapi.json was REGENERATED and that no
  // enrichment targets a dead route — an unenriched route is legal, so a routes task could
  // ship 30+ contract-less routes with all gates green. The fixture plants exactly one such
  // route; the module has no baseline row, so its floor is 0 and the ratchet must catch it.
  it("openapi-coverage — a new route shipped with no request contract", () => {
    const r = run(
      "bun",
      ["run", join(SCRIPTS, "report-openapi-coverage.ts"), "--check"],
      join(FIX, "openapi-coverage"),
    );
    expect(r.status).not.toBe(0);
    // Must fail on the RATCHET, not merely on report staleness — the fixture commits a
    // fresh report precisely so a freshness failure cannot masquerade as coverage enforcement.
    expect(r.out).toMatch(/LOST enrichment coverage/);
    expect(r.out).toMatch(/exceeds baseline 0/);
  });
});

describe("every gate stays GREEN on the repo-root baseline", () => {
  it("scaffold-parity", () =>
    expect(
      run("bun", ["run", join(SCRIPTS, "scaffold-from-manifest.ts"), "--check"], ROOT).status,
    ).toBe(0));
  it("table-ownership", () => expect(gate("check-table-ownership.ts", ROOT).status).toBe(0));
  it("tenancy", () => expect(gate("check-tenancy.ts", ROOT).status).toBe(0));
  it("ddl-legality", () => expect(gate("check-ddl-legality.ts", ROOT).status).toBe(0));
  it("fitness-gaps", () => expect(gate("check-fitness-gaps.ts", ROOT).status).toBe(0));
  it("ui-screens", () => expect(gate("check-ui-screens.ts", ROOT).status).toBe(0));
  it("boundaries", () => expect(boundaries(["apps", "packages"], ROOT).status).toBe(0));
  it("openapi-coverage", () =>
    expect(
      run("bun", ["run", join(SCRIPTS, "report-openapi-coverage.ts"), "--check"], ROOT).status,
    ).toBe(0));
});
