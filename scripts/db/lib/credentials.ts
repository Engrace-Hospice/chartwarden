/** Location shared by every demo seed that produces or consumes generated login credentials. */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local development keeps the gitignored credentials file at the repository root. Production
 * containers run the application source as a non-root user, so callers can set this to a writable
 * path such as `/tmp/CREDENTIALS.local.md` without changing their working directory.
 */
export const SEED_CREDENTIALS_PATH =
  process.env.CHARTWARDEN_SEED_CREDENTIALS_FILE ?? join(process.cwd(), "CREDENTIALS.local.md");

/** Write local plaintext credentials with owner-only permissions, including over an existing file. */
export function writeSeedCredentials(contents: string): void {
  writeFileSync(SEED_CREDENTIALS_PATH, contents, { mode: 0o600 });
  // `mode` only applies when creating a file. Tighten an existing file left by an older seed too.
  chmodSync(SEED_CREDENTIALS_PATH, 0o600);
}

/** `admin` is a reserved username (RESERVED_USERNAMES), so the seeded Administrator gets `sysadmin`. */
const SEED_USERNAME_OVERRIDES: Readonly<Record<string, string>> = {
  "admin@chartwarden.local": "sysadmin",
};

/** Seeded accounts sign in by username as well as email; the username is the email local part. */
export function seedUsername(email: string): string {
  return SEED_USERNAME_OVERRIDES[email] ?? email.split("@")[0] ?? email;
}
