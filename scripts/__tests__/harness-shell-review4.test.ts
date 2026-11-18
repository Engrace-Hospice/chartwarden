/**
 * Fourth review of the shell classifier (2026-11-09). Every payload under an "asks"/"denies" heading answered
 * `allow` (or took longer than the hook's 10 s) at a491dd563; each describe block pairs them with the nearby
 * everyday commands that must stay allowed. `classifyBash` is pure: `root`, `cwd` and `home` are injected.
 */
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { FULL_BUDGET, type Measured, measure, netMs } from "./helpers/work-counters";

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
  const cwd = { root: ROOT, home: HOME, cwd: ROOT };
  const cds = `${Array.from({ length: 15 }, (_, i) => `cd /tmp/d${i};`).join(" ")} `;
  const eightGroups = "{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}";
  const eightEmpty = "{,}{,}{,}{,}{,}{,}{,}{,}";
  const words = (count: number, braces: string): string =>
    Array.from({ length: count }, (_, i) => `w${i}${braces}`).join(" ");
  // Wave 12 (G-1, R9-COMP-9): these rows asserted `< 5000` ms (2 s in their titles) and so passed a 100x slowdown.
  // What stops the work is the BUDGET, so the counts say so: the brace and resolution budgets are drawn down to their
  // cap and no further (a resolution budget is overdrawn by the one resolution that finds it empty), and every
  // character is judged once. The clock is a safety net at twice the worst loaded run (`work-counters.ts`).
  const OVERDRAW = 1;
  // The caps themselves, spelled out (not read from the budget): a change to one is a decision about how much work a
  // command may cost, so it fails here, in `harness-timing-wave12.test.ts` and in the work-budget tests together.
  const BRACE_CAP = 4096;
  const RESOLUTION_CAP = 16_384;

  it.each([
    ["rm -f", eightGroups, 1300, 35.7],
    ["rm -f", eightEmpty, 1900, 44.3],
    ["touch", eightGroups, 1300, 35.7],
    ["touch", eightEmpty, 1900, 50.7],
    ["mv", eightGroups, 1300, 44.5],
    ["mv", eightEmpty, 1900, 47.7],
  ])(
    "answers `%s` over many brace words after fifteen absolute cds within its budget (%s x %i)",
    (prog, braces, count, worstMs) => {
      const cmd = `${cds}${prog} ${words(count, braces)} /tmp/dest`;
      expect(cmd.length).toBeLessThan(64 * 1024);
      const m = measure(cmd, cwd);
      expect(m.spent.braces).toBe(BRACE_CAP); // expansion stopped at the cap, not before and not after
      expect(m.spent.resolutions).toBeLessThanOrEqual(RESOLUTION_CAP + OVERDRAW);
      expect(m.spent.chars).toBeLessThanOrEqual(cmd.length);
      expect(m.ms).toBeLessThan(netMs(worstMs));
      expect(m.verdict.decision).toBe("ask");
      expect(m.verdict.reason).toMatch(/too many/i);
      expect(m.verdict.reason).not.toMatch(/cannot resolve/i);
    },
    60_000,
  );

  it("asks about brace expansion alone, with no write and no cd to multiply it", () => {
    const m = measure(`cat ${words(1300, eightGroups)}`, cwd);
    expect(m.verdict.decision).toBe("ask");
    expect(m.verdict.reason).toMatch(/too many/i);
    expect(m.spent.braces).toBe(BRACE_CAP);
    expect(m.spent.resolutions).toBeLessThanOrEqual(1); // one `cat` operand resolved: nothing multiplies the braces
    expect(m.ms).toBeLessThan(netMs(37.6));
  });

  it("asks about plain targets alone, with no brace to multiply them", () => {
    const plain = Array.from({ length: 9000 }, (_, i) => `f${i}`).join(" ");
    const m = measure(`${cds}rm -f ${plain}`, cwd);
    expect(m.verdict.decision).toBe("ask");
    expect(m.verdict.reason).toMatch(/too many/i);
    expect(m.spent.braces).toBe(0);
    // 9,000 targets from 16 candidate directories would be 144,000 resolutions: the budget stops it at its cap.
    expect(m.spent.resolutions).toBe(RESOLUTION_CAP + OVERDRAW);
    expect(m.ms).toBeLessThan(netMs(57.2));
  });

  it("still denies a secret read that sits beside the expansion", () => {
    const cmd = `cat .env; ${cds}rm -f ${words(1300, eightGroups)}`;
    const m = measure(cmd, cwd);
    expect(m.verdict.decision).toBe("deny");
    expect(m.spent.braces).toBe(BRACE_CAP);
    expect(m.ms).toBeLessThan(netMs(39.4));
  });

  it("spends the budget per command: the next command starts with a full one", () => {
    expect(measure(`${cds}rm -f ${words(1300, eightGroups)}`, cwd).verdict.decision).toBe("ask");
    expect(d("rm -f build/a{,.orig} build/b{1,2,3}.tmp")).toBe("allow");
    const next = measure("rm -f build/a{,.orig} build/b{1,2,3}.tmp", cwd);
    // Five alternatives, each expanded at most twice: nothing of the last command's spending is carried over.
    expect(next.exhausted).toBe(false);
    expect(next.spent.braces).toBeLessThanOrEqual(2 * 5);
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
    // the escaped-quote spellings the first splitter read as an open quote (code review M4)
    "echo \\' ; CODEX_HOME=/tmp/x codex exec hi",
    "echo it\\'s ; CLAUDE_CONFIG_DIR=/tmp/c claude -p hi",
    "echo hi # '\nCODEX_HOME=/tmp/x codex exec hi",
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

  it("lists at least 35 spellings, each one the original text rule asked about", () => {
    expect(SPELLINGS.length).toBeGreaterThanOrEqual(35);
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

// `~` and `~/…` name the home directory; every other tilde prefix (`~user`, `~+`, `~-`, `~1`) is a directory the
// guard cannot place, and a `HOME` the command sets moves `~` itself. With HOME unset, `~` is still the user's
// home (the account database knows it).
describe("a tilde form the guard cannot place, and a spoofed HOME, do not hide a write onto the repo", () => {
  const user = { root: "/Users/fabrice/Apps/x2/wardenx4", home: "/Users/fabrice" };

  it.each([
    "echo x > ~fabrice/Apps/x2/wardenx4/scripts/harness/p",
    "echo x > ~+/scripts/harness/p",
    "echo x > ~-/scripts/harness/p",
    "echo x > ~1/scripts/harness/p",
    "cd ~fabrice/Apps/x2/wardenx4 && echo x > scripts/harness/p",
    "cd ~+ && echo x > scripts/harness/p",
    "cd scripts && cd /tmp && cd ~- && echo x > harness/p",
    "HOME=/Users/fabrice/Apps/x2/wardenx4 sh -c 'echo x > ~/scripts/harness/p'",
    "HOME=/Users/fabrice/Apps/x2/wardenx4 cd && echo x > scripts/harness/p",
    "export HOME=/Users/fabrice/Apps/x2/wardenx4; echo x > ~/scripts/harness/p",
    "env HOME=/Users/fabrice/Apps/x2/wardenx4 tee ~/scripts/harness/p < /dev/null",
  ])("asks before %s", (cmd) => expect(d(cmd, user)).toBe("ask"));

  it.each([
    "echo x > ~/notes.txt",
    "cd ~ && ls",
    "cd ~/Apps/other && echo x > notes.txt",
    "echo $HOME",
    "HOME_DIR=/tmp ls",
    "XDG_CONFIG_HOME=/tmp/x bun test",
    "rg HOME= scripts",
    "cat ~/.zshrc | head -3",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd, user);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("falls back to the account's home directory when HOME is unset or empty", () => {
    const real = homedir();
    const root = `${real}/x/repo`;
    const saved = process.env.HOME;
    try {
      for (const value of [undefined, ""]) {
        if (value === undefined) Reflect.deleteProperty(process.env, "HOME");
        else process.env.HOME = value;
        const verdict = classifyBash("echo x > ~/x/repo/scripts/harness/p", { root, home: "" });
        expect(verdict.decision, `HOME=${JSON.stringify(value)}`).toBe("ask");
      }
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = saved;
    }
  });
});

// The 64 KB cap and the 300-call budget bound counts, not work: a command nested N deep in `$( )` holds nearly the
// whole command at every level, and the old listing judged EVERY level from every level. Two payloads built that
// way took 7.5 s and 25 s at 8a9eb5a, past the hook's 10 s, and the guard then lets the call run; a secret read
// after the payload is the call that ran.
describe("nested commands are judged once each, within a text budget and a time limit", () => {
  const CAP = 64 * 1024;
  const atRoot = { ...ctx, cwd: ROOT, exists: () => false };
  // Wave 12 (G-1, R9-COMP-9): the bound was 2 s, then 5 s. The text budget is what stops a nested payload, so the
  // count says so: the judged characters are drawn down past the cap by at most the one level that overdraws it, and
  // the judging halts. The clock is a safety net at twice the worst loaded run (`work-counters.ts`).
  /** The judged-text budget is checked after a level is charged, so one level (the whole text) can overdraw it. */
  const stoppedByTheTextBudget = (m: Measured, cmd: string): void => {
    expect(m.halted).toBe(true);
    expect(m.spent.chars).toBeGreaterThan(FULL_BUDGET.chars);
    expect(m.spent.chars).toBeLessThanOrEqual(FULL_BUDGET.chars + cmd.length);
  };
  const timed = (cmd: string) => measure(cmd, atRoot);
  /** `$(` x levels, one huge word with sixteen brace groups, `)` x levels, then a secret read. */
  const nestedBraces = (levels: number): string => {
    const tail = "\ncat .env";
    const room = CAP - tail.length - levels * 3 - 20;
    return `${"$(".repeat(levels)}cat ${"y".repeat(room - 120)}${"{a,b}".repeat(16)}${")".repeat(levels)}${tail}`;
  };
  const nestedSegments = (): string =>
    `${"$(".repeat(31)}${"a;".repeat(30_000)}${")".repeat(31)}\ncat .env`;

  it.each([
    [5, 28.2],
    [7, 28.5],
    [9, 27.4],
    [20, 38.5],
    [30, 30.8],
  ])("denies the secret read after a payload nested %i deep, fast", (n, worstMs) => {
    const cmd = nestedBraces(n);
    const m = timed(cmd);
    expect(m.verdict.decision).toBe("deny");
    stoppedByTheTextBudget(m, cmd);
    expect(m.ms).toBeLessThan(netMs(worstMs));
  });

  it("denies the secret read after 31 nested substitutions of 30,000 segments each, fast", () => {
    const cmd = nestedSegments();
    const m = timed(cmd);
    expect(m.verdict.decision).toBe("deny");
    stoppedByTheTextBudget(m, cmd);
    expect(m.ms).toBeLessThan(netMs(20.4));
  });

  it("asks, not allows, when nothing in the payload is itself refused", () => {
    const cheap = `${"$(".repeat(31)}${"a;".repeat(30_000)}${")".repeat(31)}`;
    const m = timed(cheap);
    expect(m.verdict.decision).toBe("ask");
    expect(m.verdict.reason).toMatch(/too many|too big/i);
    stoppedByTheTextBudget(m, cheap);
    expect(m.ms).toBeLessThan(netMs(19.8));
  });

  // Cheap per character (one long word), so only the text budget, not the clock, can stop it: each level judges the
  // whole text again, 6 x 60 KB is past 256 KB, 4 x 60 KB is not.
  it("budgets the text judged across nested commands: 3 levels of 60 KB pass, 5 do not", () => {
    const nested = (levels: number): string =>
      `${"$(".repeat(levels)}echo ${"y".repeat(60_000)}${")".repeat(levels)}`;
    const within = timed(nested(3));
    expect(within.verdict.decision).toBe("allow");
    expect(within.halted).toBe(false);
    expect(within.spent.chars).toBeLessThanOrEqual(FULL_BUDGET.chars); // four passes over 60 KB: under 256 KB
    expect(within.ms).toBeLessThan(netMs(21.4));
    const cmd = nested(5);
    const over = timed(cmd);
    expect(over.verdict.decision).toBe("ask");
    expect(over.verdict.reason).toMatch(/too many|too big/i);
    stoppedByTheTextBudget(over, cmd);
    expect(over.ms).toBeLessThan(netMs(18.3));
  });

  it("asks once its time limit has passed, and judges normally within it", () => {
    expect(classifyBash("echo hi", { ...atRoot, judgeTimeLimitMs: -1 }).decision).toBe("ask");
    expect(classifyBash("echo hi", { ...atRoot, judgeTimeLimitMs: 5000 }).decision).toBe("allow");
    expect(classifyBash("cat .env", { ...atRoot, judgeTimeLimitMs: 5000 }).decision).toBe("deny");
  });

  it("still finds a read nested several levels down, and a write after a cd inside a substitution", () => {
    expect(d("echo $(echo $(echo $(echo $(echo $(cat .env)))))")).toBe("deny");
    expect(d(`echo ${"$(echo ".repeat(7)}cat .env${")".repeat(7)}`)).toBe("deny");
    expect(d("echo $(cd scripts && echo $(echo x > harness/p))")).toBe("ask");
    expect(d("echo $(echo `cat .env`)")).toBe("deny");
  });

  it.each([
    "echo $(git rev-parse --show-toplevel)/x",
    "x=$(echo $(date))",
    'bash -c "echo $(cat package.json)"',
    "echo $(echo $(echo $(echo $(echo $(echo hi)))))",
    "diff <(sort a.txt) <(sort b.txt)",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

// Writers that name a directory or a file inside an option or an action rather than as an operand: wget `-P`,
// curl `--output-dir`, find's `-fprint` family, sed's `w` command and flag, `git format-patch -o`.
describe("a directory or file named inside an option or an action is a write target", () => {
  it.each([
    "wget -P compliance https://example.com/x",
    "wget --directory-prefix=scripts/harness https://example.com/x",
    "wget --directory-prefix .claude/rules https://example.com/x",
    "wget --directory scripts/harness https://example.com/x",
    "curl -o x.txt --output-dir compliance https://example.com/x",
    "curl --output-dir scripts/harness -O https://example.com/x",
    "curl -sSO --output-dir .githooks https://example.com/x",
    "cd compliance && curl -O https://example.com/x",
    "find . -fprint compliance/controls.yaml",
    "find . -name '*.ts' -fprintf scripts/harness/x '%p\\n'",
    "find . -fls .githooks/pre-commit",
    "find . -fprint0 compliance/x",
    "sed -n 'w compliance/controls.yaml' /tmp/x",
    "sed 's/a/b/w scripts/harness/pre-tool-guard.ts' /tmp/x",
    "sed -n '1,3w .githooks/pre-commit' /tmp/x",
    "sed -e 'w CLAUDE.md' /tmp/x",
    "sed --expression='w compliance/controls.yaml' /tmp/x",
    "sed -n -e '/x/{' -e 'w compliance/c.yaml' -e '}' /tmp/x",
    "git format-patch -o compliance HEAD~1",
    "git format-patch --output-directory scripts/harness -1",
    "git format-patch --output-directory=.githooks -1",
    "git format-patch -1 -o .claude/rules",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));

  it.each([
    "wget -P /tmp/dl https://example.com/x",
    "wget -P downloads https://example.com/x",
    "wget --directory-prefix=/tmp/dl https://example.com/x",
    "curl -o x.txt --output-dir /tmp https://example.com/x",
    "curl -O https://example.com/x",
    "curl --output-dir /tmp -O https://example.com/x",
    "curl --output-dir compliance https://example.com/x",
    "find . -fprint /tmp/files.txt",
    "find . -name '*.ts' -fprint out.txt",
    "find . -name '*.ts' -print",
    "sed -n 'w /tmp/out.txt' /tmp/x",
    "sed 's/a/b/w out.txt' /tmp/x",
    "sed -n '/foo/p' file.txt",
    "sed 's/ w x/y/' file.txt",
    "sed -n 'p' compliance/AGENT_HARNESS.md",
    "sed -n '1,5p' scripts/harness/patterns.ts",
    "git format-patch -o /tmp/patches HEAD~1",
    "git format-patch -o patches -1",
    "git format-patch -1",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});
