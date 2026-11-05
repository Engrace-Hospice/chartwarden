// apps/backend/src/modules/23-billing-medicare/routes/npi-verification-service.ts — platform-verified NPI ownership
// (ADR-0053 amendment 2026-11-05, precondition 2; migration 1326).
//
// A tenant `org.manage` user can put any Luhn-valid NPI on its provider entity, so the Claim.MD sweep routes an
// enrollment report only to an entity whose CURRENT NPI platform staff have verified (`isNpiVerified`). Verify and revoke
// run only through the injected platform runner (the BYPASSRLS platform login, one allowlisted + audited
// withPlatformContext per call); the app role holds SELECT on its own org's rows and nothing else. The operator is the
// session's membership id, never the body; the row's audit after-image carries it. Revoked rows stay as evidence.
import { type DbClient, schema } from "@chartwarden/db";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  type PlatformProviderEntity,
  listProviderEntitiesForPlatform,
  providerEntityById,
} from "../../../bootstrap/provider-entity-npi-lookup";
import type { M23WriteActor } from "./actor";

export type NpiVerificationRunner = <T>(fn: (tx: DbClient) => Promise<T>) => Promise<T>;

export type NpiVerificationState = "verified" | "unverified" | "revoked";

export interface NpiVerificationView {
  readonly providerEntityId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly legalName: string;
  /** The entity's CURRENT NPI; the state is about this value only. */
  readonly npi: string;
  readonly state: NpiVerificationState;
  readonly verificationId: string | null;
  readonly evidence: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByMembershipId: string | null;
  readonly revokedAt: string | null;
  readonly revokedByMembershipId: string | null;
}

export interface VerifyNpiArgs {
  /** The NPI the operator checked; refused when the entity's NPI has changed since (no verifying a value unseen). */
  readonly npi: string;
  /** How ownership was confirmed (no PHI). */
  readonly evidence: string;
}

export interface NpiVerificationService {
  list(): Promise<NpiVerificationView[]>;
  verify(
    actor: M23WriteActor,
    providerEntityId: string,
    args: VerifyNpiArgs,
  ): Promise<NpiVerificationView>;
  revoke(actor: M23WriteActor, providerEntityId: string): Promise<NpiVerificationView>;
}

const V = schema.providerNpiVerifications;
type VerificationRow = typeof V.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The entity's state for its CURRENT NPI. `rows` may hold any of the entity's verifications, newest first; a live row
 * for an older NPI does not count while the entity holds another NPI. Pure.
 */
export function deriveNpiVerification(
  entity: PlatformProviderEntity,
  rows: readonly VerificationRow[],
): NpiVerificationView {
  const forNpi = rows.filter((r) => r.providerEntityId === entity.id && r.npi === entity.npi);
  const row = forNpi.find((r) => r.revokedAt === null) ?? forNpi[0] ?? null;
  const state: NpiVerificationState = !row
    ? "unverified"
    : row.revokedAt === null
      ? "verified"
      : "revoked";
  return {
    providerEntityId: entity.id,
    organizationId: entity.organizationId,
    organizationName: entity.organizationName,
    legalName: entity.legalName,
    npi: entity.npi,
    state,
    verificationId: row?.id ?? null,
    evidence: row?.evidence ?? null,
    verifiedAt: iso(row?.verifiedAt ?? null),
    verifiedByMembershipId: row?.verifiedByMembershipId ?? null,
    revokedAt: iso(row?.revokedAt ?? null),
    revokedByMembershipId: row?.revokedByMembershipId ?? null,
  };
}

/** True iff a live (unrevoked) verification exists for this provider entity AND this NPI. Run on the platform tx. */
export async function isNpiVerified(
  tx: DbClient,
  providerEntityId: string,
  npi: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: V.id })
    .from(V)
    .where(and(eq(V.providerEntityId, providerEntityId), eq(V.npi, npi), isNull(V.revokedAt)))
    .limit(1);
  return row !== undefined;
}

const failClosedRunner: NpiVerificationRunner = async () => {
  throw new ChartWardenError(
    "PLATFORM_CONTEXT_UNAVAILABLE",
    "NPI verification requires a bound platform credential",
    503,
  );
};

export function buildDrizzleNpiVerificationService(
  deps: { readonly runner?: NpiVerificationRunner; readonly now?: () => Date } = {},
): NpiVerificationService {
  const platform = deps.runner ?? failClosedRunner;
  const now = deps.now ?? (() => new Date());

  const rowsFor = (tx: DbClient, ids: readonly string[]) =>
    ids.length === 0
      ? Promise.resolve([] as VerificationRow[])
      : tx
          .select()
          .from(V)
          .where(inArray(V.providerEntityId, [...ids]))
          .orderBy(desc(V.verifiedAt));

  async function entityOrThrow(tx: DbClient, id: string): Promise<PlatformProviderEntity> {
    const entity = await providerEntityById(tx, id);
    if (!entity) throw new NotFoundError("provider entity");
    return entity;
  }

  async function liveRow(tx: DbClient, id: string): Promise<VerificationRow | undefined> {
    const [row] = await tx
      .select()
      .from(V)
      .where(and(eq(V.providerEntityId, id), isNull(V.revokedAt)))
      .for("update");
    return row;
  }

  async function viewOf(tx: DbClient, entity: PlatformProviderEntity) {
    return deriveNpiVerification(entity, await rowsFor(tx, [entity.id]));
  }

  return {
    list: () =>
      platform(async (tx) => {
        const entities = await listProviderEntitiesForPlatform(tx);
        const rows = await rowsFor(
          tx,
          entities.map((e) => e.id),
        );
        return entities.map((e) => deriveNpiVerification(e, rows));
      }),

    verify: (actor, providerEntityId, args) =>
      platform(async (tx) => {
        const entity = await entityOrThrow(tx, providerEntityId);
        if (entity.npi !== args.npi) {
          throw new ChartWardenError(
            "NPI_CHANGED",
            "the provider entity's NPI is not the one you checked; reload and check it again",
            409,
          );
        }
        const at = now();
        const live = await liveRow(tx, entity.id);
        if (live?.npi === entity.npi) {
          throw new ChartWardenError("ALREADY_VERIFIED", "this NPI is already verified", 409);
        }
        // Close the entity's live verification of a previous NPI (the one-live index), AND every other entity's live
        // verification of THIS NPI: a stale row elsewhere would otherwise route again if that entity took the NPI back.
        await tx
          .update(V)
          .set({ revokedAt: at, revokedByMembershipId: actor.membershipId, updatedAt: at })
          .where(
            and(isNull(V.revokedAt), or(eq(V.providerEntityId, entity.id), eq(V.npi, entity.npi))),
          );
        await tx.insert(V).values({
          organizationId: entity.organizationId,
          providerEntityId: entity.id,
          npi: entity.npi,
          evidence: args.evidence.trim(),
          verifiedAt: at,
          verifiedByMembershipId: actor.membershipId,
          createdAt: at,
          updatedAt: at,
        });
        return viewOf(tx, entity);
      }),

    revoke: (actor, providerEntityId) =>
      platform(async (tx) => {
        const entity = await entityOrThrow(tx, providerEntityId);
        const live = await liveRow(tx, entity.id);
        if (!live) {
          throw new ChartWardenError(
            "NOT_VERIFIED",
            "there is no live verification to revoke",
            409,
          );
        }
        const at = now();
        await tx
          .update(V)
          .set({ revokedAt: at, revokedByMembershipId: actor.membershipId, updatedAt: at })
          .where(eq(V.id, live.id));
        return viewOf(tx, entity);
      }),
  };
}
