// apps/backend/src/modules/23-billing-medicare/routes/dde-provider-status.routes.ts — ADR-0103 D2: read-only platform
// status of the DDE access provider binding (#761). Platform configuration, not tenant data: no database read, no PHI,
// no credentials, so no RLS surface. Gated on the platform administrator's key; the binding is fixed at boot.
import type { DdeProviderVendor } from "@chartwarden/x12-837-client";
import type { FastifyInstance } from "fastify";
import { P } from "./guards";

export interface DdeProviderStatus {
  /** The bound vendor, or `manual` when none is (every send answers DDE_NOT_WIRED). */
  readonly provider: "manual" | DdeProviderVendor;
  readonly wired: boolean;
}

export interface DdeProviderStatusDeps {
  /** The vendor the platform bound at boot, or null for manual keying. */
  readonly ddeProviderVendor: DdeProviderVendor | null;
}

const PLATFORM_ADMIN = P("billing.rule_config.platform_admin");

export function registerDdeProviderStatusRoutes(
  app: FastifyInstance,
  deps: DdeProviderStatusDeps,
): void {
  const status: DdeProviderStatus = {
    provider: deps.ddeProviderVendor ?? "manual",
    wired: deps.ddeProviderVendor !== null,
  };
  app.get(
    "/api/v1/admin/billing/dde-provider",
    { preHandler: [PLATFORM_ADMIN] },
    async () => status,
  );
}
