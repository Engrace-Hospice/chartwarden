import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectEnvProblems } from "../../apps/backend/src/bootstrap/env";

// ADR-0049 Phase 5 — the edge files for the real, per-tenant-subdomain environment stay consistent with the
// backend's env contract and with each other.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

function assignments(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

describe("deploy/production/.env.tenant.example", () => {
  it("overlaid on the production template, satisfies the env contract with a tenant base domain", () => {
    const base = assignments(read("deploy/production/.env.production.example"));
    const merged = { ...base, ...assignments(read("deploy/production/.env.tenant.example")) };
    const filled = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [k, v.replace(/REPLACE_WITH_[A-Z0-9_]+/g, (tok) =>
          tok === "REPLACE_WITH_BASE64_32_BYTES" ? randomBytes(32).toString("base64") : randomBytes(32).toString("hex"),
        )]),
    );
    const problems = collectEnvProblems({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://chartwarden_app:x@postgres:5432/chartwarden",
      DATABASE_PLATFORM_URL: "postgresql://chartwarden_platform_login:x@postgres:5432/chartwarden",
      REDIS_URL: "redis://valkey:6379",
      ...filled,
    });
    expect(problems.map((p) => p.key).sort()).toEqual([
      "M23_MAC_GATEWAY_URL",
      "M23_X12_GATEWAY_URL",
      "M34_PROVISION_GATEWAY_URL",
    ]);
  });

  it("puts the apex in the trusted origins and the base domain in the passkey RP id", () => {
    const t = assignments(read("deploy/production/.env.tenant.example"));
    expect(t.TRUSTED_ORIGINS?.split(",")).toContain(`https://${t.TENANT_BASE_DOMAIN}`);
    expect(t.PASSKEY_RP_ID).toBe(t.TENANT_BASE_DOMAIN);
  });
});

describe("deploy/production/nginx/chartwarden-tenant.conf", () => {
  const conf = read("deploy/production/nginx/chartwarden-tenant.conf");

  it("answers the apex and every subdomain of the base domain", () => {
    expect(conf).toMatch(/server_name chartwarden\.com \*\.chartwarden\.com;/);
  });

  it("overwrites X-Forwarded-Host with $host in every proxied location, never passing the client's", () => {
    const proxied = [...conf.matchAll(/location [^{]+\{([^}]*)\}/g)].map((m) => m[1] ?? "").filter((b) => b.includes("proxy_pass"));
    expect(proxied.length).toBeGreaterThanOrEqual(2);
    for (const body of proxied) expect(body).toContain("proxy_set_header X-Forwarded-Host $host;");
    expect(conf).not.toContain("$http_x_forwarded_host");
  });

  it("proxies the API, webhooks, realtime and readiness to the backend, everything else to the web tier", () => {
    expect(conf).toMatch(/location ~ \^\/\(api\/\|webhooks\/\|socket\\\.io\/\|fhir\/\|ready\$\)/);
    expect(conf).toContain("proxy_pass http://127.0.0.1:8080;");
  });
});

describe("web tier serves the portal under /portal/", () => {
  const nginx = read("deploy/production/web-nginx.conf");

  it("falls back to the portal's own index, never the staff one", () => {
    expect(nginx).toMatch(/location \/portal\/ \{[^}]*try_files \$uri \$uri\/ \/portal\/index\.html;/);
  });

  it("the image builds the portal and copies it to /portal", () => {
    const docker = read("Dockerfile.web");
    expect(docker).toContain("build:app");
    expect(docker).toMatch(/apps\/portal build:app/);
    expect(docker).toContain("/app/apps/portal/dist/app /usr/share/nginx/html/portal");
  });
});
