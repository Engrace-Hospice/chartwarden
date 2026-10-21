// apps/backend/src/modules/25-remittance/routes/tpe.routes.ts — M25 milestone 5 routes: the TPE program tracker.
// Reads gate on `tpe.read`, writes on `tpe.manage`, and the organization's per-MAC exit thresholds on
// `tpe_rule.manage`. Every change to a program, round or sampled claim is If-Match (409 when stale), a threshold update takes an optional If-Match, and every mutation requires an Idempotency-Key. Org,
// actor and provider-entity scope are server-derived (actor.ts). Nothing is filed and no threshold has a default.
import { FormatRegistry, Type } from "@sinclair/typebox";
import { NotFoundError } from "@chartwarden/types";
import type { FastifyInstance } from "fastify";
import { TPE_CLAIM_RESULTS, TPE_MAC_RESULTS, TPE_REFERRAL_KINDS } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { clampLimit, ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import { parse } from "./m25-typebox";
import type { TpeService } from "./tpe-service";

export interface TpeRouteDeps {
  readonly tpeService: TpeService;
}

// The uuid format is a process-wide TypeBox registration other modules also make; guard so this file does not depend on them.
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_FORMAT.test(v));
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const NULLABLE_NUMBER = Type.Union([Type.Number(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

export const TpeProgramCreateRequestSchema = Type.Object({
  providerEntityId: Type.String({ format: "uuid" }),
  macName: Type.String({ minLength: 1, maxLength: 120 }),
  openedOn: DAY,
});

export const TpeRoundCreateRequestSchema = Type.Object({
  /** The date on the MAC's notice that started the round. */
  noticeOn: DAY,
});

export const TpeResultsRequestSchema = Type.Object({
  /** The date on the MAC's results letter. */
  resultsOn: DAY,
  /** The error rate the letter states, or null when it states none. */
  macErrorRatePct: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
  macResult: literals(TPE_MAC_RESULTS),
});

export const TpeEducationRequestSchema = Type.Object({
  /** null clears the education date. */
  educationOn: Type.Union([DAY, Type.Null()]),
  note: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Null()])),
});

export const TpeClaimRequestSchema = Type.Object({
  /** Omit to leave the ADR link as it is; null unlinks it. */
  adrCaseId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  result: Type.Optional(literals(TPE_CLAIM_RESULTS)),
});

export const TpeOutcomeRequestSchema = Type.Object({
  kind: Type.Union([Type.Literal("compliant"), Type.Literal("referred")]),
  outcomeOn: DAY,
  /** Typed from the CMS letter (compliant only); never computed. */
  reliefUntil: Type.Optional(Type.Union([DAY, Type.Null()])),
  /** At least one is required on a referral. */
  referralKinds: Type.Optional(Type.Array(literals(TPE_REFERRAL_KINDS), { maxItems: 4 })),
});

export const TpeRuleRequestSchema = Type.Object({
  macName: Type.String({ minLength: 1, maxLength: 120 }),
  /** The exit error rate (percent) from the MAC's TPE letter. */
  exitErrorRatePct: Type.Number({ minimum: 0, maximum: 100 }),
  sourceNote: Type.Optional(Type.String({ maxLength: 500 })),
  verifiedOn: Type.Optional(DAY),
  effectiveFrom: Type.Optional(DAY),
});

const ThresholdSchema = Type.Object({
  pct: NULLABLE_NUMBER,
  source: Type.String(),
  verified: Type.Boolean(),
});
const CountRateSchema = Type.Union([
  Type.Object({ reviewed: Type.Integer(), errors: Type.Integer(), pct: Type.Number() }),
  Type.Null(),
]);

const TpeProgramSummarySchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  macName: Type.String(),
  openedOn: Type.String(),
  state: Type.String(),
  outcomeOn: NULLABLE_STRING,
  reliefUntil: NULLABLE_STRING,
  referralKinds: Type.Array(Type.String()),
  version: Type.Integer(),
  maxRounds: Type.Integer(),
  roundsRecorded: Type.Integer(),
  currentRound: Type.Union([Type.Integer(), Type.Null()]),
  latestRound: Type.Union([
    Type.Object({
      roundNumber: Type.Integer(),
      resultsOn: Type.String(),
      macErrorRatePct: NULLABLE_NUMBER,
      macResult: Type.String(),
    }),
    Type.Null(),
  ]),
  threshold: ThresholdSchema,
  aboveThreshold: Type.Union([Type.Boolean(), Type.Null()]),
  claimCountRate: CountRateSchema,
  nextRoundEarliest: NULLABLE_STRING,
  risk: Type.String(),
});
export const TpeProgramPageSchema = Type.Object({ items: Type.Array(TpeProgramSummarySchema) });
export const TpeProgramListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  limit: Type.Optional(Type.String()),
});
export const TpeProgramDetailSchema = Type.Composite([
  TpeProgramSummarySchema,
  Type.Object({
    rounds: Type.Array(
      Type.Object({
        id: Type.String(),
        roundNumber: Type.Integer(),
        noticeOn: Type.String(),
        resultsOn: NULLABLE_STRING,
        macErrorRatePct: NULLABLE_NUMBER,
        macResult: NULLABLE_STRING,
        threshold: Type.Union([ThresholdSchema, Type.Null()]),
        educationOn: NULLABLE_STRING,
        educationNote: NULLABLE_STRING,
        claims: Type.Array(
          Type.Object({
            id: Type.String(),
            claimId: Type.String(),
            adrCaseId: NULLABLE_STRING,
            adrState: NULLABLE_STRING,
            result: Type.String(),
          }),
        ),
        claimCountRate: CountRateSchema,
        warnings: Type.Array(Type.String()),
        version: Type.Integer(),
      }),
    ),
  }),
]);
export const TpeVersionedResultSchema = Type.Object({ id: Type.String(), version: Type.Integer() });
export const TpeRoundCreatedSchema = Type.Composite([
  TpeVersionedResultSchema,
  Type.Object({ roundNumber: Type.Integer(), warnings: Type.Array(Type.String()) }),
]);
export const TpeRulePageSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Type.String(),
      macName: Type.String(),
      exitErrorRatePct: Type.Number(),
      sourceNote: NULLABLE_STRING,
      verifiedOn: NULLABLE_STRING,
      effectiveFrom: Type.String(),
      version: Type.Integer(),
    }),
  ),
});

