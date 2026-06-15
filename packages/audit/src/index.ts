// @wardenx/audit — the audit() / auditRead() foundation helper (M1-T12, spec §6–§8).
//
// The canonical, helper-only writer of the M1-owned `audit_event` table: it redacts PHI
// snapshots against the field denylist and files each event under a retention class. Every
// module reaches the audit log through this surface — never a direct schema insert.
export * from "./audit";
export * from "./denylist";
export * from "./retention";
