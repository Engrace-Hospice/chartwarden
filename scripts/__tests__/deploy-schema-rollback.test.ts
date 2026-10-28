import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// #861 (CW-QA-0017) — fault injection for deploy/production/deploy.sh's rollback decision. The real script runs
// against a stubbed `docker` that fakes the migration ledger, the migrate run and each later failure point; the
// compat classifier is the REAL scripts/check-migration-compat.ts over fixture migrations. The property under test:
// a failed deploy restarts the previous release only when the schema it leaves is proven compatible with it.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOY = join(REPO, "deploy/production/deploy.sh");
const CLASSIFIER = join(REPO, "scripts/check-migration-compat.ts");
const BUN = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout.trim();

const scratch = mkdtempSync(join(tmpdir(), "deploy-rollback-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Fixture migrations the classifier reads (CHARTWARDEN_FITNESS_ROOT).
const fixtureRoot = join(scratch, "repo");
const migrations = join(fixtureRoot, "packages/db/migrations");
mkdirSync(migrations, { recursive: true });
const FIXTURES: Record<string, string> = {
  "1290_m1_add_note.sql": "-- compat: expand\nALTER TABLE t ADD COLUMN note text;\n",
  "1291_m1_drop_legacy.sql": "-- compat: contract\nALTER TABLE t DROP COLUMN legacy;\n",
  "1292_m1_undeclared.sql": "ALTER TABLE t ADD COLUMN d int;\n",
  "1293_m1_false_expand.sql": "-- compat: expand\nALTER TABLE t RENAME COLUMN a TO b;\n",
  "1294_m1_add_index.sql": "-- compat: expand\nCREATE INDEX IF NOT EXISTS t_note ON t(note);\n",
};
for (const [file, sql] of Object.entries(FIXTURES)) writeFileSync(join(migrations, file), sql);

// `docker` stub: logs every call; answers the ledger queries; fails the step named by the test.
const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"exec -T postgres psql"*to_regclass*)
    [ "\${STUB_LEDGER_FAIL:-}" = before ] && exit 2
    [ "\${STUB_LEDGER_FAIL:-}" = after ] && [ -f "$STUB_STATE/migrated" ] && exit 2
    if [ -n "\${STUB_FRESH_DB:-}" ] && [ ! -f "$STUB_STATE/migrated" ]; then echo f; else echo t; fi ;;
  *"exec -T postgres psql"*_chartwarden_migration*)
    if [ -f "$STUB_STATE/migrated" ]; then printf '%s\\n' "$STUB_LEDGER_AFTER"; else printf '%s\\n' "$STUB_LEDGER_BEFORE"; fi ;;
  *"migrate bun run scripts/db/migrate.ts"*)
    touch "$STUB_STATE/migrated"; exit "\${STUB_MIGRATE_EXIT:-0}" ;;
  *"migrate bun run scripts/check-migration-compat.ts --classify"*)
    shift; while [ "$1" != "--classify" ]; do shift; done; shift
    exec "$STUB_BUN" "$STUB_CLASSIFIER" --classify "$@" ;;
  *"run --rm --no-deps api bun -e"*) exit "\${STUB_ENV_EXIT:-0}" ;;
  *"run --rm --no-deps provision"*)
    if [ -n "\${STUB_SLEEP:-}" ]; then touch "$STUB_STATE/hanging"; sleep "$STUB_SLEEP"; fi
    exit "\${STUB_PROVISION_EXIT:-0}" ;;
  *"--force-recreate api worker web docling-worker"*) exit "\${STUB_UP_EXIT:-0}" ;;
esac
exit 0
`;
const binDir = join(scratch, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "docker"), DOCKER_STUB);
chmodSync(join(binDir, "docker"), 0o755);

// #866 — `curl` stub standing in for the webhook receiver: records argv, the -K config read from stdin (which holds
// the URL) and the POSTed body; exits with STUB_CURL_EXIT (28 = curl's timeout code) to model a dead endpoint.
const CURL_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_STATE/curl.args"
cat > "$STUB_STATE/curl.stdin"
for a in "$@"; do case "$a" in @*) cp "\${a#@}" "$STUB_STATE/curl.body" ;; esac; done
exit "\${STUB_CURL_EXIT:-0}"
`;
writeFileSync(join(binDir, "curl"), CURL_STUB);
chmodSync(join(binDir, "curl"), 0o755);
const WEBHOOK = "https://hooks.example.test/services/T000/B000/s3cr3t-token";

