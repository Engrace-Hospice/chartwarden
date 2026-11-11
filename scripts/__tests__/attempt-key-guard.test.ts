// One implementation of "hold an Idempotency-Key across a retry": useAttemptKey / createAttemptKey in @chartwarden/ui
// (packages/ui/src/core/ops-write/use-attempt-key.ts), built on the shared keeper and the shared rules (keep the key across no answer, a
// gateway page and the in-flight 409; renew it on any other answer; idle TTL and hard cap; cleared when the session ends). A screen that
// holds its own (a ref or map of keys, a `use...AttemptKey` hook, a `crypto.randomUUID()` kept in state) silently drifts from those rules:
// it renews on the in-flight 409, never expires, and survives sign-out. This fails on a new one. docs/DEVELOPMENT.md has the rule.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APPS = join(REPO, "apps");

/** Files allowed to hold keys themselves, with a reason. Empty on purpose: use the shared hook. */
const ALLOWLIST: readonly { readonly file: string; readonly reason: string }[] = [];

const HOLDING_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: "defines its own attempt-key hook",
    pattern: /\b(?:function|const)\s+use[A-Za-z]*(?:AttemptKey|IdempotencyKey)\b/,
  },
  {
    name: "defines its own AttemptKey helper",
    pattern: /\b(?:function|const|class)\s+[A-Za-z]*AttemptKey\b/,
  },
  {
    name: "holds a key in a ref (attemptKey.current = ...)",
    pattern:
      /\b(?:attempt|idempotency|idem|attach|authorize|complete)Keys?\.current\s*(?:\?\?=|=(?!=))/,
  },
  {
    name: "mints a key into a held ref or map (keys.current.set(..., randomUUID()))",
    pattern: /\b\w*[Kk]eys?\.current(?:\.set\([^;]*|\s*(?:\?\?=|=(?!=))[^;]*)randomUUID\(\)/,
  },
  {
    name: "keeps a minted key in state (const [idempotencyKey] = useState(() => randomUUID()))",
    pattern: /const\s*\[\s*\w*[Kk]ey\w*\s*\]\s*=\s*useState\([^;]*randomUUID/,
  },
];

function holdingViolations(source: string): string[] {
  return HOLDING_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
    else if (/\.tsx?$/.test(entry) && !/\.(?:d|test)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const sources = readdirSync(APPS)
  .map((app) => join(APPS, app, "src"))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })
  .flatMap(sourcesUnder)
  .map((file) => relative(REPO, file));

describe("the one attempt-key hook", () => {
  it("scans the apps' sources", () => {
    expect(sources.length).toBeGreaterThan(500);
  });

  it("allows no home-grown key holder (the allowlist is empty)", () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it("finds no source that holds an Idempotency-Key of its own", () => {
    const offenders = sources
      .filter((file) => !ALLOWLIST.some((entry) => entry.file === file))
      .map((file) => ({ file, found: holdingViolations(readFileSync(join(REPO, file), "utf8")) }))
      .filter(({ found }) => found.length > 0);
    expect(offenders).toEqual([]);
  });
});

describe("the guard's own patterns (red on a home-grown helper, green on the shared hook)", () => {
  it.each([
    ["a local hook", "export function useAttemptKey() { return null }"],
    ["a local idempotency-key hook", "export function useIdempotencyKey() { return null }"],
    ["a local helper class", "class OrderAttemptKey {}"],
    ["a held ref", "attemptKey.current ??= crypto.randomUUID();"],
    ["a held ref reset", "attemptKey.current = null;"],
    ["a held ref of another stage", "attachKey.current = null;"],
    ["a minted key in a ref map", "keys.current.set(presetId, crypto.randomUUID());"],
    ["a minted key in a ref", "addKeys.current = new Map([[id, crypto.randomUUID()]]);"],
    ["a minted key kept in state", "const [idempotencyKey] = useState(() => crypto.randomUUID());"],
  ])("flags %s", (_label, source) => {
    expect(holdingViolations(source).length).toBeGreaterThan(0);
  });

  it.each([
    [
      "the shared hook",
      "const attempt = useAttemptKey(); const key = attempt.keyFor(fingerprint);",
    ],
    ["its import", 'import { NO_ANSWER, useAttemptKey } from "@chartwarden/ui";'],
    ["a fresh per-click key", "headers: freshIdempotencyKeyHeaders(),"],
    ["a keeper", "const keeper = useIdempotencyKeeper();"],
    [
      "a send attempt that rotates",
      "attempt.current = { ...attempt.current, idempotencyKey: crypto.randomUUID() };",
    ],
    ["comparing a key", "if (keyed.current === planId) return;"],
  ])("leaves %s alone", (_label, source) => {
    expect(holdingViolations(source)).toEqual([]);
  });
});
