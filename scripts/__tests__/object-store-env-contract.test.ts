import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { OBJECT_STORE_ENV_PAIRS } from "./object-store-env-pairs";

// Object-store environment contract (additive compatibility release): the application reads OBJECT_STORE_*, production
// provisions from SEAWEEDFS_*, MINIO_* survive only as rollback aliases (same values) or as variables of a REAL legacy
// MinIO / restore drill. These tests pin that mapping in the files that carry it, so a drift fails here and not on a host.

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

describe("deploy.sh: the credential pairs it reconciles", () => {
  it("are exactly the pairs the deployment tests assume", () => {
    const script = read("deploy/production/deploy.sh");
    const block = /OBJECT_STORE_ENV_PAIRS="([^"]+)"/.exec(script)?.[1] ?? "";
    const declared = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [canonical, legacy] = l.split(":");
        return { canonical, legacy };
      });
    expect(declared).toEqual(OBJECT_STORE_ENV_PAIRS.map((p) => ({ ...p })));
  });

  it("keeps the real legacy-MinIO and backup variables it reads (they are not aliases)", () => {
    // The backup overlay is enabled by the real read-only source key, which has nothing to do with the pairs.
    expect(read("deploy/production/deploy.sh")).toContain("BACKUP_SOURCE_MINIO_ACCESS_KEY");
  });
});

