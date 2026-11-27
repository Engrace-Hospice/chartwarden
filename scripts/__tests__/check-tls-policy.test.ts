// CW-TX-01 - arch:tls-policy goes GREEN on the committed files and RED on each planted violation of the documented policy.
import { describe, expect, it } from "vitest";
import {
  type TlsPolicyInput,
  documentedCipherSuites,
  hstsProblems,
  loadTlsPolicyInput,
  tlsPolicyProblems,
} from "../check-tls-policy";

const real = loadTlsPolicyInput();
const LEGACY = "deploy/production/nginx/chartwarden-legacy-redirects.conf";

type TextField =
  | "tlsSnippet"
  | "hardeningDoc"
  | "webSecurityHeaders"
  | "backendSecurityPlugin"
  | "bootstrapScript";

/** A copy of the real input with `from` replaced by `to` in one field; fails loudly if `from` is not there. */
function mutate(field: TextField, from: string | RegExp, to: string): TlsPolicyInput {
  const before = real[field];
  const after = before.replace(from, to);
  expect(after, `${field} does not contain ${String(from)}`).not.toBe(before);
  return { ...real, [field]: after };
}

/** A copy with one extra committed nginx file. */
const withNginx = (path: string, text: string): TlsPolicyInput => ({
  ...real,
  nginxConfigs: { ...real.nginxConfigs, [path]: text },
});

const problems = (input: TlsPolicyInput): string => tlsPolicyProblems(input).join("\n");

