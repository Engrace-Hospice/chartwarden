#!/usr/bin/env bun
/**
 * ChartWarden - transmission-security policy gate (CW-TX-01), `bun run arch:tls-policy`.
 * ---------------------------------------------------------------------------
 * SECURITY_HARDENING §4.3 documents the edge TLS policy (TLS 1.2 as the floor with a strict suite list, HSTS on every
 * customer-facing endpoint) and nothing asserted it: production's TLS came from certbot's options file on the host, which
 * the repo never saw. The policy now lives in ONE committed file, deploy/production/nginx/chartwarden-tls.conf, and this
 * gate keeps it, the documentation and every committed TLS server in step:
 *  1. the snippet offers exactly TLSv1.2 + TLSv1.3 (so TLS 1.1 and earlier are refused) and `ssl_ciphers` equals the list
 *     documented in §4.3, every suite of which is ECDHE (forward secrecy) with an AEAD cipher; session tickets are off;
 *  2. every `server` that terminates TLS (`listen ... ssl` or port 443) in any committed *.conf under deploy/ includes the
 *     snippet, and none of those files sets `ssl_protocols` / `ssl_ciphers` itself or includes certbot's options file (the
 *     repo cannot see that file);
 *  3. a `return 30x <scheme>://...` redirect in those files goes to https:// and is a 308 (the legacy-host file's documented
 *     choice: a redirected POST/PUT keeps its method and body; a temporary redirect would need a deliberate exception here);
 *  4. both HSTS emitters, the SPA's nginx snippet and the API's security plugin, carry max-age of at least one year and
 *     includeSubDomains (`preload` stays a deliberate, separate decision: see web-security-headers.conf);
 *  5. bootstrap-vps.sh installs the snippet.
 * What this CANNOT prove: what the live edge (certbot's host nginx, or Pangolin/Traefik) is running. That is the operator
 * step in deploy/production/README.md ("TLS policy"), checked with a scan of the real host, and it stays in the register row.
 * `bun run test:tls-edge:live` handshakes against a real nginx loaded with these exact files.
 *
 * Run:  bun run arch:tls-policy   (in `arch:fitness`)
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEPLOY_DIR = "deploy";
const TLS_SNIPPET_PATH = "deploy/production/nginx/chartwarden-tls.conf";
const HARDENING_DOC_PATH = "docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md";
const WEB_HEADERS_PATH = "deploy/production/web-security-headers.conf";
const BACKEND_SECURITY_PATH = "apps/backend/src/bootstrap/plugins/security.ts";
const BOOTSTRAP_PATH = "deploy/production/bootstrap-vps.sh";

export const TLS_SNIPPET_INCLUDE = "/etc/nginx/snippets/chartwarden-tls.conf";
/** One year: the lower of the two documented values (§4.3 31536000, §9.6.2 63072000). */
export const MIN_HSTS_MAX_AGE_SECONDS = 31_536_000;
const ALLOWED_PROTOCOLS = ["TLSv1.2", "TLSv1.3"];
/** The only TLS 1.2 shape the policy allows: ECDHE key exchange (forward secrecy) with an AEAD cipher. */
const STRICT_SUITE = /^ECDHE-(ECDSA|RSA)-(AES256-GCM-SHA384|AES128-GCM-SHA256|CHACHA20-POLY1305)$/;
const CIPHER_HEADING = "**Cipher suite restrictions (TLS 1.2 fallback):**";

export interface TlsPolicyInput {
  readonly tlsSnippet: string;
  readonly hardeningDoc: string;
  /** Every committed nginx file (repo-relative path -> text) except the TLS snippet itself. */
  readonly nginxConfigs: Readonly<Record<string, string>>;
  readonly webSecurityHeaders: string;
  readonly backendSecurityPlugin: string;
  readonly bootstrapScript: string;
}

