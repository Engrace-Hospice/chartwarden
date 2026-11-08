// SeaweedFS identities: render the `-s3.config` file (s3.json) from secrets + the policy documents in
// deploy/production/object-store/. One code path for production (the `object-store-provision` one-shot) and for
// the CI/local conformance store (scripts/object-store-conformance/seaweedfs-up.sh), so CI proves what ships.
//
// Identities:
//   admin   SEAWEEDFS_ADMIN_ACCESS_KEY / _SECRET_KEY   SeaweedFS `Admin` (operators, the one-time migration)
//   app     SEAWEEDFS_APP_ACCESS_KEY / _SECRET_KEY     app-policy.json ONLY: no `Admin`, so no bucket delete and no
//                                                      versioning change (the legacy `Admin:tenant-*` grant had both)
//   readers SEAWEEDFS_READER_<NAME>_ACCESS_KEY + _SECRET_KEY or _SECRET_KEY_FILE   reader-policy.json (list + get)
// Any `*_SECRET_KEY` may instead be given as `*_SECRET_KEY_FILE` (a Docker secret).
//
//   bun scripts/storage/seaweedfs-identities.ts <out/s3.json>   # prints "s3.json changed" or "s3.json unchanged"
//
// SeaweedFS reads the file at start only (a rewritten file is NOT picked up): the caller restarts SeaweedFS when
// this prints "changed". The file holds secrets: written 0600, atomically. SeaweedFS's entrypoint drops to its own
// uid (`seaweed`, 1000) before reading it, so production passes S3_CONFIG_OWNER=<uid>:<gid> and the file is handed
// to that uid (a wrong owner counts as a change, so SeaweedFS restarts and reads it).
import { chownSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_DIR = fileURLToPath(new URL("../../deploy/production/object-store/", import.meta.url));
export const APP_POLICY = "chartwarden-app";
export const READER_POLICY = "chartwarden-reader";
// MinIO's own minimum: the existing MINIO_ROOT_PASSWORD was valid there, so it must stay valid here.
const MIN_SECRET_LENGTH = 8;
const READER_KEY = /^SEAWEEDFS_READER_([A-Z0-9_]+)_ACCESS_KEY$/;

type Env = Readonly<Record<string, string | undefined>>;

interface Identity {
  readonly name: string;
  readonly credentials: readonly { readonly accessKey: string; readonly secretKey: string }[];
  readonly actions?: readonly string[];
  readonly policyNames?: readonly string[];
}

export interface S3Config {
  readonly identities: readonly Identity[];
  readonly policies: readonly { readonly name: string; readonly content: string }[];
}

function secretOf(env: Env, name: string): string {
  const file = env[`${name}_FILE`]?.trim();
  const value = (file ? readFileSync(file, "utf8") : (env[name] ?? "")).trim();
  if (value.length < MIN_SECRET_LENGTH)
    throw new Error(`${name} (or ${name}_FILE) must hold at least ${MIN_SECRET_LENGTH} characters`);
  return value;
}

function keyOf(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Compact, validated policy text: a malformed document fails here, not as a silent SeaweedFS deny-all. */
export function policyText(file: string): string {
  return JSON.stringify(JSON.parse(readFileSync(join(POLICY_DIR, file), "utf8")));
}

export function buildS3Config(env: Env): S3Config {
  const identity = (name: string, prefix: string, grant: Partial<Identity>): Identity => ({
    name,
    credentials: [
      {
        accessKey: keyOf(env, `${prefix}_ACCESS_KEY`),
        secretKey: secretOf(env, `${prefix}_SECRET_KEY`),
      },
    ],
    ...grant,
  });
  const readers = Object.keys(env)
    .map((key) => READER_KEY.exec(key)?.[1])
    .filter(
      (name): name is string =>
        Boolean(name) && Boolean(env[`SEAWEEDFS_READER_${name}_ACCESS_KEY`]?.trim()),
    )
    .sort()
    .map((name) =>
      identity(`reader-${name.toLowerCase()}`, `SEAWEEDFS_READER_${name}`, {
        policyNames: [READER_POLICY],
      }),
    );
  const identities = [
    identity("admin", "SEAWEEDFS_ADMIN", {
      actions: ["Admin", "Read", "Write", "List", "Tagging"],
    }),
    identity("app", "SEAWEEDFS_APP", { policyNames: [APP_POLICY] }),
    ...readers,
  ];
  const keys = identities.map((i) => i.credentials[0]?.accessKey);
  if (new Set(keys).size !== keys.length) throw new Error("two identities share an access key");
  return {
    identities,
    policies: [
      { name: APP_POLICY, content: policyText("app-policy.json") },
      { name: READER_POLICY, content: policyText("reader-policy.json") },
    ],
  };
}

export interface FileOwner {
  readonly uid: number;
  readonly gid: number;
}

/** `S3_CONFIG_OWNER=<uid>:<gid>`; unset leaves ownership to the writer. */
export function ownerOf(value: string | undefined): FileOwner | null {
  if (!value?.trim()) return null;
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) throw new Error("S3_CONFIG_OWNER must be <uid>:<gid>");
  return { uid: Number(match[1]), gid: Number(match[2]) };
}

export function isCurrent(out: string, text: string, owner: FileOwner | null): boolean {
  try {
    if (readFileSync(out, "utf8") !== text) return false;
    const stat = statSync(out);
    return !owner || (stat.uid === owner.uid && stat.gid === owner.gid);
  } catch {
    return false; // first run: no file yet
  }
}

/** Write `out` only when its content (or required owner) changes; returns whether it did. */
export function writeS3Config(
  out: string,
  config: S3Config,
  owner: FileOwner | null = null,
): boolean {
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (isCurrent(out, text, owner)) return false;
  const tmp = join(dirname(out), `.s3.json.${process.pid}`);
  writeFileSync(tmp, text, { mode: 0o600 });
  if (owner) chownSync(tmp, owner.uid, owner.gid);
  renameSync(tmp, out);
  return true;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error("usage: seaweedfs-identities.ts <out/s3.json>");
  const changed = writeS3Config(
    out,
    buildS3Config(process.env),
    ownerOf(process.env.S3_CONFIG_OWNER),
  );
  // names only: the file's secrets never reach stdout
  process.stdout.write(`s3.json ${changed ? "changed" : "unchanged"}\n`);
}
