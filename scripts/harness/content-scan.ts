/**
 * The content rules of the guard, pure (moved out of `patterns.ts`, wave 8): which file names are secrets
 * (`secretPathReason`) and whether a text carries a PHI-shaped identifier or a credential (`scanContent`). `patterns.ts`
 * re-exports every name it used to define, so no importer changes.
 */
import { backupName } from "./backup-names";
import { aliasNormalise } from "./path-alias";
import { EXTRA_SECRET_RULES } from "./secret-names";

export { EMPTY_REGISTRY, registryFrom, type SyntheticRegistry } from "./synthetic-registry";
import type { SyntheticRegistry } from "./synthetic-registry";

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
  // `.bak` and the other copy suffixes are judged by the file they copy (`backup-names.ts`).
  [/\.(dump|sql\.gz|sql\.zst|backup)$/i, "a database dump or backup (may hold PHI)"],
  [/(^|\/)(pgbackrest|backups?)\/.*\.(gz|zst|lz4|tar)$/i, "a backup archive (may hold PHI)"],
  [
    /(^|\/)[^/]*backups?[^/]*\.(tar(\.[a-z0-9]+)?|tgz|zip|gz|zst|lz4)$/i,
    "a backup archive (may hold PHI)",
  ],
  [/\.env\.bak(\.|$)/i, "a backup of a live environment file"],
  ...EXTRA_SECRET_RULES,
];

/** Returns why `path` is off-limits to an agent, or null when it is fine. */
export function secretPathReason(path: string): string | null {
  const p = aliasNormalise(path).replace(/\\/g, "/");
  if (TEMPLATE_SUFFIX.test(p)) return null;
  const copy = backupName(p);
  // A copy of a template is a template.
  if (copy.isCopy && TEMPLATE_SUFFIX.test(copy.original)) return null;
  const named = (name: string): string | null =>
    SECRET_PATH_RULES.find(([re]) => re.test(name))?.[1] ?? null;
  const why = named(p) ?? (copy.isCopy ? named(copy.original) : null);
  if (why !== null) return why;
  // A copy of a source file is not a database backup; a `.bak` of something unnamed may be one.
  return copy.mayBeDatabaseBackup ? "a database dump or backup (may hold PHI)" : null;
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
export const MBI = new RegExp(
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
// `postgres://x:` start (quadratic), and a guard that runs out of time refuses the call.
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
export const LOCAL_HOST = {
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
// start for every finding made a 1 MB patch of findings take 14 s, and a guard that runs out of time refuses the call.
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
