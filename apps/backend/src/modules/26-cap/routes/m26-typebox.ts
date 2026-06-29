// apps/backend/src/modules/26-cap/routes/m26-typebox.ts — the M26 route request/response TypeBox schemas the
// OpenAPI enrichment registry (scripts/openapi/enrichments.ts) layers onto the auto-discovered §4.1 routes.
// The request bodies are the SAME §4.2 contract schemas defined in @wardenx/cap-management (re-exported here
// so the enrichment import path matches `modules/26-cap/routes/*`, the M23 billing-typebox precedent); the
// list/detail response schemas are assembled from the same DTOs so the contract cannot drift from the data.
import { Type } from "@sinclair/typebox";
import { contracts } from "@wardenx/cap-management";

// ── request bodies (§4.2) ──
export const OpenCapPeriodRequest = contracts.OpenCapPeriodRequest;
export const LockMethodologyRequest = contracts.LockMethodologyRequest;
export const CloseCapPeriodRequest = contracts.CloseCapPeriodRequest;
export const ReopenCapPeriodRequest = contracts.ReopenCapPeriodRequest;
export const AcknowledgeEventRequest = contracts.AcknowledgeEventRequest;
export const PsrImportRequest = contracts.PsrImportRequest;
export const ResolveVarianceRequest = contracts.ResolveVarianceRequest;
export const FinalizeSettlementRequest = contracts.FinalizeSettlementRequest;
export const PublishConstantRequest = contracts.PublishConstantRequest;
export const AmendConstantRequest = contracts.AmendConstantRequest;

// ── response shapes (assembled from the §4.2 DTOs) ──
export const CapPeriodDto = contracts.CapPeriodDto;
export const CapPeriodListResponse = Type.Array(contracts.CapPeriodDto);
export const ProjectionSnapshotDto = contracts.ProjectionSnapshotDto;
export const ProjectionListResponse = Type.Array(contracts.ProjectionSnapshotDto);
export const InpatientProjectionDto = contracts.InpatientProjectionDto;
export const SettlementDto = contracts.SettlementDto;
