/**
 * Wave 12 part E1, E1-7 (R9-CR-11, R9-CR-12) and E1-8 (R9-CR-17): the recorder and the survivors of round 9's mutation run.
 *   - the recorder surfaces an exec failure as an ERROR and a timeout as `NoAnswer` (an option whose probe never answers is `unverified`, never a flag);
 *   - a probe that does not show that an option runs its operand fails the recording loudly; a name the installed tool lists and the recording does not
 *     hold is reported (a newer tool fails the live test until it is re-recorded);
 *   - P21 (`\r` is a blank in env's split grammar), F2 (the docker-run recording holds `--network` on its own), F9 (npx `-p` is `--package`, npm exec `-p`
 *     is `--parseable`) are pinned by tests;
 *   - the unexplained-name check of the env table no longer lists the options BSD env does record.
 * GNU env and Linux are NOT verified by any of this (the recordings were made on macOS with BSD env).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { RUN_GRAMMAR } from "../harness/container-run";
import { splitEnvString } from "../harness/env-split";
import * as G from "../harness/runner-grammars";
import { TABLES, fixtureOf, reading } from "./helpers/tool-tables";

const scratch = mkdtempSync(join(tmpdir(), "cw-recorder-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fake tool: a shell script printing `body`. */
function fakeTool(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

async function recorder() {
  vi.stubEnv("CW_PROBE_TIMEOUT_MS", "300");
  vi.resetModules();
  return import("./helpers/record-tool-options");
}

describe("E1-7: the recorder never reads a failure as an answer", () => {
  it("a tool that cannot start is an error that names it", async () => {
    const r = await recorder();
    const box = r.makeSandbox("/bin/echo");
    try {
      await expect(r.run(join(scratch, "does-not-exist"), [], box)).rejects.toThrow(
        /does-not-exist/,
      );
    } finally {
      box.dispose();
    }
  });

  it("a non-zero exit is an answer; a probe that hangs is NoAnswer after one retry", async () => {
    const r = await recorder();
    const box = r.makeSandbox("/bin/echo");
    try {
      const refused = await r.run(fakeTool("refuse", "echo no >&2; exit 3"), [], box);
      expect(refused.err).toContain("no");
      const started = Date.now();
      await expect(r.run(fakeTool("hang", "sleep 5"), [], box)).rejects.toBeInstanceOf(r.NoAnswer);
      // two attempts of 300 ms, not one and not five seconds
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      box.dispose();
    }
  }, 20_000);

  it("an option whose probe hangs is `unverified`, never a flag (`pnpm --use-node-version exec echo HIT` waits for a download)", async () => {
    const r = await recorder();
    const tool = fakeTool(
      "pnpmish",
      'for a in "$@"; do [ "$a" = "--waits" ] && sleep 5; done; echo HIT',
    );
    const box = r.makeSandbox(tool);
    const target = {
      key: "fake",
      tool: "fake",
      method: "echo-hit" as const,
      versionArgs: ["--version"],
      helpArgs: [],
      argv: (t: string, v?: string) => [t, ...(v === undefined ? [] : [v])],
    };
    try {
      expect(await r.probe(tool, target, "--waits", box)).toBe("unverified");
      expect(await r.probe(tool, target, "--quick", box)).toBe("optional");
    } finally {
      box.dispose();
    }
  }, 20_000);

  it("a valued probe that hangs is unverified too, and a tool that answers is read as before", async () => {
    const r = await recorder();
    const tool = fakeTool(
      "valued",
      'for a in "$@"; do [ "$a" = "--waits" ] && sleep 5; done; [ "$1" = "--takes" ] && [ "$2" = "VAL" ] && echo HIT; exit 0',
    );
    const box = r.makeSandbox(tool);
    const target = {
      key: "fake",
      tool: "valued",
      method: "echo-hit" as const,
      versionArgs: ["--version"],
      helpArgs: [],
      values: ["VAL"],
      argv: (t: string, v?: string) => [t, ...(v === undefined ? [] : [v])],
    };
    try {
      expect(await r.probe(tool, target, "--takes", box)).toBe(true);
      expect(await r.probe(tool, target, "--waits", box)).toBe("unverified");
      expect(await r.probe(tool, target, "--plain", box)).toBe("unverified");
    } finally {
      box.dispose();
    }
  }, 20_000);

  it("a tool that is slow once and answers the retry is an answer, not an error", async () => {
    const r = await recorder();
    const marker = join(scratch, "first-call");
    const tool = fakeTool(
      "slowonce",
      `if [ ! -e ${marker} ]; then : > ${marker}; sleep 5; fi; echo answered`,
    );
    const box = r.makeSandbox(tool);
    try {
      const result = await r.run(tool, [], box);
      expect(result.out.trim()).toBe("answered");
    } finally {
      box.dispose();
    }
  }, 20_000);

  it("a probe whose control also prints the operand fails the recording (the option proves nothing)", async () => {
    const r = await recorder();
    const tool = fakeTool("always", "echo HIT");
    const target = {
      key: "fake",
      tool: "always",
      method: "help" as const,
      versionArgs: ["1.2.3"],
      helpArgs: [],
      argv: () => [],
      runsOperand: [{ option: "--x", argv: ["--x", "echo HIT"], control: ["echo HIT"] }],
    };
    await expect(r.recordTarget(tool, target)).rejects.toThrow(/without it: true/);
  });

  it("a probe that does not show the operand run fails the recording, loudly", async () => {
    const r = await recorder();
    const tool = fakeTool("noisy", 'echo "$@"');
    const target = {
      key: "fake",
      tool: "noisy",
      method: "help" as const,
      versionArgs: ["1.2.3"],
      helpArgs: [],
      argv: () => [],
      runsOperand: [{ option: "--x", argv: ["--x", "echo HIT"], control: ["echo HIT"] }],
    };
    await expect(r.recordTarget(tool, target)).rejects.toThrow(
      /expected the operand to run as a command line/,
    );
  });

  it("a name the installed tool lists and the recording does not hold is reported", async () => {
    const r = await recorder();
    const tool = fakeTool(
      "helper",
      'printf "Usage: helper\\n  --alpha        a flag\\n  --beta <x>     a value\\n"',
    );
    const target = {
      key: "fake",
      tool: "helper",
      method: "echo-hit" as const,
      versionArgs: [],
      helpArgs: [["--help"]],
      argv: () => [],
    };
    const fixture = (names: string[]) => ({
      tool: "helper",
      version: "1.0.0",
      command: "fake",
      method: "echo-hit" as const,
      options: names.map((name) => ({
        name,
        takesValue: false as const,
        evidence: "probe" as const,
      })),
      rejected: [],
    });
    expect(await r.newNamesInHelp(tool, target, fixture(["--alpha"]))).toEqual(["--beta"]);
    expect(await r.newNamesInHelp(tool, target, fixture(["--alpha", "--beta"]))).toEqual([]);
  });

  it("the version of an installed tool is read inside the sandbox", async () => {
    const r = await recorder();
    const tool = fakeTool("versioned", 'pwd >&2; echo "versioned 4.5.6"');
    const version = r.installedVersion(tool);
    expect(version).toBe("4.5.6");
  });
});

describe("P21: a carriage return is a blank in env's split grammar", () => {
  it.each([
    ["a\rb", ["a", "b"]],
    ["a\r\rb", ["a", "b"]],
    ["\ra\r", ["a"]],
    ["a\r", ["a"]],
    ["echo\rhi", ["echo", "hi"]],
    ["a\tb\nc\vd\fe\rf", ["a", "b", "c", "d", "e", "f"]],
  ])("the reader splits %j at it, like \\n, \\t, \\v and \\f", (text, words) => {
    expect(splitEnvString(text).words).toEqual(words);
  });
  it.skipIf(!existsSync("/usr/bin/env"))(
    "and so does the installed env (BSD env; GNU env is not verified)",
    () => {
      const out = spawnSync("/usr/bin/env", ["-S", "printf %s\\0 a\rb"], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      });
      if (out.status !== 0) return; // an env without -S
      expect(out.stdout).toBe("a\0b\0");
    },
  );
});

