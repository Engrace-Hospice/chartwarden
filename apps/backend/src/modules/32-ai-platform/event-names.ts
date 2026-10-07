// apps/backend/src/modules/32-ai-platform/event-names.ts - the 21 `m32.*` event names (GAP-161), kept in a
// leaf file so the emitter and its callers type their emits without importing the TypeBox catalog.
export const M32_EVENT_NAMES = [
  "m32.capability.created",
  "m32.capability.transitioned",
  "m32.capability.calibrated",
  "m32.tenant_opt_in.recorded",
  "m32.tenant_opt_in.revoked",
  "m32.clinician_opt_out.recorded",
  "m32.capability.invoked",
  "m32.phi.disclosed",
  "m32.local_inference.recorded",
  "m32.output.accepted",
  "m32.output.edited",
  "m32.output.rejected",
  "m32.output.flagged",
  "m32.kill_switch.activated",
  "m32.kill_switch.deactivated",
  "m32.hallucination_report.filed",
  "m32.hallucination_report.triaged",
  "m32.prompt_template.activated",
  "m32.routing_override.set",
  "m32.evaluation.completed",
  "m32.drift.detected",
] as const;

export type M32EventName = (typeof M32_EVENT_NAMES)[number];
