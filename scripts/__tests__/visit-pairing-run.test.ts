import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ROWS, MAX_ROWS_CEILING, parseRunArgs } from "../lib/visit-pairing-run";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("parseRunArgs (CW-PI-04 reconciliation CLI)", () => {
  it("defaults to a dry run with the conservative cap and every tenant", () => {
    const parsed = parseRunArgs([]);
    expect(parsed).toEqual({
      ok: true,
      args: { apply: false, maxRows: DEFAULT_MAX_ROWS, orgIds: null, operator: "" },
    });
    expect(DEFAULT_MAX_ROWS).toBeLessThanOrEqual(50);
  });

  it("applies only with --apply, and then requires an operator label", () => {
    expect(parseRunArgs(["--apply"])).toEqual({
      ok: false,
      message: "--apply requires --operator <label> (recorded in the audit trail)",
    });
    expect(parseRunArgs(["--apply", "--operator", "ops-jane", "--max-rows", "5"])).toEqual({
      ok: true,
      args: { apply: true, maxRows: 5, orgIds: null, operator: "ops-jane" },
    });
  });

  it("limits to the named tenants, de-duplicated and lower-cased", () => {
    const parsed = parseRunArgs(["--org", ORG.toUpperCase(), "--org", ORG]);
    expect(parsed.ok && parsed.args.orgIds).toEqual([ORG]);
  });

  it.each([
    [["--max-rows", "0"]],
    [["--max-rows", "-3"]],
    [["--max-rows", "2.5"]],
    [["--max-rows", String(MAX_ROWS_CEILING + 1)]],
    [["--max-rows"]],
    [["--org", "not-a-uuid"]],
    [["--operator", "Jane Doe; rm -rf"]],
    [["--delete"]],
    [["--org", "--apply"]],
  ])("refuses %j", (argv) => {
    expect(parseRunArgs(argv).ok).toBe(false);
  });
});
