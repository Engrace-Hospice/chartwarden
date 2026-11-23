import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  LEFTOVER_MINIO_ENV_NAMES,
  OBJECT_STORE_ENV_NAMES,
  envEntry,
  syntheticValue,
} from "./deploy-env-helpers";

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
  *"volume ls"*) [ -z "\${STUB_MINIO_VOLUME:-}" ] || echo "\$STUB_MINIO_VOLUME" ;;
  *"up -d --no-deps"*"fluent-bit"*) exit "\${STUB_FLUENT_UP_EXIT:-0}" ;;
  *"ps -q fluent-bit"*) [ -n "\${STUB_FLUENT_NO_CONTAINER:-}" ] || echo cid-fluent ;;
  *"inspect"*)
    printf 'PATH=/usr/bin\\nAUDIT_SINK_HOST=api\\nAUDIT_SINK_PATH=%s\\n' "\${STUB_FLUENT_PATH:-/api/v1/webhooks/object-store/access-log}" ;;
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

// A `cp` that dies half way through copying the OLD backup secret (it leaves a partial destination behind, then fails) and
// is the real cp for everything else deploy.sh copies. Prepended to PATH only by a scenario that asks for it.
const failCpBin = join(scratch, "fail-cp-bin");
mkdirSync(failCpBin);
writeFileSync(
  join(failCpBin, "cp"),
  `#!/bin/sh
case "$*" in
  *backup_source_minio_secret_key*) for last; do :; done; printf 'partial' > "$last"; exit 1 ;;
esac
exec /bin/cp "$@"
`,
);
chmodSync(join(failCpBin, "cp"), 0o755);

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
  /** The host still has the retired MinIO volume and no cutover marker (deploy.sh must not care any more). */
  readonly legacyMinio?: boolean;
  /** The object-store credential lines of `.env.production`. Default: canonical names plus the leftover MINIO_* lines. */
  readonly objectStoreEnv?: readonly string[];
  /** Leave the Docling bearer out, to see deploy.sh generate it. */
  readonly omitDoclingWorkerToken?: boolean;
  /** The host has compose.backup.yml next to compose.yml (the overlay is added when its source key is configured). */
  readonly backupOverlay?: boolean;
  /** Extra `.env.production` lines (the backup overlay's source key, old or new name). */
  readonly extraEnv?: readonly string[];
  /** Files placed in the host's `secrets/` directory before the run, name -> `{ content, mode }` (mode default 0400). */
  readonly secretFiles?: Readonly<
    Record<string, { readonly content: string; readonly mode?: number }>
  >;
  /** The AUDIT_SINK_PATH the RUNNING fluent-bit container carries (default: the canonical audit path). */
  readonly fluentPath?: string;
  /** `up -d fluent-bit` exits with this status. */
  readonly fluentUpExit?: number;
  /** `ps -q fluent-bit` finds no container. */
  readonly fluentNoContainer?: boolean;
  /** Permission bits of the host's `secrets/` directory itself (default 0700), applied after the files are written. */
  readonly secretsDirMode?: number;
  /** The `cp` of the old backup secret dies half way through, leaving a partial destination behind. */
  readonly failSecretCopy?: boolean;
  /** `.env.production` ends without a newline (deploy.sh must not glue an appended line onto the last one). */
  readonly noTrailingNewline?: boolean;
  /**
   * Webhook URL: "env" = process environment, "file" = `.deploy-alert.env`, "legacy-env-file" = `.env.production`
   * (which deploy.sh must NOT honour: compose injects that file into containers). Absent = unset.
   */
  readonly alert?: {
    readonly via: "env" | "file" | "legacy-env-file";
    readonly url?: string;
    readonly curlExit?: number;
  };
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
  /** `.object-store-cutover` exists after the run (deploy.sh no longer writes it). */
  readonly cutoverMarker: boolean;
  /** `.env.production` as the host had it before the run. */
  readonly envBefore: string;
  /** `.env.production.previous-release` (what an operator hold saves for a verified rollback), or "". */
  readonly previousReleaseEnv: string;
  /** Every entry in the deploy dir after the run (a leftover `.env.production.*` staging file shows here). */
  readonly files: readonly string[];
  /** The host's `secrets/` directory after the run: name -> content and permission bits. Empty when it does not exist. */
  readonly secrets: Readonly<Record<string, { readonly content: string; readonly mode: number }>>;
}

const readIfExists = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

interface Prepared {
  readonly dir: string;
  readonly state: string;
  readonly log: string;
  readonly env: NodeJS.ProcessEnv;
  readonly envBefore: string;
}

