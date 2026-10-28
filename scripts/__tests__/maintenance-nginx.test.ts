import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #865 — the host-level maintenance switch: a flag file gates a static 503 + Retry-After page, health probes stay up,
// and every app vhost includes the snippet (a vhost without it would 502 while the stack is stopped).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const INCLUDE = "include /etc/nginx/snippets/chartwarden-maintenance.conf;";

describe("deploy/production maintenance switch (#865)", () => {
  const snippet = read("deploy/production/nginx/chartwarden-maintenance.conf");
  const page = read("deploy/production/nginx/maintenance.html");

  it("is gated on a flag file and answers 503", () => {
    expect(snippet).toMatch(
      /if \(-f \/etc\/nginx\/chartwarden-maintenance\.on\) \{ set \$cw_maintenance 1; \}/,
    );
    expect(snippet).toMatch(/if \(\$cw_maintenance\) \{ return 503; \}/);
    expect(snippet).toContain("error_page 503 @cw_maintenance;");
  });

  it("serves the static page with Retry-After and no caching", () => {
    expect(snippet).toMatch(/add_header Retry-After "\d+" always;/);
    expect(snippet).toMatch(/add_header Cache-Control "no-store" always;/);
    expect(snippet).toContain("root /var/www/chartwarden-maintenance;");
    expect(snippet).toContain("rewrite ^ /maintenance.html break;");
  });

  it("keeps the health probes outside the maintenance response", () => {
    const exempt = 'if ($uri ~ "^/(ready|api/health)$") { set $cw_maintenance ""; }';
    expect(snippet).toContain(exempt);
    expect(snippet.indexOf("set $cw_maintenance 1")).toBeLessThan(snippet.indexOf(exempt));
    expect(snippet.indexOf(exempt)).toBeLessThan(snippet.indexOf("return 503"));
  });

  it("the page exists and is self-contained", () => {
    expect(existsSync(join(ROOT, "deploy/production/nginx/maintenance.html"))).toBe(true);
    expect(page).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/url\(/i);
  });

  it.each(["frontend", "backend", "tenant"])("the %s vhost includes the snippet", (name) => {
    expect(read(`deploy/production/nginx/chartwarden-${name}.conf`)).toContain(INCLUDE);
  });

  it("bootstrap installs the snippet, the page and the toggle script", () => {
    const bootstrap = read("deploy/production/bootstrap-vps.sh");
    expect(bootstrap).toContain("nginx/chartwarden-maintenance.conf");
    expect(bootstrap).toContain("nginx/maintenance.html");
    expect(bootstrap).toContain("maintenance.sh");
  });

  it("maintenance.sh toggles the flag the snippet tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "maint-"));
    const flag = join(dir, "flag");
    const run = (arg: string) =>
      spawnSync("sh", [join(ROOT, "deploy/production/maintenance.sh"), arg], {
        encoding: "utf8",
        env: { ...process.env, CHARTWARDEN_MAINTENANCE_FLAG: flag },
      });
    try {
      expect(run("on").status).toBe(0);
      expect(existsSync(flag)).toBe(true);
      expect(run("status").stdout).toContain("ON");
      expect(run("off").status).toBe(0);
      expect(existsSync(flag)).toBe(false);
      expect(run("bogus").status).toBe(64);
      expect(read("deploy/production/maintenance.sh")).toContain(
        "/etc/nginx/chartwarden-maintenance.on",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
