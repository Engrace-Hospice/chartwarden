import type { X12WorkerResult } from "../types";
import { CH, isCredentialRejection } from "./types";
import type { SubmissionReceipt } from "./types";

export type ContractState = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type ContractEvidenceKind = "local" | "vendor";

export interface ContractScenarioResult {
  readonly scenario: string;
  readonly evidence: ContractEvidenceKind;
  readonly state: ContractState;
  /** Closed, PHI-free reason code. Never a vendor message or response body. */
  readonly reasonCode?: string;
  readonly receiptValidated?: boolean;
  readonly requestSent?: boolean;
}

export interface ContractQualificationSummary {
  readonly overall: ContractState;
  readonly requiredVendorScenarios: readonly string[];
  readonly scenarios: readonly ContractScenarioResult[];
}

/** A Stedi 2xx is a qualification pass only when the adapter extracted a real, non-derived receipt id. */
export function classifyVendorSubmission(
  scenario: string,
  result: X12WorkerResult<SubmissionReceipt>,
  requestSent: boolean,
): ContractScenarioResult {
  if (result.ok) {
    const receiptValidated =
      result.data.replayed === false &&
      result.data.clearinghouseSubmissionId.length > 0 &&
      !result.data.clearinghouseSubmissionId.startsWith("stedi:");
    return {
      scenario,
      evidence: "vendor",
      state: receiptValidated ? "PASS" : "FAIL",
      reasonCode: receiptValidated ? undefined : "successful_response_missing_vendor_receipt_id",
      receiptValidated,
      requestSent,
    };
  }

  const code = result.degraded.code;
  if (code === CH.NOT_PROVISIONED) {
    return {
      scenario,
      evidence: "vendor",
      state: "BLOCKED",
      reasonCode: "account_not_provisioned",
      requestSent,
    };
  }
  if (code === CH.UNAVAILABLE) {
    const reasonCode = result.degraded.ambiguous
      ? "ambiguous_vendor_outcome"
      : result.degraded.reason === "Stedi could not be reached"
        ? "network_unavailable"
        : "vendor_unavailable";
    return { scenario, evidence: "vendor", state: "BLOCKED", reasonCode, requestSent };
  }
  if (isCredentialRejection(result)) {
    return {
      scenario,
      evidence: "vendor",
      state: "BLOCKED",
      reasonCode: "vendor_credential_rejected",
      requestSent,
    };
  }
  if (code === CH.NOT_WIRED) {
    return {
      scenario,
      evidence: "vendor",
      state: "FAIL",
      reasonCode: "operation_not_wired",
      requestSent,
    };
  }
  if (code === CH.INVALID_REQUEST) {
    return {
      scenario,
      evidence: "vendor",
      state: "FAIL",
      reasonCode: "vendor_or_adapter_refused_request",
      requestSent,
    };
  }
  return {
    scenario,
    evidence: "vendor",
    state: "FAIL",
    reasonCode: "unexpected_vendor_result",
    requestSent,
  };
}

export function localScenario(
  scenario: string,
  state: ContractState,
  reasonCode?: string,
  requestSent = false,
): ContractScenarioResult {
  return { scenario, evidence: "local", state, ...(reasonCode ? { reasonCode } : {}), requestSent };
}

/** Missing gates mean NOT_RUN; a green Vitest process never upgrades that to vendor qualification. */
export function summarizeQualification(
  scenarios: readonly ContractScenarioResult[],
  requiredVendorScenarios: readonly string[],
  gatesSatisfied: boolean,
): ContractQualificationSummary {
  if (!gatesSatisfied) return { overall: "NOT_RUN", requiredVendorScenarios, scenarios };
  const local = scenarios.filter((s) => s.evidence === "local");
  if (local.some((s) => s.state === "FAIL"))
    return { overall: "FAIL", requiredVendorScenarios, scenarios };
  if (local.some((s) => s.state === "BLOCKED"))
    return { overall: "BLOCKED", requiredVendorScenarios, scenarios };
  if (local.some((s) => s.state === "NOT_RUN"))
    return { overall: "NOT_RUN", requiredVendorScenarios, scenarios };

  const vendorByName = new Map(
    scenarios.filter((s) => s.evidence === "vendor").map((s) => [s.scenario, s] as const),
  );
  const required = requiredVendorScenarios.map((name) => vendorByName.get(name));
  if (required.some((s) => !s || s.state === "NOT_RUN")) {
    return { overall: "NOT_RUN", requiredVendorScenarios, scenarios };
  }
  if (required.some((s) => s?.state === "FAIL"))
    return { overall: "FAIL", requiredVendorScenarios, scenarios };
  if (required.some((s) => s?.state === "BLOCKED"))
    return { overall: "BLOCKED", requiredVendorScenarios, scenarios };
  return { overall: "PASS", requiredVendorScenarios, scenarios };
}

const SAFE_REF = /^[A-Z][A-Z0-9]{1,9}-[A-Z0-9-]{1,24}$/;

export interface ContractRunGates {
  readonly ready: boolean;
  readonly reasonCodes: readonly string[];
  readonly authorizationRef: string | null;
  readonly vendorConfirmationRef: string | null;
}

/** Explicit gates are human attestations, not cryptographic/API proof of Stedi key mode. */
export function contractRunGates(
  env: Readonly<Record<string, string | undefined>>,
): ContractRunGates {
  const reasons: string[] = [];
  if (!env.STEDI_TEST_API_KEY?.trim()) reasons.push("test_key_missing");
  if (env.STEDI_CONTRACT_RUNNER !== "dedicated-command") reasons.push("dedicated_runner_required");
  if (env.STEDI_CONTRACT_CONFIRM !== "synthetic-only")
    reasons.push("synthetic_only_confirmation_missing");
  if (env.STEDI_CONTRACT_KEY_IS_TEST !== "yes") reasons.push("test_key_mode_not_human_verified");
  if (env.STEDI_CONTRACT_OPERATOR_AUTHORIZED !== "yes")
    reasons.push("operator_authorization_missing");
  const authorizationRef = env.STEDI_CONTRACT_AUTHORIZATION_REF?.trim() ?? "";
  if (!SAFE_REF.test(authorizationRef)) reasons.push("authorization_reference_missing_or_invalid");
  const vendorConfirmationRef = env.STEDI_CONTRACT_VENDOR_CONFIRMATION_REF?.trim() ?? "";
  if (!SAFE_REF.test(vendorConfirmationRef))
    reasons.push("vendor_confirmation_reference_missing_or_invalid");
  if (!env.STEDI_CONTRACT_RESULTS_FILE?.trim()) reasons.push("results_file_missing");
  if (env.CLEARINGHOUSE_VENDOR && env.CLEARINGHOUSE_VENDOR !== "in_memory") {
    reasons.push("platform_clearinghouse_binding_present");
  }
  if (env.STEDI_API_KEY?.trim()) reasons.push("platform_stedi_credential_present");
  if (env.NODE_ENV === "production") reasons.push("production_environment_refused");
  return {
    ready: reasons.length === 0,
    reasonCodes: reasons,
    authorizationRef: SAFE_REF.test(authorizationRef) ? authorizationRef : null,
    vendorConfirmationRef: SAFE_REF.test(vendorConfirmationRef) ? vendorConfirmationRef : null,
  };
}
