#!/usr/bin/env bun
/**
 * ChartWarden — static analysis (SAST) ratchet (CW-VM-01, #1139)
 * ---------------------------------------------------------------------------
 * `audit:deps` and the release-image scan cover third-party code; nothing read OUR TypeScript for
 * injection, unsafe crypto, XSS sinks or `eval`. This runs a pinned Semgrep over `apps/`, `packages/`,
 * `scripts/` and `e2e/` with pinned community rule packs, and compares the result to a committed baseline.
 *
 * No account, no registry, no telemetry, no paid licence: the engine is a digest-pinned image of the open-source
 * `semgrep/semgrep`, the rules are the `semgrep/semgrep-rules` repository at a pinned commit (fetched at scan time,
 * never copied into this repo; the Semgrep Rules License v1.0 allows internal use), and the scan runs with
 * `--metrics=off`. CodeQL would need GitHub Advanced Security on a private repo; that is deliberately not used.
 *
 * THE RATCHET (like `arch:openapi-coverage`, but per finding):
 *   a finding is keyed by (rule, file, SHA-256 of the matched source text), so moving code or editing another
 *   part of the file never changes it. `compliance/sast/baseline.json` lists the accepted keys WITH a `reason` each.
 *     more findings than baselined  → FAIL. A new finding: fix it, or (if it is a reviewed false positive or an
 *                                     accepted risk) add it with a reason via `bun run sast:update`.
 *     fewer findings than baselined → FAIL (stale). Progress must be locked in, else the slack silently re-opens.
 *   `sast:update` rewrites the baseline from a fresh scan, keeps the reason of every key that survives and gives a
 *   NEW key an empty reason, which `arch:sast` rejects until a human writes one: it never invents a justification.
 *
 * A PR cannot silence its own finding in the source tree (the same stance as gitleaks' `--ignore-gitleaks-allow`):
 * `--disable-nosem` ignores `nosemgrep` comments, and every JS/TS file under the scan roots must be scanned (bar the
 * paths `config.exclude` names: tests, fixtures, dist and .d.ts, so code placed there is NOT scanned). Semgrep
 * skips `vendor/`, `build/` and `test/` directories by default, honours nested `.semgrepignore` files and drops files
 * over 1 MB, so the scan lists the source files itself, scans any Semgrep missed by name, and fails on any that stay
 * unscanned unless `config.unscannedOk` names them with a reason. A file Semgrep reads only in part (its parser lags
 * TypeScript) must be in `config.partialParse`, a list that may only shrink, and any other Semgrep error (a timeout, out
 * of memory, a crash) fails the scan, since either can hide a finding. The baseline, the config and this script are
 * CODEOWNED. The container runs with no network, no capabilities and a read-only mount.
 *
 * KNOWN LIMITS (also in the register row): a finding's key is the matched text only, so a reason that depends on
 * what feeds that line stays attached after a caller changes (reviewers must re-check "constant at every call site");
 * excluded paths are not scanned and nothing stops production code importing them; the open-source engine has no
 * cross-file taint analysis.
 *
 * Modes:
 *   bun run arch:sast      offline, in `arch:fitness`: config, baseline and workflow topology are well formed
 *   bun run sast:scan      runs the scan (needs docker and network for the pinned rules), exits 1 on any drift
 *   bun run sast:update    re-baseline after a scan (keeps reasons; new keys need a reason before `arch:sast` passes)
 *
 * Cost: `.github/workflows/sast.yml` runs weekly and on manual dispatch only. There is deliberately NO `pull_request`
 * trigger (`arch:sast` refuses one): the job runs a PR's own scanner and package.json on the shared self-hosted runner,
 * which has docker access, and the ruleset that gates who may change them (CW-CM-01) is not applied. Re-enable a
 * path-filtered `pull_request` trigger on an ephemeral runner label once it is. Until then a new finding is caught by
 * the weekly run, and `arch:sast` (pins, reasons, workflow shape) still runs on every PR inside `arch:fitness`.
 * The workflow is NOT reachable from `deploy.yml`/`ci.yml` (`verify`/`release`/`deploy`); `arch:sast` pins that.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = "compliance/sast/config.json";
export const BASELINE_PATH = "compliance/sast/baseline.json";
export const WORKFLOW_PATH = ".github/workflows/sast.yml";
/** Shortest reason accepted: a sentence, not "ok" or "TODO". */
export const MIN_REASON_LENGTH = 30;
const FINGERPRINT_LENGTH = 16;
const SCAN_TIMEOUT_MS = 30 * 60 * 1000;
const SCAN_MAX_BUFFER = 256 * 1024 * 1024;

