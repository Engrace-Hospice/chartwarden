/**
 * Wave 12, part F, F-4 and F-5 (round-9 R9-ADV-8, R9-ADV-19, R9-CR-5, R9-CR-6): spellings of a forced push of main and of a forced
 * `git add` of a live env file that wave 11 read one way only.
 *
 *   - git takes an exact long option or an unambiguous PREFIX (`git add --fo <file>` is `--force`, `git push --mir` is `--mirror`, `--del` is
 *     `--delete`), refuses an ambiguous one (`--forc`), and the guard now resolves prefixes with git's own rule (`git-long-options.ts`);
 *   - a destination is main as `main`, `heads/main` and `refs/heads/main`; braces expand before the ref is read (`{main,x}`, `ma{in,x}`); a
 *     destination with a `*` is a pattern that names every ref it matches (`refs/heads/*:refs/heads/*` pushes main);
 *   - `git add --pathspec-from-file` reads names the guard cannot read: it asks.
 * The option names and every prefix outcome are the recording of the installed git (`fixtures/harness-db-tool-options/git/`); this file
 * proves the production tables against it and the verdicts on top. Names are built from parts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forcedAdd } from "../harness/git-add-force";
import {
  GIT_ADD_LONG_OPTIONS,
  GIT_ADD_VALUED,
  GIT_PUSH_LONG_OPTIONS,
  GIT_PUSH_VALUED,
  GIT_UPDATE_INDEX_LONG_OPTIONS,
  resolveGitLong,
} from "../harness/git-long-options";
import { pushFacts, pushFinding } from "../harness/git-push-refs";
import { classifyBash } from "../harness/patterns";
import {
  GIT_FIXTURE_DIR,
  type GitFixture,
  gitPath,
  prefixesOf,
  recordNames,
  recordPrefixes,
} from "./helpers/record-git-options";

const E = `.e${"nv"}`;
const base = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => false,
  branch: "feature/x",
};
// The classifier asks `exists` for ROOT-joined paths.
const withEnv = {
  ...base,
  exists: (file: string) => file === `/repo/${E}` || file === `/repo/apps/backend/${E}`,
};
const decide = (cmd: string, ctx: Record<string, unknown> = base): string =>
  classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{E}", E);

// ---------------------------------------------------------------------------------------------------
// The recording: production tables against the installed git's own behaviour
// ---------------------------------------------------------------------------------------------------

const fixtures: readonly GitFixture[] = readdirSync(GIT_FIXTURE_DIR)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(GIT_FIXTURE_DIR, file), "utf8")) as GitFixture);

const TABLES: Readonly<Record<string, readonly string[]>> = {
  "git push": GIT_PUSH_LONG_OPTIONS,
  "git add": GIT_ADD_LONG_OPTIONS,
  "git update-index": GIT_UPDATE_INDEX_LONG_OPTIONS,
};
const VALUED: Readonly<Record<string, ReadonlySet<string>>> = {
  "git push": GIT_PUSH_VALUED,
  "git add": GIT_ADD_VALUED,
};

describe("the git option tables are the recording of the installed git", () => {
  it("there is one fixture per command the rules read", () => {
    expect(fixtures.map((f) => f.command).sort()).toEqual(Object.keys(TABLES).sort());
  });

  for (const fixture of fixtures) {
    describe(`${fixture.command} (git ${fixture.version})`, () => {
      const table = TABLES[fixture.command] as readonly string[];

      it("the production table lists every recorded option", () => {
        const missing = fixture.options.map((o) => o.name).filter((n) => !table.includes(n));
        expect(missing).toEqual([]);
      });

      it("the production table lists nothing git does not know, but the hidden names the prefix probe found", () => {
        const recorded = new Set(fixture.options.map((o) => o.name));
        const extra = table.filter((n) => !recorded.has(n));
        const hidden =
          fixture.command === "git add" ? ["no-warn-embedded-repo", "warn-embedded-repo"] : [];
        expect(extra.sort()).toEqual(hidden);
      });

      it("every recorded prefix resolves as git resolved it (ok = exactly one option or an exact name)", () => {
        const wrong: string[] = [];
        for (const [prefix, outcome] of Object.entries(fixture.abbreviations)) {
          const read = resolveGitLong(table, prefix);
          const mine = read === "unknown" ? "unknown" : "name" in read ? "ok" : "ambiguous";
          if (mine !== outcome) wrong.push(`--${prefix}: git ${outcome}, guard ${mine}`);
        }
        expect(wrong).toEqual([]);
      });

      const valued = VALUED[fixture.command];
      if (valued !== undefined) {
        it("an option takes the next word exactly when git says so (the `no-` forms take none)", () => {
          const recorded = fixture.options
            .filter((o) => o.takesValue === true)
            .map((o) => o.name)
            .sort();
          expect([...valued].sort()).toEqual(recorded);
        });
      }
    });
  }

  it("ambiguous and unknown prefixes are told apart from unique ones", () => {
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "forc")).toEqual({
      ambiguous: ["force", "force-if-includes", "force-with-lease"],
    });
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "force")).toEqual({ name: "force" });
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "mir")).toEqual({ name: "mirror" });
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "del")).toEqual({ name: "delete" });
    expect(resolveGitLong(GIT_ADD_LONG_OPTIONS, "fo")).toEqual({ name: "force" });
    expect(resolveGitLong(GIT_ADD_LONG_OPTIONS, "f")).toEqual({ name: "force" });
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "zzz")).toBe("unknown");
    expect(resolveGitLong(GIT_PUSH_LONG_OPTIONS, "")).toBe("unknown");
  });
});

const git = gitPath();
const GIT_PINNED = fixtures.find((f) => f.command === "git push")?.version;
const installedVersion = (): string | undefined =>
  git === null
    ? undefined
    : /git version (\S+)/.exec(spawnSync(git, ["--version"], { encoding: "utf8" }).stdout)?.[1];

const installed = installedVersion();
/** Why the live re-record does not run here: always a NAMED reason (git absent, or another version than the one recorded: git's option set changes between versions). */
const GIT_SKIP_REASON =
  git === null
    ? "git is not installed on this machine"
    : installed !== GIT_PINNED
      ? `the installed git is ${installed}, the fixtures record ${GIT_PINNED}: re-record with scripts/__tests__/helpers/record-git-options.ts`
      : "";

