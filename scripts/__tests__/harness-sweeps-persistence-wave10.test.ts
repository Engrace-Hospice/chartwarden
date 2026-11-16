/**
 * Wave 10, B12 (round-7 R7-ADV-19, R7-ADV-20, R7-ADV-22).
 * - A file read line by line as names or code (`file -f F`, `wc --files0-from=F`, `git add --pathspec-from-file=F`, `sed -f F`)
 *   prints the lines it cannot use in an error: a live env file named there is a read.
 * - Tree sweeps that reach a live env file: `find . -exec sh -c ... {}`, `find . -exec tar rf ... {}`, `cpio -pdm D <<< .`,
 *   `7z a OUT .`, `hdiutil create -srcfolder . OUT`.
 * - Persistence by other tools than `cp` and `launchctl`: `defaults write`/`plutil` on a launch job's plist, `crontab`, `at`,
 *   `osascript ... do script`.
 */
import { describe, expect, it } from "vitest";
import { listedFiles } from "../harness/file-list-options";
import { classifyBash } from "../harness/patterns";
import { persistenceReason } from "../harness/persistence-commands";

const ENV = [".", "env"].join("");
const PORTAL = `apps/portal/${ENV}`;
const base = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${PORTAL}` || p === `/repo/${ENV}`,
  liveEnvFiles: () => [PORTAL, ENV],
};
const decide = (cmd: string): string => classifyBash(cmd, base).decision;

describe("a file read as a list of names or as code is a read of that file", () => {
  it.each([
    `file -f ${ENV}`,
    `file -f${ENV}`,
    `file --files-from ${ENV}`,
    `file --files-from=${ENV}`,
    `file --files-fr=${ENV}`,
    `file -b -f ${PORTAL}`,
    `wc --files0-from=${ENV}`,
    `wc --files0-from ${ENV}`,
    `du --files0-from=${ENV}`,
    `du -sh --files0-from=${PORTAL}`,
    `sort --files0-from=${ENV}`,
    `git add --pathspec-from-file=${ENV}`,
    `git rm --pathspec-from-file ${ENV}`,
    `git commit --pathspec-from-file=${PORTAL} -m x`,
    `rsync --files-from=${ENV} . /tmp/x`,
    `sed -f ${ENV} /tmp/x`,
    `sed --file=${ENV} /tmp/x`,
    `awk -f ${ENV} /tmp/x`,
    `sudo file -f ${ENV}`,
    `bash -c 'wc --files0-from=${ENV}'`,
  ])("%s is refused", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "file -f /tmp/names.txt",
    "file README.md",
    "file -b scripts/harness/patterns.ts",
    "wc --files0-from=/tmp/names0",
    "wc -l scripts/harness/patterns.ts",
    "du -sh scripts",
    "sort --files0-from=/tmp/n",
    "git add --pathspec-from-file=/tmp/paths",
    "git add scripts/harness/patterns.ts",
    `file ${ENV}.example`,
    "sed -f /tmp/script.sed /tmp/x",
    "sed -n 1p /tmp/x",
    "awk -f /tmp/p.awk /tmp/x",
    "rsync --files-from=/tmp/list . /tmp/x",
  ])("%s keeps allowing", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("the reader names the files, by every spelling of the option", () => {
    expect(listedFiles("file", ["-f", "a"])).toEqual(["a"]);
    expect(listedFiles("file", ["-fa"])).toEqual(["a"]);
    expect(listedFiles("file", ["--files-from", "a"])).toEqual(["a"]);
    expect(listedFiles("wc", ["--files0-from=a"])).toEqual(["a"]);
    expect(listedFiles("wc", ["--files0", "a"])).toEqual(["a"]);
    expect(listedFiles("git", ["add", "--pathspec-from-file=a"])).toEqual(["a"]);
    expect(listedFiles("cat", ["-f", "a"])).toEqual([]);
  });
});

describe("tree sweeps that carry every file out", () => {
  it.each([
    "find . -type f -exec sh -c 'cat \"$1\"' _ {} \\;",
    "find . -type f -exec bash -c 'cat \"$1\"' _ {} +",
    "find . -type f -exec tar rf /tmp/o.tar {} +",
    "find . -type f -exec tar -rf /tmp/o.tar {} \\;",
    "find . -type f -exec zip /tmp/o.zip {} +",
    "find . -type f -exec 7z a /tmp/o.7z {} \\;",
    "find . -type f -exec cp {} /tmp/out \\;",
    "find . -type f -exec rsync -a {} /tmp/out \\;",
    "find . -exec gzip -c {} \\;",
    "find apps -type f -exec cpio -o {} \\;",
    "cpio -pdm /tmp/o <<< .",
    "echo . | cpio -pdm /tmp/o",
    "cpio -pdm /tmp/o <<< 'apps'",
    "7z a /tmp/o.7z .",
    "7za a -mx=9 /tmp/o.7z apps",
    "7zz u /tmp/o.7z .",
    "7z a -p'secret' -r /tmp/o.7z .",
    "hdiutil create -srcfolder . /tmp/o",
    "hdiutil create -srcfolder apps -format UDZO /tmp/o.dmg",
    "hdiutil create -srcdir . /tmp/o",
  ])("%s asks", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });

  it.each([
    "find lib -type f -exec sh -c 'cat \"$1\"' _ {} \\;",
    "find lib -type f -exec tar rf /tmp/o.tar {} +",
    "7z a /tmp/o.7z lib",
    "hdiutil create -srcfolder lib /tmp/o",
    "cpio -pdm /tmp/o <<< lib",
    "echo lib | cpio -pdm /tmp/o",
  ])("%s allows over a tree with no live env file in it", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it.each([
    "find . -name '*.ts' -exec tar rf /tmp/o.tar {} +",
    "find lib -type f -exec cp {} /tmp/out \\;",
    "7z a /tmp/o.7z lib/harness",
    "7z l /tmp/o.7z",
    "hdiutil create -srcfolder lib /tmp/o",
    "hdiutil attach /tmp/o.dmg",
    "find . -exec sh -c 'echo {}' \\;",
    "find . -name '*.tmp' -exec sh -c 'rm -f {}' \\;",
    "find . -maxdepth 0 -exec sh -c 'cd apps && ls' \\;",
    "echo . | cat",
    "cpio -t < /tmp/o.cpio",
  ])("%s keeps allowing", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("persistence by other tools than cp and launchctl", () => {
  it.each([
    "defaults write ~/Library/LaunchAgents/x ProgramArguments -array /tmp/x",
    "defaults write ~/Library/LaunchAgents/com.x.plist RunAtLoad -bool true",
    "defaults write /Library/LaunchDaemons/x Label x",
    "defaults import ~/Library/LaunchAgents/x /tmp/x.plist",
    "plutil -insert ProgramArguments -array ~/Library/LaunchAgents/x.plist",
    "plutil -replace Label -string x LaunchAgents/x.plist",
    "plutil -create xml1 ~/Library/LaunchAgents/x.plist",
    "plutil -convert xml1 /Library/LaunchDaemons/x.plist",
    "crontab /tmp/x",
    "crontab -",
    "echo '* * * * * id' | crontab -",
    "crontab -e",
    "crontab -r",
    "crontab -u me /tmp/x",
    "at now <<< id",
    "at -f /tmp/job now + 1 minute",
    "batch <<< id",
    'osascript -e \'tell app "Terminal" to do script "id"\'',
    "osascript -e 'do shell script \"id\"'",
    'osascript -e \'tell application "System Events" to keystroke "x"\'',
    'osascript <<< \'tell app "Terminal" to do script "id"\'',
  ])("%s asks", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });

  it.each([
    "defaults read com.apple.finder",
    "defaults write com.apple.finder AppleShowAllFiles true",
    "defaults read ~/Library/LaunchAgents/x",
    "plutil -p ~/Library/LaunchAgents/x.plist",
    "plutil -lint ~/Library/LaunchAgents/x.plist",
    "plutil -convert xml1 /tmp/x.plist",
    "crontab -l",
    "crontab -u me -l",
    "atq",
    "at -l",
    "osascript -e 'tell app \"Finder\" to get name of startup disk'",
    "osascript -e 'display notification \"done\"'",
  ])("%s keeps allowing", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("the reader says why", () => {
    expect(persistenceReason("crontab", ["-"], [])).toContain("crontab");
    expect(persistenceReason("ls", [], [])).toBeNull();
    expect(
      persistenceReason("osascript", [], ['tell app "Terminal" to do script "id"']),
    ).not.toBeNull();
  });
});
