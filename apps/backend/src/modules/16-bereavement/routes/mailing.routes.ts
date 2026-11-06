import { NotFoundError } from "@chartwarden/types";
// apps/backend/src/modules/16-bereavement/routes/mailing.routes.ts — M16 (ADR-0109 D10) routes 42-51: the mailing program.
//
// EVERY route is bereavement oversight only: the batch PDF holds every recipient's name and address. `bereavement.mailing.read` reads configs, runs and items;
// `manage` writes a config, a draft's wording and cancels a run; `dispatch` generates, downloads and confirms a run mailed. Each is paired with the
// `org_scope_bereavement_oversight` predicate. Every write needs `Idempotency-Key` AND `If-Match` (the header decides the version; no body carries one) and the
// state changes are compare-and-set in the service. Every PHI-adjacent read declares its M4 read audit; the download's carries `resourceIdParam`, so the read
// event names WHICH run's batch was handed out (the M22 access ledger records the URL mint itself).
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import { ABAC_OVERSIGHT, P } from "./guards";
import { parse, parseQuery } from "./m16-typebox";
import type { M16MailingService } from "./mailing-service";
import {
  MailingItemListQuerySchema,
  MailingKeyParams,
  MailingRunListQuerySchema,
  MailingRunParams,
  PutMailingConfigBody,
  UpdateMailingRunContentBody,
} from "./mailing-typebox";

export interface MailingRouteDeps {
  readonly mailingService: M16MailingService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();
const RUN_READ = { resourceKind: "bereavement_mailing_run", resourceIdParam: "runId" } as const;
const oversight = (key: string) => [P(key), ABAC_OVERSIGHT(key)] as const;

export function registerBereavementMailingRoutes(
  app: FastifyInstance,
  deps: MailingRouteDeps,
): void {
  const { mailingService } = deps;

  // 42 — the four configurable mailings, each merged with its stored config (a disabled default when never configured).
  app.get(
    "/api/v1/bereavement/mailings/config",
    {
      preHandler: [...oversight("bereavement.mailing.read")],
      config: {
        auditRead: {
          none: "agency-authored mailing configuration (dates, audience, wording); no recipient and no PHI",
        },
      },
    },
    async (request) => mailingService.listConfigs(actorOf(request)),
  );

  // 43 — upsert one mailing's config. `If-Match` is the version read (0 for the first write).
  app.put(
    "/api/v1/bereavement/mailings/config/:mailingKey",
    { preHandler: [...oversight("bereavement.mailing.manage"), IDEMPOTENT] },
    async (request) => {
      const { mailingKey } = parse(MailingKeyParams, request.params);
      const body = parse(PutMailingConfigBody, request.body);
      return mailingService.putConfig(writeActorOf(request), mailingKey, {
        ...body,
        audienceRelationships: body.audienceRelationships,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 44 — runs, newest scheduled first.
  app.get(
    "/api/v1/bereavement/mailings/runs",
    {
      preHandler: [...oversight("bereavement.mailing.read"), NO_OFFSET],
      config: { auditRead: { resourceKind: "bereavement_mailing_run", list: true } },
    },
    async (request) =>
      mailingService.listRuns(
        actorOf(request),
        parseQuery(MailingRunListQuerySchema, request.query),
      ),
  );

  // 45 — one run with its item counts.
  app.get(
    "/api/v1/bereavement/mailings/runs/:runId",
    { preHandler: [...oversight("bereavement.mailing.read")], config: { auditRead: RUN_READ } },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      const run = await mailingService.getRun(actorOf(request), runId);
      if (!run) throw new NotFoundError("mailing run not found");
      return run;
    },
  );

  // 46 — a run's items (ids, relationship, channel, status and exclusion reason; never a name or an address).
  app.get(
    "/api/v1/bereavement/mailings/runs/:runId/items",
    {
      preHandler: [...oversight("bereavement.mailing.read"), NO_OFFSET],
      config: { auditRead: RUN_READ },
    },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      const page = await mailingService.listItems(
        actorOf(request),
        runId,
        parseQuery(MailingItemListQuerySchema, request.query),
      );
      if (!page) throw new NotFoundError("mailing run not found");
      return page;
    },
  );

  // 47 — replace a DRAFT run's wording (409 once it is generating or later).
  app.patch(
    "/api/v1/bereavement/mailings/runs/:runId/content",
    { preHandler: [...oversight("bereavement.mailing.manage"), IDEMPOTENT] },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      const body = parse(UpdateMailingRunContentBody, request.body);
      return mailingService.updateRunContent(writeActorOf(request), runId, {
        content: body.content,
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 48 — generate: compare-and-set draft -> generating, select the batch set-based, hand the render to the worker. Empty wording is refused (422).
  app.post(
    "/api/v1/bereavement/mailings/runs/:runId/generate",
    { preHandler: [...oversight("bereavement.mailing.dispatch"), IDEMPOTENT] },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      return mailingService.generateRun(writeActorOf(request), runId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 49 — a short-lived URL for the rendered batch PDF through the M22 org-level seam. The response is never cached.
  app.get(
    "/api/v1/bereavement/mailings/runs/:runId/download",
    { preHandler: [...oversight("bereavement.mailing.dispatch")], config: { auditRead: RUN_READ } },
    async (request, reply) => {
      const { runId } = parse(MailingRunParams, request.params);
      const out = await mailingService.downloadRun(writeActorOf(request), runId);
      void reply.header("cache-control", "no-store");
      return out;
    },
  );

  // 50 — confirm the batch was mailed: re-check eligibility (flags `excluded_after_render`), ready -> mailed, emit `mailing_run_mailed`.
  app.post(
    "/api/v1/bereavement/mailings/runs/:runId/confirm-mailed",
    { preHandler: [...oversight("bereavement.mailing.dispatch"), IDEMPOTENT] },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      return mailingService.confirmMailed(writeActorOf(request), runId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );

  // 51 — cancel a draft, ready or failed run.
  app.post(
    "/api/v1/bereavement/mailings/runs/:runId/cancel",
    { preHandler: [...oversight("bereavement.mailing.manage"), IDEMPOTENT] },
    async (request) => {
      const { runId } = parse(MailingRunParams, request.params);
      return mailingService.cancelRun(writeActorOf(request), runId, {
        expectedVersion: ifMatchVersion(request, true) as number,
      });
    },
  );
}
