export const CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV = "CLAIMMD_RESPONSE_CAPTURE_ENABLED";

/** Explicit opt-in only. Invalid or absent values keep the account-wide poller stopped. */
export function claimMdResponseCaptureEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV] === "true";
}

/**
 * The BIL-1.1 capture service is platform-account-only. Tenant-owned Claim.MD accounts keep their existing
 * organization/provider-scoped poll because it also applies the supported legacy ACK behavior. Do not turn this into a
 * tenant capture switch until raw response capture, tenant-key encryption/RLS, account-wide cursor ownership, and the
 * downstream handoff have been unified. Running a second account poll here would race the established cursor/status path.
 */
export function shouldRunLegacyClaimMdAckPoll(input: {
  readonly captureActive: boolean;
  readonly dispatcherActive?: boolean;
  readonly vendor: string | null | undefined;
  readonly account?: "tenant";
}): boolean {
  // Fail closed against accidental double polling: enabling platform capture does not opt tenant accounts into a second poller.
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