const stripComments = (conf: string): string => conf.replace(/(^|\s)#.*$/gm, "$1");

/** Arguments of every `name ...;` directive in `text` (one string per occurrence). */
function directives(text: string, name: string): string[] {
  const re = new RegExp(`(?:^|[;{}])\\s*${name}\\s+([^;]+);`, "gm");
  return [...text.matchAll(re)].map((m) => (m[1] ?? "").trim());
}

/** The body of every `server { ... }` block (brace-matched; the committed files carry no braces in strings). */
function serverBlocks(conf: string): string[] {
  const blocks: string[] = [];
  for (const open of conf.matchAll(/\bserver\s*\{/g)) {
    const start = (open.index ?? 0) + open[0].length;
    let depth = 1;
    let end = start;
    while (end < conf.length && depth > 0) {
      const ch = conf[end++];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    blocks.push(conf.slice(start, end - 1));
  }
  return blocks;
}

const terminatesTls = (listenArgs: string): boolean =>
  /\b(ssl|quic)\b/.test(listenArgs) || /(^|[:\s])443(\s|$)/.test(listenArgs);

/** The bullet list under §4.3's "Cipher suite restrictions" heading. */
export function documentedCipherSuites(doc: string): string[] {
  const start = doc.indexOf(CIPHER_HEADING);
  if (start < 0) return [];
  const suites: string[] = [];
  for (const line of doc.slice(start).split("\n").slice(1)) {
    const suite = line.match(/^-\s+([A-Z0-9-]+)\s*$/)?.[1];
    if (suite !== undefined) suites.push(suite);
    else if (line.trim() !== "" || suites.length > 0) break;
  }
  return suites;
}

function snippetProblems(snippetText: string, doc: string): string[] {
  const problems: string[] = [];
  const snippet = stripComments(snippetText);

  const protocols = directives(snippet, "ssl_protocols");
  if (protocols.length !== 1) {
    problems.push(
      `${TLS_SNIPPET_PATH}: must set ssl_protocols exactly once (found ${protocols.length})`,
    );
  } else {
    const offered = (protocols[0] ?? "").split(/\s+/).sort().join(" ");
    if (offered !== [...ALLOWED_PROTOCOLS].sort().join(" "))
      problems.push(
        `${TLS_SNIPPET_PATH}: ssl_protocols is "${protocols[0]}", must be exactly "${ALLOWED_PROTOCOLS.join(" ")}" (TLS 1.1 and earlier are prohibited, §4.1; TLS 1.3 is the preferred protocol)`,
      );
  }

  const cipherLists = directives(snippet, "ssl_ciphers");
  const documented = documentedCipherSuites(doc);
  if (documented.length === 0)
    problems.push(`${HARDENING_DOC_PATH}: no cipher list found under "${CIPHER_HEADING}"`);
  if (cipherLists.length !== 1) {
    problems.push(
      `${TLS_SNIPPET_PATH}: must set ssl_ciphers exactly once (found ${cipherLists.length})`,
    );
  } else {
    const suites = (cipherLists[0] ?? "").split(":");
    for (const suite of suites)
      if (!STRICT_SUITE.test(suite))
        problems.push(
          `${TLS_SNIPPET_PATH}: suite ${suite} is not ECDHE + AEAD (forward secrecy and authenticated encryption)`,
        );
    if (documented.length > 0 && [...suites].sort().join(" ") !== [...documented].sort().join(" "))
      problems.push(
        `${TLS_SNIPPET_PATH}: ssl_ciphers (${suites.join(", ")}) differs from the list documented in ${HARDENING_DOC_PATH} §4.3 (${documented.join(", ")}); change both together`,
      );
  }

  if (!directives(snippet, "ssl_session_tickets").includes("off"))
    problems.push(`${TLS_SNIPPET_PATH}: ssl_session_tickets must be off`);
  return problems;
}

function nginxConfigProblems(path: string, text: string): string[] {
  const problems: string[] = [];
  const conf = stripComments(text);
  for (const name of ["ssl_protocols", "ssl_ciphers"])
    if (directives(conf, name).length > 0)
      problems.push(`${path}: sets ${name}; the TLS policy lives only in ${TLS_SNIPPET_PATH}`);
  if (conf.includes("options-ssl-nginx.conf"))
    problems.push(
      `${path}: includes certbot's options-ssl-nginx.conf, which the repo cannot see; include ${TLS_SNIPPET_INCLUDE} instead`,
    );

  for (const block of serverBlocks(conf)) {
    const name = directives(block, "server_name")[0] ?? "(unnamed)";
    if (
      directives(block, "listen").some(terminatesTls) &&
      !directives(block, "include").includes(TLS_SNIPPET_INCLUDE)
    )
      problems.push(
        `${path}: server ${name} terminates TLS without \`include ${TLS_SNIPPET_INCLUDE};\``,
      );

    for (const ret of directives(block, "return")) {
      const redirect = ret.match(/^(30\d)\s+(\S+)/);
      if (redirect === null || !/^[a-z]+:\/\//i.test(redirect[2] ?? "")) continue; // relative redirects stay on the scheme
      const [, code, target] = redirect;
      if (!(target ?? "").toLowerCase().startsWith("https://"))
        problems.push(`${path}: server ${name} redirects to ${target}, which is not https://`);
      else if (code !== "308")
        problems.push(
          `${path}: server ${name} redirects with ${code}; use 308 so a redirected POST/PUT keeps its method and body`,
        );
    }
  }
  return problems;
}

export function hstsProblems(label: string, text: string): string[] {
  const value = text.match(/Strict-Transport-Security["']?\s*,?\s*["']([^"']+)["']/i)?.[1];
  if (value === undefined) return [`${label}: no Strict-Transport-Security header found`];
  const problems: string[] = [];
  const maxAge = Number(value.match(/max-age=(\d+)/i)?.[1] ?? 0);
  if (maxAge < MIN_HSTS_MAX_AGE_SECONDS)
    problems.push(
      `${label}: HSTS max-age ${maxAge} is under ${MIN_HSTS_MAX_AGE_SECONDS} (one year)`,
    );
  if (!/includeSubDomains/i.test(value)) problems.push(`${label}: HSTS lacks includeSubDomains`);
  return problems;
}

export function tlsPolicyProblems(input: TlsPolicyInput): string[] {
  const problems = [
    ...snippetProblems(input.tlsSnippet, input.hardeningDoc),
    ...Object.entries(input.nginxConfigs).flatMap(([path, text]) =>
      nginxConfigProblems(path, text),
    ),
    ...hstsProblems(WEB_HEADERS_PATH, stripComments(input.webSecurityHeaders)),
    ...hstsProblems(BACKEND_SECURITY_PATH, input.backendSecurityPlugin),
  ];
  const installsSnippet =
    /^\s*install\b.*"\$SOURCE_DIR\/nginx\/chartwarden-tls\.conf".*\/etc\/nginx\/snippets\/chartwarden-tls\.conf/m;
  if (!installsSnippet.test(input.bootstrapScript))
    problems.push(
      `${BOOTSTRAP_PATH}: does not install ${TLS_SNIPPET_PATH} to /etc/nginx/snippets/`,
    );
  return problems;
}

/** The committed files the policy is asserted over (a test mutates a copy of this to plant a violation). */
export function loadTlsPolicyInput(): TlsPolicyInput {
  const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
  // Every committed *.conf under deploy/ (not only deploy/production/nginx/), so a vhost filed elsewhere cannot escape the gate.
  const nginxFiles = readdirSync(join(REPO_ROOT, DEPLOY_DIR), { recursive: true })
    .map((f) => `${DEPLOY_DIR}/${String(f).split(sep).join("/")}`)
    .filter((p) => p.endsWith(".conf") && p !== TLS_SNIPPET_PATH);
  return {
    tlsSnippet: read(TLS_SNIPPET_PATH),
    hardeningDoc: read(HARDENING_DOC_PATH),
    nginxConfigs: Object.fromEntries(nginxFiles.map((p) => [p, read(p)])),
    webSecurityHeaders: read(WEB_HEADERS_PATH),
    backendSecurityPlugin: read(BACKEND_SECURITY_PATH),
    bootstrapScript: read(BOOTSTRAP_PATH),
  };
}

if (import.meta.main) {
  const failures = tlsPolicyProblems(loadTlsPolicyInput());
  if (failures.length > 0) {
    console.error("arch:tls-policy FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    "arch:tls-policy OK: the TLS snippet matches the documented policy, every committed TLS server includes it, redirects go to https with 308, and both HSTS emitters carry at least one year with includeSubDomains.",
  );
}