describe("arch:tls-policy", () => {
  it("passes on the committed files", () => {
    expect(tlsPolicyProblems(real)).toEqual([]);
  });

  it("scans every committed *.conf under deploy/, not only the production nginx directory, and never the snippet itself", () => {
    const scanned = Object.keys(real.nginxConfigs);
    expect(scanned).toContain("deploy/production/web-nginx.conf");
    expect(scanned).toContain(LEGACY);
    expect(scanned).toContain("deploy/clamav/clamd.conf");
    expect(scanned).not.toContain("deploy/production/nginx/chartwarden-tls.conf");
  });

  it("reads the four documented suites from SECURITY_HARDENING §4.3", () => {
    expect(documentedCipherSuites(real.hardeningDoc)).toEqual([
      "ECDHE-ECDSA-AES256-GCM-SHA384",
      "ECDHE-RSA-AES256-GCM-SHA384",
      "ECDHE-ECDSA-CHACHA20-POLY1305",
      "ECDHE-RSA-CHACHA20-POLY1305",
    ]);
    expect(documentedCipherSuites("no heading here")).toEqual([]);
  });

  describe("the policy snippet", () => {
    it("fails when TLS 1.1 is offered", () => {
      const input = mutate(
        "tlsSnippet",
        "ssl_protocols TLSv1.2 TLSv1.3;",
        "ssl_protocols TLSv1.1 TLSv1.2 TLSv1.3;",
      );
      expect(problems(input)).toContain('ssl_protocols is "TLSv1.1 TLSv1.2 TLSv1.3"');
    });

    it("fails when TLS 1.3 is dropped", () => {
      const input = mutate("tlsSnippet", "ssl_protocols TLSv1.2 TLSv1.3;", "ssl_protocols TLSv1.2;");
      expect(problems(input)).toContain("ssl_protocols");
    });

    it("fails on a non-forward-secret suite", () => {
      const input = mutate("tlsSnippet", /^ssl_ciphers /m, "ssl_ciphers AES256-GCM-SHA384:");
      expect(problems(input)).toContain("suite AES256-GCM-SHA384 is not ECDHE + AEAD");
    });

    it("fails on a CBC suite", () => {
      const input = mutate("tlsSnippet", /^ssl_ciphers /m, "ssl_ciphers ECDHE-RSA-AES256-SHA384:");
      expect(problems(input)).toContain("suite ECDHE-RSA-AES256-SHA384 is not ECDHE + AEAD");
    });

    it("fails when a strict suite is added without updating the documentation", () => {
      const input = mutate("tlsSnippet", /^ssl_ciphers /m, "ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:");
      expect(problems(input)).toContain("differs from the list documented");
    });

    it("fails when the documented list loses a suite the snippet still offers", () => {
      const input = mutate("hardeningDoc", "- ECDHE-RSA-CHACHA20-POLY1305\n", "");
      expect(problems(input)).toContain("differs from the list documented");
    });

    it("fails when the documentation no longer lists any suite", () => {
      const input = mutate(
        "hardeningDoc",
        "**Cipher suite restrictions (TLS 1.2 fallback):**",
        "**Ciphers:**",
      );
      expect(problems(input)).toContain("no cipher list found");
    });

    it("fails when session tickets are on", () => {
      const input = mutate("tlsSnippet", "ssl_session_tickets off;", "ssl_session_tickets on;");
      expect(problems(input)).toContain("ssl_session_tickets must be off");
    });

    it("ignores a commented-out directive", () => {
      const input = mutate(
        "tlsSnippet",
        "ssl_session_tickets off;",
        "ssl_session_tickets off;\n# ssl_protocols TLSv1;",
      );
      expect(tlsPolicyProblems(input)).toEqual([]);
    });
  });

  describe("committed nginx servers", () => {
    const server = (body: string): string =>
      `server {\n  server_name x.example.test;\n${body}\n}\n`;
    const INCLUDE = "include /etc/nginx/snippets/chartwarden-tls.conf;";

    it("fails a listen 443 ssl server that does not include the snippet", () => {
      const out = problems(
        withNginx("x.conf", server("listen 443 ssl;\nssl_certificate a;\nssl_certificate_key b;")),
      );
      expect(out).toContain("x.conf: server x.example.test terminates TLS without");
    });

    it("fails an IPv6 or ssl-flagged non-443 listener the same way", () => {
      expect(problems(withNginx("x.conf", server("listen [::]:443 ssl;")))).toContain(
        "terminates TLS",
      );
      expect(problems(withNginx("x.conf", server("listen 8443 ssl;")))).toContain("terminates TLS");
    });

    it("passes a TLS server that includes the snippet and a plain port-80 proxy", () => {
      const tls = withNginx("x.conf", server(`listen 443 ssl;\n${INCLUDE}`));
      expect(tlsPolicyProblems(tls)).toEqual([]);
      const plain = withNginx(
        "x.conf",
        server("listen 80;\nlocation / { proxy_pass http://127.0.0.1:3000; }"),
      );
      expect(tlsPolicyProblems(plain)).toEqual([]);
    });

    it("fails a server that sets its own protocols or ciphers", () => {
      const protocols = withNginx(
        "x.conf",
        server(`listen 443 ssl;\n${INCLUDE}\nssl_protocols TLSv1 TLSv1.2;`),
      );
      expect(problems(protocols)).toContain("sets ssl_protocols");
      const ciphers = withNginx("x.conf", server(`listen 443 ssl;\n${INCLUDE}\nssl_ciphers HIGH;`));
      expect(problems(ciphers)).toContain("sets ssl_ciphers");
    });

    it("fails a server that still includes certbot's options file", () => {
      const out = problems(
        withNginx(
          "x.conf",
          server("listen 443 ssl;\ninclude /etc/letsencrypt/options-ssl-nginx.conf;"),
        ),
      );
      expect(out).toContain("certbot's options-ssl-nginx.conf");
    });

    it("the legacy-host redirect file's three 443 servers all include the snippet", () => {
      const legacy = real.nginxConfigs[LEGACY] ?? "";
      expect(legacy.match(/include \/etc\/nginx\/snippets\/chartwarden-tls\.conf;/g)).toHaveLength(3);
      expect(legacy).not.toContain("options-ssl-nginx.conf\n");
    });
  });

  describe("redirects", () => {
    const redirect = (line: string): TlsPolicyInput =>
      withNginx("r.conf", `server {\n  server_name r.example.test;\n  listen 80;\n  ${line}\n}\n`);

    it("accepts a 308 to https and a relative redirect", () => {
      expect(tlsPolicyProblems(redirect("return 308 https://app.example.test$request_uri;"))).toEqual([]);
      expect(tlsPolicyProblems(redirect("return 308 /portal/;"))).toEqual([]);
    });

    it("fails a redirect to plain http", () => {
      expect(problems(redirect("return 308 http://app.example.test$request_uri;"))).toContain(
        "which is not https://",
      );
    });

    it("fails a 301 or 302 to https (the documented choice is 308)", () => {
      expect(problems(redirect("return 301 https://app.example.test$request_uri;"))).toContain("use 308");
      expect(problems(redirect("return 302 https://app.example.test$request_uri;"))).toContain("use 308");
    });
  });

  describe("HSTS", () => {
    it("fails a SPA header under one year", () => {
      const input = mutate("webSecurityHeaders", "max-age=63072000", "max-age=300");
      expect(problems(input)).toContain("HSTS max-age 300 is under 31536000");
    });

    it("fails a SPA header without includeSubDomains", () => {
      const input = mutate(
        "webSecurityHeaders",
        "max-age=63072000; includeSubDomains",
        "max-age=63072000",
      );
      expect(problems(input)).toContain("HSTS lacks includeSubDomains");
    });

    it("fails a backend header under one year or missing entirely", () => {
      const short = mutate("backendSecurityPlugin", "max-age=31536000", "max-age=86400");
      expect(problems(short)).toContain("HSTS max-age 86400");
      const missing = mutate("backendSecurityPlugin", /Strict-Transport-Security/g, "X-Other");
      expect(problems(missing)).toContain("no Strict-Transport-Security header found");
    });

    it("reads both header spellings (nginx add_header and Fastify reply.header)", () => {
      const nginx = 'add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;';
      expect(hstsProblems("a", nginx)).toEqual([]);
      const fastify =
        'reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");';
      expect(hstsProblems("b", fastify)).toEqual([]);
    });
  });

  it("fails when bootstrap-vps.sh stops installing the snippet", () => {
    const input = mutate("bootstrapScript", /^.*"\$SOURCE_DIR\/nginx\/chartwarden-tls\.conf".*$/m, "");
    expect(problems(input)).toContain("does not install");
  });
});
