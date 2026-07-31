// @wardenx/triage-vendors — Module 19's external-triage-vendor adapter package (the §25.14 adapter-mandate
// boundary, ADR-0028). This is the ONLY place a triage vendor's endpoint, credentials and payload shape
// may live; dependency-cruiser forbids any other module from importing a vendor SDK or hitting a vendor
// URL.
//
// M19-T01 landed the §4.4 `ExternalTriageVendorAdapter` interface, the `TriageVendorCredentials` shape,
// the D13 `assertVendorBindingActive` BAA/attestation gate, and the D13 / §7.10 PHI-minimization core
// (the `VendorOutboundPayload` discriminated union, `minimizeForVendor`, and the runtime
// `assertVendorPayloadMinimized` guard the packet-capture test asserts against).
//
// Concrete vendor adapters are deliberately absent: D3 keeps the `hybrid` / `centralized` models
// structurally complete but feature-flagged OFF pending a per-customer BAA and Compliance-approved
// profile, and ADR-013 (vendor selection) is still Proposed. Phase 1 ships `direct` only.
export * from "./interface";
export * from "./minimization";
