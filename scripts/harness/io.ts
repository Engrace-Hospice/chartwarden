/**
 * ChartWarden agent harness — shared I/O for the hook entry points.
 *
 * The ledger is a local, append-only, hash-chained JSONL record of what an agent DID (tool, target,
 * decision) — never what it SAW. It holds no file content, no command text (only its SHA-256) and no
 * tool output, so it cannot become a PHI store. Each line's `hash` covers the previous line's hash,
 * so a deleted or edited line breaks the chain (`bun run harness:ledger:verify`). It is supplementary
 * change-management evidence next to git history, PR review and CI — not a replacement for them.
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
  statSync,
  unlinkSync,
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
}

export async function readHookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
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

function lastHash(file: string): string {
  if (!existsSync(file)) return "GENESIS";
  // Only the tail is needed: read the last 8 KB rather than the whole month.
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  const len = Math.min(size, 8192);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, size - len);
  closeSync(fd);
  const lines = buf.toString("utf8").trimEnd().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return "GENESIS";
  try {
    return (JSON.parse(last) as { hash?: string }).hash ?? "GENESIS";
  } catch {
    return "BROKEN";
  }
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
        prev: lastHash(file),
      };
      entry.hash = sha256(String(entry.prev) + lineDigest(entry));
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
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

export interface ChainCheck {
  readonly ok: boolean;
  readonly lines: number;
  readonly brokenAt?: number;
}

export function verifyChain(text: string): ChainCheck {
  const lines = text.trimEnd().split("\n").filter(Boolean);
  let prev = "GENESIS";
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
  return { ok: true, lines: lines.length };
}
