// @wardenx/quality — consumed-seam barrel (M30 §4.4).
//
// Every upstream module's read seam M30 consumes through the M1 SeamRegistry (`getSeam`) — no import
// edge. PRESENT producers (M5–M14, M17, M18, and M33's published MetricsProvider) expose a
// consumer-defined interface bound to the live seam at boot (P2C); ABSENT producers (M15 Discipline /
// M16 Bereavement / M23 Billing / M27 Cost Report) ship a forward-seam DENY-STUB (interface + `denyStub…`
// value) resolving `FORWARD_SEAM_UNAVAILABLE` until the owning module lands.
export * from "./forward-seam";
// PRESENT producers (consumer interfaces only — bound to live seams via getSeam at boot, P2C).
export * from "./m5-patient";
export * from "./m6-admission";
export * from "./m7-care-plan";
export * from "./m8-encounter";
export * from "./m9-assessment";
export * from "./m10-hope";
export * from "./m11-orders";
export * from "./m12-medication-order";
export * from "./m13-emar";
export * from "./m14-idg";
export * from "./m17-scheduling";
export * from "./m18-evv";
export * from "./m33-metrics";
// ABSENT producers (consumer interface + forward-seam deny-stub value).
export * from "./m15-discipline";
export * from "./m16-bereavement";
export * from "./m23-billing";
export * from "./m27-cost-report";
