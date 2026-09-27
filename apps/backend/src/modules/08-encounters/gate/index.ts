// apps/backend/src/modules/08-encounters/gate — the §2.6 Layer-3 compliance gate (#121). Barrel.
export {
  EVALUATED_CHECKS,
  GATE_CHECKS,
  type GateCheck,
  type GateCheckId,
  type GateCheckState,
} from "./checks";
export {
  type EncounterGateFacts,
  type GateRemediation,
  type GateResult,
  type GateSectionSelection,
  assertGatePassed,
  runAddendumComplianceGate,
  runEncounterComplianceGate,
} from "./gate";
export { type VitalsRowFacts, deriveVitalsGateFacts } from "./vitals-facts";