/** A live host: the canonical names, plus the MINIO_* aliases the compatibility release left behind (unused now). */
const DEFAULT_OBJECT_STORE_ENV: readonly string[] = [
  ...OBJECT_STORE_ENV_NAMES.map((n) => `${n}=${syntheticValue(n, "new")}`),
  ...LEFTOVER_MINIO_ENV_NAMES.map((n) => `${n}=${syntheticValue(n, "old")}`),
];

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
  if (s.backupOverlay) writeFileSync(join(dir, "compose.backup.yml"), "services: {}\n");
  mkdirSync(join(dir, "object-store"));
  writeFileSync(join(dir, "object-store", "audit.json"), "{}\n");
  writeFileSync(join(dir, "object-store", "fluent-bit.yaml"), "service: {}\n");
  const envLines = [
    `CHARTWARDEN_IMAGE=${OLD_API}`,
    "CHARTWARDEN_WEB_IMAGE=ghcr.io/o/chartwarden-web:sha-old",
    ...(s.omitDoclingWorkerToken ? [] : ["DOCLING_WORKER_TOKEN=x"]),
    ...(s.objectStoreEnv ?? DEFAULT_OBJECT_STORE_ENV),
    ...(s.extraEnv ?? []),
    "CHARTWARDEN_DESTRUCTION_PASSWORD=x",
    ...(s.alert?.via === "legacy-env-file" && s.alert.url
      ? [`DEPLOY_ALERT_WEBHOOK_URL=${s.alert.url}`]
      : []),
  ];
  const envBefore = `${envLines.join("\n")}${s.noTrailingNewline ? "" : "\n"}`;
  writeFileSync(join(dir, ".env.production"), envBefore);
  if (s.secretFiles) {
    mkdirSync(join(dir, "secrets"), { mode: 0o700 });
    for (const [name, file] of Object.entries(s.secretFiles)) {
      writeFileSync(join(dir, "secrets", name), file.content);
      chmodSync(join(dir, "secrets", name), file.mode ?? 0o400);
    }
    if (s.secretsDirMode !== undefined) chmodSync(join(dir, "secrets"), s.secretsDirMode);
  }
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
    envBefore,
    env: {
      PATH: `${s.failSecretCopy ? `${failCpBin}:` : ""}${binDir}:/usr/bin:/bin`,
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
      STUB_MINIO_VOLUME: s.legacyMinio ? "wardenx_minio-data" : "",
      STUB_SLEEP: s.hangProvisionSeconds ? String(s.hangProvisionSeconds) : "",
      STUB_FLUENT_PATH: s.fluentPath ?? "/api/v1/webhooks/object-store/access-log",
      STUB_FLUENT_UP_EXIT: String(s.fluentUpExit ?? 0),
      STUB_FLUENT_NO_CONTAINER: s.fluentNoContainer ? "1" : "",
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
    cutoverMarker: existsSync(join(dir, ".object-store-cutover")),
    envBefore: p.envBefore,
    previousReleaseEnv: readIfExists(join(dir, ".env.production.previous-release")),
    files: readdirSync(dir),
    secrets: readSecrets(join(dir, "secrets")),
  };
}

