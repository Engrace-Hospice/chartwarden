export const CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV = "CLAIMMD_RESPONSE_CAPTURE_ENABLED";

/** Explicit opt-in only. Invalid or absent values keep the account-wide poller stopped. */
export function claimMdResponseCaptureEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV] === "true";
}

/**
 * Account-wide capture/dispatch and per-provider Claim.MD acknowledgment polling must never run together ON THE SAME ACCOUNT.
 * The capture reads the platform's own Claim.MD account only, so it is decided per organization: one with its own sealed
 * Claim.MD credential (`account: "tenant"`) keeps its per-tenant poll while capture is on (owner decision 2026-11-08).
 */
export function shouldRunLegacyClaimMdAckPoll(input: {
  readonly captureActive: boolean;
  readonly dispatcherActive?: boolean;
  readonly vendor: string | null | undefined;
  readonly account?: "tenant";
}): boolean {
  if (input.account === "tenant") return true;
  return !(input.vendor === "claimmd" && (input.captureActive || input.dispatcherActive === true));
}

/**
 * True when this organization's binding is the platform's Claim.MD account. Its normalized `/response/` feed is captured
 * centrally and only the gated dispatcher interprets it, so the per-provider ack pull never reads it.
 */
export const isPlatformClaimMdAccount = (binding: {
  readonly vendor: string | null;
  readonly account?: "tenant";
}): boolean => binding.vendor === "claimmd" && binding.account !== "tenant";
