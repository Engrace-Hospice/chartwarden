// @wardenx/ai-platform — §2.2/§3.2.3/§5.3/§5.4 governance rules (M32-T03).
//
//   · ./errors                 the T03 refusal catalog + the M1 error envelope
//   · ./capability-lifecycle   who may walk a §2.2 edge, with what evidence, and what the row becomes
//   · ./calibration            §3.2.3's supersede-then-insert publication plan (R5/W6)
//   · ./tenant-opt-in          §5.3/W4's acknowledgment gate and the opt-in/pause/withdraw patches
//   · ./clinician-opt-out      §5.4/§10.3's personal opt-out and revert
//   · ./capability-access      the three gates composed into the §2.2/W9 envelope
//
// Every export is PURE. The Drizzle stores and the services that sequence them live in
// `apps/backend/src/modules/32-ai-platform/governance`.
export * from "./errors";
export * from "./capability-lifecycle";
export * from "./calibration";
export * from "./tenant-opt-in";
export * from "./clinician-opt-out";
export * from "./capability-access";
