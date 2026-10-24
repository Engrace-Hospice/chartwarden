// apps/backend/src/modules/25-remittance/routes/payer-appeal-path.routes.ts - M25 milestone 12a-1 routes: the organization's
// payer appeal PATHS (data a person writes from a contract; nothing is seeded). Reads gate on `payer_appeal_path.read`, a
// draft is written on `payer_appeal_path.manage`, and a SECOND person activates it on `payer_appeal_path.verify`. Every
// change is If-Match (409 when stale) and every mutation requires an Idempotency-Key. Org and actor are server-derived.
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import {
  ANCHOR_KINDS,
  DAY_BASES,
  LEVEL_KINDS,
  PATH_BOUNDS,
  PAYER_PROGRAMS,
  ROLLS,
  WHO_FILES,
} from "../domain";
import { NotFoundError } from "@chartwarden/types";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import { uuidParam } from "./later-tier.routes";
import { parse } from "./m25-typebox";
import type { PayerAppealPathService } from "./payer-appeal-path-service";

export interface PayerAppealPathRouteDeps {
  readonly payerAppealPathService: PayerAppealPathService;
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const NULLABLE_INT = Type.Union([Type.Integer(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));
const optionalNullable = <T extends ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer>>(
  t: T,
) => Type.Optional(Type.Union([t, Type.Null()]));

export const PayerAppealPathLevelRequestSchema = Type.Object({
  levelKind: literals(LEVEL_KINDS),
  /** The level exactly as the contract or notice names it. */
  levelLabel: Type.String({ minLength: 1, maxLength: PATH_BOUNDS.labelMax }),
  whoFiles: Type.Optional(literals(WHO_FILES)),
  /** The filing window is all-or-none: days, anchor and day basis together, or none of them. */
  filingWindowDays: optionalNullable(Type.Integer()),
  anchorKind: Type.Optional(Type.Union([literals(ANCHOR_KINDS), Type.Null()])),
  receiptPresumptionDays: optionalNullable(Type.Integer()),
  dayBasis: Type.Optional(Type.Union([literals(DAY_BASES), Type.Null()])),
  roll: Type.Optional(Type.Union([literals(ROLLS), Type.Null()])),
  decisionDays: optionalNullable(Type.Integer()),
  formLabel: optionalNullable(Type.String({ maxLength: PATH_BOUNDS.labelMax })),
  channelNote: optionalNullable(Type.String({ maxLength: PATH_BOUNDS.noteMax })),
  /** Where this level came from (contract page, notice, manual). Required. */
  sourceNote: Type.String({ minLength: 1, maxLength: PATH_BOUNDS.noteMax }),
});

export const PayerAppealPathRequestSchema = Type.Object({
  payerId: Type.String({ format: "uuid" }),
  program: literals(PAYER_PROGRAMS),
  contractLabel: optionalNullable(Type.String({ maxLength: PATH_BOUNDS.labelMax })),
  effectiveFrom: DAY,
  sourceNote: Type.String({ minLength: 1, maxLength: PATH_BOUNDS.noteMax }),
  sourceDocumentId: optionalNullable(Type.String({ format: "uuid" })),
  supersedesPathId: optionalNullable(Type.String({ format: "uuid" })),
  levels: Type.Array(PayerAppealPathLevelRequestSchema, {
    minItems: 1,
    maxItems: PATH_BOUNDS.levelsMax,
  }),
});

const PathLevelViewSchema = Type.Object({
  id: Type.String(),
  ordinal: Type.Integer(),
  levelKind: Type.String(),
  levelLabel: Type.String(),
  whoFiles: Type.String(),
  filingWindowDays: NULLABLE_INT,
  anchorKind: NULLABLE_STRING,
  receiptPresumptionDays: NULLABLE_INT,
  dayBasis: NULLABLE_STRING,
  roll: NULLABLE_STRING,
  decisionDays: NULLABLE_INT,
  formLabel: NULLABLE_STRING,
  channelNote: NULLABLE_STRING,
  sourceNote: Type.String(),
});

export const PayerAppealPathViewSchema = Type.Object({
  id: Type.String(),
  payerId: Type.String(),
  payerName: Type.String(),
  program: Type.String(),
  contractLabel: NULLABLE_STRING,
  status: Type.String(),
  effectiveFrom: Type.String(),
  sourceNote: Type.String(),
  sourceDocumentId: NULLABLE_STRING,
  authoredByMembershipId: Type.String(),
  verifiedOn: NULLABLE_STRING,
  verifiedByMembershipId: NULLABLE_STRING,
  supersedesPathId: NULLABLE_STRING,
  revision: Type.Integer(),
  version: Type.Integer(),
  levels: Type.Array(PathLevelViewSchema),
});
export const PayerAppealPathPageSchema = Type.Object({ items: Type.Array(PayerAppealPathViewSchema) });
export const PayerAppealPathListQuerySchema = Type.Object({
  payerId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});
export const PayerAppealVersionedResultSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer(),
});