function readSecrets(
  secretsDir: string,
): Record<string, { readonly content: string; readonly mode: number }> {
  if (!existsSync(secretsDir)) return {};
  chmodSync(secretsDir, 0o700); // a scenario may have left the directory inaccessible; read it back as its owner
  return Object.fromEntries(
    readdirSync(secretsDir).map((name) => {
      const file = join(secretsDir, name);
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o400) === 0) chmodSync(file, 0o600); // an unreadable fixture: reported as it was, read back as owner
      return [name, { content: readFileSync(file, "utf8"), mode }];
    }),
  );
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
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    out += d.toString();
  });
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

  // The one-time MinIO -> SeaweedFS cutover is gone: a host that still has the retired MinIO volume (and no marker, and
  // no record in the seaweedfs-config volume) is deployed exactly like any other.
  describe("retired MinIO cutover", () => {
    const callsMatching = (o: Outcome, re: RegExp): string[] => o.calls.filter((c) => re.test(c));

    it("a host with a leftover minio-data volume and no marker deploys normally: no volume query, no stop, no copy, no marker", () => {
      const o = deploy({ legacyMinio: true });
      expect(o.code, o.out).toBe(0);
      expect(callsMatching(o, /volume ls/)).toEqual([]);
      expect(
        callsMatching(o, /stop api worker|legacy-minio|object-store-migrate|--profile/),
      ).toEqual([]);
      expect(o.cutoverMarker).toBe(false);
      expect(oldRestarts(o)).toBe(0);
    });

    it("a failure after migrating restores the previous release the ordinary way, with no cutover banner", () => {
      const o = deploy({ legacyMinio: true, smokeExit: 1 });
      expectRolledBack(o, true);
      expect(o.out).not.toContain("cutover");
    });

    it("an operator hold carries no 'app is STOPPED' exception", () => {
      const o = deploy({
        legacyMinio: true,
        applied: ["1291_m1_drop_legacy.sql"],
        provisionExit: 1,
      });
      expectHeld(o);
      expect(o.out).not.toContain("THE APP IS DOWN");
      expect(o.out).not.toContain("EXCEPTION");
    });
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

  it("runs the migrate step with --hold-contract so an unattended deploy never applies a non-expand migration", () => {
    const o = deploy({});
    const migrate = o.calls.find((c) => c.includes("scripts/db/migrate.ts"));
    expect(migrate, o.out).toContain("--hold-contract");
  });

  it("a hold from the runner (exit 75, nothing applied) -> exit 75, previous release untouched, not a rollback refusal", () => {
    const o = deploy({ migrateExit: 75 });
    expect(o.code, o.out).toBe(75);
    expect(o.out).toContain("DEPLOY HELD BEFORE ANY SCHEMA CHANGE");
    expect(o.out).not.toContain("AUTOMATIC ROLLBACK REFUSED");
    expect(o.env).toContain(`CHARTWARDEN_IMAGE=${OLD_API}`);
    expect(oldRestarts(o), o.out).toBe(0);
    expect(o.calls.some((c) => c.includes("run --rm --no-deps provision"))).toBe(false);
    expect(o.previousReleaseSaved).toBe(false);
  });

  it("the held banner names the hand-apply command: the NEW release's image, the migrate service, no --hold-contract", () => {
    const o = deploy({ migrateExit: 75 });
    const banner = o.out.split("\n").filter((l) => l.startsWith("!!"));
    // the env file is put back on the previous image right after, so the command must carry the new one explicitly
    const apply = banner.join("\n");
    expect(apply).toContain(`CHARTWARDEN_IMAGE='${NEW_API}'`);
    expect(apply).not.toContain(OLD_API); // the previous release's image would apply the migration with the OLD code
    expect(apply).toContain(
      "run --rm --no-deps migrate bun run scripts/db/migrate.ts --strict --schema-only",
    );
    const commandLines = banner.filter((l) => /docker compose|migrate\.ts/.test(l)).join(" ");
    expect(commandLines).not.toContain("--hold-contract"); // the point of applying by hand
    expect(apply).not.toMatch(/db:migrate:deploy/); // production uses the Docker migrate job, never host db:migrate
  });

  it("the compose migrate service defaults to --hold-contract, so a plain `docker compose up` cannot apply a held migration", () => {
    const compose = readFileSync(join(REPO, "deploy/production/compose.yml"), "utf8");
    const migrate = /^ {2}migrate:\n([\s\S]*?)\n {2}provision:/m.exec(compose)?.[1] ?? "";
    expect(migrate).toMatch(
      /command: \["bun", "run", "scripts\/db\/migrate\.ts", "--strict", "--hold-contract"\]/,
    );
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

// Object-store credentials. deploy.sh makes sure the five canonical names compose.yml reads exist in `.env.production`
// BEFORE the rollback backup is taken: an absent one is generated once, an existing one is never touched or rotated, and no
// value is ever printed. The retired MINIO_* rollback aliases are neither read nor written; a host that still carries them
// keeps booting.
describe.skipIf(BUN === "")("deploy.sh object-store credentials", () => {
  const value = (name: string): string => syntheticValue(name, "new");
  const canonicalEnv = (): string[] => OBJECT_STORE_ENV_NAMES.map((n) => `${n}=${value(n)}`);
  const leftoverEnv = (): string[] =>
    LEFTOVER_MINIO_ENV_NAMES.map((n) => `${n}=${syntheticValue(n, "old")}`);

  /** Every synthetic value a fixture could hold: none of them may ever appear in deploy output. */
  const allSyntheticValues = [
    ...OBJECT_STORE_ENV_NAMES.map(value),
    ...LEFTOVER_MINIO_ENV_NAMES.map((n) => syntheticValue(n, "old")),
  ];
  const expectNoSecretInOutput = (o: Outcome): void => {
    for (const v of allSyntheticValues) expect(o.out).not.toContain(v);
  };
  const minioLines = (env: string): string[] =>
    env.split("\n").filter((l) => l.startsWith("MINIO_"));

  it("canonical names only (the template's shape): succeeds, writes nothing, creates no MINIO_* alias", () => {
    const o = deploy({ objectStoreEnv: canonicalEnv() });
    expect(o.code, o.out).toBe(0);
    for (const n of OBJECT_STORE_ENV_NAMES) {
      expect(envEntry(o.env, n), n).toEqual({ value: value(n), count: 1 });
    }
    expect(minioLines(o.env)).toEqual([]);
    expect(o.out).not.toMatch(/(copied|generated) (SEAWEEDFS|OBJECT_STORE|MINIO)_/);
    expectNoSecretInOutput(o);
  });

  it("a live host that still has the MINIO_* lines keeps booting: they are left byte-for-byte, nothing is copied either way", () => {
    const o = deploy({ objectStoreEnv: [...canonicalEnv(), ...leftoverEnv()] });
    expect(o.code, o.out).toBe(0);
    for (const n of OBJECT_STORE_ENV_NAMES) {
      expect(envEntry(o.env, n), n).toEqual({ value: value(n), count: 1 });
    }
    for (const n of LEFTOVER_MINIO_ENV_NAMES) {
      expect(envEntry(o.env, n), n).toEqual({ value: syntheticValue(n, "old"), count: 1 });
    }
    expect(o.out).not.toMatch(/(copied|generated) (SEAWEEDFS|OBJECT_STORE|MINIO)_/);
    expectNoSecretInOutput(o);
  });

  it("a canonical name that DIFFERS from its old MINIO_* twin is no longer an error: the canonical value wins, nothing exits 78", () => {
    const o = deploy({
      objectStoreEnv: [
        `SEAWEEDFS_APP_SECRET_KEY=${value("SEAWEEDFS_APP_SECRET_KEY")}`,
        `MINIO_APP_SECRET_KEY=${syntheticValue("MINIO_APP_SECRET_KEY", "old")}`,
        ...canonicalEnv().filter((l) => !l.startsWith("SEAWEEDFS_APP_SECRET_KEY=")),
      ],
    });
    expect(o.code, o.out).toBe(0);
    expect(o.out).not.toContain("MISMATCH");
    expect(envEntry(o.env, "SEAWEEDFS_APP_SECRET_KEY").value).toBe(
      value("SEAWEEDFS_APP_SECRET_KEY"),
    );
    expectNoSecretInOutput(o);
  });

  it("a fresh host (none of the names set): each canonical name is generated once, never printed, no MINIO_* is written", () => {
    const o = deploy({ objectStoreEnv: [] });
    expect(o.code, o.out).toBe(0);
    for (const n of OBJECT_STORE_ENV_NAMES) {
      const entry = envEntry(o.env, n);
      expect(entry.count, n).toBe(1);
      expect(entry.value, n).toBeTruthy();
      expect(o.out).toContain(`generated ${n} in .env.production`);
      if (!n.endsWith("ACCESS_KEY")) {
        // A secret for every name but the two account names: long, and absent from the log.
        expect(entry.value?.length ?? 0, n).toBeGreaterThanOrEqual(32);
        expect(o.out).not.toContain(entry.value as string);
      }
    }
    expect(minioLines(o.env)).toEqual([]);
    // The admin and app accounts must differ (seaweedfs-identities.ts refuses the same name for both).
    expect(envEntry(o.env, "SEAWEEDFS_ADMIN_ACCESS_KEY").value).toBe("chartwarden-seaweedfs-admin");
    expect(envEntry(o.env, "SEAWEEDFS_APP_ACCESS_KEY").value).toBe("chartwarden-app");
    const secrets = [
      "SEAWEEDFS_ADMIN_SECRET_KEY",
      "SEAWEEDFS_APP_SECRET_KEY",
      "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN",
    ];
    expect(new Set(secrets.map((n) => envEntry(o.env, n).value)).size).toBe(secrets.length);
  });

  it("only the missing names are generated; the others keep their value", () => {
    const o = deploy({
      objectStoreEnv: canonicalEnv().filter(
        (l) => !l.startsWith("SEAWEEDFS_ADMIN_SECRET_KEY=") && !l.startsWith("OBJECT_STORE_AUDIT"),
      ),
    });
    expect(o.code, o.out).toBe(0);
    expect(o.out).toContain("generated SEAWEEDFS_ADMIN_SECRET_KEY in .env.production");
    expect(o.out).toContain("generated OBJECT_STORE_AUDIT_WEBHOOK_TOKEN in .env.production");
    expect(o.out).not.toContain("generated SEAWEEDFS_APP");
    expect(envEntry(o.env, "SEAWEEDFS_APP_SECRET_KEY")).toEqual({
      value: value("SEAWEEDFS_APP_SECRET_KEY"),
      count: 1,
    });
  });

  it("a host that has the MINIO_* names ONLY (never ran the compatibility release) gets fresh canonical values; its MINIO_* lines are not read or changed", () => {
    const o = deploy({ objectStoreEnv: leftoverEnv() });
    expect(o.code, o.out).toBe(0);
    for (const n of OBJECT_STORE_ENV_NAMES) expect(envEntry(o.env, n).count, n).toBe(1);
    for (const n of LEFTOVER_MINIO_ENV_NAMES) {
      expect(envEntry(o.env, n), n).toEqual({ value: syntheticValue(n, "old"), count: 1 });
    }
    expectNoSecretInOutput(o);
  });

  it("an env file with no trailing newline never has an appended line glued onto its last line", () => {
    const o = deploy({ objectStoreEnv: [], noTrailingNewline: true });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, "CHARTWARDEN_DESTRUCTION_PASSWORD")).toEqual({ value: "x", count: 1 });
    for (const n of OBJECT_STORE_ENV_NAMES) expect(envEntry(o.env, n).count, n).toBe(1);
  });

  it("the Docling bearer is generated like before when missing", () => {
    const o = deploy({ objectStoreEnv: canonicalEnv(), omitDoclingWorkerToken: true });
    expect(o.code, o.out).toBe(0);
    expect(o.out).toContain("generated DOCLING_WORKER_TOKEN in .env.production");
    expect(envEntry(o.env, "DOCLING_WORKER_TOKEN").count).toBe(1);
  });

  it("the rollback backup is taken AFTER the generation: a failed deploy restores an env that still carries the generated names", () => {
    const o = deploy({ objectStoreEnv: [], smokeExit: 1 });
    expectRolledBack(o, true);
    for (const n of OBJECT_STORE_ENV_NAMES) expect(envEntry(o.env, n).count, n).toBe(1);
  });

  it("an operator hold after a contract migration saves a previous-release env that carries the same names", () => {
    const o = deploy({
      objectStoreEnv: canonicalEnv(),
      applied: ["1291_m1_drop_legacy.sql"],
      smokeExit: 1,
    });
    expectHeld(o);
    for (const n of OBJECT_STORE_ENV_NAMES) {
      expect(envEntry(o.previousReleaseEnv, n), n).toEqual({ value: value(n), count: 1 });
    }
    expect(o.previousReleaseEnv).toContain(`CHARTWARDEN_IMAGE=${OLD_API}`);
  });

  it("deploy.sh never references the retired aliases: no MINIO_*, no legacy-minio profile, no mismatch exit", () => {
    const script = readFileSync(DEPLOY, "utf8");
    expect(script).not.toMatch(/MINIO_(ROOT|APP|ACCESS_LOG)/);
    expect(script).not.toContain("legacy-minio");
    expect(script).not.toContain("OBJECT_STORE_ENV_PAIRS");
    expect(script).not.toMatch(/exit 78/);
  });
});

// Backup-overlay names. compose.backup.yml reads BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY and the secret file
// secrets/backup_source_object_store_secret_key; a live host still has the OLD names (BACKUP_SOURCE_MINIO_ACCESS_KEY and
// secrets/backup_source_minio_secret_key). deploy.sh copies them across, additively and idempotently, before anything is
// started or backed up: an existing new value or file is never changed, no value is printed, the old ones stay in place.
describe.skipIf(BUN === "")("deploy.sh backup-overlay name migration", () => {
  const OLD_KEY = "BACKUP_SOURCE_MINIO_ACCESS_KEY";
  const NEW_KEY = "BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY";
  const OLD_SECRET = "backup_source_minio_secret_key";
  const NEW_SECRET = "backup_source_object_store_secret_key";
  const accessKey = "synthetic-backup-reader-not-a-real-key";
  const secretValue = "synthetic-backup-reader-secret-not-a-real-secret\n";
  const otherSecret = "synthetic-already-migrated-secret-not-real\n";
  const expectNoBackupSecretInOutput = (o: Outcome): void => {
    expect(o.out).not.toContain(secretValue.trim());
    expect(o.out).not.toContain(otherSecret.trim());
    expect(o.out).not.toContain(accessKey);
  };

  it("a live host (old variable + old secret file): the new variable and file are created with the same value, mode 0400; the old ones stay", () => {
    const o = deploy({
      extraEnv: [`${OLD_KEY}=${accessKey}`],
      secretFiles: { [OLD_SECRET]: { content: secretValue } },
    });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
    expect(envEntry(o.env, OLD_KEY)).toEqual({ value: accessKey, count: 1 });
    expect(o.secrets[NEW_SECRET]).toEqual({ content: secretValue, mode: 0o400 });
    expect(o.secrets[OLD_SECRET]).toEqual({ content: secretValue, mode: 0o400 });
    expect(o.out).toContain(`copied ${OLD_KEY} to ${NEW_KEY} in .env.production`);
    expect(o.out).toContain(`copied secrets/${OLD_SECRET} to secrets/${NEW_SECRET}`);
    expectNoBackupSecretInOutput(o);
  });

  it("is idempotent: a second deploy on the migrated host changes nothing and prints no copy", () => {
    const p = prepare({
      extraEnv: [`${OLD_KEY}=${accessKey}`],
      secretFiles: { [OLD_SECRET]: { content: secretValue } },
    });
    spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
    const first = collect(p, 0, "");
    const second = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
    const after = collect(p, second.status ?? -1, `${second.stdout}${second.stderr}`);
    expect(after.code, after.out).toBe(0);
    // Only the image lines differ between two deploys of the same release; every backup line is identical.
    expect(envEntry(after.env, NEW_KEY)).toEqual(envEntry(first.env, NEW_KEY));
    expect(envEntry(after.env, NEW_KEY).count).toBe(1);
    expect(after.secrets).toEqual(first.secrets);
    expect(after.out).not.toMatch(/copied (BACKUP_SOURCE|secrets)/);
  });

  it("a host that already has the new names keeps them, whatever the old ones hold: nothing copied, nothing changed", () => {
    const o = deploy({
      extraEnv: [`${NEW_KEY}=new-reader-key`, `${OLD_KEY}=${accessKey}`],
      secretFiles: {
        [NEW_SECRET]: { content: otherSecret },
        [OLD_SECRET]: { content: secretValue },
      },
    });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: "new-reader-key", count: 1 });
    expect(envEntry(o.env, OLD_KEY)).toEqual({ value: accessKey, count: 1 });
    expect(o.secrets[NEW_SECRET]?.content).toBe(otherSecret);
    expect(o.out).not.toMatch(/copied (BACKUP_SOURCE|secrets)/);
    expectNoBackupSecretInOutput(o);
  });

  it("a fresh host (no backup overlay at all): nothing is created, no secrets directory appears, nothing is said", () => {
    const o = deploy({});
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY).count).toBe(0);
    expect(envEntry(o.env, OLD_KEY).count).toBe(0);
    expect(o.secrets).toEqual({});
    expect(o.files).not.toContain("secrets");
    expect(o.out).not.toMatch(/BACKUP_SOURCE|backup_source/);
  });

  it("the new variable present but EMPTY is filled from the old one by an appended line; the empty line is left as it was", () => {
    const o = deploy({ extraEnv: [`${NEW_KEY}=`, `${OLD_KEY}=${accessKey}`] });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 2 }); // the last line wins, as for compose
    expect(o.env).toContain(`${NEW_KEY}=\n`);
    expectNoBackupSecretInOutput(o);
  });

  it("the old variable alone (no secret files on this host): only the variable is copied, no secret file is invented", () => {
    const o = deploy({ extraEnv: [`${OLD_KEY}=${accessKey}`] });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
    expect(o.secrets).toEqual({});
  });

  it("the old secret file alone: only the file is copied, no variable is invented", () => {
    const o = deploy({ secretFiles: { [OLD_SECRET]: { content: secretValue } } });
    expect(o.code, o.out).toBe(0);
    expect(o.secrets[NEW_SECRET]).toEqual({ content: secretValue, mode: 0o400 });
    expect(envEntry(o.env, NEW_KEY).count).toBe(0);
  });

  it("an existing new secret file is never overwritten, even when the old one differs", () => {
    const o = deploy({
      extraEnv: [`${OLD_KEY}=${accessKey}`],
      secretFiles: {
        [NEW_SECRET]: { content: otherSecret },
        [OLD_SECRET]: { content: secretValue },
      },
    });
    expect(o.code, o.out).toBe(0);
    expect(o.secrets[NEW_SECRET]?.content).toBe(otherSecret);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
  });

  it("copies the raw variable value verbatim: spaces, quotes, `=`, `$`, `#`, `&` and backslashes survive", () => {
    const raw = 'a=b/c&d$HOME#e "q" \\n tail ';
    const o = deploy({ extraEnv: [`${OLD_KEY}=${raw}`] });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: raw, count: 1 });
  });

  it("an env file with no trailing newline never has the appended variable glued onto its last line", () => {
    const o = deploy({ extraEnv: [`${OLD_KEY}=${accessKey}`], noTrailingNewline: true });
    expect(o.code, o.out).toBe(0);
    expect(envEntry(o.env, "CHARTWARDEN_DESTRUCTION_PASSWORD")).toEqual({ value: "x", count: 1 });
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
  });

  it("the rollback backup is taken AFTER the migration: a failed deploy restores an env that carries both names", () => {
    const o = deploy({
      extraEnv: [`${OLD_KEY}=${accessKey}`],
      secretFiles: { [OLD_SECRET]: { content: secretValue } },
      smokeExit: 1,
    });
    expectRolledBack(o, true);
    expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
    expect(envEntry(o.env, OLD_KEY)).toEqual({ value: accessKey, count: 1 });
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable old secret file stops the deploy before any docker call, with the env untouched and a hand-copy hint",
    () => {
      const o = deploy({
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: { [OLD_SECRET]: { content: secretValue, mode: 0o000 } },
      });
      expect(o.code, o.out).toBe(1);
      expect(o.calls, "docker must not be called").toEqual([]);
      expect(o.env).toBe(o.envBefore);
      expect(o.secrets[NEW_SECRET]).toBeUndefined();
      expect(o.out).toContain("Copy it by hand");
      expect(o.out).toContain("No service was touched");
      expectNoBackupSecretInOutput(o);
    },
  );

  it("the backup overlay (compose.backup.yml) is added to object-store-provision once the OLD variable has been migrated", () => {
    const o = deploy({
      backupOverlay: true,
      extraEnv: [`${OLD_KEY}=${accessKey}`],
      secretFiles: { [OLD_SECRET]: { content: secretValue } },
    });
    expect(o.code, o.out).toBe(0);
    expect(
      o.calls.some((c) => c.includes("-f compose.backup.yml run --rm object-store-provision")),
    ).toBe(true);
  });

  it("without the variable (old or new) the overlay is not added", () => {
    const o = deploy({ backupOverlay: true });
    expect(o.code, o.out).toBe(0);
    expect(o.calls.some((c) => c.includes("compose.backup.yml"))).toBe(false);
  });

  // Review finding 1a: a secrets/ directory this user cannot enter (0700 owned by uid 999, the deploy user is neither) made
  // `[ -f old ]` false, so the copy was skipped silently while the variable half still migrated and enabled the overlay.
  describe.skipIf(process.getuid?.() === 0)("an inaccessible secrets directory", () => {
    it("stops before .env.production is touched, with a hand-copy hint, when the overlay is configured", () => {
      const o = deploy({
        backupOverlay: true,
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: { [OLD_SECRET]: { content: secretValue } },
        secretsDirMode: 0o000,
      });
      expect(o.code, o.out).toBe(1);
      expect(o.calls, "docker must not be called").toEqual([]);
      expect(o.env, "the env file is exactly what the host had").toBe(o.envBefore);
      expect(envEntry(o.env, NEW_KEY).count).toBe(0);
      expect(o.secrets[NEW_SECRET]).toBeUndefined();
      expect(o.out).toContain("Copy it by hand");
      expect(o.out).toContain("No service was touched");
      expect(o.out).toContain("not accessible");
      expect(o.out, "the loop is named: a hand copy alone does not clear it").toContain("setfacl");
      expectNoBackupSecretInOutput(o);
    });

    it("a hand copy inside the directory does not clear the stop, only search permission on it does", () => {
      const p = prepare({
        backupOverlay: true,
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: {
          [OLD_SECRET]: { content: secretValue },
          [NEW_SECRET]: { content: secretValue },
        },
        secretsDirMode: 0o000,
      });
      const stuck = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
      expect(stuck.status, `${stuck.stdout}${stuck.stderr}`).toBe(1); // the new file exists but cannot be seen
      expect(stuck.stderr).toContain("setfacl");
      chmodSync(join(p.dir, "secrets"), 0o500); // search permission, which is what the setfacl line grants
      const cleared = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
      expect(cleared.status, `${cleared.stdout}${cleared.stderr}`).toBe(0);
      chmodSync(join(p.dir, "secrets"), 0o700); // so the scratch directory can be removed
    });

    it("a re-run fails the same way (never a half-migrated env) until the operator copies the file", () => {
      const p = prepare({
        backupOverlay: true,
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: { [OLD_SECRET]: { content: secretValue } },
        secretsDirMode: 0o000,
      });
      for (let i = 0; i < 2; i += 1) {
        const r = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
        expect(readFileSync(join(p.dir, ".env.production"), "utf8")).toBe(p.envBefore);
      }
      chmodSync(join(p.dir, "secrets"), 0o700); // the operator fixes access ...
      const fixed = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
      expect(fixed.status, `${fixed.stdout}${fixed.stderr}`).toBe(0); // ... and the deploy now migrates
      expect(existsSync(join(p.dir, "secrets", NEW_SECRET))).toBe(true);
    });

    it("an inaccessible directory is harmless when no backup overlay is configured on the host", () => {
      const o = deploy({
        secretFiles: { [OLD_SECRET]: { content: secretValue } },
        secretsDirMode: 0o000,
      });
      expect(o.code, o.out).toBe(0);
      expect(envEntry(o.env, NEW_KEY).count).toBe(0);
    });
  });

  it("the overlay is configured but NO secret file exists on the host: stops before the env is touched, naming the missing file", () => {
    const o = deploy({ backupOverlay: true, extraEnv: [`${OLD_KEY}=${accessKey}`] });
    expect(o.code, o.out).toBe(1);
    expect(o.calls).toEqual([]);
    expect(o.env).toBe(o.envBefore);
    expect(o.out).toContain(`secrets/${NEW_SECRET}`);
    expect(o.out).toContain("Copy it by hand");
  });

  it("an already migrated host (new variable + new file) passes with the overlay and copies nothing", () => {
    const o = deploy({
      backupOverlay: true,
      extraEnv: [`${NEW_KEY}=new-reader-key`],
      secretFiles: { [NEW_SECRET]: { content: otherSecret } },
    });
    expect(o.code, o.out).toBe(0);
    expect(o.out).not.toMatch(/copied (BACKUP_SOURCE|secrets)/);
    expect(
      o.calls.some((c) => c.includes("-f compose.backup.yml run --rm object-store-provision")),
    ).toBe(true);
  });

  // Review finding 1b: the copy must be atomic, so a partial destination is never mistaken for the real file on a re-run.
  describe("the secret copy is atomic", () => {
    it("a copy that dies half way leaves no partial file under the new name or a temp name, and the env unchanged", () => {
      const o = deploy({
        backupOverlay: true,
        failSecretCopy: true,
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: { [OLD_SECRET]: { content: secretValue } },
      });
      expect(o.code, o.out).toBe(1);
      expect(o.calls).toEqual([]);
      expect(o.env).toBe(o.envBefore);
      expect(Object.keys(o.secrets)).toEqual([OLD_SECRET]); // nothing partial, nothing temporary
      expect(o.secrets[OLD_SECRET]?.content).toBe(secretValue);
      expect(o.out).toContain("Copy it by hand");
      expectNoBackupSecretInOutput(o);
    });

    it("a re-run after the failed copy migrates normally (the partial was never mistaken for the real file)", () => {
      const p = prepare({
        backupOverlay: true,
        failSecretCopy: true,
        extraEnv: [`${OLD_KEY}=${accessKey}`],
        secretFiles: { [OLD_SECRET]: { content: secretValue } },
      });
      const failed = spawnSync("sh", DEPLOY_ARGS, { cwd: p.dir, encoding: "utf8", env: p.env });
      expect(failed.status).toBe(1);
      const rerun = spawnSync("sh", DEPLOY_ARGS, {
        cwd: p.dir,
        encoding: "utf8",
        env: { ...p.env, PATH: `${binDir}:/usr/bin:/bin` }, // the real cp now
      });
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      const o = collect(p, rerun.status ?? -1, `${rerun.stdout}${rerun.stderr}`);
      expect(o.secrets[NEW_SECRET]).toEqual({ content: secretValue, mode: 0o400 });
      expect(Object.keys(o.secrets).sort()).toEqual([NEW_SECRET, OLD_SECRET].sort());
      expect(envEntry(o.env, NEW_KEY)).toEqual({ value: accessKey, count: 1 });
    });

    it.skipIf(process.getuid?.() === 0)(
      "a secrets directory that cannot be written leaves nothing behind and the env unchanged",
      () => {
        const o = deploy({
          backupOverlay: true,
          extraEnv: [`${OLD_KEY}=${accessKey}`],
          secretFiles: { [OLD_SECRET]: { content: secretValue } },
          secretsDirMode: 0o500,
        });
        expect(o.code, o.out).toBe(1);
        expect(o.env).toBe(o.envBefore);
        expect(Object.keys(o.secrets)).toEqual([OLD_SECRET]);
        expect(o.out).toContain("Copy it by hand");
      },
    );
  });
});

