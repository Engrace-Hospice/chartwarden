// apps/backend/src/modules/23-billing-medicare/jobs/clearinghouse-context.ts — per-call ClearinghouseContext.
// Medicare jurisdiction is effective-dated provider routing; direct-MAC portal credentials are transport-specific.
// The provider's NPI belongs to M1's provider_entity, so the composition root injects it.
import { createHash, randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { type ClearinghouseContext, clearinghouseUsageFromEnv } from "@chartwarden/x12-837-client";
import { and, eq, gte, isNull, lte, or } from "drizzle-orm";
import { tenantClaimMdAccountReference } from "../claimmd-evidence/store";
import { resolveMedicareProviderRouting } from "../services/medicare-provider-routing";
import type { ClearinghouseContextPort } from "./clearinghouse-submission";

export const CLEARINGHOUSE_PAYER_ID_ENV = "CLEARINGHOUSE_PAYER_ID";
export const CLAIMMD_M23_PAYER_ROUTES_ENV = "CLAIMMD_M23_PAYER_ROUTES";
export const CLAIMMD_ACCOUNT_REFERENCE_ENV = "CLAIMMD_ACCOUNT_REFERENCE";
export const CLEARINGHOUSE_VENDOR_ENV = "CLEARINGHOUSE_VENDOR";
export function claimMdEnrollmentStatusReady(status: string | null, matchCount = status === null ? 0 : 1): boolean {
  return matchCount === 1 && (status === "verified" || status === "not_required");
}
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

/** What the context port needs of a clearinghouse binding: which vendor, and whether the account is the tenant's own. */
export interface OrgBindingFacts {
  readonly vendor: string | null;
  readonly account?: "tenant";
}

/** The platform binding: one for everyone, or (tenant clearinghouses) `forOrg` hands each organization its own. */
export interface ContextBinding extends OrgBindingFacts {
  readonly forOrg?: (organizationId: string) => Promise<OrgBindingFacts>;
}

export interface ClearinghouseContextDeps {
  readonly db: DbClient;
  readonly env: EnvMap;
  /**
   * The clearinghouse binding. The Claim.MD payer route is decided by the ORGANIZATION'S resolved binding (its vendor and
   * whose account it is), never by the platform env vendor: a tenant on Stedi needs no Claim.MD route, a tenant's own Claim.MD
   * account resolves its route under its own account reference. Absent (slice boots, tests), the platform env vendor decides.
   */
  readonly binding?: ContextBinding;
  /**
   * The vendor mode of an organization's own live clearinghouse config (ADR-0053 amendment 2026-11-06), or null when it has
   * none (the platform's env usage then applies). A value replaces the env usage for that organization only.
   */
  readonly usageFor?: (organizationId: string) => Promise<ClearinghouseContext["usage"] | null>;
  /** The provider entity's NPI (M1 owns the table), or null when unknown. */
  readonly providerNpi: (
    organizationId: string,
    providerEntityId: string,
  ) => Promise<string | null>;
  /** Minimal M5-owned projection; never return the subscriber/member identifier to this resolver. */
  readonly coveragePayerFacts?: (input: { organizationId: string; patientId: string; patientPayerId: string }) => Promise<{
    payerId: string; coverageKind: string; effectiveFrom: string; effectiveTo: string | null;
  } | null>;
  /** M40-owned canonical payer validation, run on the caller's transaction. */
  readonly activeMedicarePayerById?: (tx: DbClient, payerId: string) => Promise<{ id: string; x12PayerId: string | null; name: string; updatedAt: Date } | null>;
}

async function resolveDurableClaimMdRoute(deps: Pick<ClearinghouseContextDeps, "db" | "coveragePayerFacts" | "activeMedicarePayerById">, input: {
  organizationId: string; providerEntityId: string; claimId: string; accountReference: string;
  usage: ClearinghouseContext["usage"]; macJurisdiction: string;
}): Promise<{ payerId: string; canonicalPayerId: string; routeFingerprint: string }> {
  return withOrgContext(deps.db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
    const [claim] = await tx.select({ patientId: schema.claim.patientId, patientPayerId: schema.claim.patientPayerId,
      serviceFrom: schema.claim.serviceFrom, macJurisdiction: schema.claim.macJurisdiction })
      .from(schema.claim).where(and(eq(schema.claim.id, input.claimId), eq(schema.claim.organizationId, input.organizationId),
        eq(schema.claim.providerEntityId, input.providerEntityId))).limit(1);
    if (!claim) throw new ChartWardenError("CLAIMMD_ROUTE_CLAIM_UNAVAILABLE", "Claim payer routing could not be verified", 422);
    if (claim.macJurisdiction !== input.macJurisdiction) {
      throw new ChartWardenError("CLAIMMD_ROUTE_JURISDICTION_STALE", "Claim jurisdiction differs from effective provider routing", 409);
    }
    if (!deps.coveragePayerFacts || !deps.activeMedicarePayerById) {
      throw new ChartWardenError("CLAIMMD_PAYER_SEAMS_UNAVAILABLE", "Canonical payer verification is unavailable", 503);
    }
    const coverage = await deps.coveragePayerFacts({ organizationId: input.organizationId, patientId: claim.patientId, patientPayerId: claim.patientPayerId });
    if (!coverage || coverage.coverageKind !== "medicare_ffs" || coverage.effectiveFrom > claim.serviceFrom ||
        (coverage.effectiveTo !== null && coverage.effectiveTo < claim.serviceFrom)) {
      throw new ChartWardenError("CLAIMMD_ROUTE_PAYER_UNAVAILABLE", "Claim does not have an effective Medicare fee-for-service payer", 422);
    }
    const payer = await deps.activeMedicarePayerById(tx as DbClient, coverage.payerId);
    if (!payer) {
      throw new ChartWardenError("CLAIMMD_ROUTE_PAYER_INACTIVE", "The claim's canonical Medicare payer is unavailable", 422);
    }
    const routeTable = schema.claimmdMedicarePayerRoute;
    const routes = await tx.select().from(routeTable).where(and(
      eq(routeTable.organizationId, input.organizationId), eq(routeTable.providerEntityId, input.providerEntityId),
      eq(routeTable.payerId, payer.id), eq(routeTable.accountReference, input.accountReference), eq(routeTable.usage, input.usage),
      eq(routeTable.macJurisdiction, input.macJurisdiction as typeof schema.medicareProviderRouting.$inferSelect.macJurisdiction),
      eq(routeTable.transactionType, "837i"), eq(routeTable.status, "active"), lte(routeTable.effectiveFrom, claim.serviceFrom),
      or(isNull(routeTable.effectiveTo), gte(routeTable.effectiveTo, claim.serviceFrom)),
    )).limit(2);
    const route = routes[0];
    if (routes.length !== 1 || !route) throw new ChartWardenError(routes.length ? "CLAIMMD_ROUTE_AMBIGUOUS" : "CLAIMMD_ROUTE_NOT_CONFIGURED",
      routes.length ? "Claim.MD payer routing is ambiguous" : "Claim.MD payer routing is not configured for this claim", routes.length ? 409 : 422);
    const enrollmentTable = schema.claimmdMedicarePayerEnrollment;
    const enrollments = await tx.select().from(enrollmentTable).where(and(
      eq(enrollmentTable.organizationId, input.organizationId), eq(enrollmentTable.providerEntityId, input.providerEntityId),
      eq(enrollmentTable.payerId, payer.id), eq(enrollmentTable.accountReference, input.accountReference),
      eq(enrollmentTable.usage, input.usage), eq(enrollmentTable.transactionType, "837i"),
      lte(enrollmentTable.effectiveFrom, claim.serviceFrom),
      or(isNull(enrollmentTable.effectiveTo), gte(enrollmentTable.effectiveTo, claim.serviceFrom)),
    )).limit(2);
    const enrollment = enrollments[0];
    if (!claimMdEnrollmentStatusReady(enrollment?.status ?? null, enrollments.length) || !enrollment) {
      const status = enrollments.length === 1 ? enrollment?.status ?? "unknown" : "unknown";
      throw new ChartWardenError(`CLAIMMD_ENROLLMENT_${status.toUpperCase()}`,
        "Claim.MD payer enrollment or transaction authorization is not verified", 422);
    }
    return { payerId: route.externalPayerId, canonicalPayerId: payer.id, routeFingerprint: createHash("sha256").update(JSON.stringify({
      routeId: route.id, routeUpdatedAt: route.updatedAt, payerId: payer.id, payerUpdatedAt: payer.updatedAt,
      externalPayerId: route.externalPayerId, accountReference: input.accountReference, usage: input.usage,
      macJurisdiction: input.macJurisdiction,
      enrollmentId: enrollment.id, enrollmentStatus: enrollment.status, enrollmentVerifiedAt: enrollment.verifiedAt,
      enrollmentUpdatedAt: enrollment.updatedAt, transactionType: route.transactionType,
    })).digest("hex") };
  });
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
  const match = matches[0];
  if (!match) throw new Error("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  const payerId = match.payerId.trim();
  if (!payerId) throw new Error("CLAIMMD_PAYER_ROUTE_INVALID");
  const route = match;
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

/**
 * The Claim.MD account whose payer route an organization's claims need, or null when its clearinghouse is not Claim.MD (a Stedi
 * org needs no route). A tenant's OWN account is filed under `tenant:<org>` (the reference its evidence already uses); the
 * platform's account (and the orgs it serves) under CLAIMMD_ACCOUNT_REFERENCE.
 */
async function claimMdAccountOf(
  deps: Pick<ClearinghouseContextDeps, "binding" | "env">,
  organizationId: string,
): Promise<{ readonly accountReference: string } | null> {
  const resolved = deps.binding?.forOrg ? await deps.binding.forOrg(organizationId) : deps.binding;
  const vendor = resolved ? resolved.vendor : deps.env[CLEARINGHOUSE_VENDOR_ENV]?.trim();
  if (vendor !== "claimmd") return null;
  if (resolved?.account === "tenant") {
    return { accountReference: tenantClaimMdAccountReference(organizationId) };
  }
  const platformReference = deps.env[CLAIMMD_ACCOUNT_REFERENCE_ENV]?.trim();
  if (!platformReference) {
    throw new Error("CLAIMMD_ACCOUNT_REFERENCE is required for Claim.MD payer route resolution");
  }
  return { accountReference: platformReference };
}

/** What a claim fingerprint is bound to when no Claim.MD account reference is configured (the pre-tenant-account placeholder). */
const LEGACY_CLAIM_ACCOUNT_REFERENCE = "legacy-mac";

/**
 * The account reference a claim's preview fingerprint and its submit-time fingerprint are both bound to, for one organization: a
 * tenant's OWN Claim.MD account is `tenant:<org>` (the reference its evidence uses), otherwise the platform's
 * CLAIMMD_ACCOUNT_REFERENCE, else a fixed placeholder. The preview route and the submit worker call this one function, so a
 * preview confirmed for one account can never be sent under another and the two fingerprints keep matching.
 */
export async function claimAccountReferenceFor(
  deps: Pick<ClearinghouseContextDeps, "binding" | "env">,
  organizationId: string,
): Promise<string> {
  const resolved = deps.binding?.forOrg ? await deps.binding.forOrg(organizationId) : deps.binding;
  if (resolved?.vendor === "claimmd" && resolved.account === "tenant") {
    return tenantClaimMdAccountReference(organizationId);
  }
  return deps.env[CLAIMMD_ACCOUNT_REFERENCE_ENV]?.trim() || LEGACY_CLAIM_ACCOUNT_REFERENCE;
}

export function buildClearinghouseContextPort(
  deps: ClearinghouseContextDeps,
): ClearinghouseContextPort {
  const usage = clearinghouseUsageFromEnv(deps.env);
  const payerOverride = deps.env[CLEARINGHOUSE_PAYER_ID_ENV]?.trim();
  const platformVendor = deps.env.CLEARINGHOUSE_VENDOR?.trim();
  const claimMdRoutes = readClaimMdM23PayerRoutes(deps.env);
  if (platformVendor === "claimmd" && payerOverride) {
    throw new Error(
      `${CLEARINGHOUSE_PAYER_ID_ENV} cannot authorize Claim.MD payer routing; configure ${CLAIMMD_M23_PAYER_ROUTES_ENV}`,
    );
  }
  return {
    async contextFor(organizationId, providerEntityId, options) {
      const claimId = options?.claimId;
      const claimDate = claimId ? await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const [row] = await tx.select({ serviceFrom: schema.claim.serviceFrom }).from(schema.claim).where(and(
          eq(schema.claim.id, claimId), eq(schema.claim.organizationId, organizationId),
          eq(schema.claim.providerEntityId, providerEntityId),
        )).limit(1);
        return row?.serviceFrom ?? null;
      }) : null;
      if (claimId && !claimDate) throw new ChartWardenError("CLAIMMD_ROUTE_CLAIM_UNAVAILABLE", "Claim payer routing could not be verified", 422);
      if (options?.effectiveDate && claimDate && options.effectiveDate !== claimDate) {
        throw new ChartWardenError("CLAIMMD_ROUTE_EFFECTIVE_DATE_MISMATCH", "Claim routing date does not match its service date", 409);
      }
      const effectiveDate = claimDate ?? options?.effectiveDate ?? new Date().toISOString().slice(0, 10);
      const routing = await resolveMedicareProviderRouting(deps.db, { organizationId, providerEntityId, effectiveDate });
      const billingNpi = await deps.providerNpi(organizationId, providerEntityId);
      const orgUsage = (await deps.usageFor?.(organizationId)) ?? usage;
      const resolvedBinding = deps.binding?.forOrg ? await deps.binding.forOrg(organizationId) : deps.binding;
      const vendor = resolvedBinding ? resolvedBinding.vendor : platformVendor;
      if (vendor === "direct_mac") {
        const credentialReady = await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
          const [credential] = await tx.select({
            cipher: schema.macSubmitterCredential.clientSecretCipher,
            expiresAt: schema.macSubmitterCredential.credentialExpiresAt,
          }).from(schema.macSubmitterCredential).where(and(
            eq(schema.macSubmitterCredential.organizationId, organizationId),
            eq(schema.macSubmitterCredential.providerEntityId, providerEntityId),
          )).limit(1);
          return Boolean(credential?.cipher && (!credential.expiresAt || credential.expiresAt.getTime() > Date.now()));
        });
        if (!credentialReady) {
          throw new ChartWardenError("MAC_SUBMITTER_CREDENTIAL_UNAVAILABLE", "Direct-MAC transmission requires an active provider portal credential", 422);
        }
      }
      if (!billingNpi) {
        throw new Error(
          "clearinghouse context: provider entity has no NPI on file",
        );
      }
      let payerId = payerOverride || routing.macJurisdiction;
      let claimMdRouteFingerprint: string | undefined;
      let canonicalPayerId: string | undefined;
      const claimMdAccount =
        options?.payerRoute === "skip" ? null : await claimMdAccountOf(deps, organizationId);
      if (claimMdAccount) {
        // Claim.MD never takes the global payer override: the route is scoped to this org's account and mode.
        if (options?.claimId) {
          const resolvedRoute = await resolveDurableClaimMdRoute(deps, {
              organizationId, providerEntityId, claimId: options.claimId,
              accountReference: claimMdAccount.accountReference, usage: orgUsage, macJurisdiction: routing.macJurisdiction,
          });
          payerId = resolvedRoute.payerId;
          canonicalPayerId = resolvedRoute.canonicalPayerId;
          claimMdRouteFingerprint = resolvedRoute.routeFingerprint;
        } else {
          const resolvedRoute = resolveClaimMdM23PayerRoute({
            routes: claimMdRoutes, organizationId, providerEntityId,
            macJurisdiction: routing.macJurisdiction, accountReference: claimMdAccount.accountReference,
            usage: orgUsage, at: new Date(`${effectiveDate}T12:00:00.000Z`),
          });
          payerId = resolvedRoute.payerId;
          claimMdRouteFingerprint = resolvedRoute.routeFingerprint;
        }
      }
      return {
        organizationId,
        providerEntityId,
        payerId,
        correlationId: randomUUID(),
        usage: orgUsage,
        billingNpi,
        jurisdiction: routing.macJurisdiction,
        ...(claimMdRouteFingerprint ? { claimMdRouteFingerprint } : {}),
        ...(canonicalPayerId ? { canonicalPayerId } : {}),
      };
    },

    async providerEntitiesFor(organizationId) {
      return withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .selectDistinct({ id: schema.medicareProviderRouting.providerEntityId })
          .from(schema.medicareProviderRouting)
          .where(eq(schema.medicareProviderRouting.organizationId, organizationId));
        return rows.map((r) => r.id);
      });
    },
  };
}

