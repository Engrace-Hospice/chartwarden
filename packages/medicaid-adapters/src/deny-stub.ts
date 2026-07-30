// @wardenx/medicaid-adapters — shared deny-stub factory for non-implemented Phase-1 states (D14). The
// registry registers WA/ID/CA/NV deny-stubs so its existence proof is testable without committing to a
// state's wire format until a paying customer lands. Every I/O method throws a structured
// MedicaidAdapterError(code='ADAPTER_DENY_STUB'); metadata is conservative (all gates closed). The vendor
// ends with '-deny-stub' so `MedicaidAdapterRegistry.isPhaseOneDenyStub` reports it.
import type { MedicaidAdapter, MedicaidAdapterMetadata } from "./interface";
import { MedicaidAdapterError } from "./errors";
import type { StateCode } from "./contracts";

const DENY_STUB_METADATA: MedicaidAdapterMetadata = {
  acceptsDocumentedMissingEvv: false, // Cures Act §12006 — Phase-1 floor
  combinesHospiceAndRb: false,
  hasNoeEquivalent: false,
  supportedChannels: [],
  ackMode: "sync",
  supportedTobs: [],
};

/** Build a deny-stub adapter for `state`. `vendorBase` (e.g. 'washington-mmis') gets a '-deny-stub' suffix. */
export function createDenyStubAdapter(state: StateCode, vendorBase: string): MedicaidAdapter {
  const opsHint = `Implement and register the ${state} adapter (packages/medicaid-adapters/${state.toLowerCase()}) before billing ${state} Medicaid.`;
  const deny = (method: string): never => {
    throw new MedicaidAdapterError(
      "ADAPTER_DENY_STUB",
      state,
      `${state} Medicaid adapter is a Phase-1 deny-stub; ${method}() is not implemented.`,
      opsHint,
    );
  };
  return {
    state,
    vendor: `${vendorBase}-deny-stub`,
    version: "0.0.0",
    metadata: DENY_STUB_METADATA,
    replacementTob: () => deny("replacementTob"),
    voidTob: () => deny("voidTob"),
    eligibilityCheck: async () => deny("eligibilityCheck"),
    assembleSubmissionPayload: async () => deny("assembleSubmissionPayload"),
    submit: async () => deny("submit"),
    poll: async () => deny("poll"),
    parseAcknowledgment: async () => deny("parseAcknowledgment"),
    parseRemittance: async () => deny("parseRemittance"),
    rateLookup: async () => deny("rateLookup"),
    healthy: async () => ({ ok: false, lastChecked: "1970-01-01T00:00:00.000Z", latencyMs: 0, channelStatus: {} }),
  };
}
