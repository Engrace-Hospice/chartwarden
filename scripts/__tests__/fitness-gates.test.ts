// Fitness-gate self-test (PHASE_0_SCAFFOLD_PLAN.md PR-0.5 — audit item #8).
// The kit's whole value is that the gates ENFORCE. For each gate we assert it goes RED
// on a planted single-violation fixture (scripts/__fixtures__/<gate>/) and stays GREEN on
// the real repo-root baseline. Fixtures live outside every gate's real scan set, so they
// never affect the baseline.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCRIPTS = join(ROOT, "scripts");
const FIX = join(SCRIPTS, "__fixtures__");
const DEPCRUISE = join(ROOT, "node_modules", ".bin", "depcruise");
const CFG = join(ROOT, "architecture", ".dependency-cruiser.cjs");
// Repo-root probes spawn separate Bun/depcruise scans and can exceed the ordinary unit-test
// ceiling on a busy workstation. Keep the allowance limited to these integration-style checks.
const BASELINE_GATE_TIMEOUT_MS = 120_000;

interface CommandResult {
  readonly status: number;
  readonly out: string;
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      stderr += error.message;
    });
    child.on("close", (status) => {
      resolve({ status: status ?? 1, out: `${stdout}${stderr}` });
    });
  });
}
const gate = (script: string, cwd: string) => run("bun", ["run", join(SCRIPTS, script)], cwd);
const boundaries = (paths: string[], cwd: string) =>
  run(DEPCRUISE, [...paths, "--config", CFG], cwd);
const expectGreen = async (result: Promise<CommandResult>) =>
  expect((await result).status).toBe(0);
