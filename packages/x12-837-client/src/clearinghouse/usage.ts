// @chartwarden/x12-837-client · clearinghouse/usage — the platform's clearinghouse usage mode (ADR-0053 D3), shared by
// the Medicare (M23) and commercial (M41) lanes. The composition root passes its env map; nothing here reads
// `process.env`.
import { CLEARINGHOUSE_VENDOR_ENV } from "./transport-registry";
import type { ClearinghouseContext } from "./types";

export const CLEARINGHOUSE_USAGE_ENV = "CLEARINGHOUSE_USAGE";

/** `test` reaches only vendor test mode. Defaults to production exactly when NODE_ENV is production. */
export function clearinghouseUsageFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ClearinghouseContext["usage"] {
  if (env[CLEARINGHOUSE_VENDOR_ENV]?.trim() === "claimmd") {
    const accountUsage = env.CLAIMMD_ACCOUNT_USAGE?.trim();
    if (accountUsage !== "test" && accountUsage !== "production") {
      throw new Error("CLAIMMD_ACCOUNT_USAGE must be test or production for Claim.MD routing");
    }
    const sharedUsage = env[CLEARINGHOUSE_USAGE_ENV]?.trim();
    if (sharedUsage && sharedUsage !== accountUsage) {
      throw new Error("CLEARINGHOUSE_USAGE conflicts with CLAIMMD_ACCOUNT_USAGE");
    }
    return accountUsage;
  }
  const raw = env[CLEARINGHOUSE_USAGE_ENV]?.trim();
  if (!raw) return env.NODE_ENV === "production" ? "production" : "test";
  if (raw !== "test" && raw !== "production") {
    throw new Error(`${CLEARINGHOUSE_USAGE_ENV} must be "test" or "production" (or unset)`);
  }
  if (raw === "test" && env.NODE_ENV === "production") {
    throw new Error(`${CLEARINGHOUSE_USAGE_ENV}=test is refused in production`);
  }
  return raw;
}
