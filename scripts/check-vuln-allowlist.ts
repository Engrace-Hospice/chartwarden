/**
 * WardenX — vulnerability-allowlist hygiene gate (F-040 / #100)
 * -------------------------------------------------------------
 * The release job scans both published images with Trivy and fails on HIGH/CRITICAL. `.trivyignore.yaml`
 * is the only way to let a finding through, which makes it the only place the supply-chain gate can be
 * silently disarmed — and the way it gets disarmed is never a deliberate decision to ignore a
 * vulnerability forever. It is one entry added under deadline "just until upstream patches", and then
 * nobody looks again.
 *
 * So this gate does not ask whether a suppression is justified — it cannot know that. It asks whether
 * each one is still ACCOUNTABLE:
 *
 *   1. every entry names a CVE (`id`);
 *   2. every entry carries a `statement` with real content — not "TODO", not a bare CVE id echoed back;
 *   3. every entry carries an `expired_at` DATE;
 *   4. that date is in the FUTURE — an expired entry is a dead row that still reads as an active
 *      suppression to anyone skimming the file, and Trivy has already stopped honouring it, so the
 *      release is failing for a reason the file actively disguises;
 *   5. that date is at most {@link MAX_SUPPRESSION_DAYS} days out — an allowlist entry with a two-year
 *      expiry is a permanent suppression wearing a deadline.
 *
 * Deliberately a plain-text parse rather than a YAML dependency: this file has one shape, the gate needs
 * five fields from it, and `arch:fitness` should not grow a parser dependency to read fifteen lines.
 * The one thing a hand parser must not do is silently see nothing — an unparseable `vulnerabilities:`
 * block is an error, never an empty list.
 *
 * Run:   bun run scripts/check-vuln-allowlist.ts
 * CI:    exits 1 on any violation (arch:fitness stage).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const ALLOWLIST = ".trivyignore.yaml";

/** The longest an entry may defer re-examination. A quarter: long enough for an upstream release cycle,
 *  short enough that every suppression is revisited by someone who still remembers why it is there. */
export const MAX_SUPPRESSION_DAYS = 90;

export interface AllowlistEntry {
  readonly id?: string;
  readonly expiredAt?: string;
  readonly statement?: string;
  readonly line: number;
}

export interface AllowlistParse {
  readonly entries: readonly AllowlistEntry[];
  /** True when the `vulnerabilities:` key was found at all — absent is a malformed file, not an empty one. */
  readonly sawKey: boolean;
  /** True when the key is an explicit empty list (`vulnerabilities: []`). */
  readonly explicitlyEmpty: boolean;
}

/** Parse the suppression list. PURE, and exported so the tests can drive malformed shapes directly. */
export function parseAllowlist(source: string): AllowlistParse {
  const lines = source.split("\n");
  let sawKey = false;
  let explicitlyEmpty = false;
  let inBlock = false;
  const entries: AllowlistEntry[] = [];
  let current: { id?: string; expiredAt?: string; statement?: string; line: number } | null = null;

  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const keyMatch = /^vulnerabilities:\s*(.*)$/.exec(line);
    if (keyMatch) {
      sawKey = true;
      inBlock = true;
      if ((keyMatch[1] ?? "").trim() === "[]") explicitlyEmpty = true;
      continue;
    }
    if (!inBlock) continue;
    // A new top-level key ends the block.
    if (/^\S/.test(line)) {
      flush();
      inBlock = false;
      continue;
    }
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      flush();
      current = { line: i + 1 };
      const inline = /^id:\s*(\S+)/.exec(item[1] ?? "");
      if (inline?.[1]) current.id = inline[1];
      continue;
    }
    if (!current) continue;
    const field = /^\s*([a-z_]+):\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] ?? "";
    const value = (field[2] ?? "").trim();
    if (key === "id") current.id = value;
    else if (key === "expired_at") current.expiredAt = value;
    // `statement: >` folds onto following lines; the marker itself carries no text, so a folded
    // statement is recorded as present-but-empty here and filled by the continuation lines below.
    else if (key === "statement") current.statement = value.replace(/^[>|]-?$/, "");
  }
  flush();

  // Second pass for folded statements: any indented prose under a `statement: >` belongs to it. Done
  // separately because the field loop above cannot tell a continuation line from a malformed key.
  const withFolded = entries.map((e) => {
    if (e.statement !== "") return e;
    const start = lines.findIndex((l, idx) => idx >= e.line - 1 && /^\s*statement:\s*[>|]/.test(l));
    if (start === -1) return e;
    const folded: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const next = lines[i] ?? "";
      if (!/^\s{6,}\S/.test(next)) break;
      folded.push(next.trim());
    }
    return { ...e, statement: folded.join(" ") };
  });

  return { entries: withFolded, sawKey, explicitlyEmpty };
}

