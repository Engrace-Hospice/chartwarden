// @wardenx/audit — Query & Reporting + Accounting of Disclosures (§2.1, §4, §7).
//
// M4-T06 (§4.1–4.3) lands the audit-log search/filter/pagination surface + the per-patient
// access history ("who touched this chart", §10.2). The §164.528 patient accounting-of-
// disclosures query with scope differentiation (M4-T09, §7) extends this surface.
export * from "./audit-query";
