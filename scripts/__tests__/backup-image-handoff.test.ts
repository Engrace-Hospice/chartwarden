import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

// The backup sidecar's image is digest-pinned in CHARTWARDEN_BACKUP_IMAGE and is NOT recreated by deploy.sh, so for one
// release the repo's compose.backup.yml and restore.sh talk to an image whose cw-backup.sh may still read the OLD names
// (BACKUP_SOURCE_MINIO_* / RESTORE_MINIO_*). These tests exercise both hand-offs for real, with a stubbed `mc` / `docker`:
//   - compose.backup.yml -> the sidecar's environment -> cw-backup.sh (an OLD-image script and the current one);
//   - restore.sh -> the environment of the `restore-objects` container, and the old image/port variable fallbacks.
// The OLD-image script is the current one with the rename undone: the rename was a pure name substitution.
//
// TEMPORARY ALIAS: delete this file's old-image cases when CHARTWARDEN_BACKUP_IMAGE is repinned to an image built from the
// commit that renamed the variables.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const COMPOSE_BACKUP = join(REPO, "deploy/production/compose.backup.yml");
const CW_BACKUP = join(REPO, "deploy/production/backup/cw-backup.sh");
const RESTORE = join(REPO, "deploy/production/backup/restore.sh");

const have = (cmd: string): boolean =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const TOOLS = have("bash") && have("jq");
if (!TOOLS)
  console.warn("backup-image-handoff: bash or jq is missing, the hand-off tests are skipped");

const scratch = mkdtempSync(join(tmpdir(), "backup-handoff-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const NEW_SCRIPT = readFileSync(CW_BACKUP, "utf8");
const OLD_SCRIPT = NEW_SCRIPT.replaceAll(
  "BACKUP_SOURCE_OBJECT_STORE_",
  "BACKUP_SOURCE_MINIO_",
).replaceAll("RESTORE_OBJECT_STORE_", "RESTORE_MINIO_");
const oldScriptPath = join(scratch, "old-cw-backup.sh");
writeFileSync(oldScriptPath, OLD_SCRIPT);

// `mc`: records its argv and the aliases cw-backup.sh builds (MC_HOST_<alias> carries url + credentials).
const bin = join(scratch, "bin");
mkdirSync(bin);
const writeBin = (name: string, body: string): void => {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
};
writeBin(
  "mc",
  `#!/bin/sh
printf 'mc %s\\n' "$*" >> "$STUB_LOG"
printf 'MC_HOST_root=%s\\n' "\${MC_HOST_root:-}" >> "$STUB_LOG"
printf 'MC_HOST_target=%s\\n' "\${MC_HOST_target:-}" >> "$STUB_LOG"
exit 0
`,
);

const COMPOSE_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  (["sequence", "scalar", "mapping"] as const).map(
    (kind) => new yaml.Type("!reset", { kind, construct: () => null }),
  ),
);

/** Compose interpolation of `${NAME}`, `${NAME:-default}` and `${NAME:?message}` against `vars`. */
function interpolate(value: string, vars: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)(?::\?[^}]*|:-([^}]*))?\}/g,
    (_m, name: string, dflt: string | undefined) => {
      const v = vars[name];
      if (v !== undefined && v !== "") return v;
      if (dflt !== undefined) return dflt;
      if (_m.includes(":?")) throw new Error(`compose.backup.yml requires ${name}`);
      return "";
    },
  );
}

const SOURCE_ACCESS = "synthetic-backup-reader-key";
const SOURCE_SECRET = "synthetic-backup-reader-secret-0123456789";
const ROOT_USER = "synthetic-root-user";
const ROOT_PASSWORD = "synthetic-root-password-0123456789";

/**
 * The environment the `backup` sidecar would get from compose.backup.yml: its environment map, interpolated, with every
 * /run/secrets/<name> path pointed at a real temp file (the source secret holds SOURCE_SECRET).
 */
