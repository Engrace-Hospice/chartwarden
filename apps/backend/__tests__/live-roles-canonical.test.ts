// Guard for the cluster-global role trap (see _live-app-role.ts, LIVE_DROP_ROLES): live suites share
// ONE drop list, and that list covers every role the migrations create.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_DROP_ROLES } from "./_live-app-role";

const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SELF = "live-roles-canonical.test.ts";

const stripSqlComments = (sql: string) => sql.replace(/^\s*--.*$/gm, "");

describe("live-suite canonical role list", () => {
  it("covers every role the migrations CREATE or RENAME TO", () => {
    const created = new Set<string>();
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
      const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      for (const m of sql.matchAll(/CREATE ROLE\s+"?([a-z0-9_]+)"?/gi)) created.add(m[1] as string);
      // 1139 renames wardenx_* -> chartwarden_* via the first [old, new] array (the later ones are functions).
      const roleRenames = f.startsWith("1139_")
        ? (/FOREACH pair SLICE 1 IN ARRAY ARRAY\[([^;]*?)\]\s*LOOP/.exec(sql)?.[1] ?? "")
        : "";
      for (const m of roleRenames.matchAll(
        /'(wardenx_[a-z0-9_]+)',\s*'(chartwarden_[a-z0-9_]+)'/g,
      )) {
        created.add(m[1] as string);
        created.add(m[2] as string);
      }
    }
    expect(created.size).toBeGreaterThan(10);
    const missing = [...created].filter((r) => !LIVE_DROP_ROLES.includes(r));
    expect(missing).toEqual([]);
  });

  it("has no duplicate entries", () => {
    expect(new Set(LIVE_DROP_ROLES).size).toBe(LIVE_DROP_ROLES.length);
  });

  it("is the only role list: no live suite or kit declares its own ROLES array", () => {
    // Every directory that holds live suites, not just this one (#859: packages/db and scripts suites
    // kept hand-written lists that missed roles a sibling suite left behind).
    const dirs = [
      __dirname,
      join(__dirname, "../../../packages/db/migrations/__tests__"),
      join(__dirname, "../../../scripts/__tests__"),
    ];
    const offenders = dirs.flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && f !== SELF && f !== "_live-app-role.ts")
        .filter((f) =>
          /^\s*(?:export\s+)?(?:const|let)\s+(?:DB_)?ROLES\s*(?::[^=]+)?=\s*\[/m.test(
            readFileSync(join(dir, f), "utf8"),
          ),
        )
        .map((f) => join(dir, f)),
    );
    expect(offenders).toEqual([]);
  });
});
