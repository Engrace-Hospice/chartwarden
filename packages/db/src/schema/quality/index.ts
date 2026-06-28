// @wardenx/db — M30 HQRP & Quality schema barrel (§3.3, 18 tables). Re-exported from the central
// schema barrel (../index.ts). Ordering follows FK dependency: the measures subdomain, then the
// compliance-program subdomain (qapi_program → indicator/project/pip/minutes; sra_cycle → finding →
// remediation; cop_compliance_status), then the safety-surveillance subdomain. Four tables are
// monthly-partitioned (cahps_decedent_sample, incident_report, mortality_review,
// infection_surveillance_event) — the Drizzle shape here is logical; the PARTITION BY + RLS + grants +
// M4 write-audit triggers land in the M30 tables/RLS/audit migrations. jsonb payload types live in
// ./types. (risk_register_view is a materialized view, not an owned base table — defined in migration.)

// jsonb payload helper types.
export * from "./types";

// measures subdomain (5)
export * from "./quality-measure-value";
export * from "./measure-recompute-queue";
export * from "./cahps-vendor-binding";
export * from "./cahps-decedent-sample";
export * from "./cahps-result-summary";

// compliance-program subdomain (9)
export * from "./qapi-program";
export * from "./qapi-indicator";
export * from "./qapi-project";
export * from "./qapi-pip";
export * from "./qapi-governance-minutes";
export * from "./sra-cycle";
export * from "./sra-finding";
export * from "./sra-remediation";
export * from "./cop-compliance-status";

// safety-surveillance subdomain (4)
export * from "./incident-report";
export * from "./mortality-review";
export * from "./infection-surveillance-event";
export * from "./infection-outbreak-case";
