// apps/backend/src/bootstrap/interfaces.ts — the M1 bootstrap's view of the seam +
// eraser contracts. Per ADR-0005 D1/D3 the INTERFACES live in the leaf @wardenx/types
// (never in a packages/foundation); this file just re-exports them so the registry,
// providers, and consumers share one import site.
export type {
  AuditorSessionMinter,
  CaseloadProvider,
  ConsentEvaluator,
  DataClass,
  DataEraser,
  DocumentRenderer,
  OrgScope,
  PatientReader,
  RequiredSeam,
  ResolvedActor,
  SeamContracts,
  SeamName,
  SessionContextResolver,
  SessionStepUpFields,
} from "@wardenx/types";
