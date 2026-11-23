import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

// Object-store environment contract: the application reads OBJECT_STORE_*, production provisions from SEAWEEDFS_*. The
// MinIO rollback window is closed: no compose service, profile, volume or env twin carries a MINIO_* name any more.
// These tests pin that mapping in the files that carry it, so a drift fails here and not on a host.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

interface ComposeService {
  readonly profiles?: readonly string[];
  readonly environment?: Readonly<Record<string, string | number | boolean>>;
  readonly command?: unknown;
}
interface ComposeDoc {
  readonly services: Readonly<Record<string, ComposeService>>;
}
// compose.yml uses Compose's `!reset` tag, which js-yaml's default schema rejects; it loads as null here (the same
// treatment as scripts/check-compose-policy.ts).
const COMPOSE_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  (["sequence", "scalar", "mapping"] as const).map(
    (kind) => new yaml.Type("!reset", { kind, construct: () => null }),
  ),
);
const loadCompose = (rel: string): ComposeDoc =>
  yaml.load(read(rel), { schema: COMPOSE_SCHEMA }) as ComposeDoc;
const compose = loadCompose("deploy/production/compose.yml");
const localCompose = loadCompose("docker-compose.yml");

function env(doc: ComposeDoc, service: string): Readonly<Record<string, string>> {
  const svc = doc.services[service];
  if (!svc?.environment) throw new Error(`${service} has no environment map`);
  return Object.fromEntries(Object.entries(svc.environment).map(([k, v]) => [k, String(v)]));
}

/** compose's required-variable form, `${NAME:?set in .env.production}`. */
const required = (name: string): string => `\${${name}:?set in .env.production}`;

const APP_SERVICES = ["api", "worker", "tenant-buckets", "hl7-listener"] as const;
const SEAWEEDFS_ENDPOINT = "http://seaweedfs:8333";

describe("deploy.sh: the object-store variables it keeps", () => {
  it("generates the five canonical names and nothing else (no MINIO_* alias, no pair reconciliation)", () => {
    const script = read("deploy/production/deploy.sh");
    const names = /for object_store_name in ([A-Z_ ]+); do/.exec(script)?.[1]?.trim().split(" ");
    expect(names).toEqual([
      "SEAWEEDFS_ADMIN_ACCESS_KEY",
      "SEAWEEDFS_ADMIN_SECRET_KEY",
      "SEAWEEDFS_APP_ACCESS_KEY",
      "SEAWEEDFS_APP_SECRET_KEY",
      "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN",
    ]);
    expect(script).not.toMatch(/MINIO_(ROOT|APP|ACCESS_LOG)/);
    expect(script).not.toContain("legacy-minio");
  });

  it("enables the backup overlay by the renamed read-only source key", () => {
    expect(read("deploy/production/deploy.sh")).toContain(
      "grep -q '^BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY=.' .env.production",
    );
  });
});