export type ClaimPayerRouteStatus =
  | { readonly status: "verified"; readonly routeFingerprint: string }
  | { readonly status: "not_configured"; readonly reasonCode?: string }
  | { readonly status: "not_applicable" };

/**
 * The claim routes' payer-route readiness (preparation and submit). `not_applicable` for an org whose clearinghouse is not Claim.MD;
 * for a Claim.MD org it is the same resolution the submit worker repeats before upload, plus the active-M40-payer gate. Any failure
 * (including an org whose binding cannot be resolved) is `not_configured` with a code, never silently applicable.
 */
export function buildClaimPayerRouteStatus(
  deps: ClearinghouseContextDeps & {
    /** True when the resolved payer id is an active X12 payer (M40 owns the directory). */
    readonly payerIsActive: (payerId: string) => Promise<boolean>;
    /** Structured logger for a readiness check that failed to resolve (ids and a code only, never the error's message). */
    readonly log?: (fields: Record<string, unknown>, message: string) => void;
  },
): (organizationId: string, providerEntityId: string, effectiveDate?: string, claimId?: string) => Promise<ClaimPayerRouteStatus> {
  return async (organizationId, providerEntityId, effectiveDate, claimId) => {
    try {
      if (!(await claimMdAccountOf(deps, organizationId))) return { status: "not_applicable" };
      const context = await buildClearinghouseContextPort(deps).contextFor(
        organizationId,
        providerEntityId,
        { ...(effectiveDate ? { effectiveDate } : {}), ...(claimId ? { claimId } : {}) },
      );
      if (!context.claimMdRouteFingerprint) {
        return { status: "not_configured", reasonCode: "PAYER_ROUTE_NOT_VERIFIED" };
      }
      if (!claimId && !(await deps.payerIsActive(context.payerId))) {
        return { status: "not_configured", reasonCode: "CLAIMMD_PAYER_ROUTE_PAYER_NOT_ACTIVE" };
      }
      return { status: "verified", routeFingerprint: context.claimMdRouteFingerprint };
    } catch (error) {
      // A typed refusal keeps its own code (an unreadable credential is not "not verified"); only an untyped throw is generic.
      const code =
        error instanceof ChartWardenError
          ? error.code
          : error instanceof Error && error.message.startsWith("CLAIMMD_PAYER_ROUTE_")
            ? error.message
            : "PAYER_ROUTE_NOT_VERIFIED";
      deps.log?.(
        { organizationId, providerEntityId, code },
        "claim payer-route readiness could not be resolved",
      );
      return { status: "not_configured", reasonCode: code };
    }
  };
}