const baselineGate = (name: string, fn: () => void | Promise<void>) =>
  it(name, fn, BASELINE_GATE_TIMEOUT_MS);

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
  it("tenancy — PHI table missing organization_id", async () => {
    const r = await gate("check-tenancy.ts", join(FIX, "tenancy"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/missing-organization_id/);
  });

  // F-006 (#22) — the exemption hole that hid a P0. Rule 2's audit/key-ring exemptions used to be
  // tested against the whole FILE, and the repo's own convention puts a module's RLS policies in the
  // same migration as its audit triggers (`*_rls_audit_triggers.sql`), so ONE `INSERT INTO
  // audit_event` exempted every `app.user_id` in the file — policy predicates included. That is how
  // `user_notif_pref_self` (#21, cross-tenant read AND write) sat green in `0017`.
  //
  // Run against the pre-change gate this fixture is red for the WRONG reason: it misses the
  // violation in `0001` and flags the correctly-remediated policy in `0002`. Blind where it matters,
  // noisy where it does not — so the assertions below are about WHICH policy is named, never about
  // the exit code alone.
  it("tenancy — an app.user_id policy hiding in a file that also has an audit trigger", async () => {
    const r = await gate("check-tenancy.ts", join(FIX, "tenancy-audit-exemption"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/rls-policy-not-org-scoped/);
    expect(r.out).toMatch(/fixture_note_self/);
    // The exemption must be SCOPED, not deleted: the audit trigger's own attribution GUCs are not
    // RLS predicates (M04 §3.3) and must stay silent.
    expect(r.out).not.toMatch(/rls-session-variable/);
    // A user key as a CONJUNCT beside the org predicate is the remediated shape, not a hole.
    expect(r.out).not.toMatch(/fixture_ok_self/);
    // And a violation a later migration DROPs and replaces is remediated — a text-only gate that
    // cannot see that can never go green again after a correct fix.
    expect(r.out).not.toMatch(/fixture_superseded_self/);
  });

  it("tenancy — a dynamic-SQL policy must not inherit the audit exemption either", async () => {
    // `survivingPolicies()` cannot follow a policy built inside a DO block — its documented limit,
    // and five real migrations build policies that way. The limit must stay a limit on TRACKING:
    // if the audit exemption were reachable inside such a statement, the `INSERT INTO audit_event`
    // above the policy string would exempt the `app.user_id` inside it, which is #22 one nesting
    // level down. Both occurrences are reported — the blunt, safe direction.
    const r = await gate("check-tenancy.ts", join(FIX, "tenancy-dynamic-policy"));
    expect(r.status).not.toBe(0);
    expect(r.out.match(/rls-session-variable/g) ?? []).toHaveLength(2);
    expect(r.out).toMatch(/app\.user_id/);
  });

  it("table-ownership — cross-module schema access", async () => {
    const r = await gate("check-table-ownership.ts", join(FIX, "table-ownership"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/medication_order/);
    // TASK-014/ARCH-017 — the `schema.<table>` namespace-binding style (`leak-namespace.ts`) must be
    // caught too, not just the named-import style (`leak.ts`): both files should be named.
    expect(r.out).toMatch(/leak\.ts/);
    expect(r.out).toMatch(/leak-namespace\.ts/);
  });

  it("ddl-legality — duplicate enum", async () => {
    const r = await gate("check-ddl-legality.ts", join(FIX, "ddl"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/duplicate-enum/);
  });

  it("fitness-gaps — event name without mN. prefix", async () => {
    const r = await gate("check-fitness-gaps.ts", join(FIX, "gaps"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/event-naming/);
  });

  it("fitness-gaps — seam consumed via an aliased getSeam cast, not registered anywhere (ARCH-018)", async () => {
    // Same fixture root as above (the gate runs all three sub-checks together); this asserts the
    // seam-registry violation specifically. A module-local `M99_REQUIRED_SEAMS` array must NOT be
    // mistaken for the canonical registry, and `rawSeam("TotallyUnregisteredSeam")` (an alias-cast
    // call, not a literal `getSeam("...")`) must still be caught as consumed-but-unregistered.
    const r = await gate("check-fitness-gaps.ts", join(FIX, "gaps"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/seam-unregistered/);
    expect(r.out).toMatch(/TotallyUnregisteredSeam/);
    expect(r.out).not.toMatch(/SomeSeamNobodyReallyRegisters/);
  });

  it("boundaries — domain leaf importing packages/db", async () => {
    const r = await boundaries(["packages"], join(FIX, "boundaries"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/domain-is-pure/);
  });

  // The M20-T06 hole: `openapi:check` only proves openapi.json was REGENERATED and that no
  // enrichment targets a dead route — an unenriched route is legal, so a routes task could
  // ship 30+ contract-less routes with all gates green. The fixture plants exactly one such
  // route; the module has no baseline row, so its floor is 0 and the ratchet must catch it.
  it("openapi-coverage — a new route shipped with no request contract", async () => {
    const r = await run(
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

  it("abac-predicates — requireAbac names a predicate nothing declares", async () => {
    const r = await gate("check-abac-predicates.ts", join(FIX, "abac-predicates"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/NOTHING declares/);
    expect(r.out).toMatch(/totally_unregistered_predicate/);
  });

  it("design-tokens — raw hex literal in render code", async () => {
    const r = await designTokensGate(join(FIX, "design-tokens"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/raw-color-in-render/);
    expect(r.out).toMatch(/bad-component\.tsx/);
  });

  it("ui-parity — a screens.ts that exists but main.tsx never registers", async () => {
    const r = await run(
      "bun",
      ["run", join(SCRIPTS, "report-ui-parity.ts"), "--check"],
      join(FIX, "ui-parity"),
    );
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/UNREGISTERED SCREENS/);
    expect(r.out).toMatch(/99-fixture/);
  });

  it("org-index coverage — organization_id present but past the seekable prefix", async () => {
    const r = await gate("check-org-index-coverage.ts", join(FIX, "org-indexes"));
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/fixture_uncovered_note/);
    // The COVERED sibling must not be flagged — the fixture's whole point is that the gate
    // discriminates by key POSITION, not by whether organization_id is mentioned at all.
    expect(r.out).not.toMatch(/fixture_covered_note/);
  });

  it("client:check — schema.ts stale relative to openapi.json", async () => {
    const r = await clientCheck(join(FIX, "client-check"), "/tmp/wardenx-client-schema-fixture-red.ts");
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/FAIL/);
    expect(r.out).toMatch(/out of date/);
  });
});

describe("every gate stays GREEN on the repo-root baseline", () => {
  baselineGate("scaffold-parity", () =>
    expectGreen(run("bun", ["run", join(SCRIPTS, "scaffold-from-manifest.ts"), "--check"], ROOT)));
  baselineGate("table-ownership", () => expectGreen(gate("check-table-ownership.ts", ROOT)));
  baselineGate("tenancy", () => expectGreen(gate("check-tenancy.ts", ROOT)));
  baselineGate("ddl-legality", () => expectGreen(gate("check-ddl-legality.ts", ROOT)));
  baselineGate("fitness-gaps", () => expectGreen(gate("check-fitness-gaps.ts", ROOT)));
  baselineGate("ui-screens", () => expectGreen(gate("check-ui-screens.ts", ROOT)));
  baselineGate("boundaries", () => expectGreen(boundaries(["apps", "packages"], ROOT)));
  baselineGate("openapi-coverage", () =>
    expectGreen(run("bun", ["run", join(SCRIPTS, "report-openapi-coverage.ts"), "--check"], ROOT)));
  baselineGate("abac-predicates", () => expectGreen(gate("check-abac-predicates.ts", ROOT)));
  baselineGate("org-index coverage", () => expectGreen(gate("check-org-index-coverage.ts", ROOT)));
  baselineGate("design-tokens", () => expectGreen(gate("check-design-tokens.ts", ROOT)));
  baselineGate("ui-parity", () =>
    expectGreen(run("bun", ["run", join(SCRIPTS, "report-ui-parity.ts"), "--check"], ROOT)));
  baselineGate("client:check", () =>
    expectGreen(clientCheck(ROOT, "/tmp/wardenx-client-schema-fixture-green.ts")));
});
