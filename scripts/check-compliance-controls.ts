/**
 * ChartWarden — compliance register + agent-harness integrity gate (`arch:compliance`)
 * -----------------------------------------------------------------------------------
 * Two things that otherwise rot silently:
 *
 * A. `compliance/controls.yaml` — the claim→evidence register for HIPAA Security Rule standards and
 *    SOC 2 criteria. A register is only worth showing an auditor if every claim still points at
 *    something that exists, so this gate fails when:
 *      1. an evidence `script` is not a package.json script, a `file` does not exist, or a `ci`
 *         string appears in no workflow under .github/workflows/;
 *      2. an `implemented` row has no AUTOMATED evidence (script or ci) — paper-only;
 *      3. a `partial`/`gap` row has no real `gap.reason`, no `owner`, or a `review_by` that is past or
 *         more than {@link MAX_REVIEW_DAYS} days out (the vuln-allowlist rule, applied to controls);
 *      4. a `required` HIPAA standard / SOC 2 criterion is cited by no row;
 *      5. two rows share an id, or a status is not one of the four allowed values.
 *
 * B. The agent harness — the Claude Code settings that keep agents away from PHI and secrets. An
 *    agent (or a hurried human) disabling its own guard is the failure this catches:
 *      6. `.claude/settings.json` parses, denies Read of live .env files and key material, and wires
 *         the PreToolUse guard and the Stop gate;
 *      7. ECC's content-capturing hooks stay disabled (`pre:observe:continuous-learning` writes tool
 *         input AND output to disk; `stop:evaluate-session` mines transcripts);
 *      8. `.gitignore` does not swallow the shared harness (`.claude/` was ignored wholesale) but does
 *         ignore the local ledger/cache;
 *      9. `AGENTS.md` is a verbatim copy of `CLAUDE.md` (a standing rule in CLAUDE.md, now enforced).
 *
 * Run:   bun run scripts/check-compliance-controls.ts
 * CI:    exits 1 on any violation (arch:fitness stage).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const MAX_REVIEW_DAYS = 180;
const STATUSES = new Set(["implemented", "partial", "gap", "not-applicable"]);

export interface Evidence {
  readonly script?: string;
  readonly file?: string;
  readonly ci?: string;
}
export interface Control {
  readonly id?: string;
  readonly title?: string;
  readonly hipaa?: readonly string[];
  readonly soc2?: readonly string[];
  readonly status?: string;
  readonly evidence?: readonly Evidence[];
  readonly gap?: { reason?: string; owner?: string; review_by?: string | Date };
}
export interface Register {
  readonly controls?: readonly Control[];
  readonly required?: { hipaa?: readonly string[]; soc2?: readonly string[] };
}

export interface RepoView {
  readonly scripts: ReadonlySet<string>;
  readonly fileExists: (p: string) => boolean;
  readonly workflowText: string;
}

const dateOnly = (v: string | Date | undefined): string | undefined =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === undefined ? undefined : String(v);

/** PURE — `today` and the repo view are injected so the tests drive every shape. */
export function checkRegister(reg: Register, repo: RepoView, today: Date): string[] {
  const v: string[] = [];
  const controls = reg.controls ?? [];
  if (controls.length === 0)
    return [
      "compliance/controls.yaml has no `controls` — an unreadable register must fail, never read as empty",
    ];
  const ids = new Set<string>();
  const citedHipaa = new Set<string>();
  const citedSoc2 = new Set<string>();

  for (const [i, c] of controls.entries()) {
    const label = c.id ?? `(row ${i + 1})`;
    if (!c.id) v.push(`${label}: no \`id\``);
    else if (ids.has(c.id)) v.push(`${label}: duplicate id`);
    else ids.add(c.id);
    if (!c.status || !STATUSES.has(c.status))
      v.push(`${label}: status \`${c.status}\` is not one of ${[...STATUSES].join(", ")}`);
    for (const h of c.hipaa ?? []) citedHipaa.add(h);
    for (const s of c.soc2 ?? []) citedSoc2.add(s);
    if ((c.hipaa ?? []).length + (c.soc2 ?? []).length === 0)
      v.push(`${label}: cites no HIPAA standard or SOC 2 criterion`);

    const evidence = c.evidence ?? [];
    if (c.status !== "not-applicable" && evidence.length === 0) v.push(`${label}: no evidence`);
    for (const e of evidence) {
      if (e.script !== undefined && !repo.scripts.has(e.script))
        v.push(`${label}: evidence script \`${e.script}\` is not a package.json script`);
      if (e.file !== undefined && !repo.fileExists(e.file))
        v.push(`${label}: evidence file \`${e.file}\` does not exist`);
      if (e.ci !== undefined && !repo.workflowText.includes(e.ci))
        v.push(`${label}: evidence ci \`${e.ci}\` appears in no .github/workflows/*.yml`);
      if (e.script === undefined && e.file === undefined && e.ci === undefined)
        v.push(`${label}: an evidence entry names nothing (script, file or ci)`);
    }
    if (
      c.status === "implemented" &&
      !evidence.some((e) => e.script !== undefined || e.ci !== undefined)
    ) {
      v.push(
        `${label}: \`implemented\` but every piece of evidence is a document — add the gate, live suite or CI job that proves it, or mark it partial`,
      );
    }

    if (c.status === "partial" || c.status === "gap") {
      const reason = (c.gap?.reason ?? "").trim();
      if (reason.length < 30 || /^(todo|tbd|n\/a|fixme)\b/i.test(reason))
        v.push(
          `${label}: \`${c.status}\` needs a gap.reason saying what is missing and what closes it`,
        );
      if (!c.gap?.owner) v.push(`${label}: \`${c.status}\` needs a gap.owner`);
      const rb = dateOnly(c.gap?.review_by);
      if (!rb || !/^\d{4}-\d{2}-\d{2}$/.test(rb))
        v.push(`${label}: gap.review_by must be a YYYY-MM-DD date`);
      else {
        const days = Math.round(
          (new Date(`${rb}T00:00:00Z`).getTime() - today.getTime()) / 86_400_000,
        );
        if (Number.isNaN(days)) v.push(`${label}: gap.review_by \`${rb}\` is not a real date`);
        else if (days < 0)
          v.push(
            `${label}: gap.review_by ${rb} passed ${-days} day(s) ago — re-examine the gap and either close it or renew the date with an updated reason`,
          );
        else if (days > MAX_REVIEW_DAYS)
          v.push(
            `${label}: gap.review_by ${rb} is ${days} days out (max ${MAX_REVIEW_DAYS}) — a gap with a distant date is an accepted risk wearing a deadline`,
          );
      }
    }
  }

  for (const h of reg.required?.hipaa ?? [])
    if (!citedHipaa.has(h)) v.push(`required HIPAA standard ${h} is cited by no control row`);
  for (const s of reg.required?.soc2 ?? [])
    if (!citedSoc2.has(s)) v.push(`required SOC 2 criterion ${s} is cited by no control row`);
  if ((reg.required?.hipaa ?? []).length === 0 || (reg.required?.soc2 ?? []).length === 0)
    v.push("`required` must list HIPAA standards and SOC 2 criteria");
  return v;
}

