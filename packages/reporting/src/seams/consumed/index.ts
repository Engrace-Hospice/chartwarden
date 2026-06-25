// @wardenx/reporting — consumed-seam barrel (M33 §4.4).
//
// Every clinical/billing module's read seam M33 consumes through the M1 SeamRegistry (`getSeam`) — no
// import edge. PRESENT producers (M5–M14, M17, M18, M22, M39, M40) expose a consumer-defined interface
// bound to the live seam at boot (P2C); ABSENT producers (M15/M16/M19/M20/M21/M23/M24/M25/M26/M27/M28
// and the explicit M30 forward seam) ship a forward-seam DENY-STUB (interface + `denyStub…` value)
// resolving `FORWARD_SEAM_UNAVAILABLE` until the owning module lands.
export * from "./forward-seam";
// PRESENT producers (consumer interfaces only — bound to live seams via getSeam at boot, P2C).
export * from "./m5-patient";
export * from "./m6-admission";
export * from "./m7-care-plan";
export * from "./m8-encounter";
export * from "./m9-assessment";
export * from "./m10-hope";
export * from "./m11-orders";
export * from "./m12-dosespot";
export * from "./m13-emar";
export * from "./m14-idg";
export * from "./m17-scheduling";
export * from "./m18-evv";
export * from "./m22-documents";
export * from "./m39-consent";
export * from "./m40-mdm";
// ABSENT producers (consumer interface + forward-seam deny-stub value).
export * from "./m15-discipline";
export * from "./m16-bereavement";
export * from "./m19-triage";
export * from "./m20-field-safety";
export * from "./m21-supply";
export * from "./m23-billing";
export * from "./m24-medicaid";
export * from "./m25-remittance";
export * from "./m26-cap";
export * from "./m27-cost-report";
export * from "./m28-fhir";
export * from "./m30-hqrp";
