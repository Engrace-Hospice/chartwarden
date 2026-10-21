// @chartwarden/ai-platform — §2.2 capability lifecycle (M32-T01).
//
//   · ./state-machine   D2's eight-state governance FSM + the consumer-facing posture each state
//                       implies. Pure; no IO. M32-T03 writes `ai_capability_lifecycle_event` rows
//                       through it, M32-T05 trips D16's demotion through `aiSev1DemotionTarget`.
export * from "./state-machine";
