// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts — the per-call ClearinghouseContext the M23
// workers hand the bound transport (ADR-0053 D3, #707). The MAC jurisdiction comes from the provider entity's submitter
// credential (M23's own table, the row the legacy portal resolves its jurisdiction from). The provider's NPI belongs to
// M1's `provider_entity`, so the composition root injects it (`providerNpi`) instead of this module reading that table.
import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { and, eq } from "drizzle-orm";
import type { ClearinghouseContextPort } from "./clearinghouse-submission";

export const CLEARINGHOUSE_USAGE_ENV = "CLEARINGHOUSE_USAGE";
export const CLEARINGHOUSE_PAYER_ID_ENV = "CLEARINGHOUSE_PAYER_ID";
export const CLAIMMD_M23_PAYER_ROUTES_ENV = "CLAIMMD_M23_PAYER_ROUTES";
export const CLAIMMD_ACCOUNT_REFERENCE_ENV = "CLAIMMD_ACCOUNT_REFERENCE";
export const CLEARINGHOUSE_VENDOR_ENV = "CLEARINGHOUSE_VENDOR";
export type ClaimMdM23PayerRoute = {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
  readonly accountReference: string;
  readonly usage: ClearinghouseContext["usage"];
  readonly payerId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
};

type EnvMap = Readonly<Record<string, string | undefined>>;

/** `test` reaches only vendor test mode. Defaults to production exactly when NODE_ENV is production. */
export function clearinghouseUsageFromEnv(env: EnvMap): ClearinghouseContext["usage"] {
  if (env[CLEARINGHOUSE_VENDOR_ENV]?.trim() === "claimmd") {
    const accountUsage = env.CLAIMMD_ACCOUNT_USAGE?.trim();
    if (accountUsage !== "test" && accountUsage !== "production") {
      throw new Error("CLAIMMD_ACCOUNT_USAGE must be test or production for Claim.MD routing");
    }
    const sharedUsage = env[CLEARINGHOUSE_USAGE_ENV]?.trim();
    if (sharedUsage && sharedUsage !== accountUsage) {
      throw new Error("CLEARINGHOUSE_USAGE conflicts with CLAIMMD_ACCOUNT_USAGE");
    }
    return accountUsage;
  }
  const raw = env[CLEARINGHOUSE_USAGE_ENV]?.trim();
  if (!raw) return env.NODE_ENV === "production" ? "production" : "test";
  if (raw !== "test" && raw !== "production") {
    throw new Error(`${CLEARINGHOUSE_USAGE_ENV} must be "test" or "production" (or unset)`);
  }
  if (raw === "test" && env.NODE_ENV === "production") {
    throw new Error(`${CLEARINGHOUSE_USAGE_ENV}=test is refused in production`);
  }
  return raw;
}

export interface ClearinghouseContextDeps {
  readonly db: DbClient;
  readonly env: EnvMap;
  /** The provider entity's NPI (M1 owns the table), or null when unknown. */
  readonly providerNpi: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string | null>;
}

/**
 * Resolve only an explicitly configured Claim.MD route. This is platform-owned deployment configuration because
 * there is no M23/M40 source table that currently represents a Claim.MD payer route. In particular, M40's canonical
 * X12 payer directory and a MAC jurisdiction are not silently treated as Claim.MD routing evidence.
 */
