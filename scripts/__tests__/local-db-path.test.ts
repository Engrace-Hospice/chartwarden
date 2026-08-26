/**
 * Exactly one local Postgres provisioning path (F-016 / #43).
 *
 * There used to be two, and they disagreed on port, user and volume: `db:up` ran a standalone
 * `wardenx-postgres` container on **5440**, while `.env`, `docker-compose.yml` and
 * `docs/START_PROJECT.md` all used the compose Postgres on **5432**. `db:reset` straddled both — it
 * destroyed the 5440 container and volume, then migrated and seeded 5432, which was never reset. A
 * developer running it to "start clean" got their existing database seeded on top of while an
 * unrelated volume was destroyed.
 *
 * Compose is now the single path. These cases pin the properties that made the old arrangement
 * wrong, so a second path cannot reappear quietly.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ENV_EXAMPLE = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
const COMPOSE = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");

/** Every `KEY=value` in .env.example, ignoring comments. */
function envExample(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of ENV_EXAMPLE.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m?.[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
  }
  return out;
}

describe("one local provisioning path", () => {
  it("no script provisions the retired standalone container", () => {
    const offenders = Object.entries(PKG.scripts).filter(([, cmd]) =>
      /wardenx-postgres|wardenx-pgdata|5440/.test(cmd),
    );
    expect(
      offenders.map(([n]) => n),
      "the 5440 `wardenx-postgres` path is retired — compose is the only local Postgres (#43)",
    ).toEqual([]);
  });

  it("db:up and db:reset both go through compose", () => {
    expect(PKG.scripts["db:up"]).toContain("docker compose up");
    expect(PKG.scripts["db:reset"]).toContain("docker compose down -v");
  });

  it("db:reset resets, waits, migrates and seeds — in that order", () => {
    const reset = PKG.scripts["db:reset"] ?? "";
    const order = ["docker compose down -v", "db:up", "db:wait", "db:migrate", "db:seed:all"];
    let cursor = -1;
    for (const step of order) {
      const at = reset.indexOf(step);
      expect(at, `db:reset must contain \`${step}\``).toBeGreaterThan(-1);
      expect(at, `db:reset steps are out of order at \`${step}\``).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("db:reset proves the reset happened rather than assuming it", () => {
    // The whole defect was a reset that silently did not reset. `--expect-empty` asserts zero
    // tables before migrations replay, so the mismatch fails loudly instead.
    expect(PKG.scripts["db:reset"]).toContain("--expect-empty");
  });

  it(".env.example carries what the migration runner needs, on the compose port", () => {
    const env = envExample();
    // `db:migrate` does owner-level DDL and creates the wardenx_* roles, so it cannot be one of
    // them; and it sets the app role's password. Both were absent, so copying this file could not
    // start the stack.
    for (const key of ["DATABASE_ADMIN_URL", "DATABASE_URL", "WARDENX_APP_PASSWORD"]) {
      expect(env.has(key), `.env.example must set ${key}`).toBe(true);
    }
    for (const key of ["DATABASE_ADMIN_URL", "DATABASE_URL"]) {
      expect(env.get(key), `${key} must point at the compose Postgres`).toContain("localhost:5432");
    }
    // The role it used to name is created by nothing at all.
    expect(env.get("DATABASE_URL")).not.toMatch(/:\/\/wardenx:/);
  });

  it("the compose Postgres publishes the port .env.example names", () => {
    expect(COMPOSE).toContain('"5432:5432"');
  });

  it("the E2E entry points cite a doc that documents bring-up", () => {
    // Both used to cite docs/DEVELOPMENT.md, which had no local-stack section at all.
    for (const f of ["e2e/playwright.config.ts", "e2e/global-setup.ts"]) {
      const src = readFileSync(join(REPO_ROOT, f), "utf8");
      expect(src, `${f} should point at the onboarding runbook`).toContain("START_PROJECT.md");
    }
    const dev = readFileSync(join(REPO_ROOT, "docs/DEVELOPMENT.md"), "utf8");
    expect(dev, "DEVELOPMENT.md should describe db:reset").toContain("db:reset");
  });
});
