import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectEnvProblems } from "../../apps/backend/src/bootstrap/env";

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

  it("defines every ${VAR:?...} that compose.yml requires of .env.production", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]);
    const defined = Object.keys(render(text));
    for (const key of required) expect(defined).toContain(key);
  });

  it("satisfies the production env contract except for the operator-supplied gateway hosts", () => {
    const env = {
      NODE_ENV: "production",
      // compose.yml injects these three from the credentials above, not from the template.
      DATABASE_URL: "postgresql://wardenx_app:x@postgres:5432/wardenx",
      DATABASE_PLATFORM_URL: "postgresql://wardenx_platform_login:x@postgres:5432/wardenx",
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

  it("gives independent secrets to each placeholder occurrence", () => {
    const a = render(text);
    expect(a.M34_TENANT_KEK).not.toBe(a.M35_PSEUDONYM_KEY_KEK);
  });
});
