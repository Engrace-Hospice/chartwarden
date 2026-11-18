/**
 * Wave 13 part B2, B3 (round 10): `docker -cprod ps` (the context's name attached to its letter) passed while `docker -c prod ps` asked. pflag reads
 * `-cprod`, `-c=prod` and the cluster `-Dcprod` / `-Dc prod` as the context `prod`. The valued and flag letters of docker, podman and docker-compose are
 * recorded from the installed tools (rule 12, `fixtures/harness-engine-options/`); nerdctl, podman-compose and podman's hidden `-r` are documentation.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_LETTERS, shortValue } from "../harness/engine-short-options";
import { classifyBash } from "../harness/patterns";
import {
  ENGINES,
  type EngineFixture,
  FIXTURE_DIR,
  engineLines,
  engineVersion,
  parseEngineLines,
} from "./helpers/record-engine-options";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const sorted = (letters: string): string => [...letters].sort().join("");

const fixtures: EngineFixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as EngineFixture);

/** What the table lists beyond the recording: podman's hidden `-r` (`podman-remote`'s `--remote`), documented. */
const EXTRA_FLAGS: Record<string, string> = { podman: "r" };

describe("rule 12: the production letters are the recorded ones (no tool needed)", () => {
  it("there are recordings of docker, podman and docker-compose", () => {
    expect(fixtures.map((f) => f.tool).sort()).toEqual(["docker", "docker-compose", "podman"]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.tool} ${fixture.version}: the valued and flag letters are the recorded ones`, () => {
      const recorded = parseEngineLines(fixture.lines);
      const table = ENGINE_LETTERS[fixture.tool];
      expect(sorted(table?.valued ?? "")).toBe(sorted(recorded.valued));
      expect(sorted(table?.flags ?? "")).toBe(
        sorted(recorded.flags + (EXTRA_FLAGS[fixture.tool] ?? "")),
      );
    });
  }
});

describe("rule 12 live: the installed engines still print the recorded letters", () => {
  for (const tool of Object.keys(ENGINES)) {
    it(tool, (skipContext) => {
      const installed = engineVersion(tool);
      const recorded = fixtures.find((f) => f.tool === tool);
      if (installed === undefined || recorded?.version !== installed) {
        skipContext.skip(
          `${tool} is ${installed ?? "not installed"} and the recording is ${recorded?.version}: run bun scripts/__tests__/helpers/record-engine-options.ts --write`,
        );
        return;
      }
      expect(parseEngineLines(engineLines(tool) ?? [])).toEqual(parseEngineLines(recorded.lines));
    });
  }
});

describe("shortValue reads the letter and its value", () => {
  it.each<[string, string, string, string | null]>([
    ["docker", "-cprod", "c", "prod"],
    ["docker", "-c=prod", "c", "prod"],
    ["docker", "-Dcprod", "c", "prod"],
    ["docker", "-Dc", "c", null],
    ["docker", "-vDHssh://h", "H", "ssh://h"],
    ["docker", "-lDEBUG", "l", "DEBUG"],
    ["podman", "-cprod", "c", "prod"],
    ["docker-compose", "-fx.yml", "f", "x.yml"],
    ["docker-compose", "-pproj", "p", "proj"],
  ])("%s %s", (prog, arg, letter, value) => {
    expect(shortValue(prog, arg)).toEqual({ letter, value });
  });

  it.each<[string, string]>([
    ["docker", "-D"],
    ["docker", "-Dv"],
    ["docker", "-Z"],
    ["docker", "--context"],
    ["docker", "ps"],
    ["curl", "-cprod"],
  ])("%s %s names no valued letter", (prog, arg) => {
    expect(shortValue(prog, arg)).toBeUndefined();
  });
});

describe("an attached or clustered context value is read like the separate one", () => {
  it.each([
    "docker -cprod ps",
    "docker -c=prod ps",
    "docker -Dcprod ps",
    "docker -Dc prod ps",
    "docker -vc prod ps",
    "docker -Dc prod exec web sh",
    "docker -Dc prod compose ps",
    "docker -Dc default -Hssh://h.invalid ps",
    "docker -Dc default -c prod ps",
    "docker -vDcprod ps",
    "docker -lDEBUG -cprod ps",
    "docker -l debug -cprod ps",
    "docker -c prod ps",
    "docker --context prod ps",
    "docker --context=prod ps",
    "podman -cprod ps",
    "podman -c=prod ps",
    "podman -c prod ps",
    "docker -Hssh://h.invalid ps",
    "docker -DHssh://h.invalid ps",
    "docker -DH ssh://h.invalid ps",
    "docker -cprod exec web sh",
    "docker -cprod compose ps",
    "nerdctl -Hssh://h.invalid ps",
  ])("%s asks", (command) => {
    expect(d(command)).toBe("ask");
  });

  it.each([
    "docker ps",
    "docker ps -a",
    "docker -D ps",
    "docker -v",
    "docker --version",
    "docker -lDEBUG ps",
    "docker -l debug ps",
    "docker -cdefault ps",
    "docker -c=default ps",
    "docker -Dcdefault ps",
    "docker -Dc default ps",
    "docker -c desktop-linux ps",
    "docker -cdesktop-linux ps",
    "docker -ccolima ps",
    "docker -corbstack ps",
    "docker -c default images",
    "docker -Dcdefault build -t web .",
    "docker -D logs web",
    "podman ps",
    "podman -v",
    "podman -cpodman-machine-default ps",
    "podman -c=podman-machine-default-root ps",
    "docker-compose -f docker-compose.yml ps",
    "docker-compose -fdocker-compose.yml up -d",
    "docker-compose -pproj -f x.yml logs",
    "docker compose -f x.yml up -d",
    "docker run --rm -c 3 alpine true",
    "docker build -t x .",
    "docker images",
  ])("%s allows", (command) => {
    expect(d(command)).toBe("allow");
  });
});
