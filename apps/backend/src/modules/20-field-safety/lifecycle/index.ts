// apps/backend/src/modules/20-field-safety/lifecycle — M20-T03. The §2.2 domain core: the SOS machine and
// its SLA watchdog, the D4 overdue-escalation ladder, the D6 continuous-location gates, the §7.8 coverage-gap
// watchdog, and the §2.2.4 policy resolver every one of them reads its thresholds from.
//
// Everything here is PURE — injected facts in, a new state plus a declarative side-effect list out. The
// route layer (M20-T06) and the §4.8 workers execute the effects inside one transaction.
export * from "./errors";
export * from "./effects";
export * from "./policy";
export * from "./sos-alert";
export * from "./sos-escalator";
export * from "./check-in-overdue";
export * from "./location-stream";
export * from "./coverage-gap";
