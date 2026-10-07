// apps/backend/__tests__/_m29-tls-fixtures.ts — GAP-086 test helper. Mints a throwaway PKI with the `openssl` binary (the
// repo ships no certificate fixtures, and Node has no certificate-signing API): a server certificate + key WardenX presents
// on a feed port, a client CA, a client certificate signed by it, and a client certificate from an UNRELATED CA (the mTLS
// rejection case). Everything is written to a temp dir and removed by `dispose()`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

import {
  MllpFrameBuffer,
  encodeMllpFrame,
} from "../src/modules/29-external-interfaces/listener/mllp-framing";

export interface TlsFixtures {
  readonly serverCertPem: string;
  readonly serverKeyPem: string;
  /** What a client must trust to accept the server certificate. */
  readonly serverCaPem: string;
  readonly clientCaPem: string;
  readonly clientCertPem: string;
  readonly clientKeyPem: string;
  readonly strangerCertPem: string;
  readonly strangerKeyPem: string;
  /** The sealed-credential plaintext the mint route accepts. */
  readonly bundleJson: string;
  dispose(): void;
}

const openssl = (cwd: string, ...args: string[]): void => {
  execFileSync("openssl", args, { cwd, stdio: "pipe" });
};

export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function makeCa(dir: string, name: string): void {
  openssl(
    dir,
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.pem`,
    "-subj",
    `/CN=${name}`,
    "-days",
    "2",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
}

function makeLeaf(
  dir: string,
  name: string,
  caName: string,
  eku: "clientAuth" | "serverAuth",
): void {
  openssl(
    dir,
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name}`,
  );
  writeFileSync(
    join(dir, `${name}.ext`),
    `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=${eku}\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n`,
  );
  openssl(
    dir,
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    `${caName}.pem`,
    "-CAkey",
    `${caName}.key`,
    "-CAcreateserial",
    "-out",
    `${name}.pem`,
    "-days",
    "2",
    "-extfile",
    `${name}.ext`,
  );
}

export function createTlsFixtures(): TlsFixtures {
  const dir = mkdtempSync(join(tmpdir(), "wx-m29-tls-"));
  makeCa(dir, "server-ca");
  makeCa(dir, "client-ca");
  makeCa(dir, "stranger-ca");
  makeLeaf(dir, "server", "server-ca", "serverAuth");
  makeLeaf(dir, "client", "client-ca", "clientAuth");
  makeLeaf(dir, "stranger", "stranger-ca", "clientAuth");
  const read = (f: string): string => readFileSync(join(dir, f), "utf8");
  const serverCertPem = read("server.pem");
  const serverKeyPem = read("server.key");
  const clientCaPem = read("client-ca.pem");
  return {
    serverCertPem,
    serverKeyPem,
    serverCaPem: read("server-ca.pem"),
    clientCaPem,
    clientCertPem: read("client.pem"),
    clientKeyPem: read("client.key"),
    strangerCertPem: read("stranger.pem"),
    strangerKeyPem: read("stranger.key"),
    bundleJson: JSON.stringify({ serverCertPem, serverKeyPem, expectedClientCaPem: clientCaPem }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A free TCP port (bind to 0, read it, release it). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export interface MllpClientOptions {
  readonly port: number;
  readonly trust: string;
  readonly cert?: string;
  readonly key?: string;
  readonly timeoutMs?: number;
}

/** Send ONE HL7 message over mTLS and resolve with the ACK message text (without framing), or reject on a refused/closed socket. */
export function sendMllp(opts: MllpClientOptions, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const buffer = new MllpFrameBuffer();
    const socket = tls.connect({
      host: "127.0.0.1",
      port: opts.port,
      ca: opts.trust,
      ...(opts.cert ? { cert: opts.cert } : {}),
      ...(opts.key ? { key: opts.key } : {}),
      minVersion: "TLSv1.3",
      servername: "localhost",
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("mllp client timeout"));
    }, opts.timeoutMs ?? 10_000);
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };
    socket.once("secureConnect", () => socket.write(encodeMllpFrame(message)));
    socket.on("data", (chunk: Buffer) => {
      buffer.append(chunk);
      const [frame] = buffer.drain();
      if (frame !== undefined) {
        socket.end();
        done(() => resolve(frame));
      }
    });
    socket.once("error", (err) => done(() => reject(err)));
    socket.once("close", () => done(() => reject(new Error("socket closed before an ACK"))));
  });
}

/** `MSA-1` of an ACK message. */
export const ackCode = (ack: string): string => ack.split("\r")[1]?.split("|")[1] ?? "";