// Audit sink. The new api serves only /api/v1/webhooks/object-store/access-log (the legacy minio path answers 404), so a
// fluent-bit that keeps posting to the old path silently loses every signed-URL download confirmation once the api is
// swapped. deploy.sh therefore recreates fluent-bit, verifies the RUNNING container's AUDIT_SINK_PATH is the canonical one,
// and fails the deploy before any migration (previous release untouched) when it cannot start or is not canonical.
describe.skipIf(BUN === "")("deploy.sh audit sink (fluent-bit)", () => {
  const CANONICAL = "/api/v1/webhooks/object-store/access-log";
  const index = (o: Outcome, needle: string): number =>
    o.calls.findIndex((c) => c.includes(needle));
  /** A deploy that stopped at the audit-sink check: nothing migrated, nothing swapped, the previous release is still running. */
  const expectStoppedBeforeMigrations = (o: Outcome): void => {
    expect(o.code, o.out).toBe(1);
    expect(
      o.calls.some((c) => c.includes("scripts/db/migrate.ts")),
      "migrate must not run",
    ).toBe(false);
    expect(o.calls.some((c) => c.includes("--force-recreate api worker web docling-worker"))).toBe(
      false,
    );
    expect(oldRestarts(o), "the previous release is left running, not recreated").toBe(0);
    expect(o.env).toContain(`CHARTWARDEN_IMAGE=${OLD_API}`);
    expect(o.previousReleaseSaved).toBe(false);
    expect(o.files, "the applied-config hash is only recorded after verification").not.toContain(
      ".object-store-conf.sha256",
    );
  };

  it("a fluent-bit on the canonical path passes: it is recreated, inspected, and only then do migrations run", () => {
    const o = deploy({});
    expect(o.code, o.out).toBe(0);
    const up = index(o, "up -d --no-deps");
    const ps = index(o, "ps -q fluent-bit");
    const inspect = index(o, "inspect");
    const migrate = index(o, "scripts/db/migrate.ts");
    expect(
      o.calls.findIndex((c) => c.endsWith("fluent-bit") && c.includes("up -d")),
    ).toBeGreaterThan(-1);
    expect(ps).toBeGreaterThan(up);
    expect(inspect).toBeGreaterThan(ps);
    expect(migrate).toBeGreaterThan(inspect);
    expect(o.files).toContain(".object-store-conf.sha256");
  });

  it("a RUNNING fluent-bit still posting to the removed /api/v1/webhooks/minio/access-log fails the deploy before migrations", () => {
    const o = deploy({ fluentPath: "/api/v1/webhooks/minio/access-log" });
    expectStoppedBeforeMigrations(o);
    expect(o.out).toContain(CANONICAL);
    expect(o.out).toContain("/api/v1/webhooks/minio/access-log");
    expect(o.out).toMatch(/no migrations were applied/i);
  });

  it("`up -d fluent-bit` failing fails the deploy before migrations (it was a warning before)", () => {
    const o = deploy({ fluentUpExit: 1 });
    expectStoppedBeforeMigrations(o);
    expect(o.out).toContain("fluent-bit did not start");
    expect(o.out).not.toContain("WARNING: fluent-bit");
  });

  it("an unverifiable fluent-bit (no container found) fails closed", () => {
    const o = deploy({ fluentNoContainer: true });
    expectStoppedBeforeMigrations(o);
    expect(o.out).toContain(CANONICAL);
  });

  it("a path that merely CONTAINS the canonical one is not accepted (exact match)", () => {
    const o = deploy({ fluentPath: `${CANONICAL}/../minio/access-log` });
    expectStoppedBeforeMigrations(o);
    const prefixed = deploy({ fluentPath: `/legacy${CANONICAL}` });
    expectStoppedBeforeMigrations(prefixed);
  });

  it("the failure alerts as a plain failure at the object-store step (exit 1), without values", () => {
    const o = deploy({ fluentUpExit: 1, alert: { via: "env", url: WEBHOOK } });
    expect(o.code, o.out).toBe(1);
    expect(o.alertBody).toMatchObject({ step: "object-store", exit_code: 1 });
  });

  it("the canonical path deploy.sh verifies is the one compose.yml gives fluent-bit", () => {
    const compose = readFileSync(join(REPO, "deploy/production/compose.yml"), "utf8");
    const fromCompose = /AUDIT_SINK_PATH: (\S+)/.exec(compose)?.[1];
    const fromScript = /^object_store_audit_path=(\S+)$/m.exec(readFileSync(DEPLOY, "utf8"))?.[1];
    expect(fromCompose).toBe(CANONICAL);
    expect(fromScript).toBe(CANONICAL);
  });
});

// #866 — optional deploy failure alert. Fires on any non-zero exit, names exit 75, carries no PHI, never decides the
// deploy's outcome, and never leaks the (secret) URL.
describe.skipIf(BUN === "")("deploy.sh failure alert (#866)", () => {
  const alert = { via: "env", url: WEBHOOK } as const;

  it("a hold before any schema change alerts as a HOLD (nothing applied, previous release untouched), not as a refused rollback", () => {
    const o = deploy({ migrateExit: 75, alert });
    expect(o.code, o.out).toBe(75);
    expect(o.alertBody).toMatchObject({
      step: "migrate",
      exit_code: 75,
      operator_decision_required: true,
      applied_migrations: [],
    });
    const text = String(o.alertBody?.text);
    expect(text).toContain("HELD before any schema change");
    expect(text).toContain("nothing applied");
    expect(text).not.toContain("automatic rollback refused");
  });

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
      [
        "applied_migrations",
        "exit_code",
        "operator_decision_required",
        "sha",
        "step",
        "text",
      ].sort(),
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
    const envFiles = [...compose.matchAll(/^\s*env_file:\s*(.+)$/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );
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
