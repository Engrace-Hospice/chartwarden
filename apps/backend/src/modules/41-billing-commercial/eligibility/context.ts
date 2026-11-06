// apps/backend/src/modules/41-billing-commercial/eligibility/context.ts - the per-call ClearinghouseContext for a commercial send.
//
// Same platform rules as M23 (ADR-0053 D3): the usage mode comes from platform config (`test` is refused in production), and the
// billing NPI comes from the provider entity (M1 owns the table, the composition root injects the reader), never from a request.
// The payer id is the one the bound clearinghouse routes the plan on (commercial_payer_route), supplied by the send gate.
// A tenant's own clearinghouse carries its own usage mode: `usageFor` supplies it per organization and wins over the platform value.
import { randomUUID } from "node:crypto";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { clearinghouseUsageFromEnv } from "../../23-billing-medicare/jobs/clearinghouse-context";
import type { CommercialContextPort } from "./service";

export interface CommercialContextDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The provider entity's NPI (M1 owns the table), or null when unknown. */
  readonly providerNpi: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string | null>;
  /**
   * The usage mode of ONE organization's own clearinghouse. A value replaces the platform usage for that organization only; null
   * (the organization has none of its own) or an absent dependency keeps the platform usage.
   */
  readonly usageFor?: (organizationId: string) => Promise<ClearinghouseContext["usage"] | null>;
}

export function buildCommercialContextPort(deps: CommercialContextDeps): CommercialContextPort {
  const platformUsage = clearinghouseUsageFromEnv(deps.env);
  return {
    async contextFor(organizationId, providerEntityId, clearinghousePayerId) {
      const billingNpi = await deps.providerNpi(organizationId, providerEntityId);
      if (!billingNpi) return null;
      const usage = (await deps.usageFor?.(organizationId)) ?? platformUsage;
      return {
        organizationId,
        providerEntityId,
        payerId: clearinghousePayerId,
        correlationId: randomUUID(),
        usage,
        billingNpi,
      };
    },
  };
}
