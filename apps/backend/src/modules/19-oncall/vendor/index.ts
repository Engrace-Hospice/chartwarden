// apps/backend/src/modules/19-oncall/vendor — the §8.5 adapter mandate + the §7.10 PHI boundary (M19-T07).
//
// `registry.ts` resolves `external_triage_vendor.adapter_key` → an `ExternalTriageVendorAdapter` and
// refuses on a miss; `handoff.ts` is the ONE path a byte reaches a vendor through (resolve → D13 binding
// gate → minimize → assert → transmit). Nothing outside this directory names a vendor endpoint, and
// nothing outside `@wardenx/triage-vendors` may.
export {
  type TriageVendorAdapterRegistry,
  TriageVendorAdapterConflictError,
  TriageVendorAdapterUnavailableError,
  createTriageVendorAdapterRegistry,
  triageVendorAdapters,
} from "./registry";
export {
  type TriageVendorAccessAudit,
  type TriageVendorHandoffDeps,
  type TriageVendorHandoffOutcome,
  type TriageVendorHandoffRequest,
  type VendorCredentialPort,
  UnknownVendorMinimizationProfileError,
  emptyVendorCredentialPort,
  handOffCallToVendor,
  opaquePatientRefFor,
  toVendorBinding,
} from "./handoff";
