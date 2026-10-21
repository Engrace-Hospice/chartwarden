// apps/backend/src/modules/16-bereavement/lifecycle — the M16 §2.2–§2.6 domain core (M16-T03).
//
// Three pure state machines over already-resolved facts, plus the D4 schedule materialization, the §2.6
// cascade deciders and the §2.5 standalone guards. Nothing here touches IO: each transition returns its new
// state plus a DECLARATIVE side-effect list (./effects) that the M16-T06 service layer executes inside the
// aggregate's optimistic-locked transaction, so the domain row, the M4 audit row and the §4.4 outbox row
// commit together or not at all.
//
//   • ./plan      §2.2 — eligible → initiating → active ⇄ paused → closed_{completed,declined,early},
//                 with M4's legal hold as an orthogonal retention extension and the intake factory the
//                 `m6.bereavement.eligible` consumer calls
//   • ./contact   §2.3 — the per-survivor lifecycle: consent-gated confirm, the D9 opt-out + 90-day
//                 rescind, the 3-strikes unreachable proposal, the §7.7 complicated-grief referral
//   • ./outreach  §2.4 — the touchpoint lifecycle + the D15 M8-encounter binding rule
//   • ./schedule  D4 — the death-anchored cadence floor materialized into `bereavement_outreach` rows
//   • ./cascades  §2.6 — the D9 patient-flag flip, the M39 consent-revocation cascade, the D6 roster close
//   • ./validation §2.5 — the guards that belong to paths which do not move state (D18 gate, `If-Match`)
//   • ./errors    the §2.5 / §4.2 code → status catalog on the M1 `ChartWardenError` envelope
export * from "./effects";
export * from "./errors";
export * from "./plan";
export * from "./contact";
export * from "./outreach";
export * from "./schedule";
export * from "./cascades";
export * from "./validation";
export * from "./early-close";
export * from "./outreach-encounter";