const READ = P("tpe.read");
const MANAGE = P("tpe.manage");
const RULES = P("tpe_rule.manage");
const IDEMPOTENT = requireIdempotencyKey();

/** A uuid path param; a non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const uuidParam = (request: { params?: unknown }, name: string, what: string): string => {
  const value = (request.params as Record<string, string>)[name] ?? "";
  if (!UUID_FORMAT.test(value)) throw new NotFoundError(what);
  return value;
};

export function registerTpeRoutes(app: FastifyInstance, deps: TpeRouteDeps): void {
  const { tpeService } = deps;
  const programId = (request: { params?: unknown }) => uuidParam(request, "id", "TPE program");
  const roundId = (request: { params?: unknown }) => uuidParam(request, "id", "TPE round");

  app.get(
    "/api/v1/tpe-programs",
    { preHandler: [READ], config: { auditRead: { resourceKind: "tpe_program", list: true } } },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const state = typeof q.state === "string" && q.state.length > 0 ? q.state : undefined;
      return reply.send(
        await tpeService.listPrograms(
          actorOf(request),
          state ? { state } : {},
          clampLimit(typeof q.limit === "string" ? q.limit : undefined),
        ),
      );
    },
  );

  app.get(
    "/api/v1/tpe-programs/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "tpe_program", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const found = await tpeService.getProgram(actorOf(request), programId(request));
      if (!found) throw new NotFoundError("TPE program");
      return reply.send(found);
    },
  );

  app.post("/api/v1/tpe-programs", { preHandler: [MANAGE, IDEMPOTENT] }, async (request, reply) => {
    const body = parse(TpeProgramCreateRequestSchema, request.body);
    return reply.code(201).send(await tpeService.createProgram(writeActorOf(request), body));
  });

  app.post(
    "/api/v1/tpe-programs/:id/rounds",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TpeRoundCreateRequestSchema, request.body);
      return reply
        .code(201)
        .send(
          await tpeService.createRound(
            writeActorOf(request),
            programId(request),
            body.noticeOn,
            ifMatchVersion(request),
          ),
        );
    },
  );

  app.put(
    "/api/v1/tpe-rounds/:id/results",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TpeResultsRequestSchema, request.body);
      return reply.send(
        await tpeService.setResults(
          writeActorOf(request),
          roundId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.put(
    "/api/v1/tpe-rounds/:id/education",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TpeEducationRequestSchema, request.body);
      return reply.send(
        await tpeService.setEducation(
          writeActorOf(request),
          roundId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.put(
    "/api/v1/tpe-rounds/:id/claims/:claimId",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TpeClaimRequestSchema, request.body);
      return reply.send(
        await tpeService.upsertClaim(
          writeActorOf(request),
          roundId(request),
          uuidParam(request, "claimId", "claim"),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/tpe-programs/:id/outcome",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(TpeOutcomeRequestSchema, request.body);
      return reply.send(
        await tpeService.recordOutcome(
          writeActorOf(request),
          programId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/tpe-programs/:id/close",
    { preHandler: [MANAGE, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await tpeService.closeProgram(
          writeActorOf(request),
          programId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  app.get("/api/v1/tpe-rules", { preHandler: [READ] }, async (request, reply) =>
    reply.send(await tpeService.listRules(actorOf(request))),
  );

  app.put("/api/v1/tpe-rules", { preHandler: [RULES, IDEMPOTENT] }, async (request, reply) => {
    const body = parse(TpeRuleRequestSchema, request.body);
    // If-Match is optional here: it guards an UPDATE of an existing rule; a new rule needs none.
    const raw = request.headers["if-match"];
    const version = raw === undefined ? undefined : ifMatchVersion(request);
    return reply.send(await tpeService.upsertRule(writeActorOf(request), body, version));
  });
}
