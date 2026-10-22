// The backfill CLI's argument handling. Every case must be refused (exit 1) BEFORE any connection is opened, so these run with no
// database and no environment: a bad flag can never reach a table.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const CLI = join(__dirname, "../../../scripts/db/backfill-crypto-labels.ts");
const cli = (...args: string[]) =>
  spawnSync("bun", ["run", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    encoding: "utf8",
  });

// each case starts a bun process; give them room when the whole suite runs in parallel
vi.setConfig({ testTimeout: 30_000 });

describe("backfill-crypto-labels argument validation", () => {
  it.each([
    [["--verify", "--all-orgs", "--batch-size", "0"], /--batch-size must be an integer >= 1/],
    [["--verify", "--all-orgs", "--max-rows", "0"], /--max-rows must be an integer >= 1/],
    [["--verify", "--all-orgs", "--batch-size", "-3"], /--batch-size/],
    [["--verify", "--all-orgs", "--max-rows", "1.5"], /--max-rows/],
    [["--verify", "--all-orgs", "--pause-ms", "abc"], /--pause-ms/],
    [["--verify", "--all-orgs", "--batch-size"], /--batch-size needs a value/],
    [["--verify", "--all-orgs", "--max-rows"], /--max-rows needs a value/],
    [["--verify", "--all-orgs", "--pause-ms"], /--pause-ms needs a value/],
    [["--verify", "--batch-size", "--all-orgs"], /--batch-size needs a value/],
    [["--verify", "--module", "--all-orgs"], /--module needs a value/],
    [["--verify", "--all-orgs", "--batch-size", "5", "--batch-size", "6"], /given twice/],
    [["--verify", "--all-orgs", "--nope"], /unknown flag/],
    [["--verify", "--all-orgs", "stray"], /unexpected argument/],
    [
      ["--verify", "--all-orgs", "--org", "11111111-1111-4111-8111-111111111111"],
      /exactly one of --org/,
    ],
    [["--verify"], /exactly one of --org/],
    [["--verify", "--dry-run", "--all-orgs"], /exactly one of --verify/],
    [["--all-orgs"], /exactly one of --verify/],
  ])("%j is a usage error (exit 1)", (args, message) => {
    const r = cli(...args);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(message);
    expect(r.stdout).toBe("");
  });

  it("accepts the smallest valid values past parsing (it then stops only for the missing database)", () => {
    const r = cli(
      "--verify",
      "--all-orgs",
      "--batch-size",
      "1",
      "--max-rows",
      "1",
      "--pause-ms",
      "0",
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DATABASE_URL and DATABASE_PLATFORM_URL are required/);
  });
});
