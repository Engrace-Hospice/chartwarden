import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
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

// CW-RUST-M02 P2 prerequisite 1 — deploy.sh verifies the Rust image (an optional 4th argument) with cosign against
// the chartwarden-rust workflow identity, and trusts that identity for THAT IMAGE ONLY. The real script runs against
// a stubbed `docker` and a stubbed `cosign` that holds a (image, identity) trust table, so each case states exactly
// which signer is accepted for which image. Properties under test: scoped trust in both directions, digest-only
// roll, no unverified Rust image ever, and no change at all when the argument is absent.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOY = join(REPO, "deploy/production/deploy.sh");

const scratch = mkdtempSync(join(tmpdir(), "deploy-rust-verify-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const UPSTREAM_ID =
  "https://github.com/Engrace-Hospice/chartwarden/.github/workflows/deploy.yml@refs/heads/main";
const RUST_ID =
  "https://github.com/Engrace-Hospice/chartwarden-rust/.github/workflows/rust-image.yml@refs/heads/main";

const BACKEND = "ghcr.io/engrace-hospice/chartwarden:sha-new";
const WEB = "ghcr.io/engrace-hospice/chartwarden-web:sha-new";
const RUST = "ghcr.io/engrace-hospice/chartwarden-rust:sha-new";
// One distinct, valid digest per image so a mixed-up pin is visible.
const DIGEST = { backend: "a", web: "b", docling: "c", rust: "d" } as const;
const digestOf = (k: keyof typeof DIGEST): string => `sha256:${DIGEST[k].repeat(64)}`;

// `docker`: log every call, answer the two ledger queries (no migrations), succeed at everything else.
const DOCKER_STUB = `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$STUB_LOG"
case "$*" in
  *"exec -T postgres psql"*to_regclass*) echo t ;;
  *"exec -T postgres psql"*_chartwarden_migration*) printf '0001_init.sql\\n' ;;
esac
exit 0
`;

// `cosign verify <ref> --certificate-identity <id> ...`: succeeds only when "<ref-substring> <identity> <digest-char>"
// is a line of $STUB_STATE/trust. Prints the JSON shape deploy.sh parses.
const COSIGN_STUB = `#!/bin/sh
printf 'cosign %s\\n' "$*" >> "$STUB_LOG"
ref=$2; id=
while [ $# -gt 0 ]; do [ "$1" = --certificate-identity ] && id=$2; shift; done
while read -r pat want ch; do
  case "$ref" in *"$pat"*)
    if [ "$id" = "$want" ]; then
      d=$(printf '%064d' 0 | tr 0 "$ch")
      printf '[{"critical":{"image":{"docker-manifest-digest":"sha256:%s"}}}]\\n' "$d"; exit 0
    fi ;;
  esac
done < "$STUB_STATE/trust"
exit 1
`;

const binDir = join(scratch, "bin");
mkdirSync(binDir);
for (const [name, body] of [
  ["docker", DOCKER_STUB],
  ["cosign", COSIGN_STUB],
] as const) {
  writeFileSync(join(binDir, name), body);
  chmodSync(join(binDir, name), 0o755);
}

interface Trust {
  readonly backend?: string;
  readonly web?: string;
  readonly docling?: string;
  readonly rust?: string;
}

interface Run {
  readonly args: readonly string[];
  /** Which identity cosign should accept for which image. Absent = nobody signed it. */
  readonly trust?: Trust;
  readonly env?: Record<string, string>;
  /** Extra lines for .env.production (e.g. a pre-existing CHARTWARDEN_RUST_IMAGE). */
  readonly envFile?: readonly string[];
}

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly envFile: string;
  readonly calls: readonly string[];
  /** `[image-substring, identity]` for every cosign verify. */
  readonly verifies: readonly (readonly [string, string])[];
}

const OLD_BACKEND = "ghcr.io/engrace-hospice/chartwarden:sha-old";
const OLD_ENV = [
  `CHARTWARDEN_IMAGE=${OLD_BACKEND}`,
  "CHARTWARDEN_WEB_IMAGE=ghcr.io/engrace-hospice/chartwarden-web:sha-old",
  "DOCLING_WORKER_TOKEN=x",
  "MINIO_APP_ACCESS_KEY=x",
  "MINIO_APP_SECRET_KEY=x",
  "MINIO_ACCESS_LOG_WEBHOOK_TOKEN=x",
  "CHARTWARDEN_DESTRUCTION_PASSWORD=x",
];

function run(r: Run): Outcome {
  const dir = mkdtempSync(join(scratch, "host-"));
  const state = join(dir, ".stub");
  mkdirSync(state);
  copyFileSync(DEPLOY, join(dir, "deploy.sh"));
  writeFileSync(join(dir, "preflight.sh"), "exit 0\n");
  writeFileSync(join(dir, "smoke.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "smoke.sh"), 0o755);
  writeFileSync(join(dir, "compose.yml"), "services: {}\n");
  writeFileSync(join(dir, ".env.production"), [...OLD_ENV, ...(r.envFile ?? []), ""].join("\n"));
  const t = r.trust ?? {};
  const lines = [
    t.backend && `chartwarden:sha ${t.backend} ${DIGEST.backend}`,
    t.web && `chartwarden-web ${t.web} ${DIGEST.web}`,
    t.docling && `chartwarden-docling-worker ${t.docling} ${DIGEST.docling}`,
    t.rust && `chartwarden-rust ${t.rust} ${DIGEST.rust}`,
  ].filter(Boolean);
  writeFileSync(join(state, "trust"), `${lines.join("\n")}\n`);
  const log = join(state, "calls.log");
  writeFileSync(log, "");
  const res = spawnSync("sh", ["deploy.sh", ...r.args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      STUB_LOG: log,
      STUB_STATE: state,
      ...(r.env ?? {}),
    },
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const verifies = calls
    .filter((c) => c.startsWith("cosign verify "))
    .map(
      (c) => [c.split(" ")[2] ?? "", /--certificate-identity (\S+)/.exec(c)?.[1] ?? ""] as const,
    );
  return {
    code: res.status ?? -1,
    out: `${res.stdout}${res.stderr}`,
    envFile: readFileSync(join(dir, ".env.production"), "utf8"),
    calls,
    verifies,
  };
}

const ALL_SIGNED: Trust = { backend: UPSTREAM_ID, web: UPSTREAM_ID, rust: RUST_ID };
const envLine = (o: Outcome, key: string): string | undefined =>
  o.envFile.split("\n").find((l) => l.startsWith(`${key}=`));

describe("deploy.sh: Rust image verification (P2 prerequisite 1)", () => {
  it("without the 4th argument nothing about the Rust image happens", () => {
    const o = run({ args: [BACKEND, WEB], trust: ALL_SIGNED });
    expect(o.code, o.out).toBe(0);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toBeUndefined();
    expect(o.verifies.some(([ref]) => ref.includes("chartwarden-rust"))).toBe(false);
    expect(o.out).not.toContain("chartwarden-rust");
  });

  it("with the 4th argument: verifies it under the Rust identity and rolls the DIGEST into .env.production", () => {
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: ALL_SIGNED });
    expect(o.code, o.out).toBe(0);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toBe(
      `CHARTWARDEN_RUST_IMAGE=ghcr.io/engrace-hospice/chartwarden-rust@${digestOf("rust")}`,
    );
    expect(o.out).toContain(`verified ${RUST} -> ${digestOf("rust")}`);
    // The other images still roll exactly as before.
    expect(envLine(o, "CHARTWARDEN_IMAGE")).toBe(
      `CHARTWARDEN_IMAGE=ghcr.io/engrace-hospice/chartwarden@${digestOf("backend")}`,
    );
  });

  it("trusts each identity for its own image only", () => {
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: ALL_SIGNED });
    expect(o.code, o.out).toBe(0);
    for (const [ref, id] of o.verifies) {
      if (ref.includes("chartwarden-rust")) expect(id, ref).toBe(RUST_ID);
      else expect(id, ref).toBe(UPSTREAM_ID);
    }
    expect(o.verifies.filter(([ref]) => ref.includes("chartwarden-rust"))).toHaveLength(1);
  });

  it("refuses a Rust image signed only by upstream's own identity, and leaves .env.production untouched", () => {
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: { ...ALL_SIGNED, rust: UPSTREAM_ID } });
    expect(o.code, o.out).toBe(1);
    expect(o.out).toContain(`signature verification FAILED for ${RUST}`);
    expect(o.envFile).toContain(`CHARTWARDEN_IMAGE=${OLD_BACKEND}`);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toBeUndefined();
  });

  it("refuses a backend image signed only by the Rust workflow's identity", () => {
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: { ...ALL_SIGNED, backend: RUST_ID } });
    expect(o.code, o.out).toBe(1);
    expect(o.out).toContain(`signature verification FAILED for ${BACKEND}`);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toBeUndefined();
  });

  it("the time-boxed CHARTWARDEN_COSIGN_IDENTITY opt-in never widens trust for the Rust image", () => {
    const extra =
      "https://github.com/old-org/chartwarden/.github/workflows/deploy.yml@refs/heads/main";
    const o = run({
      args: [BACKEND, WEB, "", RUST],
      trust: { ...ALL_SIGNED, rust: extra },
      env: { CHARTWARDEN_COSIGN_IDENTITY: `${UPSTREAM_ID} ${extra}` },
    });
    expect(o.code, o.out).toBe(1);
    expect(o.out).toContain(`signature verification FAILED for ${RUST}`);
  });

  it("never rolls an unverified Rust image, even with the unverified opt-out", () => {
    const o = run({
      args: [BACKEND, WEB, "", RUST],
      trust: ALL_SIGNED,
      env: { CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED: "1" },
    });
    expect(o.code, o.out).toBe(1);
    expect(o.out).toContain("refusing to roll the Rust image");
    expect(o.verifies).toHaveLength(0);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toBeUndefined();
  });

  it("replaces a previous CHARTWARDEN_RUST_IMAGE in place, once", () => {
    const old = `CHARTWARDEN_RUST_IMAGE=ghcr.io/engrace-hospice/chartwarden-rust@sha256:${"9".repeat(64)}`;
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: ALL_SIGNED, envFile: [old] });
    expect(o.code, o.out).toBe(0);
    expect(o.envFile.match(/^CHARTWARDEN_RUST_IMAGE=/gm)).toHaveLength(1);
    expect(envLine(o, "CHARTWARDEN_RUST_IMAGE")).toContain(digestOf("rust"));
  });

  it("rejects a mutable or foreign name in the 4th argument before doing anything", () => {
    for (const bad of [
      "ghcr.io/engrace-hospice/chartwarden-rust:latest",
      "ghcr.io/engrace-hospice/chartwarden:sha-new",
      `ghcr.io/engrace-hospice/chartwarden-rust@sha256:${"d".repeat(64)}`,
      "docker.io/evil/chartwarden-rust:sha-new",
    ]) {
      const o = run({ args: [BACKEND, WEB, "", bad], trust: ALL_SIGNED });
      expect(o.code, `${bad}\n${o.out}`).toBe(64);
      expect(o.out).toContain("refusing non-immutable rust image");
      expect(o.calls.filter((c) => c.startsWith("cosign"))).toHaveLength(0);
    }
  });

  it("a failed Rust verification after a good backend verification restores the previous release", () => {
    const o = run({
      args: [BACKEND, WEB, "", RUST],
      trust: { backend: UPSTREAM_ID, web: UPSTREAM_ID },
    });
    expect(o.code, o.out).toBe(1);
    expect(o.out).toContain("deploy failed; restoring the previous image references");
    expect(o.envFile).toContain(`CHARTWARDEN_IMAGE=${OLD_BACKEND}`);
  });

  it("the Rust image is never pulled or started by deploy.sh", () => {
    const o = run({ args: [BACKEND, WEB, "", RUST], trust: ALL_SIGNED });
    expect(o.code, o.out).toBe(0);
    expect(o.calls.filter((c) => c.startsWith("docker") && /rust/.test(c))).toHaveLength(0);
  });
});
