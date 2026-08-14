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

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string | undefined>) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : undefined,
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const gate = (script: string, cwd: string) => run("bun", ["run", join(SCRIPTS, script)], cwd);
const boundaries = (paths: string[], cwd: string) =>
  run(DEPCRUISE, [...paths, "--config", CFG], cwd);

// check-design-tokens.ts roots itself off its OWN file location (import.meta.url), not cwd — by
// design, so it always validates the real repo regardless of the caller's working directory. That
// means the cwd-swap trick every other fixture here uses can't point it at a fixture tree; instead
// the script honors a test-only WARDENX_FITNESS_ROOT env override (unset in every real invocation).
const designTokensGate = (fixtureRoot: string) =>
  run("bun", ["run", join(SCRIPTS, "check-design-tokens.ts")], ROOT, {
    WARDENX_FITNESS_ROOT: fixtureRoot,
  });

// client:check (package.json) is a raw shell pipeline, not a standalone script file, so it needs
// its own runner rather than gate(). The openapi-typescript binary is invoked by absolute path
// (not through `bun run`, which would resolve node_modules/.bin against the wrong tree) and the
// diff target is a fixture-dedicated tmp file so a concurrent real `client:check` run never races it.
const OPENAPI_TS_BIN = join(ROOT, "node_modules", ".bin", "openapi-typescript");
const clientCheck = (cwd: string, outFile: string) =>
  run(
    "bash",
    [
      "-c",
      `${OPENAPI_TS_BIN} docs/api/openapi.json -o ${outFile} && diff -q packages/ui/src/core/api/schema.ts ${outFile} || (echo 'FAIL packages/ui/src/core/api/schema.ts is out of date. Run: bun run client:gen' && exit 1)`,
    ],
    cwd,
  );

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

  // TASK-050D (TEST-005) — the 4 highest-value gates with no planted-violation self-test.

  it("abac-predicates — requireAbac names a predicate nothing declares", () => {
    const r = gate("check-abac-predicates.ts", join(FIX, "abac-predicates"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/NOTHING declares/);
    expect(r.out).toMatch(/totally_unregistered_predicate/);
  });

  it("design-tokens — raw hex literal in render code", () => {
    const r = designTokensGate(join(FIX, "design-tokens"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/raw-color-in-render/);
    expect(r.out).toMatch(/bad-component\.tsx/);
  });

  it("ui-parity — a screens.ts that exists but main.tsx never registers", () => {
    const r = run(
      "bun",
      ["run", join(SCRIPTS, "report-ui-parity.ts"), "--check"],
      join(FIX, "ui-parity"),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/UNREGISTERED SCREENS/);
    expect(r.out).toMatch(/99-fixture/);
  });

  it("org-index coverage — organization_id present but past the seekable prefix", () => {
    const r = gate("check-org-index-coverage.ts", join(FIX, "org-indexes"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/fixture_uncovered_note/);
    // The COVERED sibling must not be flagged — the fixture's whole point is that the gate
    // discriminates by key POSITION, not by whether organization_id is mentioned at all.
    expect(r.out).not.toMatch(/fixture_covered_note/);
  });

  it("client:check — schema.ts stale relative to openapi.json", () => {
    const r = clientCheck(join(FIX, "client-check"), "/tmp/wardenx-client-schema-fixture-red.ts");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAIL/);
    expect(r.out).toMatch(/out of date/);
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
  it("abac-predicates", () => expect(gate("check-abac-predicates.ts", ROOT).status).toBe(0));
  it("org-index coverage", () => expect(gate("check-org-index-coverage.ts", ROOT).status).toBe(0));
  it("design-tokens", () => expect(gate("check-design-tokens.ts", ROOT).status).toBe(0));
  it("ui-parity", () =>
    expect(run("bun", ["run", join(SCRIPTS, "report-ui-parity.ts"), "--check"], ROOT).status).toBe(
      0,
    ));
  it("client:check", () =>
    expect(clientCheck(ROOT, "/tmp/wardenx-client-schema-fixture-green.ts").status).toBe(0));
});
