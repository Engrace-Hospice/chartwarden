// apps/backend/src/bootstrap/onboarding-billing-mode-port.ts — the seam through which the platform's clearinghouse write (M34
// `PUT /api/v1/platform/tenants/:orgSlug/clearinghouse`) sets a tenant's billing service mode WITH a switch away from `outside`,
// without importing M35 (M34 has no `dependsOn` edge to pricing). The sibling of `onboarding-clearinghouse-port.ts`.
//
// A tenant that bills outside ChartWarden is on billing mode none, and that is an invariant (the system sets it, an operator cannot set
// another mode on an outside tenant). Leaving `outside` for a vendor therefore means choosing the mode the vendor billing calls for, and
// only a platform operator may: M35 implements the port over ITS OWN contract service, so the mode is dated like any mode change and
// audited with the operator and the reason. The mode is set BEFORE the vendor and put back if the vendor change then fails, so a failure
// never leaves a vendor without its mode.
export type OnboardingBillingServiceMode = "none" | "billing_software" | "managed_billing";

/** The platform operator, as the pricing service's write actor wants them. All of it is server-assembled, never from a body. */
export interface OnboardingBillingModeOperator {
  readonly userId: string;
  readonly membershipId: string;
  /** The operator's OWN organisation (the platform's), not the tenant's. */
  readonly organizationId: string;
  readonly roles: readonly string[];
  readonly stepUpRecent: boolean;
}

export interface OnboardingBillingModePort {
  /** Whether the tenant holds a pricing contract that is not canceled (live or paused). Where there is none, no billing mode is ever set. */
  hasContract(organizationId: string): Promise<boolean>;
  /** Set the mode through the pricing service's ordinary path, passing the outside invariant (this is the switch OUT of outside). */
  setModeLeavingOutside(
    operator: OnboardingBillingModeOperator,
    orgSlug: string,
    mode: OnboardingBillingServiceMode,
    reason: string,
  ): Promise<void>;
  /** The compensation: the vendor change failed after the mode was set, so the tenant (still outside) goes back to none. */
  restoreNone(organizationId: string): Promise<void>;
}
