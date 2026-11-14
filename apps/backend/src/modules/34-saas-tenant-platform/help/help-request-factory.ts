// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-factory.ts — the two ways the composition root builds the service.
//
// `buildDrizzleHelpRequestService` is the production one (the tenant pool and the audited platform credential, the real catalog-
// validating publisher, piece 7S's grant operations); `createInMemoryHelpRequestService` is injected explicitly by route tests,
// with a fake grant bundle so approve and End help work end to end. A missing production binding fails closed.
import type { DbClient } from "@chartwarden/db";
import type { SupportGrantOperations } from "@chartwarden/saas-tenant-platform";
import type { PlatformBypassAuditor } from "@chartwarden/tenancy";
import { notBuilt } from "../not-built";
import type { HelpRequestService } from "./help-request-contract";
import { createMemorySupportGrantOperations } from "./help-request-grants-memory";
import {
  type HelpAlertPort,
  type HelpOutboxPort,
  createHelpRequestService,
} from "./help-request-service";
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
  readonly alerts: HelpAlertPort;
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
  /** Piece 7S's integrated support-grant operation bundle. */
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
    alerts: deps.alerts,
    ...(deps.warn ? { warn: deps.warn } : {}),
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
    alerts: { emit: async () => undefined },
    now: () => state.now(),
  });
  return { service, state };
}

/** Fail-closed route binding for a composition that omitted the database-backed help service. */
export function createUnboundHelpRequestService(): HelpRequestService {
  const refuse = async (): Promise<never> => {
    throw notBuilt("tenant help requests");
  };
  return {
    listForTenant: refuse,
    file: refuse,
    approve: refuse,
    close: refuse,
    listForPlatform: refuse,
    resolve: refuse,
  };
}
