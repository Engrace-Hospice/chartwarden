// apps/backend/src/modules/19-oncall/lifecycle — the M19 §2.2–§2.7 domain core (M19-T03).
//
// The triage-call machine, the protocol engine, the escalation ladder, the disposition matrix and the BCP
// re-entry path — all PURE, over already-resolved facts. Nothing here touches IO: each transition returns
// its new state plus a DECLARATIVE side-effect list (./effects) that the M19-T07 route layer executes
// inside the aggregate's transaction, so the `triage_call` row, its append-only
// `triage_call_state_history` row, the M4 audit row and the §4.10 outbox row commit together or not at all.
//
//   • ./triage-call      §2.2.1 / D6 / D8 — the nine-state call machine. The transition table is a
//                        WHITELIST (two legal edges run backwards), and disposition selection parks the
//                        call in `documented_pending_encounter` until `m8.encounter.signed` lands
//   • ./protocol         §2.2 / §2.3 / D4 / D5 / §7.3 — apply-and-pin, the server-authoritative ordered
//                        walk (`PROTOCOL_QUESTION_OUT_OF_ORDER`), and the red-flag evaluator
//   • ./protocol-catalog §1.1 / §3.2 Phase E — the 28 platform-floor protocols migration 0109 seeds,
//                        including D7's four mandatory-escalation rows
//   • ./escalation       §2.2.4 / D7 / §7.2 — the ladder's three-step life and the one rule that carries
//                        the module: a mandatory escalation is never auto-resolved by a call close
//   • ./disposition      D6 / §6 / §7.3 — the role × disposition scope matrix and the per-arm payload
//                        validation, plus the outbox/seam effects each disposition carries
//   • ./paper-reentry    §2.7 / M19-F08 / DR-013 — outage detection by absence, the 72-hour worklist, and
//                        the paper-origin coherence guard
//   • ./effects          §2.4 — the declarative side-effect vocabulary (closed timestamp-column union)
//   • ./errors           the §2.3 / §7 code → status catalog on the M1 `WardenXError` envelope
export * from "./effects";
export * from "./errors";
export * from "./protocol";
export * from "./protocol-catalog";
export * from "./escalation";
export * from "./disposition";
export * from "./triage-call";
export * from "./paper-reentry";
