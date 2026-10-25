import type { DdeProviderVendor } from "@chartwarden/x12-837-client";
import type { ClaimAssemblyService } from "../services/claim-assembly";
import type { ClearinghouseAttemptResolutionService } from "../services/clearinghouse-attempt-resolution-service";
import type { DdeQueueService } from "../services/dde-queue-service";
import type { TransferNoticeService } from "../services/transfer-notice-service";
import type { PlatformAdminRouteService } from "./platform-admin-service";
// apps/backend/src/modules/23-billing-medicare/routes/index.ts — M23 route-service barrel.
//
// The split READ + WRITE route services the §4.1 M23 route plugins compose over (the M27 `M27RouteServices`
// precedent), the request-scoped actor resolvers, the cursor / idempotency / If-Match helpers, the §4.6/§4.7
// guard builders, and the `parse(...)` request validator. The route plugins land in this slice; this barrel
// publishes the service CONTRACTS + the Drizzle-backed factories so the composition root binds them at boot.
//
// The read + write surfaces share no method name (the M27 combined-service precedent); the assembly service
// is a THIRD dep (route #1 `POST /claims/assemble` resolves its M5/M6/M8/M18/M38/M40 reader seams + the
// HIPPS/SIA/sequestration math through it, NOT the write service's low-level persistence path).
import type { RateTableRouteService } from "./rate-table-service";

export {
  type VisitChargeRouteService,
  buildDrizzleVisitChargeService,
  visitChargeVersionsForOrg,
} from "./visit-charge-service";
import type { M23ReadRouteService } from "./read-service";
import type { SequestrationPolicyRouteService } from "./sequestration-policy-service";
import type { VisitChargeRouteService } from "./visit-charge-service";
import type { WageIndexRouteService } from "./wage-index-service";
import type { M23WriteRouteService } from "./write-service";

export {
  type M23ReadActor,
  type M23WriteActor,
  type PreHandler,
  actorOf,
  writeActorOf,
  rejectAiActor,
} from "./actor";

export {
  type CursorKeyset,
  type CursorPage,
  IdempotencyKeyRequiredError,
  IfMatchRequiredError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  pageSizeOf,
  parseIfMatch,
  requireIdempotencyKey,
  requireIfMatch,
} from "./concurrency";

export { parse } from "./billing-typebox";

export {
  P,
  PROVIDER_SCOPE,
  CLAIM_CASELOAD,
  OVERRIDE_ELIGIBLE,
  RULE_PROTECTED,
  CASELOAD_OR_SCOPE,
  STEP_UP,
  requireSystemPrincipal,
} from "./guards";

export type { M23ReadRouteService } from "./read-service";
export type { M23WriteRouteService } from "./write-service";
export type {
  AuditEventPort,
  JobEnqueuePort,
  M23WriteServicePorts,
  ProviderCcnPort,
  SecretCipherPort,
  WriteOutboxPort,
} from "./write-service";

export { type M23ReadServicePorts, buildDrizzleM23ReadService } from "./read-service-drizzle";
export { buildDrizzleM23WriteService } from "./write-service-drizzle";
export {
  type MacSecretCipher,
  buildMacSecretCipher,
  buildMacSecretCipherFromEnv,
  loadMacSecretKek,
} from "./secret-cipher";

/** The combined READ + WRITE route service (no method-name overlap — the M27 combined-service precedent). */
export type M23CombinedRouteService = M23ReadRouteService & M23WriteRouteService;

/** The split route-service deps the §4.1 M23 route plugins mount over (read + write + claim assembly). */
export interface M23RouteServices {
  readonly readService: M23ReadRouteService;
  readonly writeService: M23WriteRouteService;
  readonly assemblyService: ClaimAssemblyService;
  /** F-210 — the tenant-entered hospice rate-table service (absent ⇒ the /billing/rate-tables routes are not mounted). */
  readonly rateTableService?: RateTableRouteService;
  /** Migration 1056 — the tenant-entered visit-charge schedule service (absent ⇒ /billing/visit-charge-schedules is not mounted). */
  readonly visitChargeService?: VisitChargeRouteService;
  /** F-211 — the tenant-entered wage-index service (absent ⇒ the /billing/wage-indexes routes are not mounted). */
  readonly wageIndexService?: WageIndexRouteService;
  /** ADR-0103 D2 — the vendor the platform bound for DDE at boot (null = manual); absent => the status route is not mounted. */
  readonly ddeProviderVendor?: DdeProviderVendor | null;
  /** GAP-144 — the platform-admin commands (#41 platform-rules, #42 wage-index load); absent => not mounted. */
  readonly platformAdminService?: PlatformAdminRouteService;
  /** F-212 — the tenant-entered sequestration-policy service (absent ⇒ the /billing/sequestration-policies routes are not mounted). */
  readonly sequestrationService?: SequestrationPolicyRouteService;
  /** The Medicare transfer notice (8xC / 8xD) service (absent ⇒ /billing/transfer-notices is not mounted). */
  readonly transferNoticeService?: TransferNoticeService;
  /** ADR-0052 — the DDE work-queue service (absent ⇒ /billing/dde-items is not mounted). */
  readonly ddeQueueService?: DdeQueueService;
  /** ADR-0053 — settles a clearinghouse attempt past the vendor's window (absent ⇒ /billing/clearinghouse-attempts is not mounted). */
  readonly attemptResolutionService?: ClearinghouseAttemptResolutionService;
}

export {
  type PlatformAdminRouteService,
  buildDrizzlePlatformAdminService,
} from "./platform-admin-service";
export {
  type WageIndexRouteService,
  buildDrizzleWageIndexService,
  resolveWageIndexForOrg,
} from "./wage-index-service";

export {
  type RateTableRouteService,
  buildDrizzleRateTableService,
  hospiceRateTableEffectiveForOrg,
} from "./rate-table-service";

export {
  type SequestrationPolicyRouteService,
  buildDrizzleSequestrationPolicyService,
} from "./sequestration-policy-service";