describe.skipIf(GIT_SKIP_REASON !== "")(
  `live re-recording of the git option tables (skipped: ${GIT_SKIP_REASON || "never"})`,
  () => {
    // The names the rules read, and every prefix of them: the live part of the proof (a few dozen probes); the full recording is the script.
    const READ: Readonly<Record<string, readonly string[]>> = {
      push: [
        "force",
        "force-with-lease",
        "force-if-includes",
        "mirror",
        "all",
        "branches",
        "delete",
        "repo",
        "receive-pack",
        "exec",
        "push-option",
        "recurse-submodules",
      ],
      add: [
        "force",
        "all",
        "update",
        "pathspec-from-file",
        "chmod",
        "unified",
        "inter-hunk-context",
      ],
      "update-index": ["add", "cacheinfo", "chmod", "index-version"],
    };
    for (const command of ["push", "add", "update-index"] as const) {
      it(`git ${command}: the option names and the prefixes of the options the rules read, re-recorded live`, () => {
        const pinned = fixtures.find((f) => f.command === `git ${command}`) as GitFixture;
        expect(recordNames(git as string, command).names).toEqual(
          pinned.options.map((o) => o.name),
        );
        const live = recordPrefixes(
          git as string,
          command,
          prefixesOf(READ[command] as readonly string[]),
        );
        expect(Object.keys(live).length).toBeGreaterThan(20);
        for (const [prefix, outcome] of Object.entries(live)) {
          expect(pinned.abbreviations[prefix], `--${prefix}`).toBe(outcome);
        }
      }, 120_000);
    }
  },
);

// ---------------------------------------------------------------------------------------------------
// F-4: spellings of a forced push of main
// ---------------------------------------------------------------------------------------------------

