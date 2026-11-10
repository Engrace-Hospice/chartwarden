/**
 * Fourth review of the shell classifier (2026-11-09). Every payload under an "asks"/"denies" heading answered
 * `allow` (or took longer than the hook's 10 s) at a491dd563; each describe block pairs them with the nearby
 * everyday commands that must stay allowed. `classifyBash` is pure: `root`, `cwd` and `home` are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ROOT = "/repo";
const HOME = "/Users/dev";
const ctx = { root: ROOT, home: HOME };
const v = (cmd: string, c: object = ctx) => classifyBash(cmd, c);
const d = (cmd: string, c: object = ctx) => v(cmd, c).decision;

describe("a write after `A || cd X && W` may run where A ran, not only in X", () => {
  it.each([
    "true || cd apps && echo x > scripts/harness/pre-tool-guard.ts",
    "[ -d apps ] || cd apps && sed -i s/a/b/ compliance/controls.yaml",
    "git status || cd apps && sed -i s/a/b/ compliance/controls.yaml",
    "true || cd apps && rm -rf .",
    "true || { cd apps; } && echo x > compliance/controls.yaml",
    "true; false || cd apps && echo x > compliance/controls.yaml",
    "cd . || cd apps && echo x > compliance/controls.yaml",
    "true || pushd apps && echo x > compliance/controls.yaml",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "cd apps/backend && bun run test",
    'cd "$(git rev-parse --show-toplevel)" && rm -rf dist',
    "test -d apps || cd apps && echo x > notes.txt",
    "true || cd apps && echo x > docs/notes.md",
    "cd apps/web || cd apps && bun run build",
    "true || cd apps/backend && bun run test",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

// The hook is killed at 10 s and Claude Code then lets the call run, so a command that makes the classifier
// slow is a bypass. The 64 KB cap bounds the text, not the work: 1,300 words that each expand to 256 brace
// alternatives, judged against 16 candidate directories, are five million path resolutions.
describe("path resolution and brace expansion draw on a per-command budget", () => {
  const FAST_MS = 2000;
  const cwd = { root: ROOT, home: HOME, cwd: ROOT };
  const cds = `${Array.from({ length: 15 }, (_, i) => `cd /tmp/d${i};`).join(" ")} `;
  const eightGroups = "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}";
  const eightEmpty = "{,}{,}{,}{,}{,}{,}{,}{,}";
  const words = (count: number, braces: string): string =>
    Array.from({ length: count }, (_, i) => `w${i}${braces}`).join(" ");
  const timed = (cmd: string) => {
    const started = performance.now();
    const verdict = classifyBash(cmd, cwd);
    return { verdict, ms: performance.now() - started };
  };

  it.each([
    ["rm -f", eightGroups, 1300],
    ["rm -f", eightEmpty, 1900],
    ["touch", eightGroups, 1300],
    ["touch", eightEmpty, 1900],
    ["mv", eightGroups, 1300],
    ["mv", eightEmpty, 1900],
  ])(
    "answers `%s` over many brace words after fifteen absolute cds in under 2 s (%s x %i)",
    (prog, braces, count) => {
      const cmd = `${cds}${prog} ${words(count, braces)} /tmp/dest`;
      expect(cmd.length).toBeLessThan(64 * 1024);
      const { verdict, ms } = timed(cmd);
      expect(ms).toBeLessThan(FAST_MS);
      expect(verdict.decision).toBe("ask");
      expect(verdict.reason).toMatch(/too many/i);
      expect(verdict.reason).not.toMatch(/cannot resolve/i);
    },
    60_000,
  );

  it("asks about brace expansion alone, with no write and no cd to multiply it", () => {
    const { verdict, ms } = timed(`cat ${words(1300, eightGroups)}`);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too many/i);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("asks about plain targets alone, with no brace to multiply them", () => {
    const plain = Array.from({ length: 9000 }, (_, i) => `f${i}`).join(" ");
    const { verdict, ms } = timed(`${cds}rm -f ${plain}`);
    expect(verdict.decision).toBe("ask");
    expect(verdict.reason).toMatch(/too many/i);
    expect(ms).toBeLessThan(FAST_MS);
  });

  it("still denies a secret read that sits beside the expansion", () => {
    const cmd = `cat .env; ${cds}rm -f ${words(1300, eightGroups)}`;
    expect(timed(cmd).verdict.decision).toBe("deny");
  });

  it("spends the budget per command: the next command starts with a full one", () => {
    expect(timed(`${cds}rm -f ${words(1300, eightGroups)}`).verdict.decision).toBe("ask");
    expect(d("rm -f build/a{,.orig} build/b{1,2,3}.tmp")).toBe("allow");
  });

  it.each([
    "rm -f a{1,2,3}.tmp b{,.orig}",
    "mkdir -p src/{a,b,c}/{x,y}",
    "cd /tmp/a; cd /tmp/b; rm -f x{,.orig}",
    "cp config.{json,json.orig}",
    "echo x > out{1,2,3,4}.txt",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd, cwd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("allows a long plain file list judged from every candidate directory", () => {
    const files = Array.from({ length: 300 }, (_, i) => `dist/f${i}.js`).join(" ");
    const verdict = v(`${cds}rm -f ${files}`, cwd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

// A command over the cap is parsed by nothing, so it cannot be judged: it is refused rather than asked about,
// or padding a refused command with spaces would turn a deny into a prompt a human might approve.
describe("a command over 64 KB is refused, not asked about", () => {
  const LIMIT = 64 * 1024;
  const padded = (text: string, chars: number): string =>
    `${text}${" ".repeat(chars - text.length)}`;

  it("allows a harmless command of exactly 64 KB", () => {
    const cmd = `echo ${"a".repeat(LIMIT - 5)}`;
    expect(cmd.length).toBe(LIMIT);
    expect(v(cmd).decision).toBe("allow");
  });

  it("refuses the same command one character longer, with a reason that names the Write tool", () => {
    const verdict = v(`echo ${"a".repeat(LIMIT - 4)}`);
    expect(verdict.decision).toBe("deny");
    expect(verdict.reason).toMatch(/64 KB/);
    expect(verdict.reason).toMatch(/Write tool/);
  });

  it("still denies a secret read at exactly 64 KB, and refuses one padded past it", () => {
    expect(v(padded("cat .env", LIMIT)).decision).toBe("deny");
    expect(v(padded("cat .env", LIMIT + 1)).decision).toBe("deny");
  });

  it("refuses a protected write padded past 64 KB instead of asking about it", () => {
    expect(v(padded("echo x > compliance/controls.yaml", LIMIT)).decision).toBe("ask");
    expect(v(padded("echo x > compliance/controls.yaml", LIMIT + 1)).decision).toBe("deny");
  });
});

// `grep -r`, `rg -u` and `tar c` over the repo root read every live secret file under it. They were judged
// from the directory every `cd` would reach if each one succeeded; a `cd` that fails, or runs in a subshell or
// a pipe, leaves the command at the root. They are judged from every directory the command may be in, as
// writes are.
describe("a whole-tree read is judged from every directory the command may be running in", () => {
  const atRoot = { ...ctx, cwd: ROOT };

  it.each([
    "cd nope; grep -r KEY .",
    "cd nope || grep -r KEY .",
    "(cd apps && true); grep -r KEY .",
    "cd apps | cat; grep -r KEY .",
    "cd nope; tar c .",
    "cd apps | cat; tar c .",
    "cd nope; rg -u KEY",
    "cd nope; rg --hidden KEY",
    "true || cd apps && grep -r KEY .",
    "true || cd apps && tar c .",
    "cd apps; grep -r KEY .",
    "cd apps; grep -r KEY",
    "cd /tmp/d1; cd nope; grep -r KEY .",
  ])("asks before %s", (cmd) => expect(d(cmd, atRoot)).toBe("ask"));

  it.each([
    "cd apps/backend && grep -rn foo src",
    "cd apps/backend && grep -rn foo .",
    "cd apps/web && rg -u foo",
    "cd apps/web && tar c .",
    "grep -rn foo apps/",
    "cd apps; grep -rn foo src",
    "cd apps; rg -u foo src",
    "grep -rn foo --include=*.ts .",
    "cd apps && grep -rn foo --include=*.ts .",
    "rg foo",
    "cd /tmp && grep -r foo .",
    "tar c apps/web",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd, atRoot);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

// GNU getopt reads any unambiguous prefix of a long option as the option, so `sort --o FILE` writes FILE as
// `sort --output FILE` does. A prefix two options of the same tool share is ambiguous (the tool refuses it), so it
// writes nothing: wget's `--output-document` and `--output-file`, curl's `--output` and `--output-dir`.
describe("an abbreviated long output option writes its file as the full spelling does", () => {
  it.each([
    "sort --out=compliance/controls.yaml /tmp/x",
    "sort --o compliance/controls.yaml /tmp/x",
    "sort --ou compliance/controls.yaml /tmp/x",
    "sort --output=compliance/controls.yaml /tmp/x",
    "wget --output-d compliance/controls.yaml https://example.com/x",
    "wget --output-doc=compliance/controls.yaml https://example.com/x",
    "wget --output-document=compliance/controls.yaml https://example.com/x",
    "wget --output-f compliance/controls.yaml https://example.com/x",
    "wget --ap compliance/controls.yaml https://example.com/x",
    "base64 --out compliance/controls.yaml -i /tmp/x",
    "base64 --o compliance/controls.yaml -i /tmp/x",
    "curl --output compliance/controls.yaml https://example.com/x",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "sort -o /tmp/x /tmp/y",
    "sort --out=/tmp/x /tmp/y",
    "sort --reverse /tmp/y",
    "sort --ou /tmp/x /tmp/y",
    "wget -qO- https://example.com/x",
    "wget --output-d /tmp/x https://example.com/x",
    "wget --output compliance/controls.yaml https://example.com/x",
    "wget --output- compliance/controls.yaml https://example.com/x",
    "curl -o /tmp/x https://example.com/x",
    "curl --out compliance/controls.yaml https://example.com/x",
    "curl --output-dir compliance https://example.com/x",
    "base64 -i /tmp/x",
  ])("allows the everyday or ambiguous %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

// A harness switch (a variable that turns the guard, the ledger or the Stop gate off, or re-points the tree or the
// hook configuration an agent loads) must ask however it is spelled. Narrowing the rule to "an assignment word"
// let indirect and wrapped spellings through that the original text match (`\bNAME=` anywhere in the command)
// caught: a nested Codex without hooks could be started. The default is inverted: the name followed by `=` asks
// anywhere in a command, except when the command only searches or prints text that mentions it.
describe("a harness switch asks however it is spelled, where the original text rule asked", () => {
  /** The rule on main before the narrowing, verbatim: the name and `=` anywhere in the command text. */
  const MAIN_TEXT_RULE =
    /\b(CW_STOP_GATE|CW_AGENT_LEDGER|CW_HARNESS_FAIL_OPEN|CW_HARNESS_ROOT_FOR_TESTS|ECC_DISABLED_HOOKS|ECC_GATEGUARD|CODEX_HOME|CLAUDE_CONFIG_DIR|CLAUDE_PROJECT_DIR)=/;

  const SPELLINGS = [
    // direct
    "CW_STOP_GATE=off claude",
    "CODEX_HOME=/tmp/h codex exec hi",
    "FOO=1 CLAUDE_CONFIG_DIR=/tmp/c claude",
    "ECC_DISABLED_HOOKS= claude",
    "ECC_GATEGUARD=off claude -p hi",
    "CW_HARNESS_ROOT_FOR_TESTS=/tmp/r bun scripts/harness/pre-tool-guard.ts",
    "cd apps && CLAUDE_PROJECT_DIR=/tmp/x bun run y",
    "export CW_STOP_GATE=off",
    "declare -x CODEX_HOME=/tmp/h",
    "env CW_HARNESS_FAIL_OPEN=1 ls",
    "env -i CODEX_HOME=/tmp/x codex exec hi",
    // indirect: the assignment is built, or fed in, by something the classifier does not run
    "export $(echo CW_STOP_GATE=off)",
    "X=CODEX_HOME=/tmp/x; env $X codex exec hi",
    "env $(echo CODEX_HOME=/tmp/x) codex exec hi",
    'eval "$(echo CW_STOP_GATE=off)"',
    "xargs -I{} env CODEX_HOME={} codex < list.txt",
    // wrapped: a program that runs a command line it is given as one string
    "script -c 'CODEX_HOME=/tmp/x codex exec hi' /dev/null",
    "watch -n1 'CW_STOP_GATE=off ls'",
    "su -c 'CW_STOP_GATE=off ls' root",
    "ssh localhost 'CW_AGENT_LEDGER=off ls'",
    "taskset 1 env CW_STOP_GATE=off ls",
    "timeout 5 env CODEX_HOME=/tmp/x codex exec hi",
    "nohup env CODEX_HOME=/tmp/x codex &",
    "exec env CW_STOP_GATE=off ls",
    "command env CLAUDE_CONFIG_DIR=/tmp/c claude",
    "find . -maxdepth 0 -exec env CODEX_HOME=/tmp/x codex exec hi ;",
    "sudo -E CLAUDE_PROJECT_DIR=/tmp bun x.ts",
    // nested
    "bash -c 'CLAUDE_CONFIG_DIR=/tmp/c claude'",
    'sh -c "export CODEX_HOME=/tmp/h; codex"',
    "echo $(CODEX_HOME=/tmp/h codex)",
    // written down for the next shell, or mentioned in a command that is not a search or a print
    "echo 'export CODEX_HOME=/tmp/h' >> ~/.zshrc",
    "printf 'CODEX_HOME=/tmp/h\\n' > ~/.zshenv",
    "echo CODEX_HOME=/tmp/h | tee -a ~/.zshrc",
    "sed -i 's/^/CODEX_HOME=\\/tmp\\/h /' run.sh",
    "git config alias.x '!CODEX_HOME=/tmp/h codex'",
  ];

  it("lists at least 25 spellings, each one the original text rule asked about", () => {
    expect(SPELLINGS.length).toBeGreaterThanOrEqual(25);
    for (const cmd of SPELLINGS) expect(MAIN_TEXT_RULE.test(cmd), cmd).toBe(true);
  });

  it.each(SPELLINGS)("asks before %s", (cmd) => {
    const verdict = v(cmd);
    expect(["ask", "deny"], `${cmd} -> ${verdict.decision}`).toContain(verdict.decision);
  });

  // The closures the narrowing was made for: a name inside the arguments of a search or print tool is text.
  it.each([
    "rg CLAUDE_PROJECT_DIR= scripts",
    "grep -rn 'CODEX_HOME=' docs",
    "git log -S'CLAUDE_PROJECT_DIR=' --oneline",
    "echo CODEX_HOME=x",
    "grep -n CW_HARNESS_FAIL_OPEN= docs/compliance/AGENT_HARNESS.md",
    "git grep -n 'CODEX_HOME=' -- docs",
    "git show HEAD:docs/x.md | rg 'CODEX_HOME='",
    "cat scripts/harness/pre-tool-guard.ts | rg 'CLAUDE_PROJECT_DIR=' | head -5",
    "printf '%s\\n' CODEX_HOME=x",
    "sed -n '/CODEX_HOME=/p' docs/x.md",
    'git commit -m "docs: say what CODEX_HOME=... does"',
  ])("keeps the search or print %s allowed, as the text rule's false positive", (cmd) => {
    expect(MAIN_TEXT_RULE.test(cmd), `${cmd} is a text-rule false positive`).toBe(true);
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("does not let a search or print carry the mention anywhere else", () => {
    for (const cmd of [
      "rg foo > ~/.zshrc; echo CODEX_HOME=x >> ~/.zshrc",
      "echo CODEX_HOME=x | sh",
      "echo CODEX_HOME=x | bash -s",
      "CODEX_HOME=x rg foo docs",
    ]) {
      expect(d(cmd), cmd).not.toBe("allow");
    }
  });
});