describe("deploy/production/compose.yml: canonical variables point to SeaweedFS", () => {
  it("object-store-provision is fed the canonical SEAWEEDFS_* credentials, never a MINIO_* name", () => {
    const e = env(compose, "object-store-provision");
    for (const name of [
      "SEAWEEDFS_ADMIN_ACCESS_KEY",
      "SEAWEEDFS_ADMIN_SECRET_KEY",
      "SEAWEEDFS_APP_ACCESS_KEY",
      "SEAWEEDFS_APP_SECRET_KEY",
    ]) {
      expect(e[name], name).toBe(required(name));
    }
    expect(Object.values(e).join("\n")).not.toMatch(/\$\{MINIO_/);
  });

  it.each(APP_SERVICES)("%s: OBJECT_STORE_* come from the SeaweedFS app credentials", (service) => {
    const e = env(compose, service);
    expect(e.OBJECT_STORE_ENDPOINT).toBe(SEAWEEDFS_ENDPOINT);
    expect(e.OBJECT_STORE_ACCESS_KEY).toBe(required("SEAWEEDFS_APP_ACCESS_KEY"));
    expect(e.OBJECT_STORE_SECRET_KEY).toBe(required("SEAWEEDFS_APP_SECRET_KEY"));
    expect(e.OBJECT_STORE_REGION).toBe("us-east-1");
    // The app holds the scoped app key, never the store's admin account.
    expect(Object.values(e).join("\n")).not.toMatch(/SEAWEEDFS_ADMIN|MINIO_ROOT/);
  });

  it.each(["api", "worker", "hl7-listener"] as const)(
    "%s: the public endpoint (presigned URLs) is STORAGE_PUBLIC_ORIGIN",
    (service) => {
      expect(env(compose, service).OBJECT_STORE_PUBLIC_ENDPOINT).toBe(
        required("STORAGE_PUBLIC_ORIGIN"),
      );
    },
  );

  it("tenant-buckets makes no presigned URLs, so it carries no public endpoint", () => {
    expect(env(compose, "tenant-buckets").OBJECT_STORE_PUBLIC_ENDPOINT).toBeUndefined();
  });

  it("no compose service carries a MINIO_* variable, and the retired MinIO / migration services, profile and volume are gone", () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      const keys = Object.keys(svc.environment ?? {}).filter((k) => k.startsWith("MINIO_"));
      expect(keys, `${name} MINIO_* env`).toEqual([]);
      expect(svc.profiles ?? [], `${name} profiles`).not.toContain("legacy-minio");
    }
    expect(compose.services.minio).toBeUndefined();
    expect(compose.services["object-store-migrate"]).toBeUndefined();
    const text = read("deploy/production/compose.yml");
    expect(text).not.toMatch(/MINIO_/);
    expect(text).not.toContain("legacy-minio");
    expect(text).not.toMatch(/minio-data/);
  });

  it("api receives the audit bearer from the canonical variable only", () => {
    expect(env(compose, "api").OBJECT_STORE_AUDIT_WEBHOOK_TOKEN).toBe(
      required("OBJECT_STORE_AUDIT_WEBHOOK_TOKEN"),
    );
  });

  it("fluent-bit posts to the canonical audit path with the canonical token", () => {
    const e = env(compose, "fluent-bit");
    expect(e.AUDIT_SINK_PATH).toBe("/api/v1/webhooks/object-store/access-log");
    expect(e.AUDIT_SINK_TOKEN).toBe(required("OBJECT_STORE_AUDIT_WEBHOOK_TOKEN"));
    expect(e.AUDIT_SINK_HOST).toBe("api");
  });

  it("the backup overlay and the restore tooling use the OBJECT_STORE names for the source and restore stores", () => {
    const overlay = read("deploy/production/compose.backup.yml");
    for (const name of [
      "BACKUP_SOURCE_OBJECT_STORE_URL",
      "BACKUP_SOURCE_OBJECT_STORE_ACCESS_KEY",
      "BACKUP_SOURCE_OBJECT_STORE_SECRET_KEY_FILE",
      "backup_source_object_store_secret_key",
    ]) {
      expect(overlay, name).toContain(name);
    }
    const restore = read("deploy/production/backup/restore.sh");
    for (const name of [
      "RESTORE_OBJECT_STORE_ACCESS_KEY",
      "RESTORE_OBJECT_STORE_SECRET_KEY",
      "RESTORE_OBJECT_STORE_PORT",
      "RESTORE_OBJECT_STORE_IMAGE",
    ]) {
      expect(restore, name).toContain(name);
    }
    const verify = read("scripts/backup/verify-restore.ts");
    for (const name of [
      "RESTORE_OBJECT_STORE_ENDPOINT",
      "RESTORE_OBJECT_STORE_ACCESS_KEY",
      "RESTORE_OBJECT_STORE_SECRET_KEY",
    ]) {
      expect(verify, name).toContain(name);
    }
  });

  it("the old BACKUP_SOURCE_MINIO_* / RESTORE_MINIO_* names survive only where they must: the host migration, preflight and restore's plain-secret guard", () => {
    const OLD = /BACKUP_SOURCE_MINIO_|RESTORE_MINIO_|backup_source_minio_secret_key/;
    const allowed = new Set([
      "deploy/production/deploy.sh",
      "deploy/production/preflight.sh",
      "deploy/production/backup/restore.sh",
    ]);
    for (const file of [
      "deploy/production/compose.backup.yml",
      "deploy/production/compose.yml",
      "deploy/production/backup/cw-backup.sh",
      "deploy/production/backup/restore.sh",
      "deploy/production/deploy.sh",
      "deploy/production/preflight.sh",
      "scripts/backup/coordinated-drill.ts",
      "scripts/backup/verify-restore.ts",
    ]) {
      const text = read(file);
      if (!allowed.has(file)) expect(text, file).not.toMatch(OLD);
    }
    // restore.sh: only the plain-secret refusal still names the old spelling.
    const restoreOld = read("deploy/production/backup/restore.sh")
      .split("\n")
      .filter((l) => OLD.test(l) || /BACKUP_SOURCE_\(OBJECT_STORE\|MINIO\)/.test(l));
    for (const l of restoreOld)
      expect(l, l).toMatch(/PLAIN_SECRETS|old BACKUP_SOURCE_MINIO|Formerly/);
    // The drill still stands up a real MinIO container: its own root login variables stay.
    expect(read("deploy/production/backup/restore.sh")).toContain("MINIO_ROOT_USER");
    expect(read("deploy/production/backup/cw-backup.sh")).toContain("MINIO_ROOT_PASSWORD");
  });
});