const PUSH_MAIN_DENIED: readonly string[] = [
  "git push -f origin HEAD:heads/main",
  "git push -f origin HEAD:refs/heads/main",
  "git push -f origin +HEAD:heads/main",
  "git push origin +HEAD:refs/heads/main",
  "git push -f origin src:heads/main",
  "git push -f origin {main,x}",
  "git push -f origin ma{in,x}",
  "git push -f origin {x,main}",
  "git push --force origin {a,b}:ma{in,x}",
  "git push origin +{main,x}",
  "git push origin +ma{in,x}",
  "git push -f origin 'refs/heads/*:refs/heads/*'",
  "git push --force origin 'refs/*:refs/*'",
  "git push origin '+refs/heads/*:refs/heads/*'",
  "git push -f origin '*:*'",
  "git push -f origin 'refs/heads/m*:refs/heads/m*'",
  "git push -f origin 'HEAD:refs/heads/ma*'",
  "git push -f origin 'refs/heads/*'",
  "git push --force-w origin main",
  "git push --force-with origin main",
  "git push --force-with-lease origin main",
  "git push --force-i origin main",
  "git push --force-if-includes origin main",
  "git push --forc --force-with-lease origin main",
  "git push --rep origin -f main",
  "git push --recurse-submodules check -f origin main",
  "git push --recurse-submodules=check -f origin main",
  "git push --exec x -f origin main",
  "git push --push-opt x -f origin main",
  "git push --receive x -f origin main",
];

const PUSH_ASKED: readonly string[] = [
  "git push --mir origin",
  "git push --mirr origin",
  "git push --mirro origin",
  "git push --mirror origin",
  "git push --al -f origin",
  "git push --all -f origin",
  "git push --br -f origin",
  "git push --del origin $X",
  "git push --de origin $X",
  "git push --delete origin $X",
  "git push -f origin $X",
  "git push --forc origin feature",
  "git push --f origin feature",
  "git push --d origin feature",
  "git push --a origin feature",
  "git push origin 'refs/heads/*:refs/heads/*'",
  "git push origin 'refs/*:refs/*'",
  "git push origin '*:*'",
  "git push --de origin main",
];

