// @wardenx/audit — the audit() / auditRead() foundation helper (M1-T12, spec §6–§8) +
// the Module 4 capture-architecture skeleton (M4-T01, M4 spec §2.1, §3.1).
//
// The canonical, helper-only writer of the M1-owned `audit_event` table: it redacts PHI
// snapshots against the field denylist and files each event under a retention class. Every
// module reaches the audit log through this surface — never a direct schema insert.
//
// Capture-architecture layout (§2.1 two capture paths feeding the one M1 table, plus M4's
// query/integrity/lifecycle layers). Each subdirectory is the reserved home for its layer;
// the modules fill in over M4-T02…T11:
//   triggers/   — capture: PHI write-audit trigger generator   (M4-T02, §3.3, §5)
//   read/       — capture: PHI read-audit declaration + lint    (M4-T03, §3.4)
//   query/      — Query & Reporting + accounting of disclosures (M4-T06/T09, §4, §7)
//   lifecycle/  — destruction eraser + certificate workflow      (M4-T08, §6, §10.5–10.6)
//   integrity/  — append-only verify + hash-chain seal          (M4-T05/T11, §3.5, §10.4)
//   export/     — csv/ndjson/pdf compliance exports             (M4-T11, §4.4)
//   actions/    — the typed action catalog + boot validation     (M4-T10, §4.6)
//   retention.ts — retention-class registry (M1; lifecycle workflow extends it, M4-T08, §6)

// --- M1 foundation helper ---------------------------------------------------------
export * from "./audit";
export * from "./denylist";
export * from "./retention";

// --- M4 capture-architecture skeleton (placeholders until each task lands) ---------
export * from "./triggers";
export * from "./read";
export * from "./query";
export * from "./lifecycle";
export * from "./integrity";
export * from "./export";
export * from "./actions";
export * from "./jobs";
