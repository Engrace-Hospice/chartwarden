/**
 * R9-CR-8 rest (verify-r9 rows CR8e, CR8f, CR8q, CR8r): everyday migration commands of the ORM tools asked on Claude and were DENIED on Codex,
 * because the `prisma` and `drizzle-kit` option tables did not list `--name` (a migration name) and prisma `--port` (studio), so the word behind
 * the unlisted option could not be placed. Both are now listed like `--out` and `--schema` (their value is read as a connection string and
 * holds no host). A URI or a non-local host behind any of these options is still read as a target.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("ORM tools: a migration name and a port are values", () => {
  it.each([
    "drizzle-kit generate --name add_users",
    "bunx drizzle-kit generate --name add_users",
    "npx drizzle-kit generate --name add_users --custom",
    "drizzle-kit generate --config drizzle.config.ts --out drizzle --name x",
    "drizzle-kit studio --port 4983",
    "prisma migrate dev --name init",
    "prisma migrate dev --name add_users --create-only",
    "npx prisma migrate dev --name x --skip-seed",
    "prisma studio --port 5555",
  ])("%s is allowed", (cmd) => {
    expect(decide(cmd)).toBe("allow");
  });
});

describe("ORM tools: a target behind the same options is still read", () => {
  it.each([
    `drizzle-kit generate --name ${PG}u@${H}/db`,
    `prisma migrate dev --name ${PG}u@${H}/db`,
    `prisma studio --port 5555 --url ${PG}u@${H}/db`,
    `drizzle-kit push --host ${H}`,
    `drizzle-kit push --url ${PG}u@${H}/db`,
    `prisma migrate dev --url ${PG}u@${H}/db --name x`,
  ])("%s is not allowed", (cmd) => {
    expect(decide(cmd)).not.toBe("allow");
  });
});
