/**
 * ChartWarden — Dependency vulnerability gate  (GAP-087)
 * ------------------------------------------------------------------
 * `bun audit` was named in CLAUDE.md as a remediated finding ("7→1"), named again in the
 * 2026-08-07 audit's own Section 2 checklist — and invoked by NOTHING. Not `ci.yml`, not
 * `deploy.yml`, not `.githooks/pre-push`, not any link in the 21-step `arch:fitness` chain. The
 * "7→1" was one person running one command once. Every dependency added or bumped since then, and
 * every advisory published against a dependency already in the lockfile, has gone unchecked.
 *
 * That second half is the part a one-time sweep can never cover: a package does not have to change
 * to become vulnerable. The lockfile can sit untouched for a month and the vulnerability count can
 * still go from 0 to 3, so this has to run on a schedule of some kind — here, every CI run and
 * every push to main.
 *
 * POLICY
 *   • `critical` / `high`  → FAIL. In a system holding PHI these are not triage items.
 *   • `moderate` / `low`   → printed, does not fail. They accumulate visibly instead of silently.
 *   • An accepted advisory goes in {@link ACCEPTED_ADVISORIES} with a reason and a review date —
 *     never a bare `--ignore=` buried in a CI line where the justification would live nowhere.
 *
 * WHY THIS IS NOT PART OF `arch:fitness`. Every other gate is hermetic: it reads the tree and
 * decides. This one calls out to the advisory registry, so folding it into `arch:fitness` would make
 * the architecture gates fail on a train. It is its own step, wired where it actually runs.
 *
 * A SECURITY GATE THAT SKIPS ITSELF IS THE BUG THIS CLOSES, so an unreachable registry is a hard
 * failure under CI (where a silent skip is indistinguishable from a pass) and a loud warning
 * locally (where the developer may genuinely be offline). `CI=true` — set by GitHub Actions — is the
 * discriminator.
 *
 * Run:   bun run audit:deps
 * CI:    exits 1 on any high/critical advisory, or on an audit that could not be performed.
 */
import { spawnSync } from "node:child_process";

/** Advisory severities, ordered. */
const SEVERITIES = ["low", "moderate", "high", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];

/** At and above this severity, an advisory fails the build. */
const FAIL_AT: Severity = "high";

/**
 * Advisories reviewed and accepted, keyed by GHSA id. Each needs a reason that says why the
 * vulnerable code path is unreachable HERE — "no fix available" is not a reason, it is a schedule.
 * Empty today: `bun audit` reports no vulnerabilities against the current lockfile.
 */
const ACCEPTED_ADVISORIES: Readonly<Record<string, { reason: string; reviewed: string }>> = {};

interface Advisory {
  readonly id?: number;
  readonly url?: string;
  readonly title?: string;
  readonly severity?: string;
  readonly vulnerable_versions?: string;
}

/** `bun audit --json` emits `{}` when clean, else `{ "<package>": Advisory[] }`. */
type AuditReport = Record<string, Advisory[]>;

export interface Finding {
  readonly pkg: string;
  readonly severity: Severity;
  readonly title: string;
  readonly url: string;
  readonly ghsa: string;
  readonly versions: string;
}

/** GHSA id out of an advisory URL (`https://github.com/advisories/GHSA-xxxx-…`). */
export function ghsaOf(url: string | undefined): string {
  return /\/(GHSA-[\w-]+)\b/.exec(url ?? "")?.[1] ?? "";
}

const rank = (s: Severity): number => SEVERITIES.indexOf(s);

/** Flatten a `bun audit --json` report into findings, dropping accepted advisories. */
export function findingsFrom(
  report: AuditReport,
  accepted: Readonly<Record<string, unknown>> = ACCEPTED_ADVISORIES,
): { findings: Finding[]; acceptedHits: string[] } {
  const findings: Finding[] = [];
  const acceptedHits: string[] = [];
  for (const [pkg, advisories] of Object.entries(report)) {
    for (const a of advisories ?? []) {
      const severity = (SEVERITIES as readonly string[]).includes(a.severity ?? "")
        ? (a.severity as Severity)
        : // An unrecognized severity is treated as the worst case, never dropped: a gate that
          // silently ignores what it cannot classify is how a vulnerability ships.
          "critical";
      const ghsa = ghsaOf(a.url);
      if (ghsa && ghsa in accepted) {
        acceptedHits.push(`${pkg} ${ghsa}`);
        continue;
      }
      findings.push({
        pkg,
        severity,
        title: a.title ?? "(untitled advisory)",
        url: a.url ?? "",
        ghsa,
        versions: a.vulnerable_versions ?? "",
      });
    }
  }
  findings.sort((x, y) => rank(y.severity) - rank(x.severity) || x.pkg.localeCompare(y.pkg));
  return { findings, acceptedHits };
}

function main(): void {
  const underCI = Boolean(process.env.CI);
  const run = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });

  let report: AuditReport;
  try {
    // `bun audit` exits non-zero WHEN IT FINDS VULNERABILITIES, so its status says nothing about
    // whether the audit ran. Parseable JSON on stdout is the signal that it did.
    report = JSON.parse(run.stdout.trim().replace(/^[^{[]*/, "")) as AuditReport;
  } catch {
    const detail = `${run.stderr || run.stdout || run.error?.message || "no output"}`.trim();
    const message = `dependency audit could not be performed: \`bun audit --json\` produced no parseable report.\n${detail}`;
    if (underCI) {
      console.error(`✗ ${message}`);
      process.exit(1);
    }
    console.warn(`⚠️  ${message}\n   (warning only outside CI — offline is a normal local state.)`);
    return;
  }

  const { findings, acceptedHits } = findingsFrom(report);
  for (const hit of acceptedHits) console.log(`· accepted advisory skipped: ${hit}`);

  const blocking = findings.filter((f) => rank(f.severity) >= rank(FAIL_AT));
  const advisoryOnly = findings.filter((f) => rank(f.severity) < rank(FAIL_AT));

  for (const f of advisoryOnly) {
    console.log(`  ${f.severity}: ${f.pkg} — ${f.title} ${f.url}`);
  }
  if (advisoryOnly.length > 0) {
    console.log(
      `\n${advisoryOnly.length} advisory-only finding(s) below the ${FAIL_AT} threshold — not blocking, but they are the backlog.`,
    );
  }

  if (blocking.length === 0) {
    console.log(`✓ dependency audit: no ${FAIL_AT}-or-above advisories against the lockfile.`);
    return;
  }

  console.error(`\n✗ dependency audit: ${blocking.length} ${FAIL_AT}-or-above advisory(ies).\n`);
  for (const f of blocking) {
    console.error(`   • [${f.severity}] ${f.pkg} ${f.versions}`);
    console.error(`     ${f.title}`);
    console.error(`     ${f.url}`);
  }
  console.error(
    "\nFix by bumping the dependency (`bun update <pkg>`, or an override in package.json when the" +
      "\nvulnerable copy is transitive). If the vulnerable code path is genuinely unreachable here," +
      "\nrecord the GHSA id in ACCEPTED_ADVISORIES in this file WITH THE REASON — not as a flag.",
  );
  process.exit(1);
}

if (import.meta.main) main();
