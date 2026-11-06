// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts — the per-call ClearinghouseContext the M23
// workers hand the bound transport (ADR-0053 D3, #707). The MAC jurisdiction comes from the provider entity's submitter
// credential (M23's own table, the row the legacy portal resolves its jurisdiction from). The provider's NPI belongs to
// M1's `provider_entity`, so the composition root injects it (`providerNpi`) instead of this module reading that table.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { clearinghouseUsageFromEnv } from "@chartwarden/x12-837-client";
import { and, eq } from "drizzle-orm";
import type { ClearinghouseContextPort } from "./clearinghouse-submission";

export const CLEARINGHOUSE_PAYER_ID_ENV = "CLEARINGHOUSE_PAYER_ID";

type EnvMap = Readonly<Record<string, string | undefined>>;

export interface ClearinghouseContextDeps {
  readonly db: DbClient;
  readonly env: EnvMap;
  /** The provider entity's NPI (M1 owns the table), or null when unknown. */
  readonly providerNpi: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string | null>;
}

export function buildClearinghouseContextPort(
  deps: ClearinghouseContextDeps,
): ClearinghouseContextPort {
  const usage = clearinghouseUsageFromEnv(deps.env);
  const payerOverride = deps.env[CLEARINGHOUSE_PAYER_ID_ENV]?.trim();
  return {
    async contextFor(organizationId, providerEntityId) {
      const credential = await withOrgContext(
        deps.db,
        { organizationId, userId: "" },
        async (tx) => {
          const [row] = await tx
            .select({ macJurisdiction: schema.macSubmitterCredential.macJurisdiction })
            .from(schema.macSubmitterCredential)
            .where(
              and(
                eq(schema.macSubmitterCredential.organizationId, organizationId),
                eq(schema.macSubmitterCredential.providerEntityId, providerEntityId),
              ),
            )
            .limit(1);
          return row;
        },
      );
      const billingNpi = await deps.providerNpi(organizationId, providerEntityId);
      if (!credential || !billingNpi) {
        throw new Error(
          "clearinghouse context: provider entity has no MAC submitter credential or NPI on file",
        );
      }
      return {
        organizationId,
        providerEntityId,
        payerId: payerOverride || credential.macJurisdiction,
        correlationId: randomUUID(),
        usage,
        billingNpi,
        jurisdiction: credential.macJurisdiction,
      };
    },

    async providerEntitiesFor(organizationId) {
      return withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .selectDistinct({ id: schema.macSubmitterCredential.providerEntityId })
          .from(schema.macSubmitterCredential)
          .where(eq(schema.macSubmitterCredential.organizationId, organizationId));
        return rows.map((r) => r.id);
      });
    },
  };
}
