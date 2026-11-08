/** BIL-1.4 gates are deliberately independent and false unless the exact string "true" is set. */
export interface ClaimMdEraRuntimeConfig {
  readonly captureEnabled: boolean;
  readonly deliveryEnabled: boolean;
  readonly ownershipResolutionEnabled: boolean;
  readonly autoPostEnabled: false;
}

export function claimMdEraRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): ClaimMdEraRuntimeConfig {
  const captureEnabled = env.CLAIMMD_ERA_CAPTURE_ENABLED === "true";
  const deliveryEnabled = env.CLAIMMD_ERA_M25_DELIVERY_ENABLED === "true";
  const ownershipResolutionEnabled = env.CLAIMMD_ERA_OWNERSHIP_RESOLUTION_ENABLED === "true";
  if (env.CLAIMMD_ERA_AUTO_POST_ENABLED === "true")
    throw new Error("CLAIMMD_ERA_AUTO_POST_ENABLED is prohibited by BIL-1.4");
  return { captureEnabled, deliveryEnabled, ownershipResolutionEnabled, autoPostEnabled: false };
}

/** New capture/delivery and legacy per-provider Claim.MD pulls may never run simultaneously. */
export function shouldRunLegacyClaimMdEraPull(input: {
  readonly vendor: string | null | undefined;
  readonly captureEnabled: boolean;
  readonly deliveryEnabled: boolean;
}): boolean {
  return input.vendor !== "claimmd" || (!input.captureEnabled && !input.deliveryEnabled);
}