// --------------------------------------------------------------------------------------- B. harness

// `Read(./.env.*)` is deliberately NOT used: deny beats allow, so it would also hide `.env.example`, the
// template agents need. Every other `.env.*` is refused by the PreToolUse guard instead.
export const REQUIRED_READ_DENIES = [
  "Read(./.env)",
  "Read(**/.env.local)",
  "Read(**/.env.production)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
];
export const REQUIRED_DISABLED_ECC_HOOKS = [
  "pre:observe:continuous-learning",
  "stop:evaluate-session",
];

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ command?: string }>;
}
interface Settings {
  permissions?: { deny?: string[] };
  hooks?: Record<string, HookEntry[]>;
  env?: Record<string, string>;
}

const commandsFor = (s: Settings, event: string): string[] =>
  (s.hooks?.[event] ?? []).flatMap((h) => (h.hooks ?? []).map((x) => x.command ?? ""));

/** PURE over file contents. */
export function checkHarness(files: {
  settings?: string;
  gitignore?: string;
  claudeMd?: string;
  agentsMd?: string;
}): string[] {
  const v: string[] = [];
  if (files.settings === undefined)
    return [".claude/settings.json is missing — the agent harness is not installed"];
  let s: Settings;
  try {
    s = JSON.parse(files.settings) as Settings;
  } catch (e) {
    return [`.claude/settings.json does not parse: ${String(e)}`];
  }
  const deny = new Set(s.permissions?.deny ?? []);
  for (const d of REQUIRED_READ_DENIES)
    if (!deny.has(d)) v.push(`.claude/settings.json: permissions.deny is missing \`${d}\``);
  if (!commandsFor(s, "PreToolUse").some((c) => c.includes("scripts/harness/pre-tool-guard.ts")))
    v.push(".claude/settings.json: PreToolUse does not run scripts/harness/pre-tool-guard.ts");
  if (!commandsFor(s, "Stop").some((c) => c.includes("scripts/harness/stop-gate.ts")))
    v.push(".claude/settings.json: Stop does not run scripts/harness/stop-gate.ts");
  const disabled = new Set((s.env?.ECC_DISABLED_HOOKS ?? "").split(",").map((x) => x.trim()));
  for (const h of REQUIRED_DISABLED_ECC_HOOKS)
    if (!disabled.has(h))
      v.push(
        `.claude/settings.json: env.ECC_DISABLED_HOOKS must include \`${h}\` (it persists tool content outside the repo's controls)`,
      );
  if (s.env?.ECC_SKIP_OBSERVE !== "1")
    v.push('.claude/settings.json: env.ECC_SKIP_OBSERVE must be "1"');

  const gi = (files.gitignore ?? "").split("\n").map((l) => l.trim());
  if (gi.includes(".claude/") || gi.includes(".claude") || gi.includes("/.claude/"))
    v.push(
      ".gitignore ignores the whole .claude/ directory — the shared harness would never be committed",
    );
  for (const need of [".claude/audit/", ".claude/.cache/", ".claude/settings.local.json"])
    if (!gi.includes(need)) v.push(`.gitignore must ignore \`${need}\` (local, per-developer)`);

  if (
    files.claudeMd !== undefined &&
    files.agentsMd !== undefined &&
    files.claudeMd !== files.agentsMd
  )
    v.push("AGENTS.md is not a verbatim copy of CLAUDE.md");
  return v;
}