describe("local docker-compose.yml (RustFS) and CI use the OBJECT_STORE_* contract", () => {
  it.each(["migrate", "api", "worker"] as const)(
    "%s reads RustFS through OBJECT_STORE_*",
    (service) => {
      const e = env(localCompose, service);
      expect(e.OBJECT_STORE_ENDPOINT).toBe("http://rustfs:9000");
      expect(e.OBJECT_STORE_ACCESS_KEY).toBe("chartwarden");
      expect(e.OBJECT_STORE_SECRET_KEY).toBe("chartwarden-object-store-dev-secret");
      expect(e.OBJECT_STORE_REGION).toBe("us-east-1");
      // Built from this tree and the backend no longer reads MINIO_*: no alias is carried.
      expect(Object.keys(e).filter((k) => k.startsWith("MINIO_"))).toEqual([]);
    },
  );

  it("the RustFS service credentials are the ones the app is given", () => {
    const rustfs = env(localCompose, "rustfs");
    expect(rustfs.RUSTFS_ACCESS_KEY).toBe(env(localCompose, "api").OBJECT_STORE_ACCESS_KEY);
    expect(rustfs.RUSTFS_SECRET_KEY).toBe(env(localCompose, "api").OBJECT_STORE_SECRET_KEY);
  });

  it("signs browser uploads with the host endpoint while internal consumers stay on Compose DNS", () => {
    expect(env(localCompose, "api").OBJECT_STORE_PUBLIC_ENDPOINT).toBe("http://localhost:9000");
    expect(env(localCompose, "migrate").OBJECT_STORE_PUBLIC_ENDPOINT).toBeUndefined();
    expect(env(localCompose, "worker").OBJECT_STORE_PUBLIC_ENDPOINT).toBeUndefined();
  });

  it("the CI e2e job configures its RustFS through OBJECT_STORE_* only", () => {
    const ciText = read(".github/workflows/ci.yml");
    const ci = yaml.load(ciText) as { jobs: Record<string, { env?: Record<string, string> }> };
    const jobs = Object.entries(ci.jobs).filter(
      ([, j]) => j.env?.OBJECT_STORE_ENDPOINT !== undefined,
    );
    expect(jobs.map(([name]) => name)).toEqual(["e2e"]);
    const e = jobs[0]?.[1].env ?? {};
    expect(e.OBJECT_STORE_ENDPOINT).toBe("http://localhost:9000");
    expect(e.OBJECT_STORE_ACCESS_KEY).toBe("chartwarden");
    expect(e.OBJECT_STORE_SECRET_KEY).toBe("chartwarden-object-store-ci-secret");
    expect(e.OBJECT_STORE_REGION).toBe("us-east-1");
    // The backend reads no MINIO_* name, so none is set.
    expect(ciText).not.toMatch(/^\s*MINIO_(ENDPOINT|ACCESS_KEY|SECRET_KEY|REGION)\s*:/m);
  });

  it("the production compose dry run needs no MINIO_* export: the template alone satisfies compose.yml", () => {
    const gate = read(".github/workflows/pr-image-gate.yml");
    expect(gate).not.toMatch(/MINIO_/);
    expect(gate).toContain("docker compose --env-file .env.production -f compose.yml config -q");
  });
});
