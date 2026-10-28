import { requirePermission } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { ringsAreValid } from "@chartwarden/shared/geo";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  type EmergencyServiceJurisdictionReader,
  NotFoundError,
  type PsapResolution,
  type SafetyPolygonRings,
  ValidationError,
} from "@chartwarden/types";
// apps/backend/src/modules/40-mdm/psap-jurisdictions.ts - M40 `emergency_service_jurisdiction` catalog (GAP-032).
//
// The TENANT-CURATED PSAP catalog M20's SOS terminus resolves against. No national dataset ships and none is
// invented: an org enters (and re-verifies, every `verify_every_days`) the administrative line of the PSAP
// covering each of its places. Three pieces, the `grief-resources.ts` precedent:
//   - `createPsapJurisdictionStore(db)`       the org-scoped Drizzle store (every method under `withOrgContext`);
//   - `buildEmergencyServiceJurisdictionReader` the `EmergencyServiceJurisdictionReader` SEAM impl;
//   - `registerPsapJurisdictionRoutes`        GET/POST/PATCH + verify/deactivate/reactivate under
//                                              `mdm.psap_jurisdiction.{read,manage}`.
// A row retires with `is_active = false`; every UPDATE asserts its row count (a write that matched nothing is a
// 404, never a silent success). A PSAP number is a PUBLIC administrative line; it is surfaced to a human in the
// authenticated UI and is never dialled by the platform, and never travels in an outbox or audit payload.
import { Type } from "@sinclair/typebox";
import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf, parseOrThrow } from "./grief-resources";
import { type JurisdictionRowFacts, isStale, resolveJurisdiction, summarize } from "./psap-resolve";

const J = schema.emergencyServiceJurisdictions;
type Row = typeof J.$inferSelect;

export interface PsapJurisdictionView {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly countyFips: string | null;
  readonly hasPolygon: boolean;
  readonly psapName: string;
  readonly psapPhone: string;
  readonly secondaryPhone: string | null;
  readonly appliesToLocationId: string | null;
  readonly isOrgDefault: boolean;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly verifiedAt: string;
  readonly verifyEveryDays: number;
  readonly stale: boolean;
  readonly isActive: boolean;
  readonly updatedAt: string;
}

export interface PsapJurisdictionInput {
  readonly name: string;
  readonly state: string;
  readonly countyFips?: string | null;
  readonly polygon?: SafetyPolygonRings | null;
  readonly psapName: string;
  readonly psapPhone: string;
  readonly secondaryPhone?: string | null;
  readonly appliesToLocationId?: string | null;
  readonly isOrgDefault?: boolean;
  readonly sourceRef?: string | null;
  readonly verifyEveryDays?: number;
}

const toFacts = (r: Row): JurisdictionRowFacts => ({
  id: r.id,
  name: r.name,
  psapName: r.psapName,
  psapPhone: r.psapPhone,
  secondaryPhone: r.secondaryPhone,
  polygon: (r.polygon ?? null) as SafetyPolygonRings | null,
  appliesToLocationId: r.appliesToLocationId,
  isOrgDefault: r.isOrgDefault,
  verifiedAt: r.verifiedAt,
  verifyEveryDays: r.verifyEveryDays,
});

const toView = (r: Row, now: Date): PsapJurisdictionView => ({
  id: r.id,
  name: r.name,
  state: r.state,
  countyFips: r.countyFips,
  hasPolygon: r.polygon !== null,
  psapName: r.psapName,
  psapPhone: r.psapPhone,
  secondaryPhone: r.secondaryPhone,
  appliesToLocationId: r.appliesToLocationId,
  isOrgDefault: r.isOrgDefault,
  source: r.source,
  sourceRef: r.sourceRef,
  verifiedAt: r.verifiedAt.toISOString(),
  verifyEveryDays: r.verifyEveryDays,
  stale: isStale(toFacts(r), now),
  isActive: r.isActive,
  updatedAt: r.updatedAt.toISOString(),
});

function assertPolygon(polygon: unknown): void {
  if (polygon !== null && polygon !== undefined && !ringsAreValid(polygon)) {
    throw new ValidationError("request validation failed", [
      {
        field: "polygon",
        code: "POLYGON_INVALID",
        message: "polygon must be closed GeoJSON rings of [lng, lat] with at least 4 points each",
      },
    ]);
  }
}

export interface PsapJurisdictionStore {
  list(
    organizationId: string,
    opts?: { includeInactive?: boolean },
  ): Promise<readonly PsapJurisdictionView[]>;
  create(
    organizationId: string,
    actorMembershipId: string | null,
    input: PsapJurisdictionInput,
  ): Promise<PsapJurisdictionView>;
  update(
    organizationId: string,
    id: string,
    patch: Partial<PsapJurisdictionInput>,
  ): Promise<PsapJurisdictionView>;
  verify(
    organizationId: string,
    id: string,
    actorMembershipId: string | null,
  ): Promise<PsapJurisdictionView>;
  setActive(organizationId: string, id: string, isActive: boolean): Promise<PsapJurisdictionView>;
}

