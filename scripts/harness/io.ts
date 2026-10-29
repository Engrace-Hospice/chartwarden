/**
 * ChartWarden agent harness — shared I/O for the hook entry points.
 *
 * The ledger is a local, append-only, hash-chained JSONL record of what an agent DID (tool, target,
 * decision) — never what it SAW. It holds no file content, no command text (only its SHA-256) and no
 * tool output, so it cannot become a PHI store. Each line's `hash` covers the previous line's hash,
 * so an accidentally edited or removed line breaks the chain (`bun run harness:ledger:verify`), months
 * link to each other, and `.claude/audit/HEAD` anchors the newest line count and hash.
 *
 * What this is NOT: tamper-PROOF. The hash is unkeyed and the files are writable by whoever runs the
 * agent, so a determined editor can rewrite the chain and the anchor together. Treat it as local
 * telemetry that catches accidents, next to git history, PR review and CI. For evidence that must
 * survive an adversary, publish the head hash (`harness:ledger:verify --print-head`) somewhere the
 * agent cannot write, such as a PR comment or a CI artifact.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { EMPTY_REGISTRY, type SyntheticRegistry, registryFrom } from "./patterns";

export interface HookInput {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: string;
  readonly stop_hook_active?: boolean;
  /** Set when stdin was empty or not JSON. PreToolUse fails CLOSED on it; other hooks ignore it. */
  readonly invalid?: boolean;
}

export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return { invalid: true };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { invalid: true };
    }
    return parsed as HookInput;
  } catch {
    return { invalid: true };
  }
}

export function projectDir(input?: HookInput): string {
  return process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
}

export function loadRegistry(root: string): SyntheticRegistry {
  const p = join(root, "compliance", "synthetic-identifiers.json");
  if (!existsSync(p)) return EMPTY_REGISTRY;
  try {
    return registryFrom(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return EMPTY_REGISTRY;
  }
}

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function relPath(root: string, p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  return p.startsWith("/") ? relative(root, p) || p : p;
}

export interface LedgerEvent {
  readonly event: string;
  readonly tool?: string;
  readonly target?: string;
  readonly cmd_sha256?: string;
  readonly decision?: string;
  readonly reason?: string;
}

export function ledgerPath(root: string, now = new Date()): string {
  return join(root, ".claude", "audit", `agent-ledger-${now.toISOString().slice(0, 7)}.jsonl`);
}

/** Month ledgers sorted oldest to newest (`agent-ledger-YYYY-MM.jsonl`). */
export function ledgerFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^agent-ledger-\d{4}-\d{2}\.jsonl$/.test(f))
        .sort()
    : [];
}

/**
 * Hash of the newest complete line in `file`, "GENESIS" for an empty file. A torn final line (a hook
 * killed mid-write) is cut off first, so one crash cannot break the chain for the rest of the month.
 */
function lastHash(file: string): string {
  if (!existsSync(file)) return "GENESIS";
  let size = statSync(file).size;
  if (size === 0) return "GENESIS";
  const fd = openSync(file, "r");
  const len = Math.min(size, 65536);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  const text = buf.toString("utf8");
  if (!text.endsWith("\n")) {
    const cut = text.lastIndexOf("\n");
    size = size - Buffer.byteLength(text.slice(cut + 1)); // drop the partial line
    truncateSync(file, size);
    return lastHash(file);
  }
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return "GENESIS";
  try {
    return (JSON.parse(last) as { hash?: string }).hash ?? "BROKEN";
  } catch {
    return "BROKEN";
  }
}

/** Where a new month's chain starts: the previous month's last hash, so months cannot be dropped silently. */
function chainStart(file: string): string {
  const dir = join(file, "..");
  const earlier = ledgerFiles(dir).filter((f) => join(dir, f) < file);
  const prev = earlier[earlier.length - 1];
  return prev ? lastHash(join(dir, prev)) : "GENESIS";
}

/** Canonical form hashed for each line: every field except `hash`, keys sorted. */
export function lineDigest(entry: Record<string, unknown>): string {
  const { hash: _omit, ...rest } = entry;
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify(sorted));
}

