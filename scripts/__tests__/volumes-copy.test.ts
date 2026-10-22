import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// deploy/production/volumes-copy.sh against a stubbed `docker`: refusal paths and the "never report identical when nothing
// was compared" guard (POSIX sh has no pipefail). The real copy was rehearsed on private containers (see the PR body).

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../../deploy/production/volumes-copy.sh");
const scratch = mkdtempSync(join(tmpdir(), "vcopy-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// STUB_VOLUMES: existing volumes; STUB_BUSY: volume held by a container; STUB_NONEMPTY: volumes whose `ls -A` is non-empty;
// STUB_RUN_FAIL=1: every `docker run` fails; STUB_NO_IMAGE=1: image inspect fails.
const STUB = `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  image) [ -z "\${STUB_NO_IMAGE:-}" ] || exit 1 ;;
  volume)
    case "$2" in
      inspect) printf '%s\\n' "\${STUB_VOLUMES:-}" | grep -qx "$3"; exit $? ;;
      create) exit 0 ;;
    esac ;;
  ps) for a in "$@"; do case "$a" in volume=*) printf '%s\\n' "\${STUB_BUSY:-}" | grep -x "\${a#volume=}" || true ;; esac; done ;;
  run)
    [ -z "\${STUB_RUN_FAIL:-}" ] || exit 1
    case "$*" in
      *"ls -A"*) for v in \${STUB_NONEMPTY:-}; do case "$*" in *"$v:"*) echo data ;; esac; done ;;
      *cp\\ -a*) exit 0 ;;
      *) echo "./|directory|755|0:0" ;;
    esac ;;
esac
exit 0
`;
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "docker"), STUB);
chmodSync(join(bin, "docker"), 0o755);

function run(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("sh", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const SRC = ["old_postgres-data", "old_minio-data"].join("\n");

describe("volumes-copy.sh", () => {
  it("rejects a bad mode, a bad prefix and identical prefixes", () => {
    expect(run(["nuke", "old", "new"]).code).toBe(1);
    expect(run(["copy", "Bad Prefix", "new"]).out).toContain("prefix must match");
    expect(run(["copy", "old", "old"]).out).toContain("same");
  });

  it("refuses when a required source volume is missing", () => {
    const r = run(["copy", "old", "new"], { STUB_VOLUMES: "old_postgres-data" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("old_minio-data does not exist");
  });

  it("refuses when a container still uses a source volume, before copying anything", () => {
    const r = run(["copy", "old", "new"], { STUB_VOLUMES: SRC, STUB_BUSY: "old_minio-data" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("in use by a container");
    expect(r.out).not.toContain("copy old_");
  });

  it("refuses a destination that already holds data", () => {
    const r = run(["copy", "old", "new"], { STUB_VOLUMES: `${SRC}\nnew_postgres-data`, STUB_NONEMPTY: "new_postgres-data" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("already exists and holds data");
  });

  it("refuses when the helper image is not cached", () => {
    const r = run(["verify", "old", "new"], { STUB_VOLUMES: SRC, STUB_NO_IMAGE: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not present locally");
  });

  it("never prints identical when the manifest cannot be read", () => {
    const r = run(["verify", "old", "new"], { STUB_VOLUMES: `${SRC}\nnew_postgres-data\nnew_minio-data`, STUB_RUN_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("identical");
  });

  it("verifies identical trees and leaves the source untouched", () => {
    const r = run(["verify", "old", "new"], { STUB_VOLUMES: `${SRC}\nnew_postgres-data\nnew_minio-data` });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("ok   postgres-data identical");
  });
});
