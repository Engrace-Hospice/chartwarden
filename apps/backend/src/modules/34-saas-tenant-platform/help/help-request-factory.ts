// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-factory.ts — the two ways the composition root builds the service.
//
// `buildDrizzleHelpRequestService` is the production one (the tenant pool and the audited platform credential, the real catalog-
// validating publisher, piece 7S's grant operations); `createInMemoryHelpRequestService` is the slice `mountTenantPlatformRoutes`
// falls back to when no database client is wired (route tests), with a fake grant bundle so approve and End help work end to end.
import type { DbClient } from "@chartwarden/db";
import type { SupportGrantOperations } from "@chartwarden/saas-tenant-platform";
import type { PlatformBypassAuditor } from "@chartwarden/tenancy";
import type { HelpRequestService } from "./help-request-contract";
import { createMemorySupportGrantOperations } from "./help-request-grants-memory";
import { type HelpOutboxPort, createHelpRequestService } from "./help-request-service";
import {
  type DrizzleHelpRequestRunnerDeps,
  createDrizzleHelpRequestRunner,
} from "./help-request-store-drizzle";
import {
  type MemoryHelpState,
  createMemoryHelpRequestRunner,
  createMemoryHelpState,
} from "./help-request-store-memory";

export interface DrizzleHelpRequestServiceDeps {
  readonly db: DbClient;
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
  readonly platformJobId: string;
  readonly outbox: HelpOutboxPort;
  /** Piece 7S's bundle (`createUnboundSupportGrantOperations()` until it is bound: approving then answers 501). */
  readonly grants: SupportGrantOperations;
  readonly now?: () => Date;
}

export function buildDrizzleHelpRequestService(
  deps: DrizzleHelpRequestServiceDeps,
): HelpRequestService {
  const now = deps.now ?? (() => new Date());
  const runnerDeps: DrizzleHelpRequestRunnerDeps = {
    db: deps.db,
    platformDb: deps.platformDb,
    auditBypass: deps.auditBypass,
    platformJobId: deps.platformJobId,
    now,
  };
  return createHelpRequestService({
    runner: createDrizzleHelpRequestRunner(runnerDeps),
    grants: deps.grants,
    outbox: deps.outbox,
    now,
  });
}

/** The in-memory slice: one tenant, no database, a fake grant bundle. Returns its state so a test can seed and inspect it. */
export function createInMemoryHelpRequestService(
  state: MemoryHelpState = createMemoryHelpState(),
): {
  readonly service: HelpRequestService;
  readonly state: MemoryHelpState;
} {
  const service = createHelpRequestService({
    runner: createMemoryHelpRequestRunner(state),
    grants: createMemorySupportGrantOperations(state),
    outbox: { publish: async () => undefined },
    now: () => state.now(),
  });
  return { service, state };
}