describe("deploy/production/compose.yml: canonical variables point to SeaweedFS", () => {
  it("object-store-provision is fed the canonical SEAWEEDFS_* credentials, never the MINIO_* names", () => {
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
    "%s: the public endpoint (presigned URLs) is STORAGE_PUBLIC_ORIGIN under both names",
    (service) => {
      const e = env(compose, service);
      expect(e.OBJECT_STORE_PUBLIC_ENDPOINT).toBe(required("STORAGE_PUBLIC_ORIGIN"));
      expect(e.MINIO_PUBLIC_ENDPOINT).toBe(e.OBJECT_STORE_PUBLIC_ENDPOINT);
    },
  );

  it("tenant-buckets makes no presigned URLs, so it carries no public endpoint", () => {
    const e = env(compose, "tenant-buckets");
    expect(e.OBJECT_STORE_PUBLIC_ENDPOINT).toBeUndefined();
    expect(e.MINIO_PUBLIC_ENDPOINT).toBeUndefined();
  });

  it.each(APP_SERVICES)(
    "%s: every MINIO_* rollback twin has EXACTLY its OBJECT_STORE_* value",
    (service) => {
      const e = env(compose, service);
      for (const suffix of ["ENDPOINT", "ACCESS_KEY", "SECRET_KEY", "REGION"]) {
        expect(e[`MINIO_${suffix}`], `MINIO_${suffix} present`).toBeDefined();
        expect(e[`MINIO_${suffix}`], `MINIO_${suffix}`).toBe(e[`OBJECT_STORE_${suffix}`]);
      }
    },
  );

  it("api receives the audit bearer under both names, from the canonical variable", () => {
    const e = env(compose, "api");
    expect(e.OBJECT_STORE_AUDIT_WEBHOOK_TOKEN).toBe(required("OBJECT_STORE_AUDIT_WEBHOOK_TOKEN"));
    expect(e.MINIO_ACCESS_LOG_WEBHOOK_TOKEN).toBe(e.OBJECT_STORE_AUDIT_WEBHOOK_TOKEN);
  });

  it("keeps fluent-bit on the rollback-safe legacy path with the canonical token", () => {
    const e = env(compose, "fluent-bit");
    expect(e.AUDIT_SINK_PATH).toBe("/api/v1/webhooks/minio/access-log");
    expect(e.AUDIT_SINK_TOKEN).toBe(required("OBJECT_STORE_AUDIT_WEBHOOK_TOKEN"));
    expect(e.AUDIT_SINK_HOST).toBe("api");
  });

  it("the legacy MinIO and its one-time migration still run on the real MinIO root credentials", () => {
    const minio = compose.services.minio;
    expect(minio?.profiles).toEqual(["legacy-minio"]);
    const minioEnv = env(compose, "minio");
    expect(minioEnv.MINIO_ROOT_USER).toBe(required("MINIO_ROOT_USER"));
    expect(minioEnv.MINIO_ROOT_PASSWORD).toBe(required("MINIO_ROOT_PASSWORD"));

    const migrate = compose.services["object-store-migrate"];
    expect(migrate?.profiles).toEqual(["legacy-minio"]);
    expect(JSON.stringify(migrate?.command)).toContain("scripts/object-store-copy.ts");
    const m = env(compose, "object-store-migrate");
    // Source: the real legacy MinIO.
    expect(m.SOURCE_S3_ENDPOINT).toBe("http://minio:9000");
    expect(m.SOURCE_S3_ACCESS_KEY).toBe(required("MINIO_ROOT_USER"));
    expect(m.SOURCE_S3_SECRET_KEY).toBe(required("MINIO_ROOT_PASSWORD"));
    // Target: SeaweedFS, through the canonical admin credentials.
    expect(m.TARGET_S3_ENDPOINT).toBe(SEAWEEDFS_ENDPOINT);
    expect(m.TARGET_S3_ACCESS_KEY).toBe(required("SEAWEEDFS_ADMIN_ACCESS_KEY"));
    expect(m.TARGET_S3_SECRET_KEY).toBe(required("SEAWEEDFS_ADMIN_SECRET_KEY"));
    expect(m.ALLOW_MASS_DELETE).toBe("${OBJECT_STORE_MIGRATE_ALLOW_MASS_DELETE:-}");
  });

  it("the real backup / restore-drill MinIO variables are untouched", () => {
    expect(read("deploy/production/compose.backup.yml")).toContain(
      "BACKUP_SOURCE_MINIO_ACCESS_KEY",
    );
    const restore = read("deploy/production/backup/restore.sh");
    for (const name of [
      "RESTORE_MINIO_ACCESS_KEY",
      "RESTORE_MINIO_SECRET_KEY",
      "RESTORE_MINIO_PORT",
      "MINIO_ROOT_USER",
    ]) {
      expect(restore, name).toContain(name);
    }
    const verify = read("scripts/backup/verify-restore.ts");
    for (const name of [
      "RESTORE_MINIO_ENDPOINT",
      "RESTORE_MINIO_ACCESS_KEY",
      "RESTORE_MINIO_SECRET_KEY",
    ]) {
      expect(verify, name).toContain(name);
    }
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
      // Built from this tree: no old image reads MINIO_*, so no alias is carried.
      expect(Object.keys(e).filter((k) => k.startsWith("MINIO_"))).toEqual([]);
    },
  );

  it("the RustFS service credentials are the ones the app is given", () => {
    const rustfs = env(localCompose, "rustfs");
    expect(rustfs.RUSTFS_ACCESS_KEY).toBe(env(localCompose, "api").OBJECT_STORE_ACCESS_KEY);
    expect(rustfs.RUSTFS_SECRET_KEY).toBe(env(localCompose, "api").OBJECT_STORE_SECRET_KEY);
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
    // No CI test verifies the legacy names, so none is kept.
    expect(ciText).not.toMatch(/^\s*MINIO_(ENDPOINT|ACCESS_KEY|SECRET_KEY|REGION)\s*:/m);
  });
});

describe("deploy/production/README.md documents the contract", () => {
  const readme = read("deploy/production/README.md");

  it("names each layer of the contract and the two audit paths", () => {
    for (const needle of [
      "OBJECT_STORE_*",
      "SEAWEEDFS_ADMIN_ACCESS_KEY",
      "SEAWEEDFS_APP_SECRET_KEY",
      "OBJECT_STORE_AUDIT_WEBHOOK_TOKEN",
      "/api/v1/webhooks/object-store/access-log",
      "/api/v1/webhooks/minio/access-log",
      "RustFS",
      "legacy-minio",
      "RESTORE_MINIO_*",
    ]) {
      expect(readme, needle).toContain(needle);
    }
  });

  it("documents every pair and the fail-closed mismatch", () => {
    for (const p of OBJECT_STORE_ENV_PAIRS) {
      expect(readme, p.canonical).toContain(`\`${p.canonical}\``);
      expect(readme, p.legacy).toContain(`\`${p.legacy}\``);
    }
    expect(readme).toContain("Fail closed on a mismatch");
    expect(readme).toContain("exits 78");
    expect(readme).toContain("never rotates a credential");
  });
});