function sidecarEnv(): Record<string, string> {
  const doc = yaml.load(readFileSync(COMPOSE_BACKUP, "utf8"), { schema: COMPOSE_SCHEMA }) as {
    services: { backup: { environment: Record<string, string | number> } };
  };
  const vars = {
    BACKUP_OFFSITE_S3_ENDPOINT: "https://offsite.example.test",
    BACKUP_OFFSITE_S3_BUCKET: "bucket",
    BACKUP_OFFSITE_S3_REGION: "us-east-1",
    BACKUP_OFFSITE_S3_ACCESS_KEY: "synthetic-offsite-key",
    BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY: SOURCE_ACCESS,
    OPS_ALERT_WEBHOOK_URL: "https://ops.example.test/hook",
  };
  const secretsDir = mkdtempSync(join(scratch, "run-secrets-"));
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(doc.services.backup.environment)) {
    let value = interpolate(String(raw), vars);
    if (value.startsWith("/run/secrets/")) {
      const file = join(secretsDir, basename(value));
      if (!existsSync(file)) {
        writeFileSync(
          file,
          basename(value) === "backup_source_object_store_secret_key"
            ? SOURCE_SECRET
            : `synthetic-${basename(value)}-0123456789abcdef`,
        );
      }
      value = file;
    }
    env[key] = value;
  }
  return env;
}

function runScript(
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): { code: number; out: string; log: string } {
  const dir = mkdtempSync(join(scratch, "run-"));
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_LOG: log,
      BACKUP_STATE_DIR: join(dir, "state"),
      ...env,
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, log: readFileSync(log, "utf8") };
}

describe.skipIf(!TOOLS)("compose.backup.yml -> the backup sidecar's cw-backup.sh", () => {
  const root = { MINIO_ROOT_USER: ROOT_USER, MINIO_ROOT_PASSWORD: ROOT_PASSWORD };

  it("a sidecar still running the OLD image (reads BACKUP_SOURCE_MINIO_*) gets the reader key, secret and URL from the new compose file", () => {
    const r = runScript(oldScriptPath, ["provision-source-reader"], { ...sidecarEnv(), ...root });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain(`admin user add root ${SOURCE_ACCESS} ${SOURCE_SECRET}`);
    expect(r.log).toContain(`MC_HOST_root=http://${ROOT_USER}:${ROOT_PASSWORD}@seaweedfs:8333`);
  });

  it("a sidecar running an image built from this change (reads BACKUP_SOURCE_OBJECT_STORE_*) gets the same", () => {
    const r = runScript(CW_BACKUP, ["provision-source-reader"], { ...sidecarEnv(), ...root });
    expect(r.code, r.out).toBe(0);
    expect(r.log).toContain(`admin user add root ${SOURCE_ACCESS} ${SOURCE_SECRET}`);
    expect(r.log).toContain(`MC_HOST_root=http://${ROOT_USER}:${ROOT_PASSWORD}@seaweedfs:8333`);
  });

  it("both spellings point at the same secret file: the old variable never carries a different key", () => {
    const env = sidecarEnv();
    expect(env.BACKUP_SOURCE_MINIO_SECRET_KEY_FILE).toBe(
      env.BACKUP_SOURCE_OBJECT_STORE_SECRET_KEY_FILE,
    );
    expect(env.BACKUP_SOURCE_MINIO_ACCESS_KEY).toBe(env.BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY);
    expect(env.BACKUP_SOURCE_MINIO_URL).toBe(env.BACKUP_SOURCE_OBJECT_STORE_URL);
  });
});

// ── restore.sh -> the restore-objects container ──────────────────────────────────────────────────────────────────────
const OLD_ID = "t1";
const PINNED = (c: string): string => `registry.example.test/minio@sha256:${c.repeat(64)}`;

// `docker`: logs every call; answers the marker, the promotion probe and the curl health check; for the restore-objects
// container it writes the environment docker would hand it (`-e NAME` takes the caller's value, `-e NAME=v` and
// --env-file are literal), so the hand-off is observed, not assumed.
const DOCKER_STUB = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$*" in *"exec -i"*) cat > /dev/null ;; esac
case "$*" in
  *"cw-backup.sh restore-db"*) printf '{"snapshotId":"20261027T150000Z","db":{"database":"chartwarden"}}\\n' ;;
  *"psql"*"pg_is_in_recovery"*) echo f ;;
  *"cw-backup.sh restore-objects"*)
    out="$STUB_STATE/restore-objects.env"; : > "$out"; prev=""
    for a in "$@"; do
      case "$prev" in
        -e) case "$a" in *=*) printf '%s\\n' "$a" >> "$out" ;; *) eval "v=\\\${$a-}"; printf '%s=%s\\n' "$a" "$v" >> "$out" ;; esac ;;
        --env-file) cat "$a" >> "$out" ;;
      esac
      prev="$a"
    done
    echo manifest ;;
