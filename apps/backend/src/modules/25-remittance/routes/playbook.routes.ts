// apps/backend/src/modules/25-remittance/routes/playbook.routes.ts - M25 milestone 9a-1 routes: the denial-reason PLAYBOOK
// library and the per-denial panel. Reads gate on `playbook.read`, writing a playbook or a draft on `playbook.author`,
// publishing or retiring a version on `playbook.publish` (a person other than the author). The two per-denial routes also
// require `denial.read` and its claim-assignment ABAC, so a playbook never opens a denial the actor cannot see. A step
// tick needs only `denial.read` + `playbook.read` and is advisory: no guard reads it. Edits to a version are If-Match
// (409 when stale); every mutation requires an Idempotency-Key. Org, actor and provider-entity scope are server-derived
// (actor.ts). Nothing here states a CMS or MAC rule: all text is the organization's own.
import { NotFoundError } from "@chartwarden/types";
import { FormatRegistry, Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { PLAYBOOK_CODE_KINDS, PLAYBOOK_STEP_STATUSES } from "../domain";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { ASSIGNED_TO_ACTOR, P } from "./guards";
import { parse } from "./m25-typebox";
import type { PlaybookService } from "./playbook-service";

export interface PlaybookRouteDeps {
  readonly playbookService: PlaybookService;
}

// The uuid format is a process-wide TypeBox registration other modules also make; guard so this file does not depend on them.
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_FORMAT.test(v));
}

const NULLABLE_STRING = Type.Union([Type.String(), Type.Null()]);
const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((v) => Type.Literal(v)));

const StepSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 32 }),
  text: Type.String({ minLength: 1, maxLength: 500 }),
});
const ContentProps = {
  summary: Type.String({ minLength: 1, maxLength: 1000 }),
  /** Where this guidance came from. Required: guidance without a source is never saved. */
  sourceNote: Type.String({ minLength: 1, maxLength: 500 }),
  sourceDocumentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  steps: Type.Array(StepSchema, { minItems: 1, maxItems: 30 }),
};

export const PlaybookContentRequestSchema = Type.Object(ContentProps);
export const PlaybookCreateRequestSchema = Type.Object({
  codeKind: literals(PLAYBOOK_CODE_KINDS),
  code: Type.String({ minLength: 1, maxLength: 16 }),
  /** Omit for a playbook that applies to every MAC. */
  macName: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 120 }), Type.Null()])),
  title: Type.String({ minLength: 1, maxLength: 120 }),
  ...ContentProps,
});
export const PlaybookStepRequestSchema = Type.Object({
  /** The playbook version the person is looking at; a tick on any other version is a 409. */
  versionId: Type.String({ format: "uuid" }),
  status: literals(["open", ...PLAYBOOK_STEP_STATUSES] as const),
});

const VersionViewSchema = Type.Object({
  id: Type.String(),
  versionNo: Type.Integer(),
  status: Type.String(),
  summary: Type.String(),
  steps: Type.Array(StepSchema),
  sourceNote: Type.String(),
  sourceDocumentId: NULLABLE_STRING,
  authoredByMembershipId: Type.String(),
  reviewedByMembershipId: NULLABLE_STRING,
  publishedAt: NULLABLE_STRING,
  retiredAt: NULLABLE_STRING,
  effectiveFrom: NULLABLE_STRING,
  rowVersion: Type.Integer(),
});
const PlaybookKeyProps = {
  id: Type.String(),
  codeKind: Type.String(),
  code: Type.String(),
  macName: NULLABLE_STRING,
  title: Type.String(),
};
export const PlaybookListSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      ...PlaybookKeyProps,
      publishedVersionNo: Type.Union([Type.Integer(), Type.Null()]),
      publishedAt: NULLABLE_STRING,
      hasDraft: Type.Boolean(),
    }),
  ),
});
export const PlaybookDetailSchema = Type.Object({
  ...PlaybookKeyProps,
  versions: Type.Array(VersionViewSchema),
});
export const PlaybookCreatedSchema = Type.Object({ id: Type.String(), versionId: Type.String() });
export const PlaybookDraftCreatedSchema = Type.Object({
  id: Type.String(),
  versionNo: Type.Integer(),
  rowVersion: Type.Integer(),
});
export const PlaybookVersionResultSchema = Type.Object({
  id: Type.String(),
  rowVersion: Type.Integer(),
});
export const PlaybookPublishResultSchema = Type.Object({
  id: Type.String(),
  rowVersion: Type.Integer(),
  effectiveFrom: Type.String(),
});

