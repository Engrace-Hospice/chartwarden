// e2e/fixtures/credentials.ts — reads the gitignored, locally-generated demo accounts
// (WX-PR-018). `bun run db:seed` regenerates a RANDOM password every run (scripts/db/seed.ts) and
// writes it to CREDENTIALS.local.md — so specs must read that file at run time rather than hardcode
// a password that would go stale the moment someone reseeds.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DemoAccount {
  readonly roleName: string;
  readonly email: string;
  readonly password: string;
}

const CREDENTIALS_PATH = join(import.meta.dirname, "..", "..", "CREDENTIALS.local.md");

// | Administrator | `admin@wardenx.local` | `Wx-...` | 816 keys () |
const ROW_RE = /\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/g;

let cache: readonly DemoAccount[] | null = null;

function parse(): readonly DemoAccount[] {
  if (cache) return cache;
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `e2e fixtures: ${CREDENTIALS_PATH} not found. Run \`bun run db:reset\` (or \`bun run db:seed\`) against the local dev stack before running the E2E suite — see docs/DEVELOPMENT.md.`,
    );
  }
  const text = readFileSync(CREDENTIALS_PATH, "utf8");
  const accounts: DemoAccount[] = [];
  for (const m of text.matchAll(ROW_RE)) {
    accounts.push({ roleName: m[1] as string, email: m[2] as string, password: m[3] as string });
  }
  cache = accounts;
  return accounts;
}

function byEmailPrefix(prefix: string): DemoAccount {
  const account = parse().find((a) => a.email.startsWith(prefix));
  if (!account) {
    throw new Error(
      `e2e fixtures: no seeded account with email starting "${prefix}" in CREDENTIALS.local.md`,
    );
  }
  return account;
}

export const DEMO_ORG_NAME = "WardenX Demo Hospice";

/** Full permissions (816 keys) — used for admin-console / permission-boundary specs. */
export const ADMIN_ACCOUNT = (): DemoAccount => byEmailPrefix("admin@");
/** Clinical-only permissions (263 keys, no `member.manage`) — used for permission-denied paths. */
export const CLINICIAN_ACCOUNT = (): DemoAccount => byEmailPrefix("casey@");
/** Compliance-only permissions (84 keys) — used for permission-denied paths. */
export const AUDITOR_ACCOUNT = (): DemoAccount => byEmailPrefix("avery@");
/**
 * The RN persona from `db:seed:staff` — the only seeded account that can actually administer a
 * medication. F-031: `administration.record` is gated by BOTH a permission key and M13's
 * `administering_clinician_eligible` ABAC predicate, and that predicate reads the caller's clinical
 * DISCIPLINE from their session role grants (`rn` / `lpn` / `md` / `np` / `pa`). `admin@` holds all
 * 816 permission keys and none of those role keys, so it passes RBAC and is refused by ABAC —
 * exactly the split the eMAR spec has to sign in around.
 */
export const RN_ACCOUNT = (): DemoAccount => byEmailPrefix("rita@");
