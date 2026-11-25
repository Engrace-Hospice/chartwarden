import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// deploy/production/preflight.sh against a stubbed `docker`: every intermediate state of the infra rename windows
// (INFRA_RENAME_RUNBOOK.md, "Phase 2 operator windows") must be accepted or refused for the stated reason. The script is
// read-only and fail-closed (exit 67); a green test here means a deploy cannot start on a half-copied volume set or a
// database name that disagrees with the cluster.

const PREFLIGHT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../deploy/production/preflight.sh",
);
const scratch = mkdtempSync(join(tmpdir(), "preflight-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const DOCKER_STUB = `#!/bin/sh
case "$1" in
  info) [ -z "\${STUB_INFO_FAIL:-}" ] || exit 1 ;;
  volume) # volume ls -q --filter name=_X$
    pat=""; for a in "$@"; do case "$a" in name=*) pat=\${a#name=} ;; esac; done
    suffix=\${pat%\\$}
    printf '%s\\n' "\${STUB_VOLUMES:-}" | grep -E "^.+\${suffix}\\$" || true ;;
  ps)
    if [ "$2" = "-a" ]; then printf '%s\\n' "\${STUB_PG_PROJECTS:-}"; else printf '%s\\n' "\${STUB_PG_ID:-}"; fi ;;
  exec) printf '%s\\n' "\${STUB_DATABASES:-}" ;;
