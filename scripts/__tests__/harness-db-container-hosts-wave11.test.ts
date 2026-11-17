/**
 * Wave 11, part D, D3 (round-8 R8-CR-8, a wave-10 false positive): a database variable naming a container of this project
 * (`chartwarden-postgres`, `valkey`) denied `DATABASE_URL=postgres://u:p@chartwarden-postgres:5432/x bun run test`, which wave 9
 * allowed. `db-container-hosts.ts` lists the names the repo's own compose files use (local, allowed) and the generic names a compose
 * file conventionally gives a database service (`db`, `mysql`, `mongo`: they resolve on a compose network, but a resolver search
 * domain could resolve one elsewhere, so the guard asks). Read only for a program that is not a database client: `psql -h NAME` is
 * still refused, and a host that is not one of these names is still a deny. Every remote name is built from parts.
 */
import { describe, expect, it } from "vitest";
import {
  GENERIC_CONTAINER_HOSTS,
  PROJECT_CONTAINER_HOSTS,
  containerHostKind,
} from "../harness/db-container-hosts";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("D3: the project's own container names are local for a program that reads a database variable", () => {
  it.each([...PROJECT_CONTAINER_HOSTS])("DATABASE_URL naming %s allows", (name) => {
    const cmd = `DATABASE_URL=${PG}u:p@${name}:5432/x bun run test`;
    expect(decide(cmd), cmd).toBe("allow");
  });

  it.each([
    "REDIS_URL=redis://valkey:6379 bun run dev",
    "REDIS_URL=redis://redis:6379 bun run dev",
    `export DATABASE_URL=${PG}u:p@chartwarden-postgres:5432/x; bun run db:migrate`,
    "env REDIS_URL=redis://chartwarden-valkey:6379 bun run dev",
    `DATABASE_URL=${PG}u:p@CHARTWARDEN-POSTGRES:5432/x bun run test`,
  ])("%s allows", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("D3: a generic container name asks (a human decides), it is neither refused nor allowed", () => {
  it.each([...GENERIC_CONTAINER_HOSTS])("DATABASE_URL naming %s asks", (name) => {
    const cmd = `DATABASE_URL=${PG}u:p@${name}:5432/x bun run db:migrate`;
    expect(decide(cmd), cmd).toBe("ask");
  });

  it("MYSQL_HOST=mysql asks", () => {
    expect(decide("MYSQL_HOST=mysql php artisan migrate")).toBe("ask");
  });
});

describe("D3: nothing else became local", () => {
  it.each([
    `DATABASE_URL=${PG}u:p@${H}:5432/x bun run db:migrate`,
    `DATABASE_URL=${PG}u:p@db.${H}:5432/x bun run db:migrate`,
    `DATABASE_URL=${PG}u:p@valkey.${H}:6379/x bun run dev`,
    `DATABASE_URL=${PG}u:p@postgres.${H}/x bun run db:migrate`,
    `PGHOST=${H} bun run db:migrate`,
    `REDIS_URL=redis://${H}:6379 bun run dev`,
    `DATABASE_URL=${PG}u:p@valkey:5432,${H}/x bun run db:migrate`,
  ])("%s is refused", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    `psql -h db -c 'select 1'`,
    `psql -h valkey -c 'select 1'`,
    `PGHOST=chartwarden-postgres psql -c 'select 1'`,
  ])(
    "a database CLIENT told to reach %s is still refused: it resolves the name through this host",
    (cmd) => {
      expect(decide(cmd), cmd).toBe("deny");
    },
  );

  it("names no container kind for an ordinary host name", () => {
    expect(containerHostKind(H)).toBeNull();
    expect(containerHostKind("prod-db")).toBeNull();
    expect(containerHostKind("Valkey")).toBe("project");
    expect(containerHostKind("DB")).toBe("generic");
  });

  it("the two tables share no name", () => {
    for (const name of PROJECT_CONTAINER_HOSTS)
      expect(GENERIC_CONTAINER_HOSTS.has(name)).toBe(false);
  });
});
