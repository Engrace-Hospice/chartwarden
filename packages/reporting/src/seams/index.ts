// @wardenx/reporting — seam barrel (M33 §4.3 + §4.4).
//
// The three seams M33 PUBLISHES (./published — MetricsProvider / DashboardCatalogProvider /
// ScheduledReportProvider) plus the consumer-defined views + forward-seam deny-stubs of every seam M33
// CONSUMES (./consumed). The boot-time registration of the publishes + binding of the consumes lives in
// ../seam-registration (the P2C wiring site).
export * from "./published";
export * from "./consumed";
