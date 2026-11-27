// CW-TX-01 live: handshake the committed edge TLS policy against a REAL nginx, in private containers on loopback only.
//
// `arch:tls-policy` proves the committed files say the documented thing; this proves nginx, loaded with those exact files,
// does it on the wire: TLS 1.3 by default, TLS 1.2 fallback with only the documented suites, TLS 1.1 / 1.0 and every other
// TLS 1.2 suite refused, the legacy-host http and https redirects are 308 to https, and the SPA nginx emits HSTS on every
// response (404 included).
//
// A refusal only proves something if the probe COULD have connected. So every "refused" assertion is paired with a control:
// a deliberately permissive nginx (TLS 1.0 to 1.3, every suite, security level 0, throwaway certificates) that the same probe,
// with the same options, must connect to. If the probe cannot speak TLS 1.0 on this machine the control fails loudly instead
// of every negative assertion passing for the wrong reason.
//
// Reading the TLS 1.1 / 1.0 refusals: the policy's suites are all AEAD, which TLS 1.1 and earlier cannot negotiate, so those
// refusals are the effect of `ssl_protocols` and `ssl_ciphers` together; the `ssl_protocols` line on its own is held by
// `arch:tls-policy`.
//
// Needs docker and the `openssl` CLI. Probes 127.0.0.1 ports of its own containers only; never an external host. The
// certificates are generated per run in a temp directory and removed afterwards; nothing here is a secret.
// Run: `bun run test:tls-edge:live` (CI job "TLS edge live"). Skipped unless CHARTWARDEN_TLS_LIVE=1, which the script sets.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentedCipherSuites } from "../check-tls-policy";

const LIVE = process.env.CHARTWARDEN_TLS_LIVE === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const DEPLOY = join(ROOT, "deploy", "production");

/** nginx 1.29 on Alpine's OpenSSL 3: the same major line as the web image. Pinned by digest like compose.yml's images. */
const IMAGE =
  "nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de";
const READY_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const LEGACY_REDIRECTS = [
  { from: "wardenx.chartwarden.cloud", to: "https://app.chartwarden.cloud" },
  { from: "be082026.wardenx.chartwarden.cloud", to: "https://api.chartwarden.cloud" },
  { from: "storage.wardenx.chartwarden.cloud", to: "https://storage.chartwarden.cloud" },
];

type CertKind = "rsa" | "ec";
/** TLS 1.2 suites the policy must refuse: ECDHE + AEAD but unlisted, CBC, and no forward secrecy. */
const DENIED_SUITES: Readonly<Record<CertKind, readonly string[]>> = {
  rsa: [
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES256-SHA384",
    "AES256-GCM-SHA384",
    "AES128-SHA",
  ],
  ec: ["ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-ECDSA-AES256-SHA384"],
};

type ProbeResult =
  | { readonly ok: true; readonly protocol: string; readonly cipher: string }
  | { readonly ok: false; readonly error: string };
interface Mount {
  readonly host: string;
  readonly container: string;
}
interface Cert {
  readonly cert: string;
  readonly key: string;
}

const run = (cmd: string, ...args: string[]): string =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function mintCert(dir: string, kind: CertKind): Cert {
  const cert = join(dir, `${kind}.crt`);
  const key = join(dir, `${kind}.key`);
  const names = [...LEGACY_REDIRECTS.map((r) => r.from), "probe.example.test"];
  const keyArgs =
    kind === "rsa"
      ? ["-newkey", "rsa:2048"]
      : ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  run(
    "openssl",
    ...["req", "-x509", "-nodes", "-days", "1", "-subj", "/CN=wardenx.chartwarden.cloud"],
    ...["-addext", `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`],
    ...keyArgs,
    ...["-keyout", key, "-out", cert],
  );
  return { cert, key };
}

/** Handshake with explicit protocol bounds and TLS 1.2 suites; resolves instead of throwing so refusals can be asserted. */
function probe(opts: {
  port: number;
  min: tls.SecureVersion;
  max: tls.SecureVersion;
  ciphers?: string;
  ca: string[];
}): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: opts.port,
      servername: "wardenx.chartwarden.cloud",
      minVersion: opts.min,
      maxVersion: opts.max,
      ...(opts.ciphers === undefined ? {} : { ciphers: opts.ciphers }),
      ca: opts.ca,
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve({ ok: false, error: "probe timed out" });
    });
    socket.once("secureConnect", () => {
      resolve({ ok: true, protocol: socket.getProtocol() ?? "", cipher: socket.getCipher().name });
      socket.end();
    });
    socket.once("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
}

function get(opts: { port: number; host: string; path: string; ca?: string[] }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const settle = (res: http.IncomingMessage): void => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    };
    const common = {
      host: "127.0.0.1",
      port: opts.port,
      path: opts.path,
      headers: { Host: opts.host },
    };
    const req =
      opts.ca === undefined
        ? http.get(common, settle)
        : https.get({ ...common, servername: opts.host, ca: opts.ca }, settle);
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error("request timed out")));
    req.once("error", reject);
  });
}