describe("F-4: a push of main by any spelling is refused or asked", () => {
  it.each(PUSH_MAIN_DENIED)("%s is refused", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });
  it.each(PUSH_ASKED)("%s asks", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });

  it("an ambiguous abbreviation asks whatever follows it", () => {
    expect(decide("git push --forc origin x")).toBe("ask");
    expect(decide("git push --forc -u origin x")).toBe("ask");
  });

  it("everyday pushes stay allow", () => {
    for (const cmd of [
      "git push origin feature",
      "git push -u origin feature",
      "git push --set-upstream origin feature",
      "git push --set-up origin feature",
      "git push --force-with-lease origin feature",
      "git push --force origin feature",
      "git push -f origin feature",
      "git push --force-with-lease=feature origin feature",
      "git push --dry-run origin feature",
      "git push --dry origin feature",
      "git push --delete origin feature",
      "git push origin --delete feature",
      "git push --tags",
      "git push --tags origin",
      "git push --follow-tags origin feature",
      "git push -f origin 'refs/tags/*:refs/tags/*'",
      "git push origin 'refs/heads/feature/*:refs/heads/feature/*'",
      "git push -f origin 'refs/heads/ma*x:refs/heads/ma*x'",
      "git push origin 'refs/heads/*:refs/remotes/origin/*'",
      "git push -f origin ma{y,z}",
      "git push -f origin feature{1,2}",
      "git push origin heads/feature",
      "git push --repo origin feature",
      "git push --no-force origin feature",
      "git push -o ci.skip origin feature",
      "git push --push-option=ci.skip origin feature",
      "git push",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("pushFacts resolves the options, expands the braces and normalises nothing it cannot place", () => {
    const facts = pushFacts(["--mir", "--del", "--forc", "origin", "{a,b}:c"], (t) => t);
    expect(facts).toMatchObject({
      mirror: true,
      deleting: true,
      forced: false,
      unplacedOption: true,
      refs: ["a:c", "b:c"],
    });
    expect(pushFacts(["--force-w", "origin", "main"], (t) => t).forced).toBe(true);
    expect(pushFacts(["--no-force", "origin", "main"], (t) => t).forced).toBe(false);
    expect(pushFacts(["--repo", "origin", "main"], (t) => t).refs).toEqual(["main"]);
    expect(pushFacts(["--repo=origin", "main"], (t) => t).refs).toEqual(["main"]);
  });

  it("a valued push option takes its word (by its name or by a prefix of it), so the refs after it are the refs", () => {
    for (const option of [
      "--exec",
      "--receive-pack",
      "--push-option",
      "--recurse-submodules",
      "--exe",
      "--receive",
      "--push-o",
      "-o",
    ]) {
      expect(pushFacts([option, "x", "origin", "main"], (t) => t).refs, option).toEqual(["main"]);
    }
    for (const option of [
      "--exec=x",
      "--receive-pack=x",
      "--push-option=x",
      "--recurse-submodules=check",
    ]) {
      expect(pushFacts([option, "origin", "main"], (t) => t).refs, option).toEqual(["main"]);
    }
  });

  it("an option newer than the recorded git that starts with force is still a force (verdict)", () => {
    expect(decide("git push --force-bogus origin main")).toBe("deny");
  });

  it("an option newer than the recorded git that starts with force is still a force (facts)", () => {
    expect(pushFacts(["--forceful", "origin", "main"], (t) => t).forced).toBe(true);
  });

  it("pushFinding names main by every spelling and by a matching pattern", () => {
    const facts = (...refs: string[]) => pushFacts(["-f", "origin", ...refs], (t) => t);
    for (const ref of [
      "main",
      "heads/main",
      "refs/heads/main",
      "src:heads/main",
      "+refs/heads/main",
      "refs/heads/*:refs/heads/*",
      "*",
      "refs/*",
    ]) {
      expect(pushFinding(facts(ref), "feature/x"), ref).toBe("force-main");
    }
    for (const ref of [
      "feature",
      "refs/tags/*",
      "refs/heads/feature/*",
      "refs/remotes/*",
      "mainline",
      "refs/heads/mainline",
    ]) {
      expect(pushFinding(facts(ref), "feature/x"), ref).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// F-5: spellings of a forced git add
// ---------------------------------------------------------------------------------------------------

const ADD_DENIED: readonly string[] = [
  "git add --fo {E}",
  "git add --for {E}",
  "git add --forc {E}",
  "git add --f {E}",
  "git add --force {E}",
  "git add --fo -- {E}",
  "git add --fo apps/backend/{E}",
  "git stage --fo {E}",
  "git add -v --fo {E}",
  "git add --verbose --fo {E}",
  "git update-index --ad {E}",
  "git update-index --add {E}",
  "git update-index --ad --info {E}",
  "git update-index --add --cache 100644,0123456789abcdef0123456789abcdef01234567,{E}",
  "git update-index --ad --cacheinfo=100644,0123456789abcdef0123456789abcdef01234567,{E}",
  "git add -f --chmod +x {E}",
  "git add --fo -U 3 {E}",
  // the wave-10 read of a pathspec file that is a live env file stands, forced or not
  "git add --pathspec-from-file {E}",
  "git add -f --pathspec-from-file={E}",
];

const ADD_ASKED: readonly string[] = [
  "git add --pathspec-from-file=- <<< {E}",
  "git add -f --pathspec-from-file list.txt",
  "git add --pathspec-from-file=$LIST",
  "git add --pathspec-from-file /dev/stdin <<< {E}",
  "git add --pathspec-from=- <<< {E}",
  "git add --pathspec-f=- <<< {E}",
  "git add -f --pathspec-from-file=- <<< {E}",
  "git stage --pathspec-from-file=- <<< {E}",
  // an ambiguous prefix (git refuses it) one of whose candidates is the pathspec file option: the guard cannot place it
  "git add --pat <<< {E}",
];

describe("F-5: a forced git add by any spelling of --force is refused", () => {
  it.each(ADD_DENIED)("%s is refused", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each(ADD_ASKED)("%s asks", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("ask");
  });

  it("a forced add of a pattern that matches a live env file asks or is refused", () => {
    for (const cmd of [
      "git add -f '*env'",
      "git add --fo '*env'",
      "git add --force '.e*'",
      "git add -f 'apps/*/.env'",
    ]) {
      expect(decide(cmd, withEnv), cmd).not.toBe("allow");
    }
  });

  it("a forced add of everything asks where the tree holds a live env file, by any spelling", () => {
    for (const cmd of [
      "git add --fo --al",
      "git add --fo --all",
      "git add --fo --upd",
      "git add --force --update",
      "git add -A --fo",
    ]) {
      expect(decide(cmd, withEnv), cmd).toBe("ask");
    }
  });

  it("everyday adds stay allow", () => {
    for (const cmd of [
      "git add scripts/harness/patterns.ts",
      "git add -A",
      "git add --all",
      "git add --al",
      "git add -u",
      "git add --upd",
      "git add .",
      "git add -p",
      "git add --patch",
      "git add --verbose scripts/x.ts",
      "git add --dry-run scripts/x.ts",
      "git add -N scripts/x.ts",
      "git add --intent scripts/x.ts",
      "git add --chmod +x scripts/x.sh",
      "git add --chmod=+x scripts/x.sh",
      "git add -U 3 scripts/x.ts",
      "git add --unified 3 scripts/x.ts",
      "git add -f docs/generated/report.md",
      "git add --fo docs/generated/report.md",
      "git add --forc docs/generated/report.md",
      "git add .env.example",
      "git add --pathspec-from-file=list.txt",
      "git add --pathspec-from-file /tmp/paths",
      "git add --refresh",
      "git add --renormalize .",
      "git update-index --refresh",
      "git update-index --assume-unchanged scripts/x.ts",
      "git update-index --chmod=+x scripts/x.sh",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a forced update-index add of a pattern that reaches a live env file asks, by any spelling of --add", () => {
    for (const cmd of [
      "git update-index --add '*env'",
      "git update-index --ad '*env'",
      "git update-index --ad --info '*env'",
      "git update-index --ad --index-v 4 '*env'",
    ]) {
      expect(decide(cmd, withEnv), cmd).toBe("ask");
    }
  });

  it("update-index reads --add and --cacheinfo by prefix too", () => {
    expect(forcedAdd("update-index", ["--ad", "x"])).toEqual({ operands: ["x"] });
    expect(forcedAdd("update-index", ["--ad", "--cache", "100644,abc,y"])).toEqual({
      operands: ["y"],
    });
    expect(forcedAdd("update-index", ["--ad", "--cacheinfo=100644,abc,y"])).toEqual({
      operands: ["y"],
    });
    expect(forcedAdd("update-index", ["--ad", "--cache", "100644", "abc", "y"])).toEqual({
      operands: ["y"],
    });
    // an ambiguous prefix (git refuses it) one of whose candidates is --add is read as --add: the wider reading
    expect(forcedAdd("update-index", ["--a", "x"])).toEqual({ operands: ["x"] });
    expect(forcedAdd("update-index", ["--ag", "x"])).toBeNull();
    expect(forcedAdd("update-index", ["--no-add", "x"])).toBeNull();
  });

  it("a valued add option takes its word (by its name or by a prefix of it), so the operands after it are the operands", () => {
    for (const option of [
      "--unified",
      "--inter-hunk-context",
      "--chmod",
      "--unif",
      "--chm",
      "--inter-h",
      "--pathspec-from-file",
    ]) {
      expect(forcedAdd("add", ["--fo", option, "3", E])?.operands, option).toEqual([E]);
    }
    expect(forcedAdd("add", ["-U", "3", "--fo", E])?.operands).toEqual([E]);
    expect(forcedAdd("add", ["--fo", E, "-U", "3"])?.operands).toEqual([E]);
  });

  it("forcedAdd reads the spelling, the pathspec file and the operand a valued option must not swallow", () => {
    expect(forcedAdd("add", ["--fo", E])).toEqual({ operands: [E] });
    expect(forcedAdd("add", ["--pathspec-from-file=-"])).toMatchObject({
      pathspecSource: "-",
      unforced: true,
    });
    expect(forcedAdd("add", ["--pathspec-from-file=list.txt"])).toBeNull();
    expect(forcedAdd("add", ["-f", "--pathspec-from-file", "list.txt"])).toMatchObject({
      pathspecSource: "list.txt",
    });
    expect(forcedAdd("add", ["--fo", "--chmod", "+x", E])?.operands).toEqual([E]);
    expect(forcedAdd("add", ["--fo", "-U", "3", E])?.operands).toEqual([E]);
    expect(forcedAdd("add", ["--chmod", "+x", E])).toBeNull();
    expect(forcedAdd("add", ["--no-force", E])).toBeNull();
    expect(forcedAdd("add", ["--forces", E])).toBeNull();
  });
});
