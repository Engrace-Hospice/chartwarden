import type { DdeAccessProvider, DdeOperationKind } from "@chartwarden/x12-837-client";

export type DdeProviderCapabilityMode =
  | "manual_only"
  | "test_provider"
  | "unverified"
  | "qualified"
  | "unknown";

export interface DdeProviderCapability {
  readonly mode: DdeProviderCapabilityMode;
  readonly label: string;
  readonly submissionItemTypes: readonly DdeOperationKind[];
  readonly statusCheckItemTypes: readonly DdeOperationKind[];
  readonly explanation: string;
}

/** Code-wired qualification only. There is intentionally no environment-variable override. */
export interface QualifiedDdeOperations {
  readonly qualification: "vendor_qualified";
  readonly submissionItemTypes: readonly DdeOperationKind[];
  readonly statusCheckItemTypes: readonly DdeOperationKind[];
}

const OPERATION_KINDS: readonly DdeOperationKind[] = [
  "noe",
  "notr",
  "claim_entry",
  "rtp_correction",
  "adjustment",
  "cancel",
  "adr_response",
];

const MANUAL: DdeProviderCapability = {
  mode: "manual_only",
  label: "Manual DDE workflow",
  submissionItemTypes: [],
  statusCheckItemTypes: [],
  explanation: "Record work after completing it in DDE. No electronic DDE provider is enabled.",
};

const UNKNOWN: DdeProviderCapability = {
  mode: "unknown",
  label: "Provider readiness unknown",
  submissionItemTypes: [],
  statusCheckItemTypes: [],
  explanation: "Provider readiness could not be established. Use the manual DDE workflow.",
};

/** A queue-level snapshot. Tenant, provider-entity, item, permission and operator checks still run per request. */
export function ddeProviderCapability(
  provider: DdeAccessProvider | undefined,
  qualified: QualifiedDdeOperations | undefined,
): DdeProviderCapability {
  if (!provider || provider.vendor === "not_wired") return MANUAL;

  if (provider.vendor === "in_memory") {
    return {
      mode: "test_provider",
      label: "Test provider — not connected to Medicare",
      submissionItemTypes: OPERATION_KINDS,
      statusCheckItemTypes: OPERATION_KINDS,
      explanation: "This in-memory reference provider is for local testing only.",
    };
  }

  if (qualified?.qualification === "vendor_qualified") {
    return {
      mode: "qualified",
      label: "Electronic DDE provider enabled",
      submissionItemTypes: [...qualified.submissionItemTypes],
      statusCheckItemTypes: [...qualified.statusCheckItemTypes],
      explanation:
        "This is a platform-level snapshot, not a reachability guarantee. Item scope, state, ownership and permission are checked per action; provider-specific operator authorization remains provider-dependent.",
    };
  }

  if (provider.vendor === "episode_alert") {
    return {
      mode: "unverified",
      label: "Electronic DDE provider unavailable",
      submissionItemTypes: [],
      statusCheckItemTypes: [],
      explanation: "The provider contract is not verified for operational use. Use manual DDE.",
    };
  }

  return UNKNOWN;
}
