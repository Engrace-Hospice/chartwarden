import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { parseFallbackOrgIds } from "../tenant-clearinghouse/choice";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type { ProviderCcnPort } from "./write-service";

const TX = "837i" as const;
type Env = Readonly<Record<string, string | undefined>>;
export interface ClaimMdMedicareRoutingService {
  list(actor: M23ReadActor, providerEntityId: string): Promise<unknown>;
  createRoute(
    actor: M23WriteActor,
    input: {
      providerEntityId: string;
      payerId: string;
      externalPayerId: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
    },
  ): Promise<unknown>;
  closeRoute(
    actor: M23WriteActor,
    input: { providerEntityId: string; routeId: string; effectiveTo: string },
  ): Promise<unknown>;
  recordEnrollment(
    actor: M23WriteActor,
    input: {
      providerEntityId: string;
      payerId: string;
      status: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
      verificationSource?: string;
      verificationRef?: string;
    },
  ): Promise<unknown>;
}
export type ActiveMedicarePayerReader = (
  tx: DbClient,
  payerId: string,
) => Promise<{ id: string; x12PayerId: string | null; name: string; updatedAt: Date } | null>;

export function buildClaimMdMedicareRoutingService(
  db: DbClient,
  providerCcn: ProviderCcnPort,
  env: Env,
  activePayerById: ActiveMedicarePayerReader,
): ClaimMdMedicareRoutingService {
  return {
    list: (actor, providerId) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, providerId);
          return {
            routes: await tx
              .select()
              .from(schema.claimmdMedicarePayerRoute)
              .where(
                and(
                  eq(schema.claimmdMedicarePayerRoute.organizationId, actor.organizationId),
                  eq(schema.claimmdMedicarePayerRoute.providerEntityId, providerId),
                ),
              )
              .orderBy(asc(schema.claimmdMedicarePayerRoute.effectiveFrom)),
            enrollments: await tx
              .select()
              .from(schema.claimmdMedicarePayerEnrollment)
              .where(
                and(
                  eq(schema.claimmdMedicarePayerEnrollment.organizationId, actor.organizationId),
                  eq(schema.claimmdMedicarePayerEnrollment.providerEntityId, providerId),
                ),
              )
              .orderBy(asc(schema.claimmdMedicarePayerEnrollment.effectiveFrom)),
          };
        },
      ),
    createRoute: (actor, input) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, input.providerEntityId);
          const payer = await activePayerById(tx, input.payerId);
          if (!payer)
            throw new ChartWardenError(
              "CLAIMMD_M40_PAYER_INVALID",
              "An active canonical Medicare payer is required",
              422,
            );
          const { accountReference, usage } = await currentClaimMdAccount(
            tx,
            actor.organizationId,
            env,
          );
          if (
            !validInterval(input.effectiveFrom, input.effectiveTo) ||
            !validExternalPayerId(input.externalPayerId)
          ) {
            throw new ChartWardenError(
              "CLAIMMD_ROUTE_INPUT_INVALID",
              "Payer route dates or external payer ID are invalid",
              422,
            );
          }
          const jurisdictionRows = await tx
            .select({ macJurisdiction: schema.medicareProviderRouting.macJurisdiction })
            .from(schema.medicareProviderRouting)
            .where(
              and(
                eq(schema.medicareProviderRouting.organizationId, actor.organizationId),
                eq(schema.medicareProviderRouting.providerEntityId, input.providerEntityId),
                lte(schema.medicareProviderRouting.effectiveFrom, input.effectiveFrom),
                or(
                  isNull(schema.medicareProviderRouting.effectiveTo),
                  gte(schema.medicareProviderRouting.effectiveTo, input.effectiveFrom),
                ),
              ),
            )
            .limit(2);
          if (jurisdictionRows.length !== 1)
            throw new ChartWardenError(
              jurisdictionRows.length ? "MEDICARE_ROUTING_AMBIGUOUS" : "MEDICARE_ROUTING_MISSING",
              "A unique Medicare jurisdiction must be effective when the payer route starts",
              jurisdictionRows.length ? 409 : 422,
            );
          const macJurisdiction = jurisdictionRows[0]?.macJurisdiction;
          if (!macJurisdiction)
            throw new ChartWardenError(
              "MEDICARE_ROUTING_MISSING",
              "Medicare jurisdiction is unavailable",
              422,
            );
          const [row] = await tx
            .insert(schema.claimmdMedicarePayerRoute)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              payerId: payer.id,
              macJurisdiction,
              accountReference,
              usage,
              externalPayerId: input.externalPayerId,
              transactionType: TX,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo ?? null,
              status: "active",
              provenance: "manual_configuration",
              createdByMembershipId: actor.membershipId,
            })
            .returning({ id: schema.claimmdMedicarePayerRoute.id });
          if (!row)
            throw new ChartWardenError(
              "CLAIMMD_ROUTE_WRITE_FAILED",
              "Payer route could not be saved",
              500,
            );
          return { id: row.id };
        },
      ),
    closeRoute: (actor, input) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, input.providerEntityId);
          if (!validInterval(input.effectiveTo))
            throw new ChartWardenError(
              "CLAIMMD_ROUTE_INTERVAL_INVALID",
              "Route end date is invalid",
              422,
            );
          const [current] = await tx
            .select({
              id: schema.claimmdMedicarePayerRoute.id,
              effectiveFrom: schema.claimmdMedicarePayerRoute.effectiveFrom,
              effectiveTo: schema.claimmdMedicarePayerRoute.effectiveTo,
              status: schema.claimmdMedicarePayerRoute.status,
            })
            .from(schema.claimmdMedicarePayerRoute)
            .where(
              and(
                eq(schema.claimmdMedicarePayerRoute.id, input.routeId),
                eq(schema.claimmdMedicarePayerRoute.organizationId, actor.organizationId),
                eq(schema.claimmdMedicarePayerRoute.providerEntityId, input.providerEntityId),
              ),
            )
            .limit(1);
          if (
            !current ||
            current.status !== "active" ||
            current.effectiveTo !== null ||
            input.effectiveTo < current.effectiveFrom
          ) {
            throw new ChartWardenError(
              "CLAIMMD_ROUTE_NOT_CLOSABLE",
              "Route is missing, already closed, or has an invalid end date",
              409,
            );
          }
          await tx
            .update(schema.claimmdMedicarePayerRoute)
            .set({ effectiveTo: input.effectiveTo, updatedAt: new Date() })
            .where(
              and(
                eq(schema.claimmdMedicarePayerRoute.id, input.routeId),
                eq(schema.claimmdMedicarePayerRoute.organizationId, actor.organizationId),
                isNull(schema.claimmdMedicarePayerRoute.effectiveTo),
              ),
            );
          return { id: input.routeId, effectiveTo: input.effectiveTo };
        },
      ),
    recordEnrollment: (actor, input) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, input.providerEntityId);
          const payer = await activePayerById(tx, input.payerId);
          if (!payer)
            throw new ChartWardenError(
              "CLAIMMD_M40_PAYER_INVALID",
              "An active canonical Medicare payer is required",
              422,
            );
          const { accountReference, usage } = await currentClaimMdAccount(
            tx,
            actor.organizationId,
            env,
          );
          if (
            !["pending", "verified", "not_required", "rejected", "suspended", "expired"].includes(
              input.status,
            )
          ) {
            throw new ChartWardenError(
              "CLAIMMD_ENROLLMENT_STATUS_INVALID",
              "Enrollment status is invalid",
              422,
            );
          }
          if (!validInterval(input.effectiveFrom, input.effectiveTo))
            throw new ChartWardenError(
              "CLAIMMD_ENROLLMENT_INTERVAL_INVALID",
              "Enrollment dates are invalid",
              422,
            );
          if (
            ["verified", "not_required"].includes(input.status) &&
            (!input.verificationSource || !input.verificationRef)
          ) {
            throw new ChartWardenError(
              "CLAIMMD_ENROLLMENT_EVIDENCE_REQUIRED",
              "Verified or exempt enrollment requires a source and evidence reference",
              422,
            );
          }
          if (input.status === "not_required" && input.verificationSource !== "documented_policy") {
            throw new ChartWardenError(
              "CLAIMMD_ENROLLMENT_POLICY_REQUIRED",
              "An enrollment exemption requires documented policy evidence",
              422,
            );
          }
          const overlaps = await tx
            .select({
              id: schema.claimmdMedicarePayerEnrollment.id,
              effectiveFrom: schema.claimmdMedicarePayerEnrollment.effectiveFrom,
              effectiveTo: schema.claimmdMedicarePayerEnrollment.effectiveTo,
            })
            .from(schema.claimmdMedicarePayerEnrollment)
            .where(
              and(
                eq(schema.claimmdMedicarePayerEnrollment.organizationId, actor.organizationId),
                eq(schema.claimmdMedicarePayerEnrollment.providerEntityId, input.providerEntityId),
                eq(schema.claimmdMedicarePayerEnrollment.payerId, payer.id),
                eq(schema.claimmdMedicarePayerEnrollment.accountReference, accountReference),
                eq(schema.claimmdMedicarePayerEnrollment.usage, usage),
                eq(schema.claimmdMedicarePayerEnrollment.transactionType, TX),
                lte(
                  schema.claimmdMedicarePayerEnrollment.effectiveFrom,
                  input.effectiveTo ?? "9999-12-31",
                ),
                or(
                  isNull(schema.claimmdMedicarePayerEnrollment.effectiveTo),
                  gte(schema.claimmdMedicarePayerEnrollment.effectiveTo, input.effectiveFrom),
                ),
              ),
            );
          for (const existing of overlaps) {
            if (existing.effectiveTo === null && existing.effectiveFrom < input.effectiveFrom) {
              const previous = previousDate(input.effectiveFrom);
              await tx
                .update(schema.claimmdMedicarePayerEnrollment)
                .set({ effectiveTo: previous, updatedAt: new Date() })
                .where(
                  and(
                    eq(schema.claimmdMedicarePayerEnrollment.id, existing.id),
                    isNull(schema.claimmdMedicarePayerEnrollment.effectiveTo),
                  ),
                );
            } else {
              throw new ChartWardenError(
                "CLAIMMD_ENROLLMENT_OVERLAP",
                "Enrollment history overlaps the requested effective period",
                409,
              );
            }
          }
          const [row] = await tx
            .insert(schema.claimmdMedicarePayerEnrollment)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              payerId: payer.id,
              accountReference,
              usage,
              transactionType: TX,
              status: input.status,
              verificationSource: input.verificationSource ?? null,
              verificationRef: input.verificationRef ?? null,
              verifiedByMembershipId: ["verified", "not_required"].includes(input.status)
                ? actor.membershipId
                : null,
              verifiedAt: ["verified", "not_required"].includes(input.status) ? new Date() : null,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo ?? null,
            })
            .returning({ id: schema.claimmdMedicarePayerEnrollment.id });
          if (!row)
            throw new ChartWardenError(
              "CLAIMMD_ENROLLMENT_WRITE_FAILED",
              "Enrollment evidence could not be saved",
              500,
            );
          return { id: row.id };
        },
      ),
  };
}

