/**
 * How a database client reads an option of its own (wave 11, part D, R8-ADV-4, R8-CR-13).
 * ------------------------------------------------------------------------------------------------
 * Wave 10 had a long-option reader of its own in `db-target.ts` (minimum prefix 2, or 3 for a plain value option) beside
 * `option-grammar.ts` `resolveLong` (minimum 1, the way getopt_long reads). The real PostgreSQL 16 clients accept ONE
 * character: `createdb --h=HOST`, `psql --d=URI` and `createdb --m=URI` connected to the host and the guard let them through.
 * This module is the one reader: an exact name first (an exact flag such as pgbench's `--log` stays a flag although it
 * prefixes `--log-prefix`), then a unique prefix over the flags AND the value options together (`resolveLong`), one character
 * down. A prefix that spans a flag and a value option is `ambiguous`; one that names nothing is `unknown`. Both ask: the
 * guard cannot tell whether the word names a host. A client that reads no abbreviation (redis-cli, mongosh, ...) takes exact
 * names only. The tables are proven against the installed programs by the fixtures of
 * `scripts/__tests__/fixtures/harness-db-tool-options` (`harness-db-options-wave11.test.ts`). Pure.
 */
import type { TargetClient } from "./db-target-clients";
import { type OptionGrammar, resolveLong } from "./option-grammar";

export type Role = "host" | "string" | "alias" | "indirect" | "value" | "flag";
export type OptionRead = Role | "ambiguous" | "unknown";

/** The roles that take a value, most severe first: a prefix that could be several of them is read as the first. */
const VALUE_ROLES: readonly Role[] = ["host", "string", "alias", "indirect", "value"];

const namesOf = (spec: TargetClient, role: Role): readonly string[] => {
  switch (role) {
    case "host":
      return spec.hostLong;
    case "string":
      return spec.stringLong;
    case "alias":
      return spec.aliasLong ?? [];
    case "indirect":
      return spec.indirectLong ?? [];
    case "value":
      return spec.valueLong;
    case "flag":
      return spec.flagLong ?? [];
  }
};

/** The long names of a client with the role each one has (a name in two tables has the most severe role). */
function roleTable(spec: TargetClient): ReadonlyMap<string, Role> {
  const out = new Map<string, Role>();
  for (const role of [...VALUE_ROLES, "flag" as const]) {
    for (const name of namesOf(spec, role)) if (!out.has(name)) out.set(name, role);
  }
  return out;
}

const grammars = new WeakMap<
  TargetClient,
  { roles: ReadonlyMap<string, Role>; grammar: OptionGrammar }
>();

function grammarOf(spec: TargetClient): {
  roles: ReadonlyMap<string, Role>;
  grammar: OptionGrammar;
} {
  const cached = grammars.get(spec);
  if (cached !== undefined) return cached;
  const roles = roleTable(spec);
  const names = [...roles.keys()];
  const grammar: OptionGrammar = {
    flags: "",
    values: "",
    longFlags: names.filter((name) => roles.get(name) === "flag"),
    longValues: names.filter((name) => roles.get(name) !== "flag"),
    ...(spec.exactLong === true ? { exact: true as const } : {}),
  };
  const built = { roles, grammar };
  grammars.set(spec, built);
  return built;
}

/** Is this exact long name in one of the client's tables? (A table that must be complete fails a test when it is not.) */
export const isListedLong = (spec: TargetClient, name: string): boolean =>
  grammarOf(spec).roles.has(name);

/**
 * What `--given` is for this client. `given` is the text after the dashes, up to any `=`. Exact name, else a unique prefix of
 * one character or more; the most severe role among the names a prefix can only be (they take a value alike).
 */
export function readLongOption(spec: TargetClient, given: string): OptionRead {
  const { roles, grammar } = grammarOf(spec);
  const exact = roles.get(given);
  if (exact !== undefined) return exact;
  const found = resolveLong(grammar, given);
  if (found === undefined) return "unknown";
  if (found === "ambiguous") return "ambiguous";
  if (found.kind === "flag") return "flag";
  const candidates = grammar.longValues.filter((name) => name.startsWith(given));
  return VALUE_ROLES.find((role) => candidates.some((name) => roles.get(name) === role)) ?? "value";
}

/** What `-L` is for this client; `attached` takes only the rest of its word (`mysql -pSECRET`). */
export function readShortOption(spec: TargetClient, letter: string): Role | "attached" {
  if (spec.hostShort?.includes(letter)) return "host";
  if (spec.stringShort?.includes(letter)) return "string";
  if (spec.aliasShort?.includes(letter)) return "alias";
  if (spec.attachedShort?.includes(letter)) return "attached";
  return spec.valueShort.includes(letter) ? "value" : "flag";
}