const OLD_API = "ghcr.io/o/chartwarden:sha-old";
const NEW_API = "ghcr.io/o/chartwarden:sha-new";
const BASE_LEDGER = ["0001_init.sql", "1287_m41_commercial_destruction_grants.sql"];
const ROLLBACK_UP = "--force-recreate api worker web";

interface Scenario {
  readonly applied?: readonly string[];
  readonly migrateExit?: number;
  readonly provisionExit?: number;
  readonly upExit?: number;
  readonly smokeExit?: number;
  readonly ledgerFail?: "before" | "after";
  readonly envExit?: number;
  /** First-ever deploy: no ledger table until migrate runs. */
  readonly freshDb?: boolean;
  /** `provision` blocks for this many seconds (so a signal can be delivered mid-deploy). */
  readonly hangProvisionSeconds?: number;
  /** smoke.sh makes the deploy dir read-only, so the EXIT-trap cleanup fails. */
  readonly lockDir?: boolean;
  /**
   * Webhook URL: "env" = process environment, "file" = `.deploy-alert.env`, "legacy-env-file" = `.env.production`
   * (which deploy.sh must NOT honour: compose injects that file into containers). Absent = unset.
   */
  readonly alert?: { readonly via: "env" | "file" | "legacy-env-file"; readonly url?: string; readonly curlExit?: number };
}

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly env: string;
  readonly calls: readonly string[];
  readonly previousReleaseSaved: boolean;
  /** Parsed JSON body of the alert POST, or null when none was sent. */
  readonly alertBody: Record<string, unknown> | null;
  /** Everything curl was handed on argv (the URL must never be in it). */
  readonly curlArgs: string;
  /** The -K config curl read on stdin. */
  readonly curlStdin: string;
}

const readIfExists = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

interface Prepared {
  readonly dir: string;
  readonly state: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
}

function prepare(s: Scenario): Prepared {
  const dir = mkdtempSync(join(scratch, "host-"));
  const state = join(dir, ".stub");
  mkdirSync(state);
  copyFileSync(DEPLOY, join(dir, "deploy.sh"));
  writeFileSync(join(dir, "preflight.sh"), "exit 0\n");
  // lockDir: smoke makes the deploy dir read-only, so the EXIT-trap cleanup (rm of the staged files) fails.
  writeFileSync(
    join(dir, "smoke.sh"),
    `#!/bin/sh\n${s.lockDir ? "chmod 500 .\n" : ""}exit ${s.smokeExit ?? 0}\n`,
  );
  chmodSync(join(dir, "smoke.sh"), 0o755);
  writeFileSync(join(dir, "compose.yml"), "services: {}\n");
  writeFileSync(
    join(dir, ".env.production"),
    [
      `CHARTWARDEN_IMAGE=${OLD_API}`,
      "CHARTWARDEN_WEB_IMAGE=ghcr.io/o/chartwarden-web:sha-old",
      "DOCLING_WORKER_TOKEN=x",
      "MINIO_APP_ACCESS_KEY=x",
      "MINIO_APP_SECRET_KEY=x",
      "MINIO_ACCESS_LOG_WEBHOOK_TOKEN=x",
      "CHARTWARDEN_DESTRUCTION_PASSWORD=x",
      ...(s.alert?.via === "legacy-env-file" && s.alert.url
        ? [`DEPLOY_ALERT_WEBHOOK_URL=${s.alert.url}`]
        : []),
      "",
    ].join("\n"),
  );
  if (s.alert?.via === "file" && s.alert.url) {
    writeFileSync(join(dir, ".deploy-alert.env"), `DEPLOY_ALERT_WEBHOOK_URL=${s.alert.url}\n`, {
      mode: 0o600,
    });
  }
  const log = join(state, "calls.log");
  writeFileSync(log, "");
  return {
    dir,
    state,
    log,
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED: "1",
      CHARTWARDEN_FITNESS_ROOT: fixtureRoot,
      STUB_LOG: log,
      STUB_STATE: state,
      STUB_BUN: BUN,
      STUB_CLASSIFIER: CLASSIFIER,
      STUB_LEDGER_BEFORE: s.freshDb ? "" : BASE_LEDGER.join("\n"),
      STUB_LEDGER_AFTER: [...(s.freshDb ? [] : BASE_LEDGER), ...(s.applied ?? [])].join("\n"),
      STUB_FRESH_DB: s.freshDb ? "1" : "",
      STUB_ENV_EXIT: String(s.envExit ?? 0),
      STUB_MIGRATE_EXIT: String(s.migrateExit ?? 0),
      STUB_PROVISION_EXIT: String(s.provisionExit ?? 0),
      STUB_UP_EXIT: String(s.upExit ?? 0),
      STUB_LEDGER_FAIL: s.ledgerFail ?? "",
      STUB_CURL_EXIT: String(s.alert?.curlExit ?? 0),
      STUB_SLEEP: s.hangProvisionSeconds ? String(s.hangProvisionSeconds) : "",
      ...(s.alert?.via === "env" && s.alert.url ? { DEPLOY_ALERT_WEBHOOK_URL: s.alert.url } : {}),
    },
  };
}