async function assertProvider(
  tx: DbClient,
  port: ProviderCcnPort,
  org: string,
  provider: string,
): Promise<void> {
  try {
    await port.ccnForProviderEntity(tx as never, org, provider);
  } catch {
    throw new ChartWardenError(
      "PROVIDER_ENTITY_UNRESOLVED",
      "Provider entity is not available in this organization",
      404,
    );
  }
}
async function currentClaimMdAccount(
  tx: DbClient,
  org: string,
  env: Env,
): Promise<{ accountReference: string; usage: "test" | "production" }> {
  const [tenant] = await tx
    .select({
      vendor: schema.tenantClearinghouseConfig.vendor,
      mode: schema.tenantClearinghouseConfig.mode,
      status: schema.tenantClearinghouseConfig.status,
    })
    .from(schema.tenantClearinghouseConfig)
    .where(eq(schema.tenantClearinghouseConfig.organizationId, org))
    .limit(1);
  if (tenant) {
    if (
      tenant.vendor !== "claimmd" ||
      tenant.status !== "active" ||
      (tenant.mode !== "test" && tenant.mode !== "production")
    ) {
      throw new ChartWardenError(
        "CLAIMMD_ACCOUNT_NOT_ACTIVE",
        "The organization's active clearinghouse account is not Claim.MD",
        409,
      );
    }
    return { accountReference: `tenant:${org}`, usage: tenant.mode };
  }
  const allow = parseFallbackOrgIds(env.CLEARINGHOUSE_ENV_FALLBACK_ORG_IDS);
  if (env.CLEARINGHOUSE_VENDOR?.trim() !== "claimmd" || !allow.has(org.toLowerCase())) {
    throw new ChartWardenError(
      "CLAIMMD_PLATFORM_ACCOUNT_NOT_AUTHORIZED",
      "This organization is not authorized for the platform Claim.MD account",
      403,
    );
  }
  const usage = env.CLAIMMD_ACCOUNT_USAGE?.trim();
  const accountReference = env.CLAIMMD_ACCOUNT_REFERENCE?.trim();
  if ((usage !== "test" && usage !== "production") || !accountReference)
    throw new ChartWardenError(
      "CLAIMMD_ACCOUNT_UNAVAILABLE",
      "The authorized Claim.MD account is not configured",
      503,
    );
  return { accountReference, usage };
}
export function validInterval(from: string, to?: string | null): boolean {
  const valid = (value: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  return valid(from) && (!to || (valid(to) && to >= from));
}
export function validExternalPayerId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,40}$/.test(value);
}
function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