const DenialStepViewSchema = Type.Object({
  key: Type.String(),
  text: Type.String(),
  status: Type.String(),
  markedAt: NULLABLE_STRING,
  markedByMembershipId: NULLABLE_STRING,
});
export const DenialPlaybookViewSchema = Type.Object({
  denialCaseId: Type.String(),
  codeKind: NULLABLE_STRING,
  code: NULLABLE_STRING,
  macName: NULLABLE_STRING,
  playbook: Type.Union([
    Type.Object({
      playbookId: Type.String(),
      title: Type.String(),
      codeKind: Type.String(),
      code: Type.String(),
      macName: NULLABLE_STRING,
      versionId: Type.String(),
      versionNo: Type.Integer(),
      summary: Type.String(),
      sourceNote: Type.String(),
      sourceDocumentId: NULLABLE_STRING,
      authoredByMembershipId: Type.String(),
      reviewedByMembershipId: Type.String(),
      publishedAt: Type.String(),
      effectiveFrom: Type.String(),
      steps: Type.Array(DenialStepViewSchema),
    }),
    Type.Null(),
  ]),
});
export const PlaybookStepResultSchema = Type.Object({
  stepKey: Type.String(),
  status: Type.String(),
});

const READ = P("playbook.read");
const AUTHOR = P("playbook.author");
const PUBLISH = P("playbook.publish");
const MARK = P("playbook.step.mark");
const DENIAL_READ = P("denial.read");
const DENIAL_READ_ABAC = ASSIGNED_TO_ACTOR("denial.read");
const IDEMPOTENT = requireIdempotencyKey();

/** A non-uuid can never match a row, so it is a 404 rather than a database cast error. */
const uuidParam = (request: { params?: unknown }, name: string, what: string): string => {
  const value = (request.params as Record<string, string>)[name] ?? "";
  if (!UUID_FORMAT.test(value)) throw new NotFoundError(what);
  return value;
};

export function registerPlaybookRoutes(app: FastifyInstance, deps: PlaybookRouteDeps): void {
  const { playbookService } = deps;
  const playbookId = (request: { params?: unknown }) => uuidParam(request, "id", "playbook");
  const versionId = (request: { params?: unknown }) => uuidParam(request, "id", "playbook version");
  const denialId = (request: { params?: unknown }) => uuidParam(request, "id", "denial case");

  app.get(
    "/api/v1/playbooks",
    { preHandler: [READ], config: { auditRead: { resourceKind: "denial_playbook", list: true } } },
    async (request, reply) => reply.send(await playbookService.listPlaybooks(actorOf(request))),
  );

  app.get(
    "/api/v1/playbooks/:id",
    {
      preHandler: [READ],
      config: { auditRead: { resourceKind: "denial_playbook", resourceIdParam: "id" } },
    },
    async (request, reply) => {
      const found = await playbookService.getPlaybook(actorOf(request), playbookId(request));
      if (!found) throw new NotFoundError("playbook");
      return reply.send(found);
    },
  );

  app.post("/api/v1/playbooks", { preHandler: [AUTHOR, IDEMPOTENT] }, async (request, reply) => {
    const body = parse(PlaybookCreateRequestSchema, request.body);
    return reply.code(201).send(await playbookService.createPlaybook(writeActorOf(request), body));
  });

  app.post(
    "/api/v1/playbooks/:id/versions",
    { preHandler: [AUTHOR, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PlaybookContentRequestSchema, request.body);
      return reply
        .code(201)
        .send(
          await playbookService.createDraftVersion(
            writeActorOf(request),
            playbookId(request),
            body,
          ),
        );
    },
  );

  app.patch(
    "/api/v1/playbook-versions/:id",
    { preHandler: [AUTHOR, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PlaybookContentRequestSchema, request.body);
      return reply.send(
        await playbookService.updateDraft(
          writeActorOf(request),
          versionId(request),
          body,
          ifMatchVersion(request),
        ),
      );
    },
  );

  app.post(
    "/api/v1/playbook-versions/:id/publish",
    { preHandler: [PUBLISH, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await playbookService.publishVersion(
          writeActorOf(request),
          versionId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  app.post(
    "/api/v1/playbook-versions/:id/retire",
    { preHandler: [PUBLISH, IDEMPOTENT] },
    async (request, reply) =>
      reply.send(
        await playbookService.retireVersion(
          writeActorOf(request),
          versionId(request),
          ifMatchVersion(request),
        ),
      ),
  );

  // The playbook that applies to this denial (resolved by code and MAC), or `playbook: null` when none is written.
  app.get(
    "/api/v1/denials/:id/playbook",
    {
      preHandler: [READ, DENIAL_READ, DENIAL_READ_ABAC],
      config: { auditRead: { resourceKind: "denial_case", resourceIdParam: "id" } },
    },
    async (request, reply) =>
      reply.send(await playbookService.getDenialPlaybook(actorOf(request), denialId(request))),
  );

  // An advisory tick of one step. Writes only the tick row; changes no case, claim, appeal, ADR or submission.
  app.put(
    "/api/v1/denials/:id/playbook-steps/:stepKey",
    { preHandler: [MARK, DENIAL_READ, DENIAL_READ_ABAC, IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(PlaybookStepRequestSchema, request.body);
      const stepKey = (request.params as Record<string, string>).stepKey ?? "";
      return reply.send(
        await playbookService.setStepStatus(
          writeActorOf(request),
          denialId(request),
          stepKey,
          body.versionId,
          body.status,
        ),
      );
    },
  );
}
