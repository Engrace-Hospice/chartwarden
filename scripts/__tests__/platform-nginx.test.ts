import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Platform Ops vhost: the signed-BAA upload gets the only raised body cap, and both API locations share one
// proxy snippet (so the live, certbot-edited vhost is updated by re-installing the snippet, not by overwriting it).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NGINX = join(ROOT, "deploy/production/nginx");
const conf = readFileSync(join(NGINX, "chartwarden-platform.conf"), "utf8");
const INCLUDE = "include /etc/nginx/snippets/chartwarden-platform-proxy.conf;";
const BAA_LOCATION = "location ~ ^/api/v1/platform/tenants/[^/]+/baa-document$ {";
const API_LOCATION = "location ~ ^/(api/|webhooks/) {";

/** The body of the `location` block opened by `header` (no nested braces in this file's locations). */
function locationBody(header: string): string {
  const start = conf.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = start + header.length;
  return conf.slice(open, conf.indexOf("}", open));
}

const withoutComments = (text: string): string => text.replace(/#.*$/gm, "");

describe("deploy/production/nginx/chartwarden-platform.conf", () => {
  it("puts the BAA location above the general /api/ location (regex locations match in file order)", () => {
    expect(conf.indexOf(BAA_LOCATION)).toBeLessThan(conf.indexOf(API_LOCATION));
  });

  it("both API locations include the shared proxy snippet", () => {
    expect(locationBody(BAA_LOCATION)).toContain(INCLUDE);
    expect(locationBody(API_LOCATION)).toContain(INCLUDE);
  });

  it("raises the body cap to 16m in the BAA location only", () => {
    const code = withoutComments(conf);
    expect(code.match(/client_max_body_size/g)).toHaveLength(1);
    expect(withoutComments(locationBody(BAA_LOCATION))).toContain("client_max_body_size 16m;");
  });

  it("bounds the BAA upload's body read and upstream wait", () => {
    const baa = withoutComments(locationBody(BAA_LOCATION));
    expect(baa).toContain("client_body_timeout 30s;");
    expect(baa).toContain("proxy_read_timeout 90s;");
  });

  it("the snippet carries all eight proxy directives, the stripped actor assertion and the REPLACED X-Forwarded-Host included", () => {
    const snippet = withoutComments(
      readFileSync(join(NGINX, "chartwarden-platform-proxy.conf"), "utf8"),
    );
    const directives = snippet
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(directives).toEqual([
      "proxy_pass http://127.0.0.1:3000;",
      'proxy_set_header X-CW-Actor-Assertion "";',
      "proxy_http_version 1.1;",
      "proxy_set_header Host $host;",
      "proxy_set_header X-Forwarded-Host $host;",
      "proxy_set_header X-Real-IP $remote_addr;",
      "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
      "proxy_set_header X-Forwarded-Proto $scheme;",
    ]);
  });

  it("bootstrap installs the snippet at the path the vhost includes", () => {
    expect(readFileSync(join(ROOT, "deploy/production/bootstrap-vps.sh"), "utf8")).toContain(
      'install -m 0644 "$SOURCE_DIR/nginx/chartwarden-platform-proxy.conf" /etc/nginx/snippets/chartwarden-platform-proxy.conf',
    );
  });

  // The signed-BAA body is buffered by nginx before the API's guards and limiter run: it is bounded per address in nginx itself.
  it("limits the BAA upload per address, refusing with 429, with zones defined in an http-context file", () => {
    const baa = withoutComments(locationBody(BAA_LOCATION));
    expect(baa).toContain("limit_req zone=chartwarden_platform_baa_req burst=3 nodelay;");
    expect(baa).toContain("limit_conn chartwarden_platform_baa_conn 2;");
    expect(baa).toContain("limit_req_status 429;");
    expect(baa).toContain("limit_conn_status 429;");
    // no other location is limited by these zones (the rest of the console is not an upload)
    expect(withoutComments(conf).match(/limit_req zone=/g)).toHaveLength(1);
    const zones = withoutComments(
      readFileSync(join(NGINX, "chartwarden-platform-limits.conf"), "utf8"),
    );
    expect(zones).toContain(
      "limit_req_zone $binary_remote_addr zone=chartwarden_platform_baa_req:1m rate=6r/m;",
    );
    expect(zones).toContain(
      "limit_conn_zone $binary_remote_addr zone=chartwarden_platform_baa_conn:1m;",
    );
    // a zone is declared in the http context, never inside a server or location block
    expect(zones).not.toMatch(/[{}]/);
  });

  it("bootstrap installs the zones into conf.d (the http context) before nginx -t", () => {
    const bootstrap = readFileSync(join(ROOT, "deploy/production/bootstrap-vps.sh"), "utf8");
    const install =
      'install -m 0644 "$SOURCE_DIR/nginx/chartwarden-platform-limits.conf" /etc/nginx/conf.d/chartwarden-platform-limits.conf';
    expect(bootstrap).toContain(install);
    expect(bootstrap.indexOf(install)).toBeLessThan(bootstrap.indexOf("nginx -t"));
  });

  it("the SPA location replaces X-Forwarded-Host too, as the tenant vhost does", () => {
    const spa = withoutComments(locationBody("location / {"));
    expect(spa).toContain("proxy_set_header X-Forwarded-Host $host;");
  });

  it("the README no longer offers to copy the repo vhost (no TLS) over the live certbot-edited one", () => {
    const readme = readFileSync(join(ROOT, "deploy/production/README.md"), "utf8");
    expect(readme).not.toContain("Alternative to step 2");
    expect(readme).toContain("never copy");
    expect(readme).toContain("chartwarden-platform-limits.conf");
  });
});
