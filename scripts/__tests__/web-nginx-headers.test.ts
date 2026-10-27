import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// GAP-185 — the SPA is served by deploy/production/web-nginx.conf with no CSP / frame-ancestors / HSTS /
// nosniff / Referrer-Policy. nginx does NOT inherit add_header from an outer level once a location
// declares its own, so the headers must be (re)included in every location that sets one.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const INCLUDE = "include /etc/nginx/snippets/security-headers.conf;";

/** Split the conf into its `location ... { ... }` blocks (no nested blocks inside a location here). */
function locationBlocks(conf: string): { head: string; body: string }[] {
  return [...conf.matchAll(/^\s*location\s+([^{]+)\{([^}]*)\}/gm)].map((m) => ({
    head: (m[1] ?? "").trim(),
    body: m[2] ?? "",
  }));
}

describe("deploy/production SPA security headers (SECURITY_HARDENING §9.6)", () => {
  const snippet = read("deploy/production/web-security-headers.conf");
  const conf = read("deploy/production/web-nginx.conf");

  it("the snippet sets CSP with frame-ancestors, X-Frame-Options, nosniff, Referrer-Policy and HSTS", () => {
    expect(snippet).toMatch(/add_header Content-Security-Policy "[^"]*frame-ancestors 'none'/);
    expect(snippet).toMatch(/add_header Content-Security-Policy "[^"]*script-src 'self'/);
    expect(snippet).not.toMatch(/script-src[^;"]*'unsafe-inline'/);
    expect(snippet).toMatch(/add_header X-Frame-Options "DENY" always;/);
    expect(snippet).toMatch(/add_header X-Content-Type-Options "nosniff" always;/);
    expect(snippet).toMatch(/add_header Referrer-Policy "[^"]+" always;/);
    expect(snippet).toMatch(/add_header Strict-Transport-Security "max-age=\d+[^"]*" always;/);
  });

  it("every header is `always` (so error responses carry it too)", () => {
    for (const line of snippet.split("\n").filter((l) => l.startsWith("add_header"))) {
      expect(line.trimEnd().endsWith("always;")).toBe(true);
    }
  });

  it("the server block includes the snippet", () => {
    const serverLevel = conf.replace(/^\s*location\s+[^{]+\{[^}]*\}/gm, "");
    expect(serverLevel).toContain(INCLUDE);
  });

  it("every location that declares its own add_header re-includes the snippet (no inheritance)", () => {
    const withOwnHeaders = locationBlocks(conf).filter((b) => /\badd_header\b/.test(b.body));
    expect(withOwnHeaders.length).toBeGreaterThan(0);
    for (const block of withOwnHeaders) {
      expect(block.body, `location ${block.head}`).toContain(INCLUDE);
    }
  });

  it("the web image ships the snippet where the conf includes it from", () => {
    const dockerfile = read("Dockerfile.web");
    expect(dockerfile).toContain(
      "COPY deploy/production/web-security-headers.conf /etc/nginx/snippets/security-headers.conf",
    );
  });

  it("the real-environment build can pin img-src/frame-src to the storage origin, and the demo default is unchanged", () => {
    const dockerfile = read("Dockerfile.web");
    expect(dockerfile).toContain('ARG CSP_STORAGE_ORIGIN=""');
    // The sed target must exist in the snippet: both directives end in ` https:;`.
    const csp = snippet.match(/Content-Security-Policy "([^"]*)"/)?.[1] ?? "";
    expect(csp).toMatch(/img-src [^;]* https:;/);
    expect(csp).toMatch(/frame-src [^;]* https:;/);
    expect(read(".github/workflows/release-tenant-web.yml")).toContain(
      "CSP_STORAGE_ORIGIN=https://storage.",
    );
  });

  it("smoke.sh asserts the headers on the live SPA response", () => {
    const smoke = read("deploy/production/smoke.sh");
    expect(smoke).toContain("content-security-policy:");
    expect(smoke).toContain("strict-transport-security:");
  });
});