export function resolveClaimMdM23PayerRoute(input: {
  readonly routes: readonly ClaimMdM23PayerRoute[];
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly macJurisdiction: string;
  readonly accountReference: string;
  readonly usage: ClearinghouseContext["usage"];
  readonly at?: Date;
}): { readonly payerId: string; readonly routeFingerprint: string } {
  const now = input.at ?? new Date();
  const scoped = input.routes.filter(
    (r) =>
      r.organizationId === input.organizationId &&
      r.providerEntityId === input.providerEntityId &&
      r.macJurisdiction === input.macJurisdiction &&
      r.accountReference === input.accountReference &&
      r.usage === input.usage,
  );
  const validDate = (value: string): boolean => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (
    scoped.some(
      (r) =>
        !validDate(r.effectiveFrom) ||
        (r.effectiveTo !== undefined &&
          (!validDate(r.effectiveTo) || r.effectiveTo < r.effectiveFrom)),
    )
  ) {
    throw new Error("CLAIMMD_PAYER_ROUTE_INVALID_DATES");
  }
  const matches = scoped.filter(
    (r) =>
      Date.parse(`${r.effectiveFrom}T00:00:00.000Z`) <= now.getTime() &&
      (r.effectiveTo === undefined ||
        Date.parse(`${r.effectiveTo}T23:59:59.999Z`) >= now.getTime()),
  );
  if (matches.length === 0) throw new Error("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  if (matches.length !== 1) throw new Error("CLAIMMD_PAYER_ROUTE_AMBIGUOUS");
  const payerId = matches[0]!.payerId.trim();
  if (!payerId) throw new Error("CLAIMMD_PAYER_ROUTE_INVALID");
  const route = matches[0]!;
  return {
    payerId,
    routeFingerprint: createHash("sha256").update(JSON.stringify(route)).digest("hex"),
  };
}

function readClaimMdM23PayerRoutes(env: EnvMap): readonly ClaimMdM23PayerRoute[] {
  const raw = env[CLAIMMD_M23_PAYER_ROUTES_ENV]?.trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((item) => {
      if (!item || typeof item !== "object") throw new Error();
      const r = item as Record<string, unknown>;
      const required = [
        "organizationId",
        "providerEntityId",
        "macJurisdiction",
        "accountReference",
        "usage",
        "payerId",
        "effectiveFrom",
      ];
      if (required.some((k) => typeof r[k] !== "string" || !(r[k] as string).trim()))
        throw new Error();
      if (r.usage !== "test" && r.usage !== "production") throw new Error();
      if (r.effectiveTo !== undefined && typeof r.effectiveTo !== "string") throw new Error();
      return r as unknown as ClaimMdM23PayerRoute;
    });
  } catch {
    throw new Error(
      `${CLAIMMD_M23_PAYER_ROUTES_ENV} must be a valid array of scoped, effective-dated route records`,
    );
  }
}

export function buildClearinghouseContextPort(
  deps: ClearinghouseContextDeps,
): ClearinghouseContextPort {
  const usage = clearinghouseUsageFromEnv(deps.env);
  const payerOverride = deps.env[CLEARINGHOUSE_PAYER_ID_ENV]?.trim();
  const vendor = deps.env.CLEARINGHOUSE_VENDOR?.trim();
  const claimMdAccountReference = deps.env[CLAIMMD_ACCOUNT_REFERENCE_ENV]?.trim() ?? "";
  const claimMdRoutes = readClaimMdM23PayerRoutes(deps.env);
  if (vendor === "claimmd" && payerOverride) {
    throw new Error(
      `${CLEARINGHOUSE_PAYER_ID_ENV} cannot authorize Claim.MD payer routing; configure ${CLAIMMD_M23_PAYER_ROUTES_ENV}`,
    );
  }
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
      let payerId = payerOverride || credential.macJurisdiction;
      let claimMdRouteFingerprint: string | undefined;
      if (vendor === "claimmd") {
        if (!claimMdAccountReference)
          throw new Error(
            "CLAIMMD_ACCOUNT_REFERENCE is required for Claim.MD payer route resolution",
          );
        const resolvedRoute = resolveClaimMdM23PayerRoute({
          routes: claimMdRoutes,
          organizationId,
          providerEntityId,
          macJurisdiction: credential.macJurisdiction,
          accountReference: claimMdAccountReference,
          usage,
        });
        payerId = resolvedRoute.payerId;
        claimMdRouteFingerprint = resolvedRoute.routeFingerprint;
      }
      return {
        organizationId,
        providerEntityId,
        payerId,
        correlationId: randomUUID(),
        usage,
        billingNpi,
        jurisdiction: credential.macJurisdiction,
        ...(claimMdRouteFingerprint ? { claimMdRouteFingerprint } : {}),
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
