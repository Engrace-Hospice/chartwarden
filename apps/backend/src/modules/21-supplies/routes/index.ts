// apps/backend/src/modules/21-supplies/routes/index.ts — M21 route-service surface barrel.
// The split `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders
// the composition root binds (the M15/M16/M24/M25/M26 routes/index.ts precedent).
export type {
  CatalogFilters,
  ComfortKitReturnDetail,
  ComfortKitReturnListItem,
  ComfortKitReturnedLineView,
  ComfortKitTemplateMedicationView,
  ComfortKitTemplateView,
  DispatchDetail,
  DispatchFilters,
  DispatchListItem,
  M21ReadService,
  ParStockFilters,
  ParStockView,
  PerpetualLogLineView,
  PerpetualLogView,
  ReturnFilters,
  RoutingRuleFilters,
  SupplyItemView,
  SupplyRequestDetail,
  SupplyRequestFilters,
  SupplyRequestListItem,
  TemplateFilters,
  VendorRoutingRuleView,
} from "./read-service";
export type {
  AlertPort,
  CreateSupplyRequestResult,
  M21WriteService,
  OutboxEmission,
  ReconcileReturnResult,
  WriteOutboxPort,
} from "./write-service";
export { type M21ReadDeps, buildDrizzleM21ReadService } from "./read-service-drizzle";
export {
  type DispatcherEligibilityProbe,
  type M21WriteDeps,
  type VendorActiveProbe,
  buildDrizzleM21WriteService,
} from "./write-service-drizzle";
export {
  type M21MutatingActor,
  type M21ReadActor,
  type M21WriteActor,
  actorOf,
  mutatingActorOf,
  writeActorOf,
} from "./actor";
export {
  type CursorPage,
  M21_PAGE_SIZES,
  clampLimit,
  decodeCursor,
  encodeCursor,
  ifMatchStamp,
  rejectOffsetPagination,
  requireIdempotencyKey,
  toCursorPage,
} from "./concurrency";
export {
  type EffectContext,
  type EffectPatch,
  MissingOutboxPayloadError,
  UNHANDLED_EFFECT_KINDS,
  UnknownTimestampFieldError,
  runEffects,
} from "./effects-runner";

import type { M21ReadService } from "./read-service";
import type { M21WriteService } from "./write-service";

/** The two services every M21 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M21RouteServices {
  readonly readService: M21ReadService;
  readonly writeService: M21WriteService;
}
