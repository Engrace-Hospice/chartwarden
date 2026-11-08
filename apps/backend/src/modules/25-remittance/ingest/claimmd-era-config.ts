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

type EraFlags = Pick<ClaimMdEraRuntimeConfig, "captureEnabled" | "deliveryEnabled">;

/**
 * The legacy ERA pull per ACCOUNT (owner decision 2026-11-08): a tenant's OWN Claim.MD account (`account: "tenant"`) is not in
 * main's capture and keeps its per-org pull; the platform's Claim.MD account follows {@link shouldRunLegacyClaimMdEraPull}.
 */
export function shouldRunLegacyEraPullFor(
  binding: { readonly vendor: string | null; readonly account?: "tenant" },
  flags: EraFlags,
): boolean {
  return (
    binding.account === "tenant" ||
    shouldRunLegacyClaimMdEraPull({ vendor: binding.vendor, ...flags })
  );
}

/** One org's binding for the pull: itself when it pulls, else unbound (vendor null: the pull skips that org). */
export function eraPullBindingForOrg<
  B extends {
    readonly vendor: string | null;
    readonly account?: "tenant";
    readonly transport: unknown;
  },
>(bound: B, flags: EraFlags): B | { readonly transport: B["transport"]; readonly vendor: null } {
  return shouldRunLegacyEraPullFor(bound, flags)
    ? bound
    : { transport: bound.transport, vendor: null };
}
