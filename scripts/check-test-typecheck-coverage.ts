/**
 * Test-tree typecheck coverage gate (`bun run arch:test-typecheck`, in `arch:fitness`).
 *
 * EVERY TEST FILE VITEST RUNS MUST BE IN A TYPECHECK PROGRAM. It was not. Every workspace
 * `tsconfig.json` in this repo — all four apps and all 51 packages — sets `"include": ["src"]`, and
 * the convention here is that a suite lives in a sibling `__tests__/` directory. So `tsc -b` compiled
 * the source of every project and **674 test files outside `src/` were compiled by nothing** —
 * 346 of them in `apps/backend/__tests__` alone. Only `scripts/` (whose own tsconfig
 * globs every TypeScript file under it) and `e2e/` were covered.
 *
 * WHY THAT IS A DEFECT AND NOT A PREFERENCE. A test file is the only executable statement of what a
 * production signature is supposed to be. When it is not typechecked, changing a signature does not
 * break its callers — it silently makes them WRONG, and a suite that no longer matches the code it
 * covers still reports green for whatever it happens to do instead. F-096 (#209) is the worked
 * example: it made `PatientRouteService.list`'s caseload-narrowing argument REQUIRED, a two-argument
 * caller survived in `auth.live.test.ts`, and a full `bun run typecheck && bun run test` was green on
 * both. Invisible on two axes at once — never compiled, and a live suite self-skips without a
 * database. The census-narrowing control shipped with its own proof passing an undefined scope.
 *
 * WHAT THIS GATE CHECKS. Not that the configs exist — that they RESOLVE to the same file set the
 * runner does. It imports `vitest.config.ts` itself (rather than restating its globs, which is the
 * copy-of-a-list shape F-094/F-095 were about), expands each project's include/exclude over the
 * tracked tree, and requires every file to appear in the `fileNames` of at least one typecheck
 * program — the `tsc -b` project graph reached from the root `tsconfig.json` references, plus
 * `tsconfig.tests.json` and `tsconfig.tests.dom.json`.
 *
 * AND IT CHECKS THE SPLIT, which is the half a coverage count would miss. `tsconfig.tests.dom.json` is
 * the only program carrying `lib: DOM` and `jsx`. A jsdom suite compiled without them cannot pass, so
 * that direction reports itself; the direction that does NOT is a node suite drifting INTO the DOM
 * program, which compiles happily and then throws at runtime on a `document` jsdom was never asked
 * for. So the two programs must be DISJOINT, and every jsdom-project file must be in the DOM one.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two programs this gate exists to keep honest. They are split by what a suite NEEDS, not by which
 * vitest project runs it: `tsconfig.tests.dom.json` is the only one carrying `lib: DOM` and `jsx`, and
 * it covers the jsdom suites plus every suite in a frontend workspace (those reach React components
 * whether or not the file itself renders one). Everything else compiles without a browser in scope.
 */
const TEST_PROGRAMS = ["tsconfig.tests.json", "tsconfig.tests.dom.json"] as const;
const DOM_PROGRAM = "tsconfig.tests.dom.json";

export interface CoverageViolation {
  readonly kind: "unchecked" | "wrong-program" | "empty-program" | "config-error";
  readonly where: string;
  readonly detail: string;
}

/**
 * Translate one glob to a RegExp. The vocabulary is deliberately the small one vitest's config
 * actually uses — `**` across separators, `*` within a segment, `?`, and literals. Anything richer
 * (brace expansion, extglob) would be silently mis-parsed here, so it is REFUSED rather than
 * approximated: a matcher that quietly under-matches would report a file as unchecked when it is
 * covered, or worse, as covered when it is not.
 */
