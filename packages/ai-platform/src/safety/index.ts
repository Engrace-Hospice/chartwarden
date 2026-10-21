// @chartwarden/ai-platform — §3.2.10/§3.2.11/§3.2.12 safety governance (M32-T05).
//
//   · ./kill-switch            §3.2.12/W3 — the mixed-scope switch, its attribution rules and D16's demotion
//   · ./hallucination-triage   §3.2.10/D9/W5 — file → triage → follow-up, with the follow-up COMPUTED
//   · ./evaluation-run         §3.2.11/D10/W6 — the run's lifecycle and whether it evidences a §2.2 edge
//
// Every export is PURE. The stores, the §4.8 workers and the M36 alert publishes live in
// `apps/backend/src/modules/32-ai-platform/safety`.
export * from "./kill-switch";
export * from "./hallucination-triage";
export * from "./evaluation-run";