async function waitReady(label: string, name: string, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await get({ port, host: "probe.example.test", path: "/" });
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${label} did not answer on port ${port}:\n${run("docker", "logs", name)}`);
}

describe.skipIf(!LIVE)("CW-TX-01 live: edge TLS policy handshakes against real nginx", () => {
  const started: string[] = [];
  let workDir = "";
  let trust: string[] = [];
  /** container label -> (container port -> host port) */
  const ports: Record<string, Record<number, number>> = {};

  const hostPort = (label: string, containerPort: number): number =>
    ports[label]?.[containerPort] ?? 0;

  /** Start an nginx container with read-only mounts, publish the given ports on loopback, wait until it answers http. */
  async function startNginx(
    label: string,
    mounts: Mount[],
    publish: number[],
    readyPort: number,
  ): Promise<void> {
    const name = `cw-tls-live-${process.pid}-${label}`;
    started.push(name);
    run(
      "docker",
      ...["run", "-d", "--name", name],
      ...publish.flatMap((p) => ["-p", `127.0.0.1::${p}`]),
      ...mounts.flatMap((m) => ["-v", `${m.host}:${m.container}:ro`]),
      IMAGE,
    );
    const mapped: Record<number, number> = {};
    for (const p of publish)
      mapped[p] = Number(run("docker", "port", name, `${p}/tcp`).split("\n")[0]?.split(":").pop());
    ports[label] = mapped;
    await waitReady(label, name, mapped[readyPort] ?? 0);
  }

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "cw-tls-live-"));
    const rsa = mintCert(workDir, "rsa");
    const ec = mintCert(workDir, "ec");
    trust = [readFileSync(rsa.cert, "utf8"), readFileSync(ec.cert, "utf8")];
    try {
      run("docker", "image", "inspect", IMAGE);
    } catch {
      run("docker", "pull", IMAGE);
    }

    const snippet: Mount = {
      host: join(DEPLOY, "nginx", "chartwarden-tls.conf"),
      container: "/etc/nginx/snippets/chartwarden-tls.conf",
    };
    // The committed legacy-host file, unmodified, with a throwaway certificate at the path it names.
    const legacy = (c: Cert): Mount[] => [
      snippet,
      {
        host: join(DEPLOY, "nginx", "chartwarden-legacy-redirects.conf"),
        container: "/etc/nginx/conf.d/default.conf",
      },
      { host: c.cert, container: "/etc/letsencrypt/live/wardenx.chartwarden.cloud/fullchain.pem" },
      { host: c.key, container: "/etc/letsencrypt/live/wardenx.chartwarden.cloud/privkey.pem" },
    ];
    // The control: every protocol and suite, both certificates. It exists only to prove the probe can reach what it refuses.
    const permissiveConf = join(workDir, "permissive.conf");
    writeFileSync(
      permissiveConf,
      [
        "server { listen 80; return 200 ok; }",
        "server {",
        "  listen 443 ssl;",
        "  ssl_certificate /certs/rsa.crt;",
        "  ssl_certificate_key /certs/rsa.key;",
        "  ssl_certificate /certs/ec.crt;",
        "  ssl_certificate_key /certs/ec.key;",
        "  ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;",
        "  ssl_ciphers ALL:@SECLEVEL=0;",
        "  return 200 ok;",
        "}",
        "",
      ].join("\n"),
    );

    await startNginx("rsa", legacy(rsa), [80, 443], 80);
    await startNginx("ec", legacy(ec), [80, 443], 80);
    await startNginx(
      "permissive",
      [
        { host: permissiveConf, container: "/etc/nginx/conf.d/default.conf" },
        { host: rsa.cert, container: "/certs/rsa.crt" },
        { host: rsa.key, container: "/certs/rsa.key" },
        { host: ec.cert, container: "/certs/ec.crt" },
        { host: ec.key, container: "/certs/ec.key" },
      ],
      [80, 443],
      80,
    );
    // The SPA's own nginx exactly as Dockerfile.web wires it (conf.d/default.conf + snippets/security-headers.conf).
    await startNginx(
      "web",
      [
        { host: join(DEPLOY, "web-nginx.conf"), container: "/etc/nginx/conf.d/default.conf" },
        {
          host: join(DEPLOY, "web-security-headers.conf"),
          container: "/etc/nginx/snippets/security-headers.conf",
        },
      ],
      [8080],
      8080,
    );
  }, 240_000);

  afterAll(() => {
    for (const name of started) {
      try {
        run("docker", "rm", "-f", name);
      } catch {
        // already gone
      }
    }
    if (workDir !== "") rmSync(workDir, { recursive: true, force: true });
  });

  const documentedSuites = (kind: CertKind): string[] =>
    documentedCipherSuites(read("docs/architecture/CHARTWARDEN_SECURITY_HARDENING_v0_2.md")).filter(
      (s) => s.includes(kind === "rsa" ? "-RSA-" : "-ECDSA-"),
    );

  it("control: a permissive nginx accepts TLS 1.0 and 1.1 and every suite the policy denies, so the probe's refusals mean something", async () => {
    const port = hostPort("permissive", 443);
    for (const version of ["TLSv1", "TLSv1.1"] as const) {
      const result = await probe({
        port,
        min: version,
        max: version,
        ciphers: "ALL:@SECLEVEL=0",
        ca: trust,
      });
      expect(result, `permissive control, ${version}`).toMatchObject({
        ok: true,
        protocol: version,
      });
    }
    for (const kind of ["rsa", "ec"] as const)
      for (const suite of DENIED_SUITES[kind]) {
        const result = await probe({
          port,
          min: "TLSv1.2",
          max: "TLSv1.2",
          ciphers: `${suite}:@SECLEVEL=0`,
          ca: trust,
        });
        expect(result, `permissive control, ${suite}`).toMatchObject({ ok: true, cipher: suite });
      }
  });

  it.each(["rsa", "ec"] as const)("%s edge: negotiates TLS 1.3 by default", async (kind) => {
    const result = await probe({
      port: hostPort(kind, 443),
      min: "TLSv1.2",
      max: "TLSv1.3",
      ca: trust,
    });
    expect(result).toMatchObject({ ok: true, protocol: "TLSv1.3" });
  });

  it.each(["rsa", "ec"] as const)(
    "%s edge: the TLS 1.2 fallback works with exactly the documented suites",
    async (kind) => {
      const documented = documentedSuites(kind);
      expect(documented).toHaveLength(2);
      for (const suite of documented) {
        const result = await probe({
          port: hostPort(kind, 443),
          min: "TLSv1.2",
          max: "TLSv1.2",
          ciphers: suite,
          ca: trust,
        });
        expect(result, suite).toMatchObject({ ok: true, protocol: "TLSv1.2", cipher: suite });
      }
    },
  );

  it.each(["rsa", "ec"] as const)("%s edge: refuses TLS 1.1 and TLS 1.0", async (kind) => {
    for (const version of ["TLSv1.1", "TLSv1"] as const) {
      const result = await probe({
        port: hostPort(kind, 443),
        min: version,
        max: version,
        ciphers: "ALL:@SECLEVEL=0",
        ca: trust,
      });
      expect(result, version).toMatchObject({ ok: false });
      expect((result as { error: string }).error, version).toMatch(/alert|handshake|protocol/i);
    }
  });

  it.each(["rsa", "ec"] as const)(
    "%s edge: refuses every TLS 1.2 suite outside the documented list",
    async (kind) => {
      for (const suite of DENIED_SUITES[kind]) {
        const result = await probe({
          port: hostPort(kind, 443),
          min: "TLSv1.2",
          max: "TLSv1.2",
          ciphers: `${suite}:@SECLEVEL=0`,
          ca: trust,
        });
        expect(result, suite).toMatchObject({ ok: false });
        expect((result as { error: string }).error, suite).toMatch(/alert|handshake|cipher/i);
      }
    },
  );

  it.each(LEGACY_REDIRECTS)(
    "http on port 80 sends $from to $to with a 308 that keeps the path and query",
    async ({ from, to }) => {
      const reply = await get({
        port: hostPort("rsa", 80),
        host: from,
        path: "/fhir/Patient?_count=1",
      });
      expect(reply.status).toBe(308);
      expect(reply.headers.location).toBe(`${to}/fhir/Patient?_count=1`);
    },
  );

  it.each(LEGACY_REDIRECTS)(
    "https for $from, over a verified connection, also answers 308 to $to",
    async ({ from, to }) => {
      const reply = await get({
        port: hostPort("rsa", 443),
        host: from,
        path: "/a?b=1",
        ca: trust,
      });
      expect(reply.status).toBe(308);
      expect(reply.headers.location).toBe(`${to}/a?b=1`);
    },
  );

  it("the SPA nginx emits the committed HSTS value on 200 and 404 responses alike", async () => {
    const expected = read("deploy/production/web-security-headers.conf").match(
      /Strict-Transport-Security "([^"]+)"/,
    )?.[1];
    expect(expected).toMatch(/max-age=\d+; includeSubDomains/);
    const port = hostPort("web", 8080);
    const statuses: number[] = [];
    for (const path of ["/", "/index.html", "/portal/", "/assets/missing.js"]) {
      const reply = await get({ port, host: "app.chartwarden.cloud", path });
      statuses.push(reply.status);
      expect(reply.headers["strict-transport-security"], `${path} (${reply.status})`).toBe(
        expected,
      );
    }
    // At least one error response is in the sample: that is what `always` is for.
    expect(statuses).toContain(404);
  });
});
