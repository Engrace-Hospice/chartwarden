import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectEnvProblems } from "../../apps/backend/src/bootstrap/env";
import { CANONICAL_OF_LEGACY, OBJECT_STORE_ENV_PAIRS } from "./object-store-env-pairs";

// GAP-176 — `deploy/production/.env.production.example` is the file bootstrap-vps.sh renders on a fresh
// host / DR rebuild. It was referenced but never committed (the `.env.*` ignore glob swallowed it), so
// provisioning aborted. This keeps the template, the production env contract (bootstrap/env.ts) and
// compose.yml's `${VAR:?}` requirements in sync.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = join(ROOT, "deploy/production/.env.production.example");
const COMPOSE = join(ROOT, "deploy/production/compose.yml");
const KNOWN_TOKENS = [
  "REPLACE_WITH_64_HEX_CHARACTERS",
  "REPLACE_WITH_BASE64_32_BYTES",
  "REPLACE_WITH_AT_LEAST_32_CHARACTERS",
];

/** What bootstrap-vps.sh does: each token occurrence becomes its own fresh secret. */
function render(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const value = (m[2] ?? "").replace(/REPLACE_WITH_[A-Z0-9_]+/g, (tok) =>
      tok === "REPLACE_WITH_BASE64_32_BYTES"
        ? randomBytes(32).toString("base64")
        : randomBytes(32).toString("hex"),
    );
    out[m[1]] = value;
  }
  return out;
}

describe("deploy/production/.env.production.example", () => {
  it("is committed (not swallowed by the .env.* ignore glob)", () => {
    expect(existsSync(TEMPLATE)).toBe(true);
  });

  const text = existsSync(TEMPLATE) ? readFileSync(TEMPLATE, "utf8") : "";

  it("only uses placeholder tokens bootstrap-vps.sh knows how to fill", () => {
    const tokens = new Set(text.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? []);
    for (const t of tokens) expect(KNOWN_TOKENS).toContain(t);
  });

  it("defines every ${VAR:?...} that compose.yml requires of .env.production (a MINIO_* rollback alias is derived by deploy.sh)", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1] ?? "");
    const defined = Object.keys(render(text));
    for (const key of required) {
      const canonical = CANONICAL_OF_LEGACY.get(key);
      if (canonical === undefined) {
        expect(defined).toContain(key);
      } else {
        // compose still requires the legacy name (the legacy-minio profile and the rollback twins), but the template
        // must not define it: deploy.sh writes it, identical to its canonical counterpart, before any compose call.
        expect(defined, `${key} is a deploy.sh-derived alias`).not.toContain(key);
        expect(defined, `${key} derives from ${canonical}`).toContain(canonical);
      }
    }
  });

  it("ships the SeaweedFS provisioning credentials and the audit token under their canonical names", () => {
    expect(text).toMatch(/^SEAWEEDFS_ADMIN_ACCESS_KEY=chartwarden-seaweedfs-admin$/m);
    expect(text).toMatch(/^SEAWEEDFS_ADMIN_SECRET_KEY=REPLACE_WITH_AT_LEAST_32_CHARACTERS$/m);
    expect(text).toMatch(/^SEAWEEDFS_APP_ACCESS_KEY=chartwarden-app$/m);
    expect(text).toMatch(/^SEAWEEDFS_APP_SECRET_KEY=REPLACE_WITH_AT_LEAST_32_CHARACTERS$/m);
    expect(text).toMatch(/^OBJECT_STORE_AUDIT_WEBHOOK_TOKEN=REPLACE_WITH_AT_LEAST_32_CHARACTERS$/m);
  });

  it("never defines a rollback alias: independently generated old and new secrets are what deploy.sh's mismatch check refuses", () => {
    const defined = Object.keys(render(text));
    for (const p of OBJECT_STORE_ENV_PAIRS) {
      expect(defined, p.legacy).not.toContain(p.legacy);
      expect(defined, p.canonical).toContain(p.canonical);
    }
    expect(text).not.toMatch(/^MINIO_/m);
  });

  it("explains that deploy.sh creates the MINIO_* aliases with identical values and never rotates a credential", () => {
    expect(text).toContain("ROLLBACK ALIASES");
    expect(text).toMatch(/`deploy\.sh` creates each of them with a value IDENTICAL/);
    expect(text).toMatch(/never rotates a credential/);
    for (const p of OBJECT_STORE_ENV_PAIRS) expect(text, p.legacy).toContain(p.legacy);
  });

  it("gives each object-store secret its own fresh value", () => {
    const rendered = render(text);
    const secrets = [
      rendered.SEAWEEDFS_ADMIN_SECRET_KEY,
      rendered.SEAWEEDFS_APP_SECRET_KEY,
      rendered.OBJECT_STORE_AUDIT_WEBHOOK_TOKEN,
    ];
    expect(secrets.every((s) => typeof s === "string" && s.length >= 32)).toBe(true);
    expect(new Set(secrets).size).toBe(secrets.length);
  });

  it("satisfies the production env contract except for the operator-supplied gateway hosts", () => {
    const env = {
      NODE_ENV: "production",
      // compose.yml injects these three from the credentials above, not from the template.
      DATABASE_URL: "postgresql://chartwarden_app:x@postgres:5432/chartwarden",
      DATABASE_PLATFORM_URL: "postgresql://chartwarden_platform_login:x@postgres:5432/chartwarden",
      REDIS_URL: "redis://valkey:6379",
      ...render(text),
    };
    const problems = collectEnvProblems(env);
    // The `.example.invalid` gateway URLs are intentionally rejected until the operator edits them.
    expect(problems.map((p) => p.key).sort()).toEqual([
      "M23_MAC_GATEWAY_URL",
      "M23_X12_GATEWAY_URL",
      "M34_PROVISION_GATEWAY_URL",
    ]);
  });

  it("ships the Postmark credentials BLANK (unbound by default) and a filled set satisfies the contract", () => {
    const rendered = render(text);
    for (const key of [
      "POSTMARK_SERVER_TOKEN",
      "POSTMARK_FROM_ADDRESS",
      "POSTMARK_SENDER_VERIFIED",
    ]) {
      expect(rendered[key]).toBe("");
    }
    // Never a hard-coded credential in the template: every uncommented POSTMARK_ value is empty.
    const assigned = text.split("\n").filter((l) => /^POSTMARK_[A-Z_]+=/.test(l));
    expect(assigned.every((l) => l.endsWith("="))).toBe(true);
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://chartwarden_app:x@postgres:5432/chartwarden",
      DATABASE_PLATFORM_URL: "postgresql://chartwarden_platform_login:x@postgres:5432/chartwarden",
      REDIS_URL: "redis://valkey:6379",
      ...rendered,
      POSTMARK_SERVER_TOKEN: "pm-token-0123456789abcdef",
      POSTMARK_FROM_ADDRESS: "no-reply@mail.chartwarden.health",
      POSTMARK_SENDER_VERIFIED: "true",
    };
    expect(collectEnvProblems(env).filter((p) => p.key.startsWith("POSTMARK_"))).toEqual([]);
  });

  it("gives independent secrets to each placeholder occurrence", () => {
    const a = render(text);
    expect(a.M34_TENANT_KEK).not.toBe(a.M35_PSEUDONYM_KEY_KEK);
  });
});