// --------------------------------------------------------------------------------------- main

function main(): void {
  const root = process.cwd();
  const read = (p: string): string | undefined =>
    existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : undefined;
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const wfDir = join(root, ".github", "workflows");
  const workflowText = existsSync(wfDir)
    ? readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => readFileSync(join(wfDir, f), "utf8"))
        // Comment lines don't count: a control is not evidenced by a commented-out step.
        .map((t) =>
          t
            .split("\n")
            .filter((l) => !/^\s*#/.test(l))
            .join("\n"),
        )
        .join("\n")
    : "";
  const regText = read("compliance/controls.yaml");
  const violations: string[] = [];
  if (regText === undefined) violations.push("compliance/controls.yaml is missing");
  else {
    let reg: Register = {};
    try {
      reg = (Bun.YAML.parse(regText) ?? {}) as Register;
    } catch (e) {
      violations.push(`compliance/controls.yaml does not parse: ${String(e)}`);
    }
    violations.push(
      ...checkRegister(
        reg,
        {
          scripts: new Set(Object.keys(pkg.scripts)),
          fileExists: (p) => existsSync(join(root, p)),
          workflowText,
        },
        new Date(),
      ),
    );
  }
  violations.push(
    ...checkHarness({
      settings: read(".claude/settings.json"),
      gitignore: read(".gitignore"),
      claudeMd: read("CLAUDE.md"),
      agentsMd: read("AGENTS.md"),
    }),
  );

  if (violations.length > 0) {
    console.error(`FAIL check-compliance-controls: ${violations.length} violation(s)\n`);
    for (const x of violations) console.error(`  - ${x}`);
    process.exit(1);
  }
  console.log(
    "OK check-compliance-controls: register evidence resolves, gaps are dated, agent harness intact",
  );
}

if (import.meta.main) main();
