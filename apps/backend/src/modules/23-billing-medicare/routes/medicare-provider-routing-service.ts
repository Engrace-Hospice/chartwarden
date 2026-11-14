import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";
import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { M23ReadActor, M23WriteActor } from "./actor";
import type { ProviderCcnPort } from "./write-service";

const JURISDICTIONS = [
  "ngs_j6",
  "ngs_jk",
  "cgs_j15",
  "palmetto_jj",
  "palmetto_jm",
  "noridian_jf",
  "noridian_je",
] as const;
const REASON_CODES = [
  "provider_documentation",
  "cms_notice",
  "legacy_review",
  "correction",
] as const;
export type MedicareRoutingJurisdiction = (typeof JURISDICTIONS)[number];

export interface MedicareProviderRoutingService {
  history(actor: M23ReadActor, providerEntityId: string): Promise<unknown>;
  backfillIssues(actor: M23ReadActor, providerEntityId: string): Promise<unknown>;
  configure(
    actor: M23WriteActor,
    input: {
      providerEntityId: string;
      macJurisdiction: string;
      effectiveFrom: string;
      effectiveTo?: string | null;
      reason: string;
    },
  ): Promise<unknown>;
}

export function buildDrizzleMedicareProviderRoutingService(
  db: DbClient,
  providerCcn: ProviderCcnPort,
): MedicareProviderRoutingService {
  return {
    history: (actor, providerEntityId) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, providerEntityId);
          return tx
            .select({
              id: schema.medicareProviderRouting.id,
              macJurisdiction: schema.medicareProviderRouting.macJurisdiction,
              effectiveFrom: schema.medicareProviderRouting.effectiveFrom,
              effectiveTo: schema.medicareProviderRouting.effectiveTo,
              provenance: schema.medicareProviderRouting.provenance,
              setReason: schema.medicareProviderRouting.setReason,
              createdAt: schema.medicareProviderRouting.createdAt,
            })
            .from(schema.medicareProviderRouting)
            .where(
              and(
                eq(schema.medicareProviderRouting.organizationId, actor.organizationId),
                eq(schema.medicareProviderRouting.providerEntityId, providerEntityId),
              ),
            )
            .orderBy(asc(schema.medicareProviderRouting.effectiveFrom));
        },
      ),
    backfillIssues: (actor, providerEntityId) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, providerEntityId);
          return tx
            .select({
              reasonCode: schema.medicareProviderRoutingBackfillIssue.reasonCode,
              candidateJurisdictions:
                schema.medicareProviderRoutingBackfillIssue.candidateJurisdictions,
              createdAt: schema.medicareProviderRoutingBackfillIssue.createdAt,
            })
            .from(schema.medicareProviderRoutingBackfillIssue)
            .where(
              and(
                eq(
                  schema.medicareProviderRoutingBackfillIssue.organizationId,
                  actor.organizationId,
                ),
                eq(schema.medicareProviderRoutingBackfillIssue.providerEntityId, providerEntityId),
              ),
            );
        },
      ),
    configure: (actor, input) =>
      withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        async (tx) => {
          await assertProvider(tx, providerCcn, actor.organizationId, input.providerEntityId);
          if (!JURISDICTIONS.includes(input.macJurisdiction as MedicareRoutingJurisdiction)) {
            throw new ChartWardenError(
              "MEDICARE_ROUTING_JURISDICTION_INVALID",
              "Medicare jurisdiction is invalid",
              422,
            );
          }
          if (
            !validDate(input.effectiveFrom) ||
            (input.effectiveTo && !validDate(input.effectiveTo)) ||
            (input.effectiveTo && input.effectiveTo < input.effectiveFrom) ||
            !REASON_CODES.includes(input.reason as (typeof REASON_CODES)[number])
          ) {
            throw new ChartWardenError(
              "MEDICARE_ROUTING_INTERVAL_INVALID",
              "Medicare routing dates or reason are invalid",
              422,
            );
          }
          const overlaps = await tx
            .select({
              id: schema.medicareProviderRouting.id,
              from: schema.medicareProviderRouting.effectiveFrom,
              to: schema.medicareProviderRouting.effectiveTo,
            })
            .from(schema.medicareProviderRouting)
            .where(
              and(
                eq(schema.medicareProviderRouting.organizationId, actor.organizationId),
                eq(schema.medicareProviderRouting.providerEntityId, input.providerEntityId),
                lte(
                  schema.medicareProviderRouting.effectiveFrom,
                  input.effectiveTo ?? "9999-12-31",
                ),
                or(
                  isNull(schema.medicareProviderRouting.effectiveTo),
                  gte(schema.medicareProviderRouting.effectiveTo, input.effectiveFrom),
                ),
              ),
            );
          for (const row of overlaps) {
            if (row.to === null && row.from < input.effectiveFrom) {
              await tx
                .update(schema.medicareProviderRouting)
                .set({ effectiveTo: previousDate(input.effectiveFrom) })
                .where(
                  and(
                    eq(schema.medicareProviderRouting.id, row.id),
                    isNull(schema.medicareProviderRouting.effectiveTo),
                  ),
                );
              continue;
            }
            throw new ChartWardenError(
              "MEDICARE_ROUTING_OVERLAP",
              "The requested routing interval overlaps existing provider routing",
              409,
            );
          }
          const [saved] = await tx
            .insert(schema.medicareProviderRouting)
            .values({
              organizationId: actor.organizationId,
              providerEntityId: input.providerEntityId,
              macJurisdiction: input.macJurisdiction as MedicareRoutingJurisdiction,
              effectiveFrom: input.effectiveFrom,
              effectiveTo: input.effectiveTo ?? null,
              provenance: "manual",
              setByMembershipId: actor.membershipId,
              setReason: input.reason,
            })
            .returning({ id: schema.medicareProviderRouting.id });
          return { id: saved!.id };
        },
      ),
  };
}

async function assertProvider(
  tx: DbClient,
  port: ProviderCcnPort,
  orgId: string,
  providerEntityId: string,
): Promise<void> {
  try {
    await port.ccnForProviderEntity(tx as never, orgId, providerEntityId);
  } catch {
    throw new ChartWardenError(
      "PROVIDER_ENTITY_UNRESOLVED",
      "Provider entity is not available in this organization",
      404,
    );
  }
}
function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