esac
exit 0
`;
writeBin("docker", DOCKER_STUB);
writeBin("curl", "#!/bin/sh\nexit 0\n");

interface RestoreRun {
  readonly code: number;
  readonly out: string;
  readonly calls: readonly string[];
  /** The environment of the restore-objects container, name -> value. */
  readonly containerEnv: Readonly<Record<string, string>>;
  readonly restoreEnv: string;
}

function restore(
  extra: Record<string, string> = {},
  envFileExtra: readonly string[] = [],
): RestoreRun {
  const dir = mkdtempSync(join(scratch, "restore-"));
  const state = join(dir, ".stub");
  mkdirSync(state);
  const log = join(state, "calls.log");
  writeFileSync(log, "");
  const envFile = join(dir, "backup.env");
  writeFileSync(envFile, ["BACKUP_OFFSITE_S3_BUCKET=bucket", ...envFileExtra, ""].join("\n"));
  const outDir = join(dir, "out");
  const r = spawnSync("bash", [RESTORE, "latest"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      STUB_LOG: log,
      STUB_STATE: state,
      BACKUP_ENV_FILE: envFile,
      BACKUP_IMAGE: "chartwarden-backup:test",
      RESTORE_ID: OLD_ID,
      RESTORE_OUT_DIR: outDir,
      ...extra,
    },
  });
  const envFileOut = join(state, "restore-objects.env");
  const containerEnv = existsSync(envFileOut)
    ? Object.fromEntries(
        readFileSync(envFileOut, "utf8")
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      )
    : {};
  return {
    code: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    containerEnv,
    restoreEnv: existsSync(join(outDir, "restore.env"))
      ? readFileSync(join(outDir, "restore.env"), "utf8")
      : "",
  };
}

const storeRun = (r: RestoreRun): string => r.calls.find((c) => c.includes(" server /data")) ?? "";
const imageOf = (call: string): string =>
  call.split(" ")[call.split(" ").indexOf("server") - 1] ?? "";

describe.skipIf(!TOOLS)("restore.sh -> the restore-objects container", () => {
  it("hands the container BOTH the new and the old restore-target variables, with identical values", () => {
    const r = restore();
    expect(r.code, r.out).toBe(0);
    for (const suffix of ["URL", "ACCESS_KEY", "SECRET_KEY"]) {
      const next = r.containerEnv[`RESTORE_OBJECT_STORE_${suffix}`];
      expect(next, `RESTORE_OBJECT_STORE_${suffix}`).toBeTruthy();
      expect(r.containerEnv[`RESTORE_MINIO_${suffix}`], `RESTORE_MINIO_${suffix}`).toBe(next);
    }
    expect(r.containerEnv.RESTORE_OBJECT_STORE_URL).toBe(`http://cw-restore-${OLD_ID}-minio:9000`);
  });

  it("an OLD backup image (reads RESTORE_MINIO_*) configures its restore target from that environment", () => {
    const r = restore();
    expect(r.code, r.out).toBe(0);
    const env = {
      ...r.containerEnv,
      BACKUP_OBJECT_SSE_C_KEY: Buffer.alloc(32, 7).toString("base64"),
      BACKUP_OFFSITE_S3_ENDPOINT: "https://offsite.example.test",
      BACKUP_OFFSITE_S3_ACCESS_KEY: "synthetic-offsite-key",
      BACKUP_OFFSITE_S3_SECRET_KEY: "synthetic-offsite-secret",
      BACKUP_OFFSITE_S3_BUCKET: "bucket",
    };
    // The stubbed `mc` returns nothing, so the script stops after it has built its aliases; what matters is that the
    // `target` alias exists, from the old names, before that point.
    const old = runScript(oldScriptPath, ["restore-objects", "20261027T150000Z"], env);
    expect(old.log).toContain(
      `MC_HOST_target=http://${env.RESTORE_MINIO_ACCESS_KEY}:${env.RESTORE_MINIO_SECRET_KEY}@cw-restore-${OLD_ID}-minio:9000`,
    );
    expect(old.out).not.toContain("RESTORE_MINIO_ACCESS_KEY is not set");
    expect(old.out).not.toMatch(/RESTORE_MINIO_\w+: (unbound variable|parameter)/);
    // ... and the current script reads the new names from the very same environment.
    const current = runScript(CW_BACKUP, ["restore-objects", "20261027T150000Z"], env);
    expect(current.log).toContain(
      `MC_HOST_target=http://${env.RESTORE_OBJECT_STORE_ACCESS_KEY}:${env.RESTORE_OBJECT_STORE_SECRET_KEY}@cw-restore-${OLD_ID}-minio:9000`,
    );
  });

  it("restore.env carries the old endpoint/credential names too, for a verifier from an older image", () => {
    const r = restore();
    expect(r.code, r.out).toBe(0);
    for (const suffix of ["ENDPOINT", "ACCESS_KEY", "SECRET_KEY"]) {
      const next = new RegExp(`^RESTORE_OBJECT_STORE_${suffix}=(.+)$`, "m").exec(r.restoreEnv)?.[1];
      const old = new RegExp(`^RESTORE_MINIO_${suffix}=(.+)$`, "m").exec(r.restoreEnv)?.[1];
      expect(next, `RESTORE_OBJECT_STORE_${suffix}`).toBeTruthy();
      expect(old, `RESTORE_MINIO_${suffix}`).toBe(next);
    }
  });

  it("the default image and port are used when neither spelling is set", () => {
    const r = restore();
    expect(r.code, r.out).toBe(0);
    expect(imageOf(storeRun(r))).toMatch(/^cgr\.dev\/chainguard\/minio@sha256:[0-9a-f]{64}$/);
    expect(storeRun(r)).toContain("-p 127.0.0.1:59000:9000");
  });

  it("an exported RESTORE_MINIO_IMAGE / RESTORE_MINIO_PORT is honoured: it never silently falls back to the default", () => {
    const r = restore({ RESTORE_MINIO_IMAGE: PINNED("a"), RESTORE_MINIO_PORT: "61234" });
    expect(r.code, r.out).toBe(0);
    expect(imageOf(storeRun(r))).toBe(PINNED("a"));
    expect(storeRun(r)).toContain("-p 127.0.0.1:61234:9000");
    expect(r.restoreEnv).toContain("RESTORE_OBJECT_STORE_ENDPOINT=http://127.0.0.1:61234");
    expect(r.out).toContain("RESTORE_MINIO_IMAGE");
  });

  it("the new names win when both spellings are set", () => {
    const r = restore({
      RESTORE_OBJECT_STORE_IMAGE: PINNED("b"),
      RESTORE_MINIO_IMAGE: PINNED("a"),
      RESTORE_OBJECT_STORE_PORT: "62000",
      RESTORE_MINIO_PORT: "61234",
    });
    expect(r.code, r.out).toBe(0);
    expect(imageOf(storeRun(r))).toBe(PINNED("b"));
    expect(storeRun(r)).toContain("-p 127.0.0.1:62000:9000");
  });

  it("an unpinned image is refused whichever spelling carried it, before any container starts", () => {
    for (const name of ["RESTORE_OBJECT_STORE_IMAGE", "RESTORE_MINIO_IMAGE"]) {
      const r = restore({ [name]: "registry.example.test/minio:latest" });
      expect(r.code, `${name}\n${r.out}`).toBe(1);
      expect(r.out).toContain("pinned by digest");
      expect(r.calls.filter((c) => c.startsWith("docker run"))).toEqual([]);
    }
  });

  it("a plain backup-source secret in BACKUP_ENV_FILE is refused in either spelling, before any container starts", () => {
    for (const name of [
      "BACKUP_SOURCE_OBJECT_STORE_SECRET_KEY",
      "BACKUP_SOURCE_MINIO_SECRET_KEY",
    ]) {
      const r = restore({}, [`${name}=synthetic-plain-secret-not-real`]);
      expect(r.code, `${name}\n${r.out}`).toBe(1);
      expect(r.out).toContain("plain secret value");
      expect(r.out).not.toContain("synthetic-plain-secret-not-real");
      expect(r.calls).toEqual([]);
    }
  });
});
