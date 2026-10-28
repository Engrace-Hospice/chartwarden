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
  | "high-entropy-secret";

export interface Finding {
  readonly kind: FindingKind;
  readonly line: number;
  /** Length only — no characters of the value, not even a prefix (an SSN's last four are the sensitive part). */
  readonly sample: string;
}

const redact = (v: string): string => `${v.length} chars`;

const SSN_DASHED = /\b(\d{3})-(\d{2})-(\d{4})\b/g;
const SSN_KEYED = /\bssn\b[^0-9\n]{0,6}(\d{9})\b/gi;
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
const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal|[a-z0-9_-]+|.*\.(local|internal|test|localhost|example))$/i;
const PLACEHOLDER =
  /^(\$\{?[A-Z_]+\}?|<[^>]+>|\*+|x+|password|postgres|changeme|secret|pass|chartwarden(-(local|dev|test|ci|e2e)[A-Za-z0-9_-]*)?)$/i;

/** `SECRET=...`-style assignment with a long, high-entropy literal. Applied to non-test paths only. */
const KEYED_SECRET =
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*["'`]?([A-Za-z0-9+/=_.-]{32,})["'`]?/g;

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

export function scanContent(text: string, registry: SyntheticRegistry, path = ""): Finding[] {
  if (path && !isScannable(path)) return [];
  const out: Finding[] = [];
  const push = (kind: FindingKind, index: number, value: string) =>
    out.push({ kind, line: lineOf(text, index), sample: redact(value) });

  for (const m of text.matchAll(SSN_DASHED)) {
    const [whole, a = "", g = "", s = ""] = m;
    if (ssnNeverIssued(a, g, s) || registry.ssn.has(a + g + s)) continue;
    push("ssn", m.index ?? 0, whole);
  }
  for (const m of text.matchAll(SSN_KEYED)) {
    const v = m[1] ?? "";
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

export function describeFindings(path: string, findings: readonly Finding[]): string {
  const kinds = [...new Set(findings.map((f) => f.kind))];
  const where = findings
    .slice(0, 5)
    .map((f) => `${path}:${f.line} (${f.kind}, ${f.sample})`)
    .join("; ");
  const phi = kinds.some((k) => k === "ssn" || k === "mbi");
  const advice = phi
    ? "Use a value from compliance/synthetic-identifiers.json, or an SSN with area 000/666/9xx. Adding a new synthetic value to that file is a human decision."
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
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Shell words, keeping a quoted string as one word (quotes stripped). */
function words(seg: string): string[] {
  return [...seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** The program a simple command runs, skipping `VAR=value` prefixes and `sudo`/`time`/`command`. */
function program(seg: string): { prog: string; args: string[] } {
  const w = words(seg);
  let k = 0;
  while (
    k < w.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k] ?? "") ||
      /^(sudo|time|command|exec|nohup)$/.test(w[k] ?? ""))
  )
    k++;
  return { prog: (w[k] ?? "").replace(/^.*\//, ""), args: w.slice(k + 1) };
}

/** File-ish arguments: not flags, not globs or expansions, quotes stripped. */
function fileArgs(args: readonly string[]): string[] {
  return args
    .map((t) => t.replace(/^['"`]+|['"`]+$/g, "").replace(/^--?[a-z-]+=/i, ""))
    .filter((t) => t && !t.startsWith("-") && !/[*?$(){}<>]/.test(t));
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
function gitInvocation(args: readonly string[]): {
  sub: string;
  rest: string[];
  configs: string[];
} {
  const takesValue =
    /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/;
  const configs: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (takesValue.test(a)) {
      if (a === "-c" || a === "--config-env") configs.push(args[k + 1] ?? "");
      k++;
      continue;
    }
    if (a.startsWith("--config-env=")) configs.push(a.slice("--config-env=".length));
    if (a.startsWith("-")) continue;
    return { sub: a, rest: args.slice(k + 1), configs };
  }
  return { sub: "", rest: [], configs };
}

/** `-c` keys that switch off the repo's hooks or make git run a program of the caller's choosing. */
const GIT_EXEC_CONFIG = /^(core\.hookspath|core\.fsmonitor|core\.sshcommand|alias\.)/i;
/** `git branch` forms that change refs; the read-only listing forms are allowed in settings.json. */
const GIT_BRANCH_MUTATES =
  /^(-[a-zA-Z]*[fdDmMcCu][a-zA-Z]*|--(force|delete|move|copy|set-upstream-to|unset-upstream|edit-description)(=.*)?)$/;

const deny = (reason: string): BashVerdict => ({ decision: "deny", reason });
const ask = (reason: string): BashVerdict => ({ decision: "ask", reason });

export function classifyBash(cmd: string, ctx: BashContext = {}): BashVerdict {
  const c = cmd.trim();
  const segs = segments(c);

  // --- Gate bypasses: always refused. The pre-push hook and CI are the change-management control.
  if (/\bSKIP_FITNESS=1\b|\bCW_SKIP_PHI_SCAN=1\b/.test(c)) {
    return deny("Skipping the fitness gate or PHI scan is a human decision, not an agent one.");
  }

  // Every simple command is judged; any deny wins, else the first ask, else allow.
  const verdicts = segs
    .map((seg) => classifySegment(seg, ctx))
    .filter((v): v is BashVerdict => v !== null);
  return (
    verdicts.find((v) => v.decision === "deny") ??
    verdicts.find((v) => v.decision === "ask") ?? { decision: "allow", reason: "" }
  );
}

function classifySegment(seg: string, ctx: BashContext): BashVerdict | null {
  const { prog, args } = program(seg);
  const argline = args.join(" ");

  if (prog === "git") {
    const { sub, rest, configs } = gitInvocation(args);
    if (/\s--no-verify\b/.test(` ${argline}`)) {
      return deny(
        "`--no-verify` skips the repo's git hooks (the fitness gate and secret scan). Fix what the hook reports instead; a human can bypass deliberately outside the agent.",
      );
    }
    if (configs.some((kv) => GIT_EXEC_CONFIG.test(kv))) {
      return deny(
        "`git -c` / `--config-env` setting core.hooksPath, core.fsmonitor, core.sshCommand or an alias disables the repo's hooks or runs an arbitrary program for this one command.",
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
    if (sub === "branch" && rest.some((a) => GIT_BRANCH_MUTATES.test(a))) {
      return deny(
        "This `git branch` form creates, moves, copies, deletes or re-points a branch; listing is the only form an agent may run.",
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

  // --- Production data access. An agent session connecting to a non-local database is PHI access.
  if (/^(psql|pg_dump|pg_dumpall|pg_restore|pgcli)$/.test(prog)) {
    const hostFlag = /(?:^|\s)(?:-h\s*|--host[=\s])([^\s'"]+)/.exec(argline)?.[1];
    const urlHost = /postgres(?:ql)?:\/\/[^@\s]*@([^/:\s?'"]+)/.exec(argline)?.[1];
    const host = hostFlag ?? urlHost;
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
    if (host && !isLocalHost(host.includes(".") ? host : `${host}.remote`)) {
      return ask(
        `Remote access to \`${host}\`. Production hosts hold PHI; confirm this is intended and that no PHI will enter the session.`,
      );
    }
  }

  // --- Outbound uploads: the exfiltration shape.
  if (
    /^(curl|wget|http|https|httpie)$/.test(prog) &&
    /(\s-d\b|\s--data(-[a-z]+)?\b|\s-F\b|\s--form\b|\s-T\b|\s--upload-file\b|\s-X\s*(POST|PUT|PATCH)\b|--post-(data|file))/i.test(
      ` ${argline}`,
    )
  ) {
    const host = /https?:\/\/([^/:\s'"]+)/.exec(argline)?.[1] ?? "";
    if (!isLocalHost(host)) {
      return ask(
        `Sending data to \`${host || "a remote host"}\`. Confirm the payload carries no PHI or secrets.`,
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
