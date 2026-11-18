/**
 * Wave 10, B10 (round-7 R7-CR-14, R7-CR-10). `printenv -0` and `printenv --null` print the whole environment (NUL-separated) and
 * were allowed because the rule tested `args.length === 0`; `tar --creat -f x apps` creates an archive of a directory that holds
 * a live env file and was not read as creating, because only `--create` spelled out in full was. Both are read as the tools read
 * them: options alone name no variable, and a long option is any unambiguous prefix of its name.
 */
import { describe, expect, it } from "vitest";
import { environmentDumpReason } from "../harness/env-dump";
import { classifyBash } from "../harness/patterns";
import { readTar } from "../harness/tar-grammar";

const ENV = [".", "env"].join("");
const PORTAL = `apps/portal/${ENV}`;
const base = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${PORTAL}`,
  liveEnvFiles: () => [PORTAL],
};
const decide = (cmd: string): string => classifyBash(cmd, base).decision;

describe("printenv with only options prints the whole environment", () => {
  it.each([
    ["printenv", []],
    ["printenv", ["-0"]],
    ["printenv", ["--null"]],
    ["printenv", ["--nul"]],
    ["printenv", ["--n"]],
    ["printenv", ["-0", "-0"]],
    ["printenv", ["--null", "--null"]],
  ])("%s %j is a dump", (prog, args) => {
    expect(environmentDumpReason(prog, args)).not.toBeNull();
    expect(decide([prog, ...args].join(" ")), [prog, ...args].join(" ")).toBe("deny");
  });

  it.each([
    ["printenv", ["--help"]],
    ["printenv", ["--he"]],
    ["printenv", ["--version"]],
    ["printenv", ["--ver"]],
    ["printenv", ["HOME"]],
    ["printenv", ["-0", "HOME"]],
    ["printenv", ["--null", "NODE_ENV"]],
    ["printenv", ["HOME", "PATH"]],
  ])("%s %j is not", (prog, args) => {
    expect(environmentDumpReason(prog, args)).toBeNull();
    expect(decide([prog, ...args].join(" ")), [prog, ...args].join(" ")).toBe("allow");
  });

  it("through a wrapper, a runner, a container and a nested shell", () => {
    for (const cmd of [
      "sudo printenv -0",
      "nice printenv --null",
      "bunx printenv -0",
      "docker compose exec api printenv -0",
      "bash -c 'printenv -0'",
      "docker compose exec api sh -c 'printenv --null'",
      "printenv -0 | tr '\\0' '\\n'",
    ]) {
      expect(decide(cmd), cmd).toBe("deny");
    }
  });
});

describe("tar reads a long option by any unambiguous prefix", () => {
  it.each([
    "--create",
    "--creat",
    "--crea",
    "--cre",
    "--cr",
    "--append",
    "--appe",
    "--app",
    "--ap",
    "--update",
    "--updat",
    "--upd",
    "--up",
  ])("tar %s creates an archive", (option) => {
    expect(readTar([option, "-f", "/tmp/o.tar", "apps"]).creating, option).toBe(true);
  });

  it.each(["--cr", "--creat", "--cre", "--appe", "--upd", "--up", "--ap"])(
    "tar %s -f x apps asks, like tar --create does",
    (option) => {
      expect(decide("tar --create -f /tmp/o.tar apps")).toBe("ask");
      expect(decide(`tar ${option} -f /tmp/o.tar apps`), option).toBe("ask");
      expect(decide(`tar ${option}=x -f /tmp/o.tar apps`), option).toBe("ask");
    },
  );

  it.each([
    ["--c", false],
    ["--extract", false],
    ["--list", false],
    ["--compare", false],
    ["--directory=apps", false],
  ] as const)("tar %s is not creating", (option, creating) => {
    expect(readTar([option, "-f", "x.tar", "apps"]).creating).toBe(creating);
  });

  it("the other long options the grammar reads still resolve", () => {
    expect(readTar(["--create", "--dir=apps", "portal"]).dirs).toEqual(["apps"]);
    expect(readTar(["--cr", "--files-from=/tmp/l"]).filesFrom).toBe(true);
    expect(readTar(["--cr", "--directory", "apps", "portal"]).members).toEqual([
      { name: "portal", dirs: ["apps"] },
    ]);
  });

  it("reading a tarball and the extract and list forms keep allowing", () => {
    for (const cmd of [
      "tar tf /tmp/o.tar",
      "tar xf /tmp/o.tar -C /tmp/out",
      "tar --list -f /tmp/o.tar",
      "tar --extr -f /tmp/o.tar",
      "tar --cr -f /tmp/o.tar lib",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
