// M25 Remittance & Denials — pure-domain barrel. These modules carry the deterministic revenue-cycle
// logic (no DB, no IO): the three-strategy auto-match (D3), the two-tier posting routing (D4/D5), the
// per-line posting outcome (§2.4), the denial + appeal state machines (§2.2), the appeal-tier deadline
// clock (D6/F04), and denial aging (§1.1). The Phase-3 services wrap these with persistence, outbox
// emission, seams, and routes.
export * from "./types";
export * from "./aging";
export * from "./deadline";
export * from "./classify";
export * from "./posting";
export * from "./match";
export * from "./denial-machine";
export * from "./appeal-machine";
export * from "./manual-posting";
export * from "./adr-deadline";
export * from "./adr-machine";
export * from "./adr-packet-rules";
export * from "./denial-route";
export * from "./reopening-machine";
