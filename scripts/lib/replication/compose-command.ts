/**
 * Read a compose service's `command` the way compose would run it, so the replication drill starts containers with the
 * production overlay's real flags (not a copy of them) and the static test can compare the primary's and the standby's
 * settings (CW-CP-01). `${VAR:-default}` resolves to its default; any other interpolation in a command is refused,
 * because a command that needs a value the drill does not have cannot be tested.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

interface ComposeFile {
  readonly services?: Readonly<Record<string, { readonly command?: unknown }>>;
}

const WITH_DEFAULT = /\$\{[A-Z0-9_]+:-([^}]*)\}/g;

// compose.yml uses compose's `!reset` tag, which js-yaml's default schema rejects; a command never carries one.
const COMPOSE_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  (["sequence", "scalar"] as const).map(
    (kind) => new yaml.Type("!reset", { kind, construct: () => null }),
  ),
);

export function resolveDefaults(value: string): string {
  const resolved = value.replace(WITH_DEFAULT, (_match, fallback: string) => fallback);
  if (resolved.includes("${")) {
    throw new Error(`command argument "${value}" interpolates a variable without a default`);
  }
  return resolved;
}

export function serviceCommand(composePath: string, service: string): readonly string[] {
  const doc = yaml.load(readFileSync(composePath, "utf8"), {
    schema: COMPOSE_SCHEMA,
  }) as ComposeFile;
  const command = doc.services?.[service]?.command;
  if (!Array.isArray(command) || command.some((c) => typeof c !== "string")) {
    throw new Error(`${composePath}: service ${service} has no list-form command`);
  }
  return (command as readonly string[]).map(resolveDefaults);
}

/** The `-c name=value` pairs of a postgres command line, later ones winning like the server's own parsing. */
export function postgresSettings(command: readonly string[]): ReadonlyMap<string, string> {
  const settings = new Map<string, string>();
  for (let i = 0; i < command.length - 1; i += 1) {
    if (command[i] !== "-c") continue;
    const pair = command[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) settings.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return settings;
}