describe("F2: the docker-run recording holds --network on its own (podman shares the table, not the recording)", () => {
  it.each(["docker run", "podman run"])(
    "%s: --network takes a value in the recording and the table reads it so",
    (command) => {
      const option = fixtureOf(command).options.find((o) => o.name === "--network");
      expect(option?.takesValue, command).toBe(true);
      expect(reading(RUN_GRAMMAR, "--network"), "RUN_GRAMMAR").toBe("value");
    },
  );
  it("the table is checked against both recordings", () => {
    expect(TABLES.find((t) => t.name === "RUN_GRAMMAR")?.commands).toEqual([
      "docker run",
      "podman run",
    ]);
  });
});

describe("F9: npx -p is --package (valued), npm exec -p is --parseable (a flag)", () => {
  it("the recordings hold both, and the tables read them that way", () => {
    const npx = fixtureOf("npx").options;
    expect(npx.find((o) => o.name === "--package")?.takesValue).toBe(true);
    expect(npx.find((o) => o.name === "-p")?.takesValue).toBe(true);
    const exec = fixtureOf("npm exec").options;
    expect(exec.find((o) => o.name === "-p")?.takesValue).toBe(false);
    expect(exec.find((o) => o.name === "--parseable")?.takesValue).toBe(false);
    expect(reading(G.NPX, "-p")).toBe("value");
    expect(reading(G.NPX, "--package")).toBe("value");
    expect(reading(G.NPM, "-p")).toBe("flag");
    expect(reading(G.NPM, "--parseable")).toBe("flag");
  });
});

describe("E1-8: the env table's unexplained-name check covers the options BSD env records", () => {
  it("none of the recorded short options is excused as `legacy`", () => {
    const env = TABLES.find((t) => t.name === "env");
    const recorded = fixtureOf("env").options.flatMap((o) => [
      o.name,
      ...(o.short === undefined ? [] : [o.short]),
    ]);
    expect((env?.legacy ?? []).filter((name) => recorded.includes(name))).toEqual([]);
  });
});
