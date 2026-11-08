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

  it("the snippet strips the actor assertion and proxies to the API", () => {
    const snippet = withoutComments(readFileSync(join(NGINX, "chartwarden-platform-proxy.conf"), "utf8"));
    expect(snippet).toContain('proxy_set_header X-CW-Actor-Assertion "";');
    expect(snippet).toContain("proxy_pass http://127.0.0.1:3000;");
  });

  it("bootstrap installs the snippet", () => {
    expect(readFileSync(join(ROOT, "deploy/production/bootstrap-vps.sh"), "utf8")).toContain(
      "nginx/chartwarden-platform-proxy.conf",
    );
  });
});
