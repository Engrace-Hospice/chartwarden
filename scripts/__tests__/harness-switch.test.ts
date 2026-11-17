/**
 * Wave 3 (fixer W3b): the harness-switch rule. A print/search/filter exemption let a switch through when the
 * "print" could write a file (`sort -o`, `uniq IN OUT`, `sed 'w F'`) or run a command (`git grep -O`, `rg --pre`).
 * Every payload under an "asks" heading answered `allow` at the base of this wave (the escaped-quote spellings
 * asked already, and are pinned here as the differential test's missing rows). `classifyBash` is pure.
 */
import { describe, expect, it } from "vitest";
import { isGitPagerOption } from "../harness/harness-switch";
import { classifyBash } from "../harness/patterns";

const ROOT = "/repo";
const HOME = "/Users/dev";
const ctx = { root: ROOT, home: HOME };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;

describe("a print or search that can write a file or run a command is not a print", () => {
  it.each([
    // The text goes into a startup file through an option, not a redirect.
    "echo 'export CODEX_HOME=/tmp/x' | sort -o ~/.zshenv",
    "echo 'export CODEX_HOME=/tmp/x' | sort --output ~/.zshenv",
    "echo 'export CODEX_HOME=/tmp/x' | sort --output=/tmp/s",
    "echo 'export CODEX_HOME=/tmp/x' | sort -uo ~/.zshenv",
    "echo 'export CODEX_HOME=/tmp/x' | sort --compress-program=sh",
    "printf 'export CW_HARNESS_FAIL_OPEN=1\\n' | uniq - ~/.zshenv",
    "printf 'export CW_HARNESS_FAIL_OPEN=1\\n' | uniq in.txt ~/.zshenv",
    "echo 'export CW_STOP_GATE=off' | sed -n 'w /Users/x/.zshenv'",
    "echo 'export CW_STOP_GATE=off' | sed -n '1w /tmp/o'",
    "echo 'x CW_STOP_GATE=off' | sed -n 's/x/y/w /tmp/o'",
    "echo 'CW_STOP_GATE=off' | sed -n 'e sh'",
    "sed -n -f x.txt CODEX_HOME=x",
    // A search or print whose own option runs a command line.
    "git grep -O'CODEX_HOME=/tmp/x codex exec hi' foo",
    "git grep -n --open-files-in-pager='CODEX_HOME=/tmp/x sh' foo",
    "git grep --open-files-in-p='CODEX_HOME=/tmp/x sh' foo",
    "git grep --open-f='CODEX_HOME=/tmp/x sh' foo",
    "git grep --open-files-in-pager='CODEX_HOME=/tmp/x sh' foo",
    "rg --pre 'CODEX_HOME=/tmp/x sh' pat f",
    "rg --pre='CODEX_HOME=/tmp/x sh' pat f",
    "ag --pager='CODEX_HOME=/tmp/x sh' pat",
    "ack --pager 'CODEX_HOME=/tmp/x sh' pat",
    "git commit --template=CODEX_HOME=/tmp/x -m x",
    "git commit -t CODEX_HOME=/tmp/x -m x",
    // `less` runs `+!cmd` and a `LESSOPEN` pipe: it is not a print.
    "less '+!CODEX_HOME=/tmp/x sh' f",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "rg -n CODEX_HOME= docs | sort | uniq -c",
    "grep -rn 'CODEX_HOME=' docs | sort -u | head -5",
    "git grep -n CODEX_HOME= -- docs | uniq",
    "git grep -c CODEX_HOME= -- docs | sort -n",
    "echo CODEX_HOME=x | cut -d= -f1",
    "echo CODEX_HOME=x | uniq -c",
    "printf '%s\\n' CODEX_HOME=x | sort -r",
    "printf '%s\\n' CODEX_HOME=x | uniq -f 1 -s 2",
    "git commit -m 'docs: say what CODEX_HOME=... does'",
    // A file name that holds an `e`, a `w` or an `o` is a file, not a sed command or an option.
    "sed -n '/CODEX_HOME=/p' docs/where.md",
    "sed -n -e '/CODEX_HOME=/p' docs/release-notes.md",
    "sed -n '/CODEX_HOME=/{p;q}' docs/x.md",
    "sed -n 's/CODEX_HOME=//p' docs/x.md",
    "sed -n 's/CODEX_HOME=/where=/p' docs/x.md",
    "sed -n 's|CODEX_HOME=|were|p' docs/x.md",
    "cat docs/x.md | rg CODEX_HOME= | tr a-z A-Z",
    "rg --glob '*.md' CODEX_HOME= docs",
    "rg --page-size 5 CODEX_HOME= docs",
  ])("keeps the print, search or filter %s allowed", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("the escaped-quote spellings the splitter used to hide a switch behind", () => {
  it.each([
    "echo \\' ; CODEX_HOME=/tmp/x codex exec hi",
    "echo it\\'s ; CLAUDE_CONFIG_DIR=/tmp/c claude -p hi",
    "echo hi # '\nCODEX_HOME=/tmp/x codex exec hi",
    'echo "a\\"b" ; CW_STOP_GATE=off claude',
    "echo hi # it's\nexport CODEX_HOME=/tmp/h",
  ])("asks before %s", (cmd) => {
    expect(d(cmd), cmd).not.toBe("allow");
  });
});

describe("a switch spelled so that no `NAME=` shows in the text, or named for the shell to set", () => {
  it.each([
    "printf -v CODEX_HOME %s /x",
    "printf -vCODEX_HOME %s /x",
    "read CODEX_HOME <<< /x",
    "read -r CW_STOP_GATE",
    "read CODEX_HO\\ME <<< /x",
    "mapfile CODEX_HOME < /etc/hosts",
    "export CODEX_HOME+=/x",
    "export CODEX_HO\\ME=/x",
    "export CODEX_HOME{,}=/x",
    "export CODEX_HO{ME,X}=/x",
    "export 'CODEX_HOME'=/x",
    "export $'\\x43ODEX_HOME=/x'",
    ': "${CODEX_HOME:=/x}"',
    "CODEX_HOME+=/x codex exec hi",
    "for CODEX_HOME in /x; do codex exec hi; done",
    "echo CODEX_HO\\ME=/x | sh",
    // The session's or the login's environment, set by name.
    "launchctl setenv CODEX_HOME /tmp/nohooks",
    "launchctl setenv CW_HARNESS_FAIL_OPEN 1",
    "tmux set-environment CODEX_HOME /tmp/x",
    "tmux set-environment -g CLAUDE_CONFIG_DIR /tmp/x",
    "tmux setenv CW_STOP_GATE off",
    "systemctl --user set-environment CODEX_HOME=/tmp/x",
    "systemctl --user set-environment CODEX_HOME /tmp/x",
    "defaults write com.apple.x CODEX_HOME /tmp/x",
    "defaults write -g CW_STOP_GATE off",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "export PATH=$PATH:/x",
    "export NODE_ENV=test",
    "read -r line < notes.txt",
    "for f in a b; do echo $f; done",
    "printf -v msg '%s' hello",
    "launchctl list",
    "tmux set-option -g mouse on",
    "tmux set-environment FOO bar",
    "defaults read com.apple.finder",
    "systemctl --user status foo",
    "export CODEX_HOME_NOTE=x",
    "export MY_HOME=/x",
  ])("keeps the everyday %s allowed", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("git's --open-files-in-pager takes any unambiguous prefix of four characters or more (wave 10, B13)", () => {
  it.each([
    "--open",
    "--open-f",
    "--open-files",
    "--open-files-in-p",
    "--open-files-in-pager",
    "--open=x",
    "-Ocat",
    "-O",
  ])("%s is the pager option", (arg) => {
    expect(isGitPagerOption(arg)).toBe(true);
  });
  it.each([
    "--ope",
    "--op",
    "--o",
    "--only-matching",
    "--no-index",
    "-n",
    "--open-files-in-pagers",
  ])("%s is not", (arg) => {
    expect(isGitPagerOption(arg)).toBe(false);
  });
});
