/** Location shared by every demo seed that produces or consumes generated login credentials. */
import { join } from "node:path";

/**
 * Local development keeps the gitignored credentials file at the repository root. Production
 * containers run the application source as a non-root user, so callers can set this to a writable
 * path such as `/tmp/CREDENTIALS.local.md` without changing their working directory.
 */
export const SEED_CREDENTIALS_PATH =
  process.env.WARDENX_SEED_CREDENTIALS_FILE ?? join(process.cwd(), "CREDENTIALS.local.md");