// Any construct that can move the shell and that the guard cannot model leaves the directory UNKNOWN, and a
// relative write from an unknown directory asks. Every payload below really writes into scripts/harness in a
// real shell (`harness/p` is `scripts/harness/p` once the shell is in `scripts`), yet answered allow.
describe("a directory change the guard cannot model leaves the directory unknown", () => {
  it.each([
    // a cd inside something that runs in this shell
    "eval 'cd scripts'; echo x > harness/p",
    "eval \"$(printf 'cd scripts')\"; echo x > harness/p",
    "case 1 in 1) cd scripts;; esac; echo x > harness/p",
    "f() { cd scripts; }; f && echo x > harness/p",
    "function f { cd scripts; }; f && echo x > harness/p",
    "cd() { builtin cd scripts; }; cd && echo x > harness/p",
    "source ./go-to-scripts.sh; echo x > harness/p",
    ". ./go-to-scripts.sh && echo x > harness/p",
    // a spelling of cd the program name hides
    "\\cd scripts && echo x > harness/p",
    "c\\d scripts && echo x > harness/p",
    // the directory stack
    "cd scripts && pushd /tmp && pushd && echo x > harness/p",
    "cd scripts && pushd /tmp && pushd +1 && echo x > harness/p",
    "cd scripts && pushd /tmp && pushd -0 && echo x > harness/p",
    "pushd -n /tmp; echo x > notes.txt && pushd scripts && popd && echo x > harness/p",
    // CDPATH makes `cd harness` land somewhere else
    "CDPATH=/repo/scripts cd harness && echo x > p",
    "export CDPATH=/repo/scripts; cd harness && echo x > p",
    // env and sudo move the command they run
    "env -C scripts/harness tee p < /dev/null",
    "env --chdir=scripts sh -c 'echo x > harness/p'",
    "env --chdir scripts tee harness/p < /dev/null",
    "sudo -D scripts/harness tee p < /dev/null",
    // a shell the command starts, with a cd in it
    "find . -maxdepth 0 -exec sh -c 'cd scripts && echo x > harness/p' \\;",
    "find . -maxdepth 0 -exec bash -c 'cd scripts && echo x > harness/p' ;",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "cd apps/backend && bun run test",
    "cd apps/web && echo x > notes.txt",
    "builtin cd apps/web && bun run build",
    "for f in a b; do echo $f; done; echo x > notes.txt",
    "if [ -d dist ]; then rm -rf dist; fi",
    "while read l; do echo $l; done < list.txt; echo x > notes.txt",
    "case $1 in a) echo a;; esac; echo x > notes.txt",
    "f() { echo hi; }; f && echo x > notes.txt",
    "pushd apps/web && bun run build && popd",
    "env -C apps/web bun run build",
    "env NODE_ENV=test bun run test",
    "env --chdir=apps/web bun run build",
    "sudo -u root ls",
    "sudo -D apps/web ls",
    "find . -name '*.ts' -exec grep -l foo {} \\;",
    "find . -maxdepth 0 -exec sh -c 'cd apps && ls' \\;",
    'eval "$(ssh-agent -s)"',
    "source .venv/bin/activate && pytest",
    "\\rm -f dist/x.js",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("reads a program name written with a backslash as the program", () => {
    expect(d("\\rm -rf scripts/harness")).toBe("ask");
    expect(d("\\tee scripts/harness/x < /tmp/in")).toBe("ask");
  });
});

// A bare file name is a secret only when a file of that name exists where the command runs, so `cat server.key` is
// judged against the files that are there. That test ran against the START directory only: after a `cd` into the
// directory that holds the key, `cat server.key` found nothing and was allowed.
describe("a secret file is found in the directory a cd left the command in", () => {
  const FILES = new Set([
    `${ROOT}/deploy/production/tls/server.key`,
    `${ROOT}/apps/backend/id_rsa`,
    `${ROOT}/apps/backend/package.json`,
  ]);
  const onDisk = {
    root: ROOT,
    home: HOME,
    cwd: ROOT,
    exists: (p: string) => FILES.has(p.startsWith("/") ? p : `${ROOT}/${p}`),
  };

  it.each([
    "cd deploy/production/tls && cat server.key",
    "cd deploy/production/tls; cat server.key",
    "(cd deploy/production/tls && cat server.key)",
    "cd deploy && cd production && cd tls && cat server.key",
    "cd deploy/production/tls || true; cat server.key",
    "cd apps/backend && cat id_rsa",
    "cd apps/backend && head -1 id_rsa",
    "cd deploy/production/tls && base64 server.key",
    "cd deploy/production/tls && xxd server.key",
    "cd deploy/production/tls && cp server.key /tmp/k",
    "cd deploy/production/tls && grep -n BEGIN server.key",
    "cd deploy/production/tls && cat < server.key",
    'cd "$KEYDIR" && cat server.key',
    "cd $(dirname $KEY) && cat server.key",
  ])("denies %s", (cmd) => expect(d(cmd, onDisk)).toBe("deny"));

  it.each([
    "cat server.key",
    "cd apps/web && cat server.key",
    "cd deploy/production/tls && ls",
    "cd deploy/production/tls; ls -la",
    "cd apps/backend && cat package.json",
    "cd apps/backend; cat package.json",
    "cd apps/backend && grep -rn 'server.key' src",
    'cd "$KEYDIR" && cat package.json',
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd, onDisk);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