esac
exit 0
`;
const binDir = join(scratch, "bin");
mkdirSync(binDir);
writeFileSync(join(binDir, "docker"), DOCKER_STUB);
chmodSync(join(binDir, "docker"), 0o755);

interface State {
  readonly env: readonly string[];
  readonly volumes?: readonly string[];
  readonly pgProjects?: readonly string[];
  readonly runningPg?: boolean;
  readonly databases?: readonly string[];
  readonly dockerDown?: boolean;
}

function run(state: State): { code: number; out: string } {
  const dir = mkdtempSync(join(scratch, "deploy-"));
  writeFileSync(join(dir, ".env.production"), `${state.env.join("\n")}\n`);
  const r = spawnSync("sh", [PREFLIGHT], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      STUB_VOLUMES: (state.volumes ?? []).join("\n"),
      STUB_PG_PROJECTS: (state.pgProjects ?? []).join("\n"),
      STUB_PG_ID: state.runningPg ? "abc123" : "",
      STUB_DATABASES: (state.databases ?? []).join("\n"),
      STUB_INFO_FAIL: state.dockerDown ? "1" : "",
    },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const SMOKE = [
  "CHARTWARDEN_SMOKE_APP_URL=https://wardenx.chartwarden.cloud",
  "CHARTWARDEN_SMOKE_API_URL=https://be082026.wardenx.chartwarden.cloud",
];
const LEGACY_VOLUMES = [
  "wardenx_postgres-data",
  "wardenx_valkey-data",
  "wardenx_seaweedfs-data",
  "wardenx_clamav-data",
];
const NEW_VOLUMES = LEGACY_VOLUMES.map((v) => v.replace("wardenx_", "chartwarden_"));

describe("preflight.sh across the infra-rename windows", () => {
  it("accepts a fresh host (no volumes, no containers)", () => {
    const r = run({ env: [] });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("preflight ok");
  });

  // The key was renamed (BACKUP_SOURCE_MINIO_ACCESS_KEY -> BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY). Preflight runs before
  // deploy.sh copies the old name to the new one on a host's first deploy, so EITHER name must enable the check.
  describe.each(["BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY", "BACKUP_SOURCE_MINIO_ACCESS_KEY"])(
    "requires a repository-owned digest pin when the backup overlay is enabled by %s",
    (key) => {
      it("accepts the published tag@sha256 digest", () => {
        const digest = `sha256:${"a".repeat(64)}`;
        const good = run({
          env: [
            `${key}=reader`,
            `CHARTWARDEN_BACKUP_IMAGE=ghcr.io/engrace-hospice/chartwarden-backup:18-tools-sha-abc@${digest}`,
          ],
        });
        expect(good.code, good.out).toBe(0);
      });

      it("refuses a local, mutable, foreign or malformed image", () => {
        const digest = `sha256:${"a".repeat(64)}`;
        for (const image of [
          "chartwarden-backup:local",
          "ghcr.io/engrace-hospice/chartwarden-backup:latest",
          `ghcr.io/other/chartwarden-backup:18-tools-sha-abc@${digest}`,
          "ghcr.io/engrace-hospice/chartwarden-backup:18-tools-sha-abc@sha256:abc",
        ]) {
          const bad = run({ env: [`${key}=reader`, `CHARTWARDEN_BACKUP_IMAGE=${image}`] });
          expect(bad.code, `${image}\n${bad.out}`).toBe(67);
          expect(bad.out).toContain("CHARTWARDEN_BACKUP_IMAGE");
        }
      });
    },
  );

  it("does not check the backup image when neither name enables the overlay", () => {
    const r = run({ env: ["CHARTWARDEN_BACKUP_IMAGE=chartwarden-backup:local"] });
    expect(r.code, r.out).toBe(0);
  });

  it("accepts the live state today: wardenx_* volumes, prefix + db pinned to wardenx", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=wardenx", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
      volumes: LEGACY_VOLUMES,
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "wardenx"],
    });
    expect(r.code, r.out).toBe(0);
  });

  it("accepts the copied state: both volume sets present, prefix flipped, db still wardenx", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=chartwarden", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
      volumes: [...LEGACY_VOLUMES, ...NEW_VOLUMES],
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "wardenx"],
    });
    expect(r.code, r.out).toBe(0);
  });

  it("accepts the end state: prefix line removed (default), db renamed, old volumes kept for rollback", () => {
    const r = run({
      env: [
        "CHARTWARDEN_DB_NAME=chartwarden",
        "CHARTWARDEN_SMOKE_APP_URL=https://app.chartwarden.cloud",
        "CHARTWARDEN_SMOKE_API_URL=https://api.chartwarden.cloud",
      ],
      volumes: [...LEGACY_VOLUMES, ...NEW_VOLUMES],
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "chartwarden"],
    });
    expect(r.code, r.out).toBe(0);
  });

  it("accepts the final cleanup state: only chartwarden_* volumes remain", () => {
    const r = run({
      env: ["CHARTWARDEN_DB_NAME=chartwarden", ...SMOKE],
      volumes: NEW_VOLUMES,
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "chartwarden"],
    });
    expect(r.code, r.out).toBe(0);
  });

  it("refuses a flipped prefix before the postgres volume was copied", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=chartwarden", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
      volumes: LEGACY_VOLUMES,
      pgProjects: ["chartwarden"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("chartwarden_postgres-data");
  });

  it("refuses a half-finished copy (postgres copied, object store not)", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=chartwarden", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
      volumes: [...LEGACY_VOLUMES, "chartwarden_postgres-data"],
      pgProjects: ["chartwarden"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("chartwarden_seaweedfs-data");
  });

  // The MinIO -> SeaweedFS cutover machinery is gone from deploy.sh, so nothing starts the copy any more: a host that still
  // has a *_minio-data volume and NO *_seaweedfs-data volume would get an EMPTY SeaweedFS (every document looks lost).
  describe("the retired MinIO volume", () => {
    const env = ["CHARTWARDEN_VOLUME_PREFIX=chartwarden", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE];

    it("refuses a host that has *_minio-data but no *_seaweedfs-data volume (the cutover never ran)", () => {
      for (const minio of ["chartwarden_minio-data", "wardenx_minio-data"]) {
        const r = run({
          env,
          volumes: ["chartwarden_postgres-data", minio],
          pgProjects: ["chartwarden"],
        });
        expect(r.code, `${minio}\n${r.out}`).toBe(67);
        expect(r.out).toContain(minio);
        expect(r.out).toContain("EMPTY");
        expect(r.out).toMatch(/do not deploy/i);
      }
    });

    it("refuses it on the legacy prefix too (the copy of postgres done, SeaweedFS never created)", () => {
      const r = run({
        env: ["CHARTWARDEN_VOLUME_PREFIX=wardenx", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
        volumes: ["wardenx_postgres-data", "wardenx_minio-data"],
        pgProjects: ["chartwarden"],
      });
      expect(r.code, r.out).toBe(67);
      expect(r.out).toContain("wardenx_minio-data");
    });

    it("a migrated host (SeaweedFS volume present) with a leftover minio-data volume deploys, with a WARNING", () => {
      const r = run({
        env,
        volumes: [...NEW_VOLUMES, "wardenx_minio-data"],
        pgProjects: ["chartwarden"],
      });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("preflight WARNING");
      expect(r.out).toContain("wardenx_minio-data");
      expect(r.out).toContain("plaintext");
      expect(r.out).toContain("backups");
    });

    it("a migrated host without any minio-data volume prints no MinIO warning", () => {
      const r = run({ env, volumes: NEW_VOLUMES, pgProjects: ["chartwarden"] });
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("minio-data");
    });

    it("a fresh host (no volumes at all) is untouched by the check", () => {
      const r = run({ env: [] });
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("minio-data");
    });
  });

  it("refuses when the key says chartwarden but the cluster still holds wardenx (rename not run)", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=wardenx", "CHARTWARDEN_DB_NAME=chartwarden", ...SMOKE],
      volumes: LEGACY_VOLUMES,
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "wardenx"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("does not exist in the running cluster");
  });

  it("refuses when the key still says wardenx after the rename ran", () => {
    const r = run({
      env: ["CHARTWARDEN_VOLUME_PREFIX=chartwarden", "CHARTWARDEN_DB_NAME=wardenx", ...SMOKE],
      volumes: NEW_VOLUMES,
      pgProjects: ["chartwarden"],
      runningPg: true,
      databases: ["postgres", "chartwarden"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("database 'wardenx' does not exist");
  });

  it("refuses an existing stack with no explicit database key", () => {
    const r = run({ env: [...SMOKE], volumes: NEW_VOLUMES, pgProjects: ["chartwarden"] });
    expect(r.code).toBe(67);
    expect(r.out).toContain("CHARTWARDEN_DB_NAME");
  });

  it("refuses an existing stack without both smoke host keys", () => {
    const r = run({
      env: ["CHARTWARDEN_DB_NAME=chartwarden"],
      volumes: NEW_VOLUMES,
      pgProjects: ["chartwarden"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("CHARTWARDEN_SMOKE_APP_URL");
  });

  it("refuses a second stack under another compose project name", () => {
    const r = run({
      env: ["CHARTWARDEN_DB_NAME=chartwarden", ...SMOKE],
      volumes: NEW_VOLUMES,
      pgProjects: ["wardenx"],
    });
    expect(r.code).toBe(67);
    expect(r.out).toContain("no postgres container");
  });

  it("refuses when docker is down (fail closed)", () => {
    const r = run({ env: [], dockerDown: true });
    expect(r.code).toBe(67);
    expect(r.out).toContain("docker is not reachable");
  });
});