/** Best-effort: a ledger failure must never block the developer's work. */
export function appendLedger(root: string, sessionId: string | undefined, e: LedgerEvent): void {
  if (process.env.CW_AGENT_LEDGER === "off") return;
  try {
    const now = new Date();
    const file = ledgerPath(root, now);
    mkdirSync(join(root, ".claude", "audit"), { recursive: true });
    const lock = `${file}.lock`;
    let fd = -1;
    for (let i = 0; i < 50 && fd < 0; i++) {
      try {
        fd = openSync(lock, "wx");
      } catch {
        // A lock older than 5 s was left by a killed hook: clear it rather than wait on it forever.
        try {
          if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock);
        } catch {}
        Bun.sleepSync(10);
      }
    }
    // Never write unlocked: a lost line is visible as a gap in time, a raced line breaks the chain.
    if (fd < 0) {
      process.stderr.write("[chartwarden-harness] ledger busy; entry skipped\n");
      return;
    }
    try {
      const entry: Record<string, unknown> = {
        ts: now.toISOString(),
        session: sessionId ?? "",
        actor: process.env.GIT_AUTHOR_EMAIL || process.env.USER || "",
        ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined && v !== "")),
        prev: existsSync(file) ? lastHash(file) : chainStart(file),
      };
      entry.hash = sha256(String(entry.prev) + lineDigest(entry));
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
      writeHead(file, String(entry.hash));
    } finally {
      if (fd >= 0) {
        closeSync(fd);
        try {
          unlinkSync(lock);
        } catch {}
      }
    }
  } catch {
    // swallow — see doc comment
  }
}

/** `.claude/audit/HEAD`: newest file, its line count and last hash. Catches truncation and deleted files. */
function writeHead(file: string, hash: string): void {
  const name = file.replace(/^.*\//, "");
  const headPath = join(file, "..", "HEAD");
  let lines = 0;
  try {
    const prev = JSON.parse(readFileSync(headPath, "utf8")) as { file?: string; lines?: number };
    if (prev.file === name && typeof prev.lines === "number") lines = prev.lines;
  } catch {}
  // No usable anchor for this month yet (first line, or the anchor was lost): count the file once.
  if (lines === 0) lines = readFileSync(file, "utf8").split("\n").filter(Boolean).length - 1;
  writeFileSync(headPath, `${JSON.stringify({ file: name, lines: lines + 1, hash })}\n`);
}

export interface ChainCheck {
  readonly ok: boolean;
  readonly lines: number;
  readonly brokenAt?: number;
  /** Hash of the last line, to seed the next month's check. */
  readonly lastHash?: string;
  /** First `prev` seen: a ledger whose oldest months were pruned starts mid-chain. */
  readonly startsAt?: string;
}

/**
 * `startPrev` is the previous month's last hash. Omit it for the oldest file: its first `prev` is
 * taken as the start, since old months may have been pruned on purpose.
 */
export interface Head {
  readonly file: string;
  readonly lines: number;
  readonly hash: string;
}

export function readHead(dir: string): Head | null {
  try {
    return JSON.parse(readFileSync(join(dir, "HEAD"), "utf8")) as Head;
  } catch {
    return null;
  }
}

export function verifyChain(text: string, startPrev?: string): ChainCheck {
  const lines = text.trimEnd().split("\n").filter(Boolean);
  let prev = startPrev ?? "GENESIS";
  let startsAt: string | undefined;
  if (startPrev === undefined && lines[0]) {
    try {
      prev = String((JSON.parse(lines[0]) as { prev?: unknown }).prev ?? "GENESIS");
      startsAt = prev;
    } catch {}
  }
  for (const [i, l] of lines.entries()) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(l) as Record<string, unknown>;
    } catch {
      return { ok: false, lines: lines.length, brokenAt: i + 1 };
    }
    if (entry.prev !== prev || entry.hash !== sha256(prev + lineDigest(entry))) {
      return { ok: false, lines: lines.length, brokenAt: i + 1 };
    }
    prev = String(entry.hash);
  }
  return { ok: true, lines: lines.length, lastHash: prev, startsAt };
}
