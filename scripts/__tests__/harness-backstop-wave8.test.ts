/**
 * Wave 8, T2 (round-6 CR6-1, ADV6-2, CR6-4, CR6-7, ADV6-5): the backstop for writers nobody modelled, rewritten.
 * Wave 7 exempted a program wholesale when it was on a hand list (READ_ONLY, MODELLED), but plutil, 7z, tree, awk, the vim
 * family, `python -m json.tool IN OUT`, docker, go, gcc, `time -o` … write a file their command line names in a way no model
 * reads. Now: a READER is exempt only until a WRITE FLAG appears; a MODELLED program's positional operands are the model's
 * (its own rules judge them) but a protected path attached to an option is not; everything else asks for any word that names a
 * protected path. Words are placed like every other operand (braces, variables, ancestors, wildcards), and the names inside
 * an inline program, an editor command or a SQL string are read for a program that is neither a reader nor modelled.
 * `classifyBash` is pure: root, home, cwd and "exists" are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { MODELLED, READERS, backstopPlan, localFunctionNames } from "../harness/protected-operands";
import { shellQuote } from "../harness/wrappers";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string, c: object = ctx) => classifyBash(cmd, c).decision;
const G = "scripts/harness/hard-deadline.ts";
const S = ".claude/settings.json";
const ENV_FILE = [".", "env"].join("");

describe("ADV6-2 / CR6-1: programs that write a file their command line names, which the wave-7 lists exempted", () => {
  it.each([
    // awk: the file arrives as ARGV[1] / FILENAME, or -i inplace
    `awk 'BEGIN{printf "{}" > ARGV[1]}' ${S}`,
    `awk '{print > FILENAME}' ${S}`,
    `awk '{print | "cat > x"}' ${S}`,
    `awk 'BEGIN{system("true")}' ${S}`,
    `gawk -i inplace '{print}' ${S}`,
    `gawk -iinplace '{print}' ${S}`,
    `gawk --include=inplace '{print}' CLAUDE.md`,
    `gawk --include inplace '{print}' CLAUDE.md`,
    `mawk -f prog.awk ${S}`,
    // python -m
    `python3 -m json.tool /tmp/a.json ${S}`,
    `python3 -m json.tool /tmp/a.json ${G}`,
    `python -m zipfile -c ${S} /tmp/x`,
    // plutil: the in-place verbs
    `plutil -replace hooks -json '{}' ${S}`,
    `plutil -remove hooks ${S}`,
    `plutil -insert k -string v ${S}`,
    `plutil -extract hooks json ${S}`,
    `plutil -convert json ${S}`,
    `plutil -convert json -o ${S} /tmp/x.plist`,
    // the vim family, ed and ex: a command in an argument, or on standard input
    `vim -es -c ':w! ${S}' -c ':q' /tmp/x`,
    `vi -c 'w! ${S}' -c q`,
    `nvim --headless -c 'w! CLAUDE.md' -c q`,
    `vim -es '+w!CODEOWNERS' +q`,
    `vim -es '+w!CODEOWNERS'`,
    `ed -s /tmp/x <<< 'w ${S}'`,
    `printf 'w CODEOWNERS\\nq\\n' | ed -s /tmp/x`,
    `ex -s /tmp/x <<< 'w! CODEOWNERS'`,
    `echo 'w! CLAUDE.md' | ex -s /tmp/x`,
    // output options of tools that read
    `tree -o ${S}`,
    `7z a CODEOWNERS /tmp/a`,
    `7za a ${S} /tmp/a`,
    `7z x /tmp/a.7z -o${G}`,
    `pax -w -f CLAUDE.md /tmp/a`,
    `cpio -o -O CLAUDE.md`,
    `objcopy /tmp/a CODEOWNERS`,
    `strip ${G}`,
    `ar rcs ${G} x.o`,
    `jest --outputFile=${S}`,
    `jest --coverageDirectory=scripts/harness`,
    `mocha --reporter-options output=${S}`,
    `playwright screenshot https://example.com ${S}`,
    `playwright test --output=scripts/harness`,
    `markdownlint -o CLAUDE.md x.md`,
    `markdownlint --fix CLAUDE.md`,
    `gitleaks detect -r ${S}`,
    `gitleaks detect --report-path ${S}`,
    `time -o CLAUDE.md true`,
    `time --output=CLAUDE.md true`,
    `time -ofoo true`.replace("foo", "CLAUDE.md"),
    `strace -o ${S} true`,
    `docker build -o scripts/harness .`,
    `docker build --output=type=local,dest=scripts/harness .`.replace(
      "type=local,dest=scripts/harness",
      "scripts/harness",
    ),
    `docker buildx build --output scripts/harness .`,
    `docker compose cp c:/x ${S}`,
    `docker container cp c:/x ${S}`,
    `docker image save -o scripts/harness/x img`,
    `docker context export c ${S}`,
    `docker build --iidfile ${S} .`,
    `go test -coverprofile=CLAUDE.md`,
    `go build -o=CLAUDE.md`,
    `go build -o ${G}`,
    `gcc -MD -MF CLAUDE.md -c x.c`,
    `gcc -o ${G} x.c`,
    `rustc --out-dir .claude/hooks x.rs`,
    `deno bundle x.ts CLAUDE.md`,
    `deno compile -o CLAUDE.md x.ts`,
    `bun test --reporter-outfile=${S}`,
    `node --redirect-warnings=${S} x.js`,
    `node --cpu-prof-dir=scripts/harness x.js`,
    `node --heap-prof-dir scripts/harness x.js`,
    `node --report-dir=scripts/harness x.js`,
    `node --trace-event-file-pattern=${S} x.js`,
    `sed -e 'e cp /tmp/x ${S}' /tmp/y`,
    `sed '1e cp /tmp/x ${S}' /tmp/y`,
    `sed 's/x/y/e' ${S}`,
    // package managers pointed at a directory
    `npm install --prefix scripts/harness x`,
    `pnpm -C scripts/harness install`,
    `yarn --cwd scripts/harness add x`,
    `bun add --cwd scripts/harness x`,
    `bunx playwright test --output=scripts/harness`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("the same programs still read a protected file without a write flag", () => {
    for (const cmd of [
      `awk '{print $1}' ${S}`,
      `awk -F, '$2 > 5 {print $1}' ${S}`,
      `python3 -m json.tool ${S}`,
      `python3 -m json.tool < ${S}`,
      `plutil -p ${S}`,
      `plutil -lint ${S}`,
      `vim -R ${S}`.replace("vim -R", "cat"),
      `tree scripts/harness`,
      `tree -L 2 scripts/harness`,
      `jest scripts/__tests__/x.test.ts`,
      `playwright test e2e/x.spec.ts`,
      `markdownlint CLAUDE.md`,
      `gitleaks detect --redact -v`,
      `time true`,
      `time -p true`,
      `docker compose -f deploy/production/compose.yml config --quiet`,
      `docker build -t x .`,
      `bun test scripts/__tests__/x.test.ts`,
      `node ${G}`,
      `sed -n '1,5p' ${S}`,
      `sed 's/a/b/e' /tmp/x`.replace("/e", "/g"),
      `7z l /tmp/a.7z`,
      `npm install`,
      `pnpm install`,
      `yarn add x`,
      `bun add x`,
      `go version`,
    ]) {
      expect(d(cmd), cmd).toBe("allow");
    }
  });
});

describe("CR6-4: the backstop places an operand like every other rule", () => {
  it.each([
    "sd a b scripts/{harness,x}/y.ts",
    "sd a b {scripts/harness,docs}/x.ts",
    "sd a b .claude/{hooks,x}/y",
    "sd a b {docs,x}/CODEOWNERS",
    "sd a b {x,.github}/CODEOWNERS",
    "bunx biome check --write scripts/{harness,x}",
    "D=scripts; sd a b $D/harness/x.ts",
    "D=.claude; sd a b $D/settings.json",
    "export D=scripts; sd a b $D/harness/x.ts",
    "sd a b scripts",
    "sd a b scripts/",
    "sd a b ./scripts",
    "sd a b .claude",
    "sd a b scripts/h*/x.ts",
    "sd a b scripts/**/*.ts",
    "sd a b 'scripts/**/*.ts'",
    "bunx prettier --write 'scripts/**/*.ts'",
    "bunx prettier --write scripts/harness/*.ts",
    "bunx biome check --write .",
    "bunx biome check --write scripts",
    "bunx biome check --fix .",
    "bunx eslint --fix .",
    "bunx prettier --write .",
    "bunx prettier -w .",
    "shfmt -w .",
    "shfmt -w scripts",
    "gofmt -w .",
    "gofmt -w scripts/harness",
    "prettier --write *.md",
    "somenewtool --out=scripts",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("a variable the command sets twice, or computes, stays unseen", () => {
    expect(d("sd a b $D/harness/x.ts")).toBe("allow");
    expect(d("sd a b $(printf scripts)/harness/x.ts")).toBe("allow");
  });

  it("the repo root counts only when a write flag says the program writes in place", () => {
    // wave-8 corpus: `ecc-agentshield scan --path .` and `live.sh "$PWD" x.live.test.ts` read; they are not asked
    expect(d("npx --yes ecc-agentshield scan --path . --format text")).toBe("allow");
    expect(d(`./live.sh "$PWD" a.live.test.ts`, { ...ctx, cwd: "/repo" })).toBe("allow");
    expect(d("somenewtool .")).toBe("allow");
    expect(d("somenewtool /repo")).toBe("allow");
    expect(d("somenewtool --write .")).toBe("ask");
    expect(d("somenewtool -w .")).toBe("ask");
    // a directory that holds protected files but is not the root always counts
    expect(d("somenewtool scripts")).toBe("ask");
  });

  it("a wildcard with no slash is a pattern for the tool, unless a write flag says it writes", () => {
    expect(d("somenewtool --include='*.ts' x")).toBe("allow");
    expect(d("redis-cli keys '*'")).toBe("allow");
    expect(d("somenewtool '*.md'")).toBe("allow");
    expect(d("bunx prettier --write '*.md'")).toBe("ask");
  });

  it("a wildcard whose directory part can match a protected directory asks for a file that may not exist yet", () => {
    expect(d("sd a b scripts/h?rness/new-file.ts")).toBe("ask");
    expect(d("sd a b compliance/*.yaml")).toBe("ask");
    expect(d("sd a b apps/*/src/x.ts")).toBe("allow");
  });
});