export function createPsapJurisdictionStore(
  db: DbClient,
  now: () => Date = () => new Date(),
): PsapJurisdictionStore {
  const scoped = <T>(organizationId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) => fn(tx as unknown as DbClient));
  const mustFind = (row: Row | undefined, id: string): Row => {
    if (!row) throw new NotFoundError("emergency_service_jurisdiction", id);
    return row;
  };
  return {
    list: (organizationId, opts) =>
      scoped(organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(J)
          .where(
            opts?.includeInactive
              ? eq(J.organizationId, organizationId)
              : and(eq(J.organizationId, organizationId), eq(J.isActive, true)),
          )
          .orderBy(desc(J.isActive), asc(J.name), asc(J.id));
        const at = now();
        return rows.map((r) => toView(r, at));
      }),

    create: (organizationId, actorMembershipId, input) =>
      scoped(organizationId, async (tx) => {
        assertPolygon(input.polygon);
        const at = now();
        const [row] = await tx
          .insert(J)
          .values({
            organizationId,
            name: input.name.trim(),
            state: input.state,
            countyFips: input.countyFips ?? null,
            polygon: input.polygon ?? null,
            psapName: input.psapName.trim(),
            psapPhone: input.psapPhone,
            secondaryPhone: input.secondaryPhone ?? null,
            appliesToLocationId: input.appliesToLocationId ?? null,
            isOrgDefault: input.isOrgDefault ?? false,
            sourceRef: input.sourceRef ?? null,
            verifyEveryDays: input.verifyEveryDays ?? 180,
            verifiedAt: at,
            verifiedByMembershipId: actorMembershipId,
          })
          .returning();
        return toView(mustFind(row, "(new)"), at);
      }),

    update: (organizationId, id, patch) =>
      scoped(organizationId, async (tx) => {
        assertPolygon(patch.polygon);
        const at = now();
        const [existing] = await tx
          .select()
          .from(J)
          .where(and(eq(J.id, id), eq(J.organizationId, organizationId)))
          .limit(1);
        const current = mustFind(existing, id);
        // Changing WHERE a number applies or WHO answers it invalidates the last verification: re-verify.
        const changesNumberOrCoverage =
          patch.psapPhone !== undefined ||
          patch.secondaryPhone !== undefined ||
          patch.polygon !== undefined ||
          patch.appliesToLocationId !== undefined ||
          patch.isOrgDefault !== undefined;
        const [row] = await tx
          .update(J)
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
            ...(patch.state === undefined ? {} : { state: patch.state }),
            ...(patch.countyFips === undefined ? {} : { countyFips: patch.countyFips }),
            ...(patch.polygon === undefined ? {} : { polygon: patch.polygon }),
            ...(patch.psapName === undefined ? {} : { psapName: patch.psapName.trim() }),
            ...(patch.psapPhone === undefined ? {} : { psapPhone: patch.psapPhone }),
            ...(patch.secondaryPhone === undefined ? {} : { secondaryPhone: patch.secondaryPhone }),
            ...(patch.appliesToLocationId === undefined
              ? {}
              : { appliesToLocationId: patch.appliesToLocationId }),
            ...(patch.isOrgDefault === undefined ? {} : { isOrgDefault: patch.isOrgDefault }),
            ...(patch.sourceRef === undefined ? {} : { sourceRef: patch.sourceRef }),
            ...(patch.verifyEveryDays === undefined
              ? {}
              : { verifyEveryDays: patch.verifyEveryDays }),
            // An edit that changes the number or its coverage must be re-verified by a human: the verified
            // stamp is rewound to the epoch so the row reads as stale until `verify` is called.
            ...(changesNumberOrCoverage ? { verifiedAt: new Date(0) } : {}),
            version: current.version + 1,
            updatedAt: at,
          })
          .where(and(eq(J.id, id), eq(J.organizationId, organizationId)))
          .returning();
        return toView(mustFind(row, id), at);
      }),

    verify: (organizationId, id, actorMembershipId) =>
      scoped(organizationId, async (tx) => {
        const at = now();
        const [row] = await tx
          .update(J)
          .set({ verifiedAt: at, verifiedByMembershipId: actorMembershipId, updatedAt: at })
          .where(and(eq(J.id, id), eq(J.organizationId, organizationId)))
          .returning();
        return toView(mustFind(row, id), at);
      }),

    setActive: (organizationId, id, isActive) =>
      scoped(organizationId, async (tx) => {
        const at = now();
        const [row] = await tx
          .update(J)
          .set({ isActive, updatedAt: at })
          .where(and(eq(J.id, id), eq(J.organizationId, organizationId)))
          .returning();
        return toView(mustFind(row, id), at);
      }),
  };
}

