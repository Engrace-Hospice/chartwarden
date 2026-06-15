// @wardenx/audit — capture path: PHI write-audit triggers (§2.1 "trigger write", §3.3, §5).
//
// The canonical write-audit trigger *generator* (M4-T02, §3.3): `generate.ts` emits the per-table
// `audit_phi_write_<table>` SECURITY DEFINER trigger DDL into audit_event, and `scrub.ts` resolves
// the high-sensitivity column denylist (explicit columns + the named §5.1/D10 categories) and ships
// the `audit_scrub` SQL helper. M4-T07 layers the DB-backed category catalog + row-conditional
// `sud_value` scrub on top; M4-T10 back-fills the M1–M3 baseline triggers through this generator.
export * from "./catalog";
export * from "./generate";
export * from "./scrub";
