export const CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV = "CLAIMMD_RESPONSE_CAPTURE_ENABLED";

/** Explicit opt-in only. Invalid or absent values keep the account-wide poller stopped. */
export function claimMdResponseCaptureEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env[CLAIMMD_RESPONSE_CAPTURE_ENABLED_ENV] === "true";
}

/** Account-wide capture/dispatch and per-provider Claim.MD acknowledgment polling must never run together. */
export function shouldRunLegacyClaimMdAckPoll(input: {
  readonly captureActive: boolean;
  readonly dispatcherActive?: boolean;
  readonly vendor: string | null | undefined;
}): boolean {
  return !(input.vendor === "claimmd" && (input.captureActive || input.dispatcherActive === true));
}
