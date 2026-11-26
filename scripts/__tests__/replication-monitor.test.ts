import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The decision table of deploy/production/db-replication/replication-monitor.sh (CW-CP-01): which standby/slot state
// raises which alert at which severity (DR/BCP 5.1: >= 60 s SEV-3, >= 5 min SEV-2, >= 30 min SEV-1). `evaluate` takes
// the facts as arguments and touches no database, so it runs anywhere bash does. The real thing (a standby that stops,
// WAL that piles up, a primary that cannot be read) is proven by `bun run backup:replication-drill`.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(REPO, "deploy/production/db-replication/replication-monitor.sh");
const have = (cmd: string): boolean =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const suite = have("bash") ? describe : describe.skip;

interface Result {
  readonly status: number;
  readonly lines: readonly string[];
  readonly stderr: string;
}

function evaluate(
  facts: {
    streaming?: number;
    lagSeconds?: number;
    lagBytes?: number;
    slot?: string;
    retained?: number;
    absentFor?: number;
  },
  env: Readonly<Record<string, string>> = {},
): Result {
  const {
    streaming = 1,
    lagSeconds = 0,
    lagBytes = 0,
    slot = "reserved",
    retained = 0,
    absentFor = 0,
  } = facts;
  const res = spawnSync(
    "bash",
    [
      SCRIPT,
      "evaluate",
      ...[streaming, lagSeconds, lagBytes, slot, retained, absentFor].map(String),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } },
  );
  return {
    status: res.status ?? -1,
    lines: res.stdout.split("\n").filter(Boolean),
    stderr: res.stderr,
  };
}
const kinds = (r: Result): string[] => r.lines.map((l) => l.split("|").slice(0, 2).join(" "));