describe("ADV6-5: the names inside an inline program, an editor command or a SQL string", () => {
  it.each([
    `duckdb -c "select * from read_csv('${ENV_FILE}')"`,
    `Rscript -e 'cat(readLines("${ENV_FILE}"))'`,
    `julia -e 'print(read("${ENV_FILE}", String))'`,
    `emacs --batch --eval '(insert-file-contents "${ENV_FILE}")'`,
    `expect -c 'spawn cat ${ENV_FILE}'`,
    `tclsh <<< 'puts [read [open ${ENV_FILE}]]'`,
    `mongosh --nodb --eval 'print(cat("${ENV_FILE}"))'`,
    `somenewtool "load deploy/production/backend.env now"`,
  ])("%s is refused as a secret read", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    `somenewtool "write to ${S} please"`,
    `somenewtool --message="fix ${G}"`,
    `Rscript -e 'writeLines("x", "${S}")'`,
    `tclsh <<< 'set f [open ${S} w]'`,
    `emacs --batch --eval '(write-region "x" nil "CLAUDE.md")'`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("a SQL column, a property chain and a variable path are not file names", () => {
    expect(d(`somenewtool "select r.key, e.event_key from role r"`)).toBe("allow");
    expect(d(`somenewtool "console.log(process.env.NODE_ENV)"`)).toBe("allow");
    expect(d(`somenewtool "load $OUT/restore.env now"`)).toBe("allow");
    expect(d(`somenewtool "select * from t where name = 'a b'"`)).toBe("allow");
  });

  it("prose handed to a modelled program or a reader is not read (a commit message, a PR body, a grep pattern)", () => {
    expect(d(`git commit -m "document ${ENV_FILE} handling in ${G}"`)).toBe("allow");
    expect(d(`gh pr create --body "see ${G} and ${S}"`)).toBe("allow");
    expect(d(`grep "scripts/harness" README.md`)).toBe("allow");
  });

  it("a function the command defines is called with prose as often as with code", () => {
    const text = `mk(){ gh issue create --title "$1" --body "$2"; }; mk "Decision" "see deploy/production notes"`;
    expect(d(text)).toBe("allow");
    expect(d(`function mk { echo; }; mk "see deploy/production notes"`)).toBe("allow");
    expect(d(`mk "see deploy/production notes"`)).toBe("ask");
    expect([...localFunctionNames(text)]).toEqual(["mk"]);
    expect([...localFunctionNames("function f { x; }\ng() { y; }\nh () { z; }")].sort()).toEqual([
      "f",
      "g",
      "h",
    ]);
    expect(localFunctionNames("echo hi").size).toBe(0);
  });
});

describe("(e) read-only tools stop asking, with the write flags that matter excluded", () => {
  it.each([
    "cloc scripts/harness",
    "tokei scripts/harness",
    "scc scripts/harness",
    "bunx cspell scripts/harness/x.ts",
    "bunx depcruise --config architecture/.dependency-cruiser.cjs scripts/harness",
    "dependency-cruiser --config architecture/.dependency-cruiser.cjs scripts",
    "shfmt -d scripts/harness/x.sh",
    "shfmt -l .githooks/pre-commit",
    "ruff check scripts/harness",
    "ruff format --check scripts/harness",
    "eza -la scripts/harness",
    "lsof scripts/harness/x",
    "open scripts/harness/x",
    "make -C scripts/harness",
    "semgrep scripts/harness",
    "semgrep --config p/secrets scripts/harness",
    "trivy fs scripts/harness",
    "code scripts/harness/x.ts",
    "redis-cli --scan --pattern '*'",
  ])("%s allows", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it.each([
    `cloc --out=${S} scripts`,
    `cloc --report-file=${S} scripts`,
    `scc -o ${S} scripts`,
    `bunx cspell --cache-location ${G} x`,
    `depcruise -f ${S} scripts`,
    `depcruise --output-to ${S} scripts`,
    `shfmt -w .githooks/pre-commit`,
    `ruff format scripts/harness`,
    `ruff check --fix scripts/harness`,
    `ruff check --output-file ${S} .`,
    `semgrep --autofix scripts/harness`,
    `semgrep -o ${S} scripts`,
    `semgrep --sarif-output=${S} scripts`,
    `trivy fs -o ${S} .`,
    `redis-cli --rdb ${S}`,
    `less -o ${S} x`,
    `code --user-data-dir scripts/harness`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
});

describe("sed: only a command that executes makes it a writer (GNU `e`, `s///e`)", () => {
  it.each([
    "sed -ne 's/a/b/e' x",
    "sed --expression='1e id' x",
    "sed -e 's/a/b/' -e '2e id' x",
    "sed 'y/abc/xyz/;1e cp' x",
    "sed '$e echo hi' x",
    "sed -e '/foo/e' x",
    "sed 's/a\\/b/c/e' x",
  ])("%s executes", (cmd) => {
    expect(d(`${cmd} ${S}`), cmd).toBe("ask");
  });

  it.each([
    "sed -n p",
    "sed -n '1,5p'",
    "sed 's/a/b/g'",
    "sed 's/e//'",
    "sed 's/.*/e/'",
    "sed '/^e/d'",
    "sed 's#a#b#; s/c/d/'",
    "sed -n '/start/,/end/p'",
    "sed 's/^| Form .*/| Form | PARTIAL; safety incident BLOCKED; claims |/'",
    "sed 'a hello; e echo'",
    "sed 's/a/b/w out.txt'",
    "sed 's/x\\/a/ec/'",
  ])("%s does not", (cmd) => {
    expect(d(`${cmd} ${S}`), cmd).toBe("allow");
  });

  it("a file name with an e in it is not a script", () => {
    expect(d("sed -n p scripts/harness/engine.ts")).toBe("allow");
    expect(d("sed -n 1,5p scripts/harness/engine.ts")).toBe("allow");
    expect(d("sed -e p scripts/harness/engine.ts")).toBe("allow");
    // read as a script this operand would be an `s` command with the flag `e`
    expect(d(`sed -e p sxxxe ${S}`)).toBe("allow");
  });
});

describe("wrappers that write: time -o, strace -o", () => {
  it("the file a wrapper's option writes is judged like a redirect target", () => {
    expect(d(`time -o ${S} true`)).toBe("ask");
    expect(d(`time --output ${S} true`)).toBe("ask");
    expect(d(`time -o /tmp/t.txt true`)).toBe("allow");
    expect(d(`time -f '%e' -o /tmp/t.txt true`)).toBe("allow");
    expect(d(`strace -o ${S} true`)).toBe("ask");
    expect(d(`strace -o /tmp/s.txt true`)).toBe("allow");
    expect(d(`time -o /tmp/t.txt cp /tmp/x ${S}`)).toBe("ask");
  });
});

describe("-o=FILE: the Go and clap spelling of an output option", () => {
  it("is read as the file name", () => {
    expect(d(`sort -o=${S} x`)).toBe("ask");
    expect(d(`curl -o=${S} http://localhost/x`)).toBe("ask");
    expect(d(`sort -o=/tmp/x y`)).toBe("allow");
  });
});

describe("the plan: what the backstop reads for each kind of program", () => {
  it("a reader with no write flag has no plan; with one it reads every word", () => {
    expect(backstopPlan("cat", [G])).toBeNull();
    expect(backstopPlan("tree", ["-o", S])?.words).toEqual(["-o".length > 0 ? S : S]);
    expect(backstopPlan("tree", ["scripts"])).toBeNull();
  });

  it("an awk program in a file cannot be read, so awk is watched like a writer", () => {
    expect(backstopPlan("awk", ["-f", "p.awk", S])).not.toBeNull();
    expect(backstopPlan("awk", ["{print $1}", S])).toBeNull();
  });

  it("a modelled program is read only where a path is attached to an option", () => {
    expect(backstopPlan("cp", [G, "/tmp/x"])?.words).toEqual([]);
    expect(backstopPlan("cp", ["--foo=a/b", G])?.words).toEqual(["a/b"]);
    expect(backstopPlan("git", ["diff", G])?.words).toEqual([]);
  });

  it("an unknown program is read in full, with the names inside its whitespace words", () => {
    const plan = backstopPlan("tool", ["a b.txt", G, "-x", 'x "p/q.ts" y']);
    expect(plan?.words).toEqual([G]);
    expect(plan?.names).toEqual(["b.txt", "p/q.ts"]);
  });

  it("a program name that is an option, or empty, has no plan", () => {
    expect(backstopPlan("", [G])).toBeNull();
    expect(backstopPlan("-x", [G])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (f) The consistency test: every entry of the two tables is proved in the direction that matters.
// ---------------------------------------------------------------------------------------------------------------------

/** The command line for `name` followed by `words`, each quoted as the shell must read it back. */
const line = (name: string, words: readonly string[]): string =>
  [name, ...words.map(shellQuote)].join(" ");

/** A shape of each MODELLED program that writes the protected file P. Adding a name to MODELLED needs a row here. */
const WRITE_SHAPE: ReadonlyMap<string, string> = new Map([
  ["cp", `cp /tmp/x ${S}`],
  ["mv", `mv /tmp/x ${S}`],
  ["ln", `ln -sf /tmp/x ${S}`],
  ["install", `install /tmp/x ${S}`],
  ["rsync", `rsync /tmp/x ${S}`],
  ["scp", `scp /tmp/x ${S}`],
  ["ssh", `ssh -o UserKnownHostsFile=${S} localhost true`],
  ["ditto", `ditto /tmp/x ${S}`],
  ["rm", `rm ${S}`],
  ["unlink", `unlink ${S}`],
  ["shred", `shred ${S}`],
  ["rmdir", `rmdir scripts/harness`],
  ["tee", `tee ${S}`],
  ["touch", `touch ${S}`],
  ["truncate", `truncate -s 0 ${S}`],
  ["mkdir", `mkdir -p scripts/harness/x`],
  ["ed", `ed ${S}`],
  ["ex", `ex ${S}`],
  ["vi", `vi ${S}`],
  ["vim", `vim ${S}`],
  ["nvim", `nvim ${S}`],
  ["nano", `nano ${S}`],
  ["chmod", `chmod 600 ${S}`],
  ["chown", `chown me ${S}`],
  ["chgrp", `chgrp staff ${S}`],
  ["setfacl", `setfacl -m u:me:r ${S}`],
  ["chflags", `chflags nouchg ${S}`],
  ["xattr", `xattr -c ${S}`],
  ["perl", `perl -pi -e 's/a/b/' ${S}`],
  ["dd", `dd if=/tmp/x of=${S}`],
  ["git", `git checkout -- ${S}`],
  ["patch", `patch ${S} /tmp/x.diff`],
  ["tar", `tar cf ${S} x`],
  ["gtar", `gtar cf ${S} x`],
  ["bsdtar", `bsdtar -cf ${S} x`],
  ["zip", `zip ${S} x`],
  ["unzip", `unzip -d scripts/harness /tmp/x.zip`],
  ["gzip", `gzip ${S}`],
  ["gunzip", `gunzip ${S}.gz`],
  ["bzip2", `bzip2 ${S}`],
  ["bunzip2", `bunzip2 ${S}.bz2`],
  ["xz", `xz ${S}`],
  ["unxz", `unxz ${S}.xz`],
  ["lzma", `lzma ${S}`],
  ["unlzma", `unlzma ${S}.lzma`],
  ["zstd", `zstd ${S}`],
  ["unzstd", `unzstd ${S}.zst`],
  ["compress", `compress ${S}`],
  ["uncompress", `uncompress ${S}.Z`],
  ["sponge", `sponge ${S}`],
  ["yq", `yq -i '.a = 1' ${S}`],
  ["pg_dump", `pg_dump -f ${S} db`],
  ["pg_dumpall", `pg_dumpall -f ${S}`],
  ["pg_restore", `pg_restore -f ${S} x.dump`],
  ["psql", `psql -o ${S} -c 'select 1'`],
  ["pgcli", `pgcli -c '\\o ${S}'`],
  ["sqlite3", `sqlite3 ${S}`],
  ["mysql", `mysql -e 'tee ${S}'`],
  ["mariadb", `mariadb -e 'tee ${S}'`],
  ["mycli", `mycli -e 'tee ${S}'`],
  ["script", `script ${S}`],
  ["base64", `base64 -o ${S} /tmp/x`],
  ["openssl", `openssl rand -out ${S} 8`],
  ["gpg", `gpg -o ${S} -d /tmp/x`],
  ["gpg2", `gpg2 -o ${S} -d /tmp/x`],
  ["curl", `curl -o ${S} http://localhost/x`],
  ["wget", `wget -O ${S} http://localhost/x`],
  ["split", `split /tmp/x ${S}`],
  ["csplit", `csplit -f ${S} /tmp/x 1`],
  ["shuf", `shuf -o ${S} /tmp/x`],
  ["pandoc", `pandoc -o ${S} /tmp/x.md`],
  ["gh", `gh release download -D scripts/harness`],
]);

describe("(f) every MODELLED name asks for a protected path in at least one write shape", () => {
  it("the shape table names exactly the MODELLED programs", () => {
    expect([...WRITE_SHAPE.keys()].sort()).toEqual([...MODELLED].sort());
  });

  it.each([...WRITE_SHAPE])("%s: %s", (name, cmd) => {
    expect(cmd.startsWith(`${name} `), cmd).toBe(true);
    expect(d(cmd), cmd).toBe("ask");
  });
});

/** Programs whose name is syntax or a shell builtin: `{ P` is not a command line, so they have no read shape to try. */
const SYNTAX = new Set([
  "for",
  "while",
  "until",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "in",
  "{",
  "}",
  "!",
  "(",
  "[",
  "[[",
  "exec",
  "nohup",
  "set",
  "export",
  "cd",
  "pushd",
  "popd",
  "source",
  ".",
]);

describe("(f) every READER allows a protected operand in a read shape, and asks with a write flag where it has one", () => {
  const readers = [...READERS].filter(([name]) => !SYNTAX.has(name));

  it("the table is not empty and every write flag has an example", () => {
    expect(readers.length).toBeGreaterThan(80);
    for (const [name, flags] of READERS) {
      if (flags !== null) expect(flags.example.length, name).toBeGreaterThan(0);
    }
  });

  // awk takes its program first, ack its pattern: with only a path they are not a read of it.
  const READ_SHAPE: ReadonlyMap<string, readonly string[]> = new Map([
    ["awk", ["{print}", G]],
    ["gawk", ["{print}", G]],
    ["mawk", ["{print}", G]],
    ["ack", ["pattern", G]],
  ]);

  it.each(readers)("%s reads a protected file", (name) => {
    const cmd = line(name, READ_SHAPE.get(name) ?? [G]);
    expect(d(cmd), cmd).toBe("allow");
  });

  it.each(readers.filter(([, flags]) => flags !== null))(
    "%s asks with a write flag",
    (name, flags) => {
      const cmd = line(name, [...(flags?.example ?? []), G]);
      expect(d(cmd), cmd).toBe("ask");
    },
  );

  it("a write flag on a reader is what the plan keys on (the same words without it have no plan)", () => {
    for (const [name, flags] of readers) {
      if (flags === null) continue;
      expect(backstopPlan(name, [...flags.example, G]), name).not.toBeNull();
      expect(backstopPlan(name, [G]), name).toBeNull();
    }
  });
});
