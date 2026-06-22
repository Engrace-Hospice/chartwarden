// apps/backend/src/modules/08-encounters/cosignature — M8-T06 (§2.4 D3 cosignature workflow).
//
// The pure cosignature-request domain: the §2.4 request state machine (routed → acknowledged → signed;
// 24h escalation, 48h hard cap + supervisor release) and the hour-based 12h/24h/48h SLA clock the §4.3
// cron sweep drives. Every fact (the routed/now instants, the cosigner's RN eligibility, the
// supervisor flag) is injected, so the machine is deterministic and unit-testable with no DB. The
// service layer (M8-T09) composes these with the encounter machine's `recordCosignature` to flip the
// encounter to `cosigned`; the SLA events fan out via the §4.4 `m8.*` outbox (M36/M33).
export {
  COSIGNATURE_GRAPH,
  planCosignatureCreation,
  transitionCosignature,
  type CosignatureEvent,
  type CosignatureState,
  type CosignatureTransition,
} from "./cosignature";
export {
  COSIGNATURE_SLA_HOURS,
  addHours,
  computeCosignatureSlaDeadlines,
  decideCosignatureSlaStage,
  hoursBetween,
  type CosignatureSlaDeadlines,
  type CosignatureSlaStage,
} from "./sla-clock";