suite("replication-monitor.sh evaluate", () => {
  it("is silent for a streaming, caught-up standby on a reserved slot", () => {
    const r = evaluate({});
    expect(r.status).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it.each([
    [59, []],
    [60, ["replication.lag_high SEV-3"]],
    [299, ["replication.lag_high SEV-3"]],
    [300, ["replication.lag_high SEV-2"]],
    [1799, ["replication.lag_high SEV-2"]],
    [1800, ["replication.lag_high SEV-1"]],
  ])("grades %i s of replay lag", (lagSeconds, expected) => {
    expect(kinds(evaluate({ lagSeconds }))).toEqual(expected);
  });

  it("raises lag_high for a standby that is only bytes behind (a paused replay shows no time lag)", () => {
    expect(kinds(evaluate({ lagBytes: 268_435_456 }))).toEqual(["replication.lag_high SEV-3"]);
    expect(kinds(evaluate({ lagBytes: 268_435_455 }))).toEqual([]);
    expect(kinds(evaluate({ lagBytes: 1000 }, { REPLICATION_LAG_ALERT_BYTES: "1000" }))).toEqual([
      "replication.lag_high SEV-3",
    ]);
  });

  it.each([
    [0, []],
    [59, []],
    [60, ["replication.standby_absent SEV-3"]],
    [300, ["replication.standby_absent SEV-2"]],
    [1800, ["replication.standby_absent SEV-1"]],
  ])("grades a standby that has been absent for %i s", (absentFor, expected) => {
    expect(kinds(evaluate({ streaming: 0, absentFor }))).toEqual(expected);
  });

  it("does not grade replay lag when nothing streams (the lag of a dead walsender means nothing)", () => {
    expect(kinds(evaluate({ streaming: 0, lagSeconds: 4000, absentFor: 0 }))).toEqual([]);
  });

  it("pages a missing slot as the provisioning gap it is, without also calling the standby absent", () => {
    expect(kinds(evaluate({ streaming: 0, slot: "absent", absentFor: 9000 }))).toEqual([
      "replication.slot_missing SEV-2",
    ]);
  });

  it("pages a lost slot (SEV-1: the standby must be rebuilt) and still reports the absent standby", () => {
    expect(kinds(evaluate({ streaming: 0, slot: "lost", absentFor: 400 }))).toEqual([
      "replication.slot_lost SEV-1",
      "replication.standby_absent SEV-2",
    ]);
  });

  it("warns when the slot's WAL is about to be removed", () => {
    expect(kinds(evaluate({ slot: "unreserved" }))).toEqual(["replication.slot_wal_at_risk SEV-2"]);
  });

  it("treats a reserved and an extended slot as healthy", () => {
    expect(kinds(evaluate({ slot: "extended" }))).toEqual([]);
  });

  it("pages WAL held back by a stalled standby at the configured limit (default 2 GiB)", () => {
    expect(kinds(evaluate({ retained: 2_147_483_647 }))).toEqual([]);
    expect(kinds(evaluate({ retained: 2_147_483_648 }))).toEqual([
      "replication.slot_wal_retained SEV-3",
    ]);
    expect(
      kinds(evaluate({ retained: 5 }, { REPLICATION_SLOT_RETAINED_ALERT_BYTES: "5" })),
    ).toEqual(["replication.slot_wal_retained SEV-3"]);
  });

  it("refuses facts it cannot grade instead of staying silent", () => {
    expect(evaluate({ slot: "weird" }).status).not.toBe(0);
    const bad = spawnSync("bash", [SCRIPT, "evaluate", "1", "x", "0", "reserved", "0", "0"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/whole numbers/);
  });
});

// `check` against a stubbed psql: what the monitor does with the rows (and the failures) the real primary can produce.
const stubbed = have("bash") && have("jq") ? describe : describe.skip;
stubbed("replication-monitor.sh check (stubbed psql)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "repl-monitor-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, "bin");
  mkdirSync(bin);
  // Prints $FAKE_ROW, or fails when FAKE_PSQL_FAILS is set; stdin (the query) is drained like psql would.
  writeFileSync(
    join(bin, "psql"),
    '#!/bin/sh\ncat >/dev/null\nif [ -n "${FAKE_PSQL_FAILS:-}" ]; then exit 2; fi\necho "${FAKE_ROW:-}"\n',
  );
  chmodSync(join(bin, "psql"), 0o755);

  const check = (state: string, env: Readonly<Record<string, string>>) =>
    spawnSync("bash", [SCRIPT, "check"], {
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, REPLICATION_STATE_DIR: state, ...env },
    });
  const alerts = (out: string): string[] =>
    [...out.matchAll(/ALERT \[([a-z_.]+)\]/g)].map((m) => m[1] ?? "");

  it("is silent and records a completed pass for a healthy row", () => {
    const state = mkdtempSync(join(scratch, "ok-"));
    const res = check(state, { FAKE_ROW: "1|0|0|reserved|0" });
    expect(res.status).toBe(0);
    expect(alerts(res.stderr)).toEqual([]);
    expect(existsSync(join(state, "last-check"))).toBe(true);
  });

  it("pages monitor_blind (and exits non-zero) when the state cannot be graded, instead of passing quietly", () => {
    const state = mkdtempSync(join(scratch, "ungradable-"));
    const res = check(state, { FAKE_ROW: "1|0|0|surprising_status|0" });
    expect(res.status).toBe(1);
    expect(alerts(res.stderr)).toEqual(["replication.monitor_blind"]);
    expect(existsSync(join(state, "last-check"))).toBe(false);
  });

  it("pages monitor_blind when the primary cannot be read, once per repeat window", () => {
    const state = mkdtempSync(join(scratch, "blind-"));
    const first = check(state, { FAKE_PSQL_FAILS: "1" });
    expect(first.status).toBe(1);
    expect(alerts(first.stderr)).toEqual(["replication.monitor_blind"]);
    const second = check(state, { FAKE_PSQL_FAILS: "1" });
    expect(second.status).toBe(1);
    expect(alerts(second.stderr)).toEqual([]);
    const later = check(state, { FAKE_PSQL_FAILS: "1", REPLICATION_ALERT_REPEAT_S: "0" });
    expect(alerts(later.stderr)).toEqual(["replication.monitor_blind"]);
  });

  it("does not start the repeat window for an alert whose delivery failed", () => {
    const state = mkdtempSync(join(scratch, "undelivered-"));
    const env = {
      FAKE_ROW: "1|0|0|lost|0",
      OPS_ALERT_WEBHOOK_URL: "https://127.0.0.1:1/hook", // nothing listens: curl fails
    };
    const first = check(state, env);
    expect(first.stderr).toMatch(/alert webhook delivery failed/);
    const second = check(state, env);
    expect(alerts(second.stderr)).toEqual(["replication.slot_lost"]); // retried, not suppressed for 15 minutes
  });
});

suite("replication-monitor.sh process", () => {
  it("refuses to run without an https alert webhook (a lost standby must page someone)", () => {
    for (const url of ["", "http://alerts.example.test/hook"]) {
      const res = spawnSync("bash", [SCRIPT, "run"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", OPS_ALERT_WEBHOOK_URL: url },
        timeout: 10_000,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/OPS_ALERT_WEBHOOK_URL must be set to an https/);
    }
  });

  it("reports unhealthy when no pass has completed", () => {
    const res = spawnSync("bash", [SCRIPT, "healthcheck"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", REPLICATION_STATE_DIR: "/nonexistent/cw-replication" },
    });
    expect(res.status).not.toBe(0);
  });
});