export interface AllowlistViolation {
  readonly entry: string;
  readonly problem: string;
}

/** Apply the five accountability rules. PURE — `today` is injected so the tests are not time-dependent. */
export function checkAllowlist(
  parse: AllowlistParse,
  today: Date,
  maxDays: number = MAX_SUPPRESSION_DAYS,
): AllowlistViolation[] {
  const violations: AllowlistViolation[] = [];
  if (!parse.sawKey) {
    return [
      {
        entry: ALLOWLIST,
        problem:
          "no `vulnerabilities:` key found — the file is malformed. An unreadable allowlist must fail, " +
          "never be treated as an empty one: Trivy would read it differently from this gate.",
      },
    ];
  }
  for (const e of parse.entries) {
    const label = e.id ?? `(entry at line ${e.line})`;
    if (!e.id) {
      violations.push({ entry: label, problem: "no `id` — the entry names no vulnerability" });
      continue;
    }
    const statement = (e.statement ?? "").trim();
    if (
      statement.length < 20 ||
      /^(todo|tbd|n\/a|fixme)\b/i.test(statement) ||
      statement === e.id
    ) {
      violations.push({
        entry: label,
        problem:
          "`statement` is missing or empty of content. Say what the finding is, why it cannot be fixed " +
          "here yet, and what removes it — the next reader is deciding whether to renew this.",
      });
    }
    if (!e.expiredAt) {
      violations.push({
        entry: label,
        problem:
          "no `expired_at`. A suppression without an expiry is not a suppression, it is a decision to " +
          "stop looking.",
      });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expiredAt)) {
      violations.push({
        entry: label,
        problem: `\`expired_at: ${e.expiredAt}\` is not a YYYY-MM-DD date`,
      });
      continue;
    }
    const expiry = new Date(`${e.expiredAt}T00:00:00Z`);
    if (Number.isNaN(expiry.getTime())) {
      violations.push({
        entry: label,
        problem: `\`expired_at: ${e.expiredAt}\` is not a real date`,
      });
      continue;
    }
    const days = Math.round((expiry.getTime() - today.getTime()) / 86_400_000);
    if (days < 0) {
      violations.push({
        entry: label,
        problem: `expired ${Math.abs(days)} day(s) ago (${e.expiredAt}). Trivy has already stopped honouring it, so the release is failing for a reason this row disguises. Re-examine the finding: fix it, or renew the entry with a new date and an updated statement.`,
      });
      continue;
    }
    if (days > maxDays) {
      violations.push({
        entry: label,
        problem: `expires in ${days} days (${e.expiredAt}), beyond the ${maxDays}-day ceiling. An entry with a long expiry is a permanent suppression wearing a deadline.`,
      });
    }
  }
  return violations;
}

function main(): void {
  const path = join(REPO_ROOT, ALLOWLIST);
  if (!existsSync(path)) {
    console.error(
      `FAIL vuln-allowlist: ${ALLOWLIST} is missing. The release scan references it, so an absent file means the release job is misconfigured rather than that there is nothing to suppress.`,
    );
    process.exit(1);
  }
  const parse = parseAllowlist(readFileSync(path, "utf8"));
  const violations = checkAllowlist(parse, new Date());
  if (violations.length > 0) {
    console.error(`FAIL vuln-allowlist: ${violations.length} problem(s) in ${ALLOWLIST}\n`);
    for (const v of violations) console.error(`  · ${v.entry}: ${v.problem}`);
    console.error(
      "\nThe release image scan fails on HIGH/CRITICAL; this file is the only way past it, which is why " +
        "every entry has to stay accountable.",
    );
    process.exit(1);
  }
  const n = parse.entries.length;
  console.log(
    n === 0
      ? `OK vuln-allowlist: no suppressions (${ALLOWLIST} is empty) — every HIGH/CRITICAL finding fails the release`
      : `OK vuln-allowlist: ${n} suppression(s), each with a statement and an unexpired date within ${MAX_SUPPRESSION_DAYS} days`,
  );
}

if (import.meta.main) main();