/**
 * The `EmergencyServiceJurisdictionReader` seam: active rows only, resolved by the pure rule. A read failure
 * THROWS (the caller reads a throw as `unavailable`) - it must never collapse into `none`.
 */
export function buildEmergencyServiceJurisdictionReader(
  db: DbClient,
  now: () => Date = () => new Date(),
): EmergencyServiceJurisdictionReader {
  const activeRows = (organizationId: string): Promise<Row[]> =>
    withOrgContext(db, { organizationId, userId: "" }, (tx) =>
      (tx as unknown as DbClient)
        .select()
        .from(J)
        .where(and(eq(J.organizationId, organizationId), eq(J.isActive, true))),
    );
  return {
    async forSosAlert(input): Promise<PsapResolution> {
      const rows = await activeRows(input.orgId);
      return resolveJurisdiction(
        rows.map(toFacts),
        { point: input.point, locationId: input.locationId },
        now(),
      );
    },
    async byId(orgId, jurisdictionId) {
      const rows = await activeRows(orgId);
      const row = rows.find((r) => r.id === jurisdictionId);
      return row ? summarize(toFacts(row), now()) : null;
    },
  };
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────

const E164 = { pattern: "^\\+[1-9][0-9]{6,14}$" } as const;
const Nullable = <T extends import("@sinclair/typebox").TSchema>(t: T) =>
  Type.Optional(Type.Union([t, Type.Null()]));
const Ring = Type.Array(Type.Tuple([Type.Number(), Type.Number()]), { minItems: 4 });
export const PsapJurisdictionBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  state: Type.String({ pattern: "^[A-Z]{2}$" }),
  countyFips: Nullable(Type.String({ pattern: "^[0-9]{5}$" })),
  polygon: Nullable(Type.Array(Ring, { minItems: 1 })),
  psapName: Type.String({ minLength: 1, maxLength: 200 }),
  psapPhone: Type.String(E164),
  secondaryPhone: Nullable(Type.String(E164)),
  appliesToLocationId: Nullable(Type.String({ format: "uuid" })),
  isOrgDefault: Type.Optional(Type.Boolean()),
  sourceRef: Nullable(Type.String({ maxLength: 500 })),
  verifyEveryDays: Type.Optional(Type.Integer({ minimum: 30, maximum: 730 })),
});
export const PsapJurisdictionPatchSchema = Type.Partial(PsapJurisdictionBodySchema);
export const PsapJurisdictionIdParams = Type.Object({ id: Type.String({ format: "uuid" }) });
export const PsapJurisdictionListQuery = Type.Object({
  includeInactive: Type.Optional(Type.Boolean()),
});

export function registerPsapJurisdictionRoutes(
  app: FastifyInstance,
  deps: { readonly store: PsapJurisdictionStore },
): void {
  const { store } = deps;
  const READ = requirePermission("mdm.psap_jurisdiction.read") as PreHandler;
  const MANAGE = requirePermission("mdm.psap_jurisdiction.manage") as PreHandler;

  app.get("/api/v1/mdm/psap-jurisdictions", { preHandler: [READ] }, async (request) => {
    const { organizationId } = actorOf(request);
    const q = parseOrThrow(PsapJurisdictionListQuery, request.query);
    return { items: await store.list(organizationId, { includeInactive: q.includeInactive }) };
  });

  app.post("/api/v1/mdm/psap-jurisdictions", { preHandler: [MANAGE] }, async (request, reply) => {
    const { organizationId, membershipId } = actorOf(request);
    const body = parseOrThrow(PsapJurisdictionBodySchema, request.body);
    return reply
      .code(201)
      .send(await store.create(organizationId, membershipId, body as PsapJurisdictionInput));
  });

  app.patch("/api/v1/mdm/psap-jurisdictions/:id", { preHandler: [MANAGE] }, async (request) => {
    const { organizationId } = actorOf(request);
    const { id } = parseOrThrow(PsapJurisdictionIdParams, request.params);
    return store.update(
      organizationId,
      id,
      parseOrThrow(PsapJurisdictionPatchSchema, request.body) as Partial<PsapJurisdictionInput>,
    );
  });

  app.post(
    "/api/v1/mdm/psap-jurisdictions/:id/verify",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId, membershipId } = actorOf(request);
      const { id } = parseOrThrow(PsapJurisdictionIdParams, request.params);
      return store.verify(organizationId, id, membershipId);
    },
  );

  app.post(
    "/api/v1/mdm/psap-jurisdictions/:id/deactivate",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parseOrThrow(PsapJurisdictionIdParams, request.params);
      return store.setActive(organizationId, id, false);
    },
  );

  app.post(
    "/api/v1/mdm/psap-jurisdictions/:id/reactivate",
    { preHandler: [MANAGE] },
    async (request) => {
      const { organizationId } = actorOf(request);
      const { id } = parseOrThrow(PsapJurisdictionIdParams, request.params);
      return store.setActive(organizationId, id, true);
    },
  );
}