export function registerPayerAppealPathRoutes(
  app: FastifyInstance,
  deps: PayerAppealPathRouteDeps,
): void {
  const { payerAppealPathService: svc } = deps;
  const READ = P("payer_appeal_path.read");
  const MANAGE = P("payer_appeal_path.manage");
  const VERIFY = P("payer_appeal_path.verify");
  const IDEMPOTENT = requireIdempotencyKey();
  const pathId = (request: { params?: unknown }) => uuidParam(request, "id", "payer appeal path");

  app.get("/api/v1/payer-appeal-paths", { preHandler: [READ] }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const payerId = typeof q.payerId === "string" && q.payerId.length > 0 ? q.payerId : undefined;
    const status = typeof q.status === "string" && q.status.length > 0 ? q.status : undefined;
    return reply.send(
      await svc.listPaths(actorOf(request), {
        ...(payerId ? { payerId } : {}),
        ...(status ? { status } : {}),
      }),
    );
  });

  app.get("/api/v1/payer-appeal-paths/:id", { preHandler: [READ] }, async (request, reply) => {
    const found = await svc.getPath(actorOf(request), pathId(request));
    if (!found) throw new NotFoundError("payer appeal path");
    return reply.send(found);
  });

  app.post(
    "/api/v1/payer-appeal-paths",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PayerAppealPathRequestSchema, request.body);
      return reply.code(201).send(
        await svc.createPath(writeActorOf(request), {
          payerId: body.payerId,
          program: body.program,
          contractLabel: body.contractLabel ?? null,
          effectiveFrom: body.effectiveFrom,
          sourceNote: body.sourceNote,
          sourceDocumentId: body.sourceDocumentId ?? null,
          supersedesPathId: body.supersedesPathId ?? null,
          levels: body.levels.map((l) => ({
            levelKind: l.levelKind,
            levelLabel: l.levelLabel,
            whoFiles: l.whoFiles ?? "unknown",
            filingWindowDays: l.filingWindowDays ?? null,
            anchorKind: l.anchorKind ?? null,
            receiptPresumptionDays: l.receiptPresumptionDays ?? null,
            dayBasis: l.dayBasis ?? null,
            roll: l.roll ?? null,
            decisionDays: l.decisionDays ?? null,
            formLabel: l.formLabel ?? null,
            channelNote: l.channelNote ?? null,
            sourceNote: l.sourceNote,
          })),
        }),
      );
    },
  );

  // The second person checks the draft against the contract and activates it; the database refuses author = verifier.
  app.post(
    "/api/v1/payer-appeal-paths/:id/verify",
    { preHandler: [VERIFY, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(await svc.verifyPath(writeActorOf(request), pathId(request), ifMatchVersion(request))),
  );

  app.post(
    "/api/v1/payer-appeal-paths/:id/retire",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(await svc.retirePath(writeActorOf(request), pathId(request), ifMatchVersion(request))),
  );
}