export interface SastConfig {
  readonly semgrepImage: string;
  readonly rulesRepo: string;
  readonly rulesCommit: string;
  readonly rulePacks: readonly string[];
  readonly scanRoots: readonly string[];
  readonly exclude: readonly string[];
  /** Rules switched off, each with the reason (a rule whose results are not reproducible cannot be ratcheted). */
  readonly excludeRules: readonly { readonly rule: string; readonly reason: string }[];
  /** Source files semgrep cannot scan even when named (over its 1 MB limit), each with the reason that is acceptable. */
  readonly unscannedOk: readonly { readonly path: string; readonly reason: string }[];
  /** Files semgrep's parser reads only in part (it lags TypeScript): one shared reason, and the list a new one must join. */
  readonly partialParse: { readonly reason: string; readonly paths: readonly string[] };
}

export interface BaselineEntry {
  readonly rule: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly count: number;
  readonly reason: string;
}

export interface Finding {
  readonly rule: string;
  readonly path: string;
  readonly fingerprint: string;
  readonly line: number;
}

export interface Drift {
  /** Findings beyond what the baseline accepts. */
  readonly added: readonly Finding[];
  /** Baseline entries that no longer match (fully or partly fixed): the baseline must shrink. */
  readonly stale: readonly (BaselineEntry & { readonly found: number })[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s !== "");

export const keyOf = (e: { rule: string; path: string; fingerprint: string }): string =>
  `${e.rule}\u0000${e.path}\u0000${e.fingerprint}`;

/** SHA-256 of the matched lines with whitespace collapsed, so reformatting does not re-open a finding. */
export function fingerprintOf(source: string, startLine: number, endLine: number): string {
  const text = source
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(text).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

/** Pins that make a scan reproducible: a mutable tag or branch would change the findings under a PR that did not touch them. */
export function configProblems(cfg: unknown): string[] {
  if (!isObject(cfg)) return ["is not a JSON object"];
  const v: string[] = [];
  if (
    typeof cfg.semgrepImage !== "string" ||
    !/^[\w][\w./-]*@sha256:[0-9a-f]{64}$/.test(cfg.semgrepImage)
  )
    v.push("`semgrepImage` must be `repo@sha256:<64 hex>` (a tag is mutable)");
  if (typeof cfg.rulesRepo !== "string" || !/^https:\/\/\S+\.git$/.test(cfg.rulesRepo))
    v.push("`rulesRepo` must be an https git URL ending in .git");
  if (typeof cfg.rulesCommit !== "string" || !/^[0-9a-f]{40}$/.test(cfg.rulesCommit))
    v.push("`rulesCommit` must be a full 40-hex commit SHA (a branch moves)");
  for (const key of ["rulePacks", "scanRoots", "exclude"] as const)
    if (!isStringArray(cfg[key]) || cfg[key].length === 0)
      v.push(`\`${key}\` must be a non-empty list of strings`);
  for (const p of isStringArray(cfg.rulePacks) ? cfg.rulePacks : [])
    if (p.startsWith("/") || p.includes(".."))
      v.push(`rule pack \`${p}\` must be a relative path inside the rules repository`);
  for (const p of isStringArray(cfg.exclude) ? cfg.exclude : [])
    if (!EXCLUDE_SHAPE.test(p))
      v.push(
        `exclude \`${p}\` must be a plain name or \`*\` plus a suffix (the completeness check relies on it)`,
      );
  for (const [list, key] of [
    ["excludeRules", "rule"],
    ["unscannedOk", "path"],
  ] as const) {
    const entries = cfg[list];
    if (!Array.isArray(entries)) {
      v.push(`\`${list}\` must be an array (empty is fine)`);
      continue;
    }
    for (const x of entries as unknown[]) {
      const ok =
        isObject(x) &&
        typeof x[key] === "string" &&
        x[key] !== "" &&
        typeof x.reason === "string" &&
        x.reason.trim().length >= MIN_REASON_LENGTH;
      if (!ok)
        v.push(
          `a \`${list}\` entry needs a \`${key}\` and a \`reason\` of ${MIN_REASON_LENGTH}+ characters`,
        );
    }
  }
  const gaps = cfg.partialParse;
  if (
    !isObject(gaps) ||
    typeof gaps.reason !== "string" ||
    gaps.reason.trim().length < MIN_REASON_LENGTH ||
    !Array.isArray(gaps.paths) ||
    !gaps.paths.every((p) => typeof p === "string" && p !== "")
  )
    v.push(
      `\`partialParse\` needs a \`reason\` of ${MIN_REASON_LENGTH}+ characters and a \`paths\` list (empty is fine)`,
    );
  return v;
}

/** Shape of the baseline and that every accepted finding carries a real reason. */
export function baselineProblems(
  baseline: unknown,
  fileExists: (path: string) => boolean,
): string[] {
  if (!isObject(baseline) || !Array.isArray(baseline.entries))
    return ["must be an object with an `entries` array"];
  const v: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of baseline.entries.entries()) {
    if (!isObject(raw)) {
      v.push(`entries[${i}] is not an object`);
      continue;
    }
    const where = `entries[${i}] (${String(raw.rule)} in ${String(raw.path)})`;
    if (typeof raw.rule !== "string" || raw.rule === "") v.push(`entries[${i}] has no \`rule\``);
    if (typeof raw.path !== "string" || raw.path === "") v.push(`entries[${i}] has no \`path\``);
    else if (!fileExists(raw.path)) v.push(`${where}: the file no longer exists, remove the entry`);
    if (typeof raw.fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(raw.fingerprint))
      v.push(`${where}: \`fingerprint\` must be ${FINGERPRINT_LENGTH} hex characters`);
    if (!Number.isInteger(raw.count) || (raw.count as number) < 1)
      v.push(`${where}: \`count\` must be an integer of at least 1`);
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (reason.length < MIN_REASON_LENGTH)
      v.push(`${where}: \`reason\` is missing or shorter than ${MIN_REASON_LENGTH} characters`);
    const key = keyOf(raw as unknown as BaselineEntry);
    if (seen.has(key)) v.push(`${where}: duplicate entry (raise \`count\` instead)`);
    seen.add(key);
  }
  return v;
}

const UNPINNED_USES = /^\s*-?\s*uses:\s*(?!\.\/)(?!\S+@[0-9a-f]{40}\b)\S+/m;
/**
 * The only triggers sast.yml may have. `pull_request` is refused until the re-enable condition holds: the job runs the
 * PR's own scanner and package.json on the shared self-hosted runner (docker access) and the ruleset that gates who may
 * change them (CW-CM-01) is not applied. Then re-add it on an ephemeral runner label and widen this list.
 */
const ALLOWED_TRIGGERS: ReadonlySet<string> = new Set(["schedule", "workflow_dispatch"]);
/** One weekly run: a fixed minute and hour, any day of month and month, one weekday. */
const WEEKLY_CRON = /^\d{1,2} \d{1,2} \* \* [0-6]$/;

/**
 * Topology of sast.yml: cheap triggers, read-only, pinned, and never reachable from the release path.
 * `deploy`/`ci` are the text of deploy.yml and ci.yml.
 */
export function workflowProblems(yaml: string, deploy: string, ci: string): string[] {
  const live = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const v: string[] = [];
  const need = (ok: boolean, msg: string) => {
    if (!ok) v.push(msg);
  };
  need(/^on:\s*$/m.test(live), "no `on:` block");
  // Allow-list the triggers: a deny-list misses a quoted key, `release`, `issue_comment` and the next new event.
  const onBlock = /^on:\s*\n((?: .*\n?|\n)*)/m.exec(live)?.[1] ?? "";
  const triggers = [...onBlock.matchAll(/^ {2}["']?([\w-]+)["']?:/gm)].map((m) => m[1] ?? "");
  for (const t of triggers)
    need(
      ALLOWED_TRIGGERS.has(t),
      t === "pull_request" || t === "pull_request_target"
        ? `must not trigger on \`${t}\`: it would run a PR's own scanner on the shared self-hosted runner while the ruleset (CW-CM-01) is not applied; re-enable it on an ephemeral runner label once it is`
        : `must not trigger on \`${t}\` (only schedule and workflow_dispatch)`,
    );
  need(triggers.includes("schedule"), "has no weekly `schedule:`");
  need(
    triggers.includes("workflow_dispatch"),
    "has no `workflow_dispatch:` (the first run is dispatched by hand)",
  );
  const crons = [...onBlock.matchAll(/- cron:\s*["']([^"']*)["']/g)].map((m) => m[1] ?? "");
  need(
    crons.length === 1 && WEEKLY_CRON.test(crons[0] ?? ""),
    "the schedule must be exactly one weekly cron (`M H * * D`): every other shape is a metered-minutes decision",
  );
  need(
    /^permissions:\n {2}contents: read(?:\n(?! )|(?![\s\S]))/m.test(live),
    "top-level `permissions:` must be exactly `contents: read`",
  );
  need(!/^ {4}permissions:/m.test(live), "a job-level `permissions:` could widen the token");
  need(
    !/^\s+(?:-\s+)?if:|continue-on-error/m.test(live),
    "no `if:` or `continue-on-error`: a skipped or ignored scan is a green check that scanned nothing",
  );
  need(!UNPINNED_USES.test(live), "every `uses:` must be pinned to a 40-hex commit SHA");
  need(/persist-credentials:\s*false/.test(live), "checkout must set `persist-credentials: false`");
  for (const script of ["arch:sast", "sast:scan"])
    need(
      new RegExp(`^\\s+run:\\s*bun run ${script}\\s*$`, "m").test(live),
      `no step runs \`bun run ${script}\` (the weekly run must check the pins and the baseline's reasons, then scan)`,
    );
  for (const [name, text] of [
    ["deploy.yml", deploy],
    ["ci.yml", ci],
  ] as const) {
    // `workflow_run` is banned outright (comments aside): its `workflows:` list can be one line, many, or inline flow
    // style, and a chain from SAST into verify/release/deploy is the metered-minutes incident (#257).
    const code = text.replace(/(^|\s)#.*$/gm, "$1");
    need(
      !/sast\.yml/.test(text) && !/\bworkflow_run\b/.test(code),
      `${name} references the SAST workflow or uses \`workflow_run\`: it must stay out of verify/release/deploy`,
    );
  }
  return v;
}

/** Findings from Semgrep's JSON, fingerprinted from the repo's own source (`extra.lines` can be withheld). */
export function toFindings(semgrepJson: unknown, readSource: (path: string) => string): Finding[] {
  if (!isObject(semgrepJson) || !Array.isArray(semgrepJson.results))
    throw new Error("semgrep output has no `results` array");
  return semgrepJson.results.map((r: unknown): Finding => {
    if (!isObject(r) || !isObject(r.start) || !isObject(r.end))
      throw new Error("a semgrep result has no start/end");
    const path = String(r.path);
    const startLine = Number(r.start.line);
    return {
      rule: String(r.check_id),
      path,
      line: startLine,
      fingerprint: fingerprintOf(readSource(path), startLine, Number(r.end.line)),
    };
  });
}

const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The only `exclude` shapes the config may use (`configProblems` enforces it): a plain name, or `*` plus a suffix. */
const EXCLUDE_SHAPE = /^(?:\*[^*/]+|[^*/]+)$/;

/** `--exclude` semantics for those shapes: a plain name matches any path segment, `*suffix` the basename's end. */
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1] ?? "";
  return patterns.some((p) =>
    p.startsWith("*") ? base.endsWith(p.slice(1)) : segments.includes(p),
  );
}

/** Every JS/TS source file under `roots` that the config does not exclude, as repo-relative paths. */
export function sourceFiles(
  root: string,
  roots: readonly string[],
  exclude: readonly string[],
): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${e.name}`;
      if (isExcluded(next, exclude)) continue;
      if (e.isSymbolicLink())
        throw new Error(
          `${next} is a symlink under a scan root: semgrep does not follow it, so what it points at could go unscanned. Use a real file`,
        );
      if (e.isDirectory()) walk(next);
      else if (e.isFile() && SOURCE_FILE.test(e.name)) out.push(next);
    }
  };
  for (const r of roots) if (existsSync(join(root, r))) walk(r);
  return out.sort();
}

/** Paths semgrep says it scanned. */
export function scannedPaths(semgrepJson: unknown): string[] {
  if (!isObject(semgrepJson) || !isObject(semgrepJson.paths)) return [];
  const scanned = semgrepJson.paths.scanned;
  return Array.isArray(scanned) ? scanned.filter((p): p is string => typeof p === "string") : [];
}

/** `expected` files that are not in `scanned`. */
export function missingFiles(expected: readonly string[], scanned: readonly string[]): string[] {
  const seen = new Set(scanned);
  return expected.filter((p) => !seen.has(p));
}

/** Files semgrep reported a syntax or partial-parse error for, sorted and unique. */
export function unscannedFiles(semgrepJson: unknown): string[] {
  if (!isObject(semgrepJson) || !Array.isArray(semgrepJson.errors)) return [];
  const paths = semgrepJson.errors.flatMap((e: unknown) =>
    isObject(e) && typeof e.path === "string" ? [e.path] : [],
  );
  return [...new Set(paths)].sort();
}

/** Semgrep error types that only mean "parsed in part": tolerated with a warning, since the parser lags TypeScript. */
const PARSE_ERROR_TYPES: ReadonlySet<string> = new Set(["Syntax error", "PartialParsing"]);

/**
 * `path: type` for every Semgrep error that is NOT a parse error (a timeout, out of memory, a crashed worker). Those can
 * drop a file's findings while the run still exits 0, so a scan with one is not trusted: a lost NEW finding would read
 * as green. `type` is a string (`"Syntax error"`) or a tagged array (`["PartialParsing", [...]]`).
 */
export function scanFailures(semgrepJson: unknown): string[] {
  if (!isObject(semgrepJson) || !Array.isArray(semgrepJson.errors)) return [];
  return semgrepJson.errors.flatMap((e: unknown) => {
    if (!isObject(e)) return [];
    const name = String(Array.isArray(e.type) ? e.type[0] : e.type);
    return PARSE_ERROR_TYPES.has(name) ? [] : [`${String(e.path ?? "(no path)")}: ${name}`];
  });
}

/**
 * PURE: the ratchet on partly parsed files. `added` are files semgrep only partly read that the config does not list (a
 * sink in the unparsed region would be invisible), `stale` are listed files that now parse in full.
 */
export function parseGapDrift(
  found: readonly string[],
  listed: readonly string[],
): { readonly added: string[]; readonly stale: string[] } {
  const known = new Set(listed);
  const seen = new Set(found);
  return { added: found.filter((p) => !known.has(p)), stale: listed.filter((p) => !seen.has(p)) };
}

/** PURE: the ratchet. Counts per key, never line numbers. */
export function compareToBaseline(
  findings: readonly Finding[],
  baseline: readonly BaselineEntry[],
): Drift {
  const accepted = new Map(baseline.map((e) => [keyOf(e), e] as const));
  const seen = new Map<string, number>();
  const added: Finding[] = [];
  for (const f of findings) {
    const key = keyOf(f);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > (accepted.get(key)?.count ?? 0)) added.push(f);
  }
  const stale = baseline
    .map((e) => ({ ...e, found: seen.get(keyOf(e)) ?? 0 }))
    .filter((e) => e.found < e.count);
  return { added, stale };
}

/**
 * PURE: the baseline a fresh scan implies. A key keeps its reason only while its count has not grown: a new key, or an
 * extra occurrence of an old one, gets no reason, so a human has to justify the new finding rather than inherit the old.
 */
export function rebaseline(
  findings: readonly Finding[],
  previous: readonly BaselineEntry[],
): BaselineEntry[] {
  const before = new Map(previous.map((e) => [keyOf(e), e] as const));
  const counts = new Map<string, BaselineEntry>();
  for (const f of findings) {
    const key = keyOf(f);
    counts.set(key, {
      rule: f.rule,
      path: f.path,
      fingerprint: f.fingerprint,
      count: (counts.get(key)?.count ?? 0) + 1,
      reason: "",
    });
  }
  const next = [...counts.entries()].map(([key, e]): BaselineEntry => {
    const old = before.get(key);
    return old !== undefined && e.count <= old.count ? { ...e, reason: old.reason } : e;
  });
  // Byte order, not localeCompare: the baseline must not reorder between machines.
  return next.sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

function loadConfig(): SastConfig {
  const cfg = readJson(CONFIG_PATH);
  const problems = configProblems(cfg);
  if (problems.length > 0) throw new Error(`${CONFIG_PATH}: ${problems.join("; ")}`);
  return cfg as SastConfig;
}

function loadBaseline(): BaselineEntry[] {
  const b = readJson(BASELINE_PATH);
  if (!isObject(b) || !Array.isArray(b.entries)) throw new Error(`${BASELINE_PATH} is malformed`);
  return b.entries as BaselineEntry[];
}

function run(cmd: string, args: readonly string[], cwd?: string) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: SCAN_MAX_BUFFER,
  });
  if (r.error) throw new Error(`could not run ${cmd}: ${r.error.message}`);
  return r;
}

/** The rules at the pinned commit, in `dir`. Anything else at that path is refused, never trusted. */
function fetchRules(cfg: SastConfig, dir: string): void {
  if (!existsSync(join(dir, ".git"))) {
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", cfg.rulesRepo],
      ["fetch", "-q", "--depth", "1", "origin", cfg.rulesCommit],
      ["checkout", "-q", "FETCH_HEAD"],
    ]) {
      const r = run("git", args, dir);
      if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
    }
  }
  const head = run("git", ["rev-parse", "HEAD"], dir).stdout.trim();
  if (head !== cfg.rulesCommit)
    throw new Error(`rules checkout is at ${head}, expected the pinned ${cfg.rulesCommit}`);
  // HEAD alone does not prove the files are the pinned ones: a supplied directory could carry edited or extra rules.
  if (
    run(
      "git",
      ["status", "--porcelain", "--ignored", "--untracked-files=all"],
      dir,
    ).stdout.trim() !== ""
  )
    throw new Error(
      `rules checkout ${dir} has local changes: use a clean checkout of ${cfg.rulesCommit}`,
    );
}

export function dockerArgs(
  cfg: SastConfig,
  rulesDir: string,
  targets: readonly string[],
  root: string = ROOT,
): string[] {
  return [
    "run",
    "--rm",
    // The scan reads a PR's own code and needs no network (local rules, metrics off) and no privileges: give the
    // container none of either.
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    // PID 1 that forwards signals, so the job's timeout can stop a hung scan instead of leaving the container running.
    "--init",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${root}:/src:ro`,
    "-v",
    `${rulesDir}:/rules:ro`,
    "-w",
    "/src",
    cfg.semgrepImage,
    "semgrep",
    "scan",
    "--metrics=off",
    "--disable-version-check",
    "--disable-nosem",
    "--no-git-ignore",
    // No per-rule timeout: a rule that times out on a loaded runner and not on a quiet one would make the findings
    // (and so the ratchet) machine-dependent. The job's own timeout bounds a pathological run.
    "--timeout",
    "0",
    "--quiet",
    "--json",
    ...cfg.exclude.flatMap((e) => ["--exclude", e]),
    ...cfg.excludeRules.flatMap((x) => ["--exclude-rule", x.rule]),
    ...cfg.rulePacks.flatMap((p) => ["--config", `/rules/${p}`]),
    ...targets,
  ];
}

function runSemgrep(cfg: SastConfig, rulesDir: string, targets: readonly string[]): unknown {
  const r = run("docker", dockerArgs(cfg, rulesDir, targets));
  if (r.status !== 0) throw new Error(`semgrep exited ${r.status}: ${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout);
}

/**
 * Every source file under the roots must be scanned. Semgrep silently skips `vendor/`, `build/` and `test/`
 * directories by default, honours any nested `.semgrepignore`, and drops files over 1 MB. A file NAMED on the command
 * line is scanned despite the first two, so the files the directory walk missed get a second, explicit pass; anything
 * still unscanned must be named in `unscannedOk` with a reason, else the scan fails. That keeps a new ignore file,
 * a padded file or a directory named `vendor` from hiding code.
 */
function scanAll(cfg: SastConfig, rulesDir: string): unknown[] {
  const first = runSemgrep(cfg, rulesDir, cfg.scanRoots);
  const missing = missingFiles(sourceFiles(ROOT, cfg.scanRoots, cfg.exclude), scannedPaths(first));
  if (missing.length === 0) return [first];
  const second = runSemgrep(cfg, rulesDir, missing);
  const allowed = new Set(cfg.unscannedOk.map((x) => x.path));
  const still = missingFiles(missing, scannedPaths(second)).filter((p) => !allowed.has(p));
  if (still.length > 0)
    throw new Error(
      `semgrep did not scan ${still.length} source file(s), even when named: ${still.join(", ")}. Scan them, exclude them in ${CONFIG_PATH} or list them in \`unscannedOk\` with a reason`,
    );
  return [first, second];
}

function scan(cfg: SastConfig): Finding[] {
  const supplied = process.env.SAST_RULES_DIR;
  const rulesDir = supplied ?? mkdtempSync(join(tmpdir(), "sast-rules-"));
  try {
    // mkdtemp makes it 0700; the container runs as root WITHOUT capabilities (`--cap-drop ALL`), so on Linux it could
    // not read a directory only its owner may open.
    if (supplied === undefined) chmodSync(rulesDir, 0o755);
    for (const x of cfg.unscannedOk)
      if (!existsSync(join(ROOT, x.path)))
        throw new Error(
          `\`unscannedOk\` lists ${x.path}, which no longer exists: remove it from ${CONFIG_PATH}`,
        );
    fetchRules(cfg, rulesDir);
    const outs = scanAll(cfg, rulesDir);
    const failures = [...new Set(outs.flatMap(scanFailures))].sort();
    if (failures.length > 0)
      throw new Error(
        `semgrep could not analyse every file, so findings may be missing and the scan is not trusted (re-run it; if it repeats, fix the cause):\n${failures.map((f) => `  ${f}`).join("\n")}`,
      );
    // The parser lags TypeScript, so some files are read only in part. Those are a committed list that may only shrink:
    // a NEW one is code whose unparsed region nobody scanned.
    const gaps = parseGapDrift(
      [...new Set(outs.flatMap(unscannedFiles))].sort(),
      cfg.partialParse.paths,
    );
    if (gaps.added.length + gaps.stale.length > 0)
      throw new Error(
        [
          gaps.added.length > 0
            ? `semgrep read ${gaps.added.length} file(s) only in part and the config does not list them (code in the unparsed region is not scanned). Rewrite the syntax so it parses, or add them to \`partialParse\` in ${CONFIG_PATH} with a reviewed reason:\n${gaps.added.map((p) => `  ${p}`).join("\n")}`
            : "",
          gaps.stale.length > 0
            ? `${gaps.stale.length} file(s) in \`partialParse\` now parse in full or no longer exist; remove them from ${CONFIG_PATH}:\n${gaps.stale.map((p) => `  ${p}`).join("\n")}`
            : "",
        ]
          .filter((m) => m !== "")
          .join("\n"),
      );
    const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
    return outs.flatMap((out) => toFindings(out, read));
  } finally {
    if (supplied === undefined) rmSync(rulesDir, { recursive: true, force: true });
  }
}

function runScan(update: boolean): never {
  if (!update) {
    // The compare below trusts the baseline's reasons; `arch:sast` is what checks them, and a local `sast:scan` alone
    // must not report OK over an empty reason or a duplicate key.
    const bad = baselineProblems(readJson(BASELINE_PATH), (p) => existsSync(join(ROOT, p)));
    if (bad.length > 0) {
      console.error(
        `FAIL sast:scan: ${BASELINE_PATH} is not well formed:\n${bad.map((p) => `  - ${p}`).join("\n")}`,
      );
      process.exit(1);
    }
  }
  const findings = scan(loadConfig());
  if (update) {
    const next = rebaseline(findings, loadBaseline());
    writeFileSync(join(ROOT, BASELINE_PATH), `${JSON.stringify({ entries: next }, null, 2)}\n`);
    const bare = next.filter((e) => e.reason.trim() === "").length;
    console.log(
      `sast:update: ${findings.length} finding(s) in ${next.length} entries; ${bare} need a reason before arch:sast passes`,
    );
    process.exit(0);
  }
  const drift = compareToBaseline(findings, loadBaseline());
  if (drift.added.length + drift.stale.length === 0) {
    console.log(`OK sast:scan: ${findings.length} finding(s), all baselined with a reason`);
    process.exit(0);
  }
  console.error(
    `FAIL sast:scan: ${drift.added.length} new finding(s), ${drift.stale.length} stale baseline entries:`,
  );
  for (const f of drift.added) console.error(`  NEW    ${f.path}:${f.line}  ${f.rule}`);
  for (const e of drift.stale)
    console.error(
      `  STALE  ${e.path}  ${e.rule}  (baseline ${e.count}, found ${e.found}); run \`bun run sast:update\``,
    );
  process.exit(1);
}

function runOffline(): never {
  const problems: string[] = [];
  const cfg = readJson(CONFIG_PATH);
  const cfgProblems = configProblems(cfg);
  problems.push(...cfgProblems.map((p) => `${CONFIG_PATH}: ${p}`));
  const baseline = baselineProblems(readJson(BASELINE_PATH), (p) => existsSync(join(ROOT, p)));
  problems.push(...baseline.map((p) => `${BASELINE_PATH}: ${p}`));
  if (cfgProblems.length === 0) {
    // A listed path that is gone would otherwise only fail inside `sast:scan`, which is not in `arch:fitness`.
    const { partialParse, unscannedOk } = cfg as SastConfig;
    for (const p of [...partialParse.paths, ...unscannedOk.map((x) => x.path)])
      if (!existsSync(join(ROOT, p)))
        problems.push(`${CONFIG_PATH}: ${p} is listed but no longer exists, remove it`);
    problems.push(
      ...workflowProblems(
        readFileSync(join(ROOT, WORKFLOW_PATH), "utf8"),
        readFileSync(join(ROOT, ".github/workflows/deploy.yml"), "utf8"),
        readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
      ).map((p) => `${WORKFLOW_PATH}: ${p}`),
    );
  }
  if (problems.length > 0) {
    console.error(`FAIL arch:sast (CW-VM-01):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("OK arch:sast: pins, baseline reasons and workflow topology hold");
  process.exit(0);
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === "--scan" || mode === "--update") runScan(mode === "--update");
  else if (mode === undefined) runOffline();
  else {
    console.error(`unknown mode ${mode}; use --scan, --update or no argument`);
    process.exit(2);
  }
}
