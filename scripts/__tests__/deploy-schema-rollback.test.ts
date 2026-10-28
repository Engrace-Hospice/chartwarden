import { spawnSync } from "node:child_process";
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
  *"run --rm --no-deps provision"*) exit "\${STUB_PROVISION_EXIT:-0}" ;;
  *"--force-recreate api worker web docling-worker"*) exit "\${STUB_UP_EXIT:-0}" ;;
esac
exit 0
`;
const binDir = join(scratch, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "docker"), DOCKER_STUB);
chmodSync(join(binDir, "docker"), 0o755);

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
}

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly env: string;
  readonly calls: readonly string[];
  readonly previousReleaseSaved: boolean;
}

function deploy(s: Scenario): Outcome {
  const dir = mkdtempSync(join(scratch, "host-"));
  const state = join(dir, ".stub");
  mkdirSync(state);
  copyFileSync(DEPLOY, join(dir, "deploy.sh"));
  writeFileSync(join(dir, "preflight.sh"), "exit 0\n");
  writeFileSync(join(dir, "smoke.sh"), `#!/bin/sh\nexit ${s.smokeExit ?? 0}\n`);
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
      "",
    ].join("\n"),
  );
  const log = join(state, "calls.log");
  writeFileSync(log, "");
  const r = spawnSync("sh", ["deploy.sh", NEW_API, "ghcr.io/o/chartwarden-web:sha-new"], {
    cwd: dir,
    encoding: "utf8",
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
    },
  });
  return {
    code: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    env: readFileSync(join(dir, ".env.production"), "utf8"),
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    previousReleaseSaved: existsSync(join(dir, ".env.production.previous-release")),
  };
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
