// scripts/claimmd-webhook-capture.ts — take ONE or a few real Claim.MD webhook deliveries off the wire as capture files, so they
// can be checked offline with scripts/claimmd-webhook-replay.ts (CW-TX-02). Run by an operator, never by an agent.
//
//   bun run claimmd:webhook:capture -- --out ~/claimmd-captures [--port 8787] [--max 5]
//
// It listens on 127.0.0.1 ONLY (there is no option to listen elsewhere). Pointing Claim.MD's TEST account's webhook at it is the
// operator's step and goes through the operator's own tunnel; the listener verifies nothing and forwards nothing: it writes the
// exact body bytes and the signature/transport headers (every other header contributes its NAME only) to one file per request,
// answers 200 `{"captured":true}`, and stops after --max captures. It sends no traffic of its own.
//
// A real delivery can carry a provider TIN or NPI. The files are 0600 in a 0700 directory that must NOT be inside this repository
// (refused), and they stay on the operator's machine: only the replay REPORT, which carries no field value, is for sharing.
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAIMMD_CAPTURE_MAX_BODY_BYTES, buildClaimMdCapture } from "@chartwarden/x12-837-client";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_CAPTURES = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function usageError(message: string): never {
  console.error(message);
  console.error(
    "usage: bun run claimmd:webhook:capture -- --out <dir outside the repository> [--port 8787] [--max 5]",
  );
  process.exit(2);
}

/** Whether `path` is `root` or below it. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const outFlag = flag("out");
if (!outFlag) usageError("--out is required");
const outDir = resolve(outFlag);
if (isInside(REPO_ROOT, outDir))
  usageError("--out must be outside this repository: a real capture can hold provider identifiers");
const port = Number(flag("port") ?? DEFAULT_PORT);
const max = Number(flag("max") ?? DEFAULT_MAX_CAPTURES);
if (!Number.isInteger(port) || port < 1 || port > 65535) usageError("--port must be 1..65535");
if (!Number.isInteger(max) || max < 1 || max > 100) usageError("--max must be 1..100");

const existed = existsSync(outDir);
mkdirSync(outDir, { recursive: true, mode: DIR_MODE });
// The guard above is lexical; judge the REAL location too (a symlink into the repository, another clone, a different case on a
// case-insensitive disk), and refuse a directory other users can read or write.
if (isInside(realpathSync(REPO_ROOT), realpathSync(outDir))) {
  if (!existed) rmdirSync(outDir);
  usageError("--out resolves to a place inside this repository");
}
if ((statSync(outDir).mode & 0o077) !== 0)
  usageError("--out must be private to you: chmod 700 it, or name a directory this script creates");

let captured = 0;
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  // Bun ignores server.requestTimeout, so bound a slow sender here: a request that has not finished in time is dropped
  const timer = setTimeout(() => req.destroy(), REQUEST_TIMEOUT_MS);
  req.on("close", () => clearTimeout(timer));
  req.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > CLAIMMD_CAPTURE_MAX_BODY_BYTES) {
      // answer first, then drop the connection: a destroyed request never reaches `end`, so the sender would only see a reset
      tooLarge = true;
      res.writeHead(413, { connection: "close" }).end(() => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return; // the 413 is already on its way and nothing of this request is kept
    if (captured >= max) {
      // --max is a hard cap: a request that was already streaming when the last capture landed is refused, not written
      res.writeHead(503).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const capture = buildClaimMdCapture({
      method: req.method,
      url: req.url ?? "",
      headers: req.headers,
      rawBody: Buffer.concat(chunks),
      receivedAt: new Date(),
    });
    const file = join(outDir, `${Date.now()}-${captured + 1}.capture.json`);
    try {
      // "wx": never follow or overwrite a file (or a symlink) that is already there
      writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`, { mode: FILE_MODE, flag: "wx" });
    } catch {
      console.error("could not write a capture; the delivery was NOT kept");
      res.writeHead(500).end();
      return;
    }
    captured += 1;
    console.log(`captured #${captured}: ${file} (${size} bytes)`);
    res.writeHead(200, { "content-type": "application/json" }).end('{"captured":true}');
    if (captured >= max) server.close(() => process.exit(0));
  });
  req.on("error", () => undefined);
});
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.listen(port, LOOPBACK, () => {
  console.log(
    `listening on ${LOOPBACK}:${port}; writing to ${outDir}; stops after ${max} capture(s)`,
  );
});