const DEPLOY_ARGS = ["deploy.sh", NEW_API, "ghcr.io/o/chartwarden-web:sha-new"];

function collect(p: Prepared, code: number, out: string): Outcome {
  const { dir, state, log } = p;
  chmodSync(dir, 0o700); // undo a lockDir scenario so the scratch dir can be removed
  return {
    code,
    out,
    env: readFileSync(join(dir, ".env.production"), "utf8"),
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    previousReleaseSaved: existsSync(join(dir, ".env.production.previous-release")),
    alertBody: existsSync(join(state, "curl.body"))
      ? (JSON.parse(readFileSync(join(state, "curl.body"), "utf8")) as Record<string, unknown>)
      : null,
    curlArgs: readIfExists(join(state, "curl.args")),
    curlStdin: readIfExists(join(state, "curl.stdin")),
  };
}

function deploy(s: Scenario): Outcome {
  const p = prepare(s);
  const r = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
  return collect(p, r.status ?? -1, `${r.stdout}${r.stderr}`);
}

/** Starts a deploy that hangs in `provision`, delivers `signal` once it is there, and waits for it to exit. */
async function deployThenSignal(s: Scenario, signal: NodeJS.Signals): Promise<Outcome> {
  const p = prepare({ ...s, hangProvisionSeconds: 2 });
  const child = spawn("sh", DEPLOY_ARGS, { cwd: p.dir, env: p.env });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
  for (let i = 0; i < 100 && !existsSync(join(p.state, "hanging")); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill(signal);
  const code = await exited;
  return collect(p, code, out);
}

/** Recreations of the PREVIOUS release (the rollback `up` names api worker web and not docling-worker). */
const oldRestarts = (o: Outcome): number => o.calls.filter((c) => c.endsWith(ROLLBACK_UP)).length;

function expectRolledBack(o: Outcome, recreated: boolean): void {
  expect(o.code, o.out).toBe(1);
  expect(o.env).toContain(`CHARTWARDEN_IMAGE=${OLD_API}`);
  expect(oldRestarts(o), o.out).toBe(recreated ? 1 : 0);
  expect(o.previousReleaseSaved).toBe(false);
  expect(o.out).not.toContain("AUTOMATIC ROLLBACK REFUSED");
}

function expectHeld(o: Outcome): void {
  expect(o.code, o.out).toBe(75);
  expect(oldRestarts(o), o.out).toBe(0);
  expect(o.env).toContain(`CHARTWARDEN_IMAGE=${NEW_API}`);
  expect(o.previousReleaseSaved).toBe(true);
  expect(o.out).toContain("AUTOMATIC ROLLBACK REFUSED");
}

// Never skip silently in CI: without bun the classifier cannot run and the suite would prove nothing.
if (BUN === "" && process.env.CI)
  throw new Error("bun is not on PATH; the deploy rollback suite cannot run");

describe.skipIf(BUN === "")("deploy.sh rollback decision under injected failures", () => {
  it("baseline: a deploy that does not fail exits 0 and never rolls back", () => {
    const o = deploy({ applied: ["1291_m1_drop_legacy.sql"] });
    expect(o.code, o.out).toBe(0);
    expect(oldRestarts(o)).toBe(0);
  });

  it("failure with no migrations applied -> restores and restarts the previous release", () => {
    const o = deploy({ smokeExit: 1 });
    expectRolledBack(o, true);
    expect(o.out).toContain("rollback is clean");
    expect(o.calls.some((c) => c.includes("--classify"))).toBe(false);
  });

  it("failure after expand-only migrations -> restores and restarts the previous release", () => {
    const o = deploy({ applied: ["1290_m1_add_note.sql", "1294_m1_add_index.sql"], smokeExit: 1 });
    expectRolledBack(o, true);
    expect(o.out).toContain("rollback is expand-safe");
  });

  it("failure after a contract migration -> no previous-release restart, held for an operator", () => {
    const o = deploy({
      applied: ["1290_m1_add_note.sql", "1291_m1_drop_legacy.sql"],
      smokeExit: 1,
    });
    expectHeld(o);
    expect(o.out).toContain("1291_m1_drop_legacy.sql");
  });

  it("failure after an undeclared (grandfathered-style) migration -> held", () => {
    expectHeld(deploy({ applied: ["1292_m1_undeclared.sql"], provisionExit: 1 }));
  });

  it("a false expand claim (RENAME declared expand) is not trusted -> held", () => {
    expectHeld(deploy({ applied: ["1293_m1_false_expand.sql"], upExit: 1 }));
  });

  it("partial multi-file failure that committed a contract migration -> held, nothing restarted", () => {
    const o = deploy({
      applied: ["1290_m1_add_note.sql", "1291_m1_drop_legacy.sql"],
      migrateExit: 1,
    });
    expectHeld(o);
    expect(o.calls.some((c) => c.includes("up -d") && / (api|worker|web)\b/.test(c))).toBe(false);
  });

  it("partial multi-file failure that committed only expand migrations -> env restored, running containers untouched", () => {
    const o = deploy({ applied: ["1290_m1_add_note.sql"], migrateExit: 1 });
    expectRolledBack(o, false);
    expect(o.out).toContain("migrations did not complete");
  });

  it("failure before migrating (new-release env validation) -> clean rollback, migrate never ran", () => {
    const o = deploy({ envExit: 1 });
    expectRolledBack(o, false);
    expect(o.calls.some((c) => c.includes("scripts/db/migrate.ts"))).toBe(false);
  });

  it("first-ever deploy (no ledger table yet) that fails after migrating -> held, every migration listed", () => {
    const o = deploy({
      freshDb: true,
      applied: ["0001_init.sql", "1290_m1_add_note.sql"],
      smokeExit: 1,
    });
    expectHeld(o);
    expect(o.out).toContain("0001_init.sql");
  });

  it("ledger unreadable after migrating -> held (unknown is never treated as safe)", () => {
    expectHeld(deploy({ applied: ["1290_m1_add_note.sql"], ledgerFail: "after", smokeExit: 1 }));
  });

  it("ledger unreadable before migrating -> aborts before migrate, previous release untouched", () => {
    const o = deploy({ ledgerFail: "before" });
    expectRolledBack(o, false);
    expect(o.calls.some((c) => c.includes("scripts/db/migrate.ts"))).toBe(false);
  });
});

// #866 — optional deploy failure alert. Fires on any non-zero exit, names exit 75, carries no PHI, never decides the
// deploy's outcome, and never leaks the (secret) URL.
describe.skipIf(BUN === "")("deploy.sh failure alert (#866)", () => {
  const alert = { via: "env", url: WEBHOOK } as const;

  it("fires on exit 75 naming the operator decision, with sha, step, code and migration filenames only", () => {
    const o = deploy({ applied: ["1291_m1_drop_legacy.sql"], smokeExit: 1, alert });
    expect(o.code, o.out).toBe(75);
    expect(o.alertBody).toMatchObject({
      sha: "new",
      step: "smoke",
      exit_code: 75,
      operator_decision_required: true,
      applied_migrations: ["1291_m1_drop_legacy.sql"],
    });
    expect(String(o.alertBody?.text)).toContain("operator decision required");
    expect(Object.keys(o.alertBody ?? {}).sort()).toEqual(
      ["applied_migrations", "exit_code", "operator_decision_required", "sha", "step", "text"].sort(),
    );
  });

  it("fires on exit 1 as a plain failure", () => {
    const o = deploy({ envExit: 1, alert });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toMatchObject({
      step: "env-validation",
      exit_code: 1,
      operator_decision_required: false,
      applied_migrations: [],
    });
    expect(String(o.alertBody?.text)).not.toContain("operator decision");
  });

  it("does not fire on a successful deploy", () => {
    const o = deploy({ alert });
    expect(o.code, o.out).toBe(0);
    expect(o.alertBody).toBeNull();
    expect(o.curlArgs).toBe("");
  });

  it("is a no-op when the webhook is unset", () => {
    const o = deploy({ smokeExit: 1 });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toBeNull();
    expect(o.curlArgs).toBe("");
  });

  it("reads the URL from .deploy-alert.env when the environment does not set it", () => {
    const o = deploy({ smokeExit: 1, alert: { via: "file", url: WEBHOOK } });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toMatchObject({ step: "smoke", exit_code: 1 });
  });

  it("ignores the key in .env.production (compose injects that file into containers)", () => {
    const o = deploy({ smokeExit: 1, alert: { via: "legacy-env-file", url: WEBHOOK } });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toBeNull();
    expect(o.curlArgs).toBe("");
  });

  it("the alert secret never reaches the containers: absent from the env example and from compose env_file", () => {
    const example = readFileSync(join(REPO, "deploy/production/.env.production.example"), "utf8");
    expect(example).not.toContain("DEPLOY_ALERT_WEBHOOK_URL");
    const compose = readFileSync(join(REPO, "deploy/production/compose.yml"), "utf8");
    const envFiles = [...compose.matchAll(/^\s*env_file:\s*(.+)$/gm)].map((m) => (m[1] ?? "").trim());
    expect(envFiles.length).toBeGreaterThan(0);
    for (const f of envFiles) expect(f).not.toContain("deploy-alert");
    expect(compose).not.toContain(".deploy-alert");
    expect(compose).not.toContain("DEPLOY_ALERT_WEBHOOK_URL");
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGINT", 130],
  ] as const)("a deploy killed by %s still alerts with exit %i", async (signal, code) => {
    const o = await deployThenSignal({ alert }, signal);
    expect(o.code, o.out).toBe(code);
    expect(o.alertBody).toMatchObject({ step: "provision", exit_code: code });
  });

  it("the exit-75 hold path alerts exactly once (the signal traps do not double-fire it)", () => {
    const o = deploy({ applied: ["1291_m1_drop_legacy.sql"], smokeExit: 1, alert });
    expect(o.code).toBe(75);
    expect(o.curlArgs.trim().split("\n")).toHaveLength(1);
  });

  it("a failing cleanup cannot skip the alert or change the exit code", () => {
    const o = deploy({ smokeExit: 1, lockDir: true, alert });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toMatchObject({ step: "smoke", exit_code: 1 });
  });

  it("never prints or passes the URL on argv; it reaches curl only on stdin", () => {
    const o = deploy({ applied: ["1291_m1_drop_legacy.sql"], smokeExit: 1, alert });
    expect(o.out).not.toContain("s3cr3t-token");
    expect(o.out).not.toContain("hooks.example.test");
    expect(o.curlArgs).not.toContain("hooks.example.test");
    expect(o.curlArgs).toMatch(/--max-time \d+/);
    expect(o.curlArgs).toMatch(/--connect-timeout \d+/);
    expect(o.curlStdin).toContain(WEBHOOK);
  });

  it("a failing webhook is logged and swallowed: the deploy keeps its own exit status", () => {
    const held = deploy({
      applied: ["1291_m1_drop_legacy.sql"],
      smokeExit: 1,
      alert: { ...alert, curlExit: 28 },
    });
    expect(held.code, held.out).toBe(75);
    expect(held.out).toContain("deploy alert delivery FAILED");
    expect(held.out).not.toContain("s3cr3t-token");
    expect(deploy({ smokeExit: 1, alert: { ...alert, curlExit: 7 } }).code).toBe(1);
  });

  it("refuses a non-https or malformed URL without calling curl", () => {
    for (const url of ["http://hooks.example.test/x", 'https://h.example.test/"x']) {
      const o = deploy({ smokeExit: 1, alert: { via: "env", url } });
      expect(o.code, o.out).toBe(1);
      expect(o.curlArgs).toBe("");
      expect(o.out).toContain("deploy alert skipped");
    }
  });
});