export function globToRegExp(glob: string): RegExp {
  if (/[{}()!+@]/.test(glob)) {
    throw new Error(
      `unsupported glob syntax in ${JSON.stringify(glob)} — extend globToRegExp first`,
    );
  }
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more path segments; a trailing/bare `**` matches the rest.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += (ch as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

const matchesAny = (path: string, globs: readonly string[]): boolean =>
  globs.some((g) => globToRegExp(g).test(path));

/** Repo-relative, POSIX-separated paths of every tracked file — the universe both sides resolve over. */
export function trackedFiles(
  run = (cmd: string, args: string[]) => {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  },
): readonly string[] {
  return run("git", ["ls-files"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export interface VitestProject {
  readonly name: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/** Read the runner's OWN project definitions, so this gate cannot drift from what vitest runs. */
export async function vitestProjects(): Promise<readonly VitestProject[]> {
  const mod = (await import(join(REPO_ROOT, "vitest.config.ts"))) as {
    default?: { test?: { projects?: unknown } };
  };
  const projects = mod.default?.test?.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error(
      "vitest.config.ts declares no `test.projects` — this gate reads them to know what runs",
    );
  }
  return projects.map((p) => {
    const t = (p as { test?: { name?: string; include?: string[]; exclude?: string[] } }).test;
    if (!t?.name || !Array.isArray(t.include) || !Array.isArray(t.exclude)) {
      throw new Error(
        "a vitest project is missing name/include/exclude — cannot resolve what it runs",
      );
    }
    return { name: t.name, include: t.include, exclude: t.exclude };
  });
}

/** Files a vitest project would collect, resolved over the tracked tree. */
export function projectFiles(
  project: VitestProject,
  tracked: readonly string[],
): readonly string[] {
  return tracked.filter((f) => matchesAny(f, project.include) && !matchesAny(f, project.exclude));
}

/** Parse one tsconfig and return the repo-relative file set of the program it defines. */
export function programFiles(configPath: string): readonly string[] {
  const abs = resolve(REPO_ROOT, configPath);
  const parsed = ts.parseJsonConfigFileContent(
    ts.parseConfigFileTextToJson(abs, readFileSync(abs, "utf8")).config,
    ts.sys,
    dirname(abs),
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `${configPath}: ${parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`,
    );
  }
  return parsed.fileNames.map((f) => relative(REPO_ROOT, f).split("\\").join("/"));
}

/** Every tsconfig reachable from the root's `references` graph — i.e. exactly what `tsc -b` builds. */
export function buildGraphConfigs(rootConfig = "tsconfig.json"): readonly string[] {
  const seen = new Set<string>();
  const walk = (configPath: string): void => {
    const abs = resolve(REPO_ROOT, configPath);
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (seen.has(rel)) return;
    seen.add(rel);
    const json = ts.parseConfigFileTextToJson(abs, readFileSync(abs, "utf8")).config as {
      references?: { path: string }[];
    };
    for (const ref of json.references ?? []) {
      const refPath = resolve(dirname(abs), ref.path);
      walk(ts.sys.directoryExists(refPath) ? join(refPath, "tsconfig.json") : refPath);
    }
  };
  walk(rootConfig);
  return [...seen];
}

export function findCoverageViolations(
  vitest: readonly VitestProject[],
  tracked: readonly string[],
): readonly CoverageViolation[] {
  const out: CoverageViolation[] = [];

  const programOf = new Map<string, Set<string>>();
  for (const config of [...buildGraphConfigs(), ...TEST_PROGRAMS]) {
    try {
      programOf.set(config, new Set(programFiles(config)));
    } catch (err) {
      out.push({ kind: "config-error", where: config, detail: (err as Error).message });
    }
  }

  for (const config of TEST_PROGRAMS) {
    if ((programOf.get(config)?.size ?? 0) === 0) {
      out.push({
        kind: "empty-program",
        where: config,
        detail: "resolves to no files — an empty program typechecks nothing and passes",
      });
    }
  }

  const inTestProgram = (file: string): readonly string[] =>
    TEST_PROGRAMS.filter((c) => programOf.get(c)?.has(file) === true);

  for (const project of vitest) {
    for (const file of projectFiles(project, tracked)) {
      const testPrograms = inTestProgram(file);
      const workspacePrograms = [...programOf.entries()]
        .filter(
          ([c, files]) => !(TEST_PROGRAMS as readonly string[]).includes(c) && files.has(file),
        )
        .map(([c]) => c);

      if (testPrograms.length === 0 && workspacePrograms.length === 0) {
        out.push({
          kind: "unchecked",
          where: file,
          detail: `vitest project "${project.name}" runs it and no tsconfig compiles it`,
        });
        continue;
      }
      // Disjointness is the half a coverage count would miss. The DOM program's whole difference is
      // `lib: DOM` + `jsx`; a file compiled by BOTH is compiled once with a browser in scope, which is
      // the permissive answer and the one that decides. `tsc` would report the strict failure too, so
      // this is not about the verdict — it is about the two include-sets meaning what they say.
      if (testPrograms.length > 1) {
        out.push({
          kind: "wrong-program",
          where: file,
          detail: `compiled by both ${testPrograms.join(" and ")} — the DOM-typed program must not overlap the node one`,
        });
      }
      // A jsdom suite compiled without `lib: DOM` cannot pass, so this rule can only ever fire on a
      // config edit that moved one out of the DOM program — which is exactly when it should.
      if (
        project.name === "dom" &&
        !(testPrograms as readonly string[]).includes(DOM_PROGRAM) &&
        workspacePrograms.length === 0
      ) {
        out.push({
          kind: "wrong-program",
          where: file,
          detail: `vitest runs it under jsdom but ${DOM_PROGRAM} does not compile it`,
        });
      }
    }
  }
  return out;
}

if (import.meta.main) {
  const vitest = await vitestProjects();
  const tracked = trackedFiles();
  const violations = findCoverageViolations(vitest, tracked);
  const counted = vitest.reduce((n, p) => n + projectFiles(p, tracked).length, 0);
  if (violations.length === 0) {
    console.log(
      `✓ test-typecheck: all ${counted} file(s) across ${vitest.length} vitest project(s) are in a typecheck program`,
    );
    process.exit(0);
  }
  console.error(`✗ test-typecheck: ${violations.length} violation(s)\n`);
  for (const v of violations.slice(0, 40)) {
    console.error(`  [${v.kind}] ${v.where} — ${v.detail}`);
  }
  if (violations.length > 40) console.error(`  … and ${violations.length - 40} more`);
  console.error(`
  Every workspace tsconfig is \`"include": ["src"]\`, so a suite in a sibling \`__tests__/\` directory
  is compiled by NOTHING unless one of the two test programs picks it up:

    tsconfig.tests.json      — the vitest "node" project
    tsconfig.tests.dom.json  — the vitest "dom" project (the only one with \`lib: DOM\` + \`jsx\`)

  An unchecked suite is not a missing nicety: it is the only executable statement of what a production
  signature is, and when it does not compile, a signature change makes it WRONG rather than broken —
  green, and no longer testing what it says it tests (F-096/#209).`);
  process.exit(1);
}
