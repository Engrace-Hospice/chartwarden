import { ifMatchVersionOf, requireIdempotencyKey } from "@chartwarden/shared/route-kit";
// apps/backend/src/modules/16-bereavement/routes/library.routes.ts — M16 (ADR-0109 D10, PR 3) routes 77-81: the grief library (staff side).
//
// Bereavement oversight curates what the portal shows: `bereavement.library.read` lists items and previews a file, `bereavement.library.manage`
// registers an uploaded M22 document, edits its metadata and publishes / archives it. Families reach published items only through the M31 portal
// routes (`BereavementPortalContentProvider`). Writes need `Idempotency-Key`; edits and status changes `If-Match`. The library is agency content and
// names nobody (its reads say so); the preview carries `resourceIdParam` so the read event names the item, and M22 records the URL mint.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ABAC_OVERSIGHT, P } from "./guards";
import type { M16LibraryService } from "./library-service";
import {
  CreateLibraryItemBody,
  LibraryItemParams,
  LibraryListQuerySchema,
  LibraryUrlQuerySchema,
  SetLibraryStatusBody,
  UpdateLibraryItemBody,
} from "./library-typebox";
import { parse, parseQuery } from "./m16-typebox";

export interface LibraryRouteDeps {
  readonly libraryService: M16LibraryService;
}

const IDEMPOTENT = requireIdempotencyKey();
const READ = "bereavement.library.read";
const MANAGE = "bereavement.library.manage";
const oversight = (key: string) => [P(key), ABAC_OVERSIGHT(key)] as const;

export function registerBereavementLibraryRoutes(
  app: FastifyInstance,
  deps: LibraryRouteDeps,
): void {
  const { libraryService } = deps;

  // 77 — every item, portal order.
  app.get(
    "/api/v1/bereavement/library",
    {
      preHandler: [...oversight(READ)],
      config: { auditRead: { none: "agency-authored grief-library metadata; no person is named" } },
    },
    async (request) =>
      libraryService.listItems(actorOf(request), parseQuery(LibraryListQuerySchema, request.query)),
  );

  // 78 — register an uploaded M22 grief-library document as a draft item.
  app.post(
    "/api/v1/bereavement/library",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request, reply) => {
      const body = parse(CreateLibraryItemBody, request.body);
      return reply.code(201).send(await libraryService.createItem(writeActorOf(request), body));
    },
  );

  // 79 — edit an item's metadata.
  app.patch(
    "/api/v1/bereavement/library/:itemId",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { itemId } = parse(LibraryItemParams, request.params);
      const body = parse(UpdateLibraryItemBody, request.body);
      return libraryService.updateItem(writeActorOf(request), itemId, {
        ...body,
        expectedVersion: ifMatchVersionOf(request),
      });
    },
  );

  // 80 — publish (portal), archive, or back to draft.
  app.post(
    "/api/v1/bereavement/library/:itemId/status",
    { preHandler: [...oversight(MANAGE), IDEMPOTENT] },
    async (request) => {
      const { itemId } = parse(LibraryItemParams, request.params);
      const { status } = parse(SetLibraryStatusBody, request.body);
      return libraryService.setStatus(writeActorOf(request), itemId, {
        status,
        expectedVersion: ifMatchVersionOf(request),
      });
    },
  );

  // 81 — a short-lived preview URL for the file (or its transcript), minted through M22's org-level seam; never cached.
  app.get(
    "/api/v1/bereavement/library/:itemId/url",
    {
      preHandler: [...oversight(READ)],
      config: {
        auditRead: { resourceKind: "bereavement_library_item", resourceIdParam: "itemId" },
      },
    },
    async (request, reply) => {
      const { itemId } = parse(LibraryItemParams, request.params);
      const { part } = parseQuery(LibraryUrlQuerySchema, request.query);
      const out = await libraryService.itemUrl(writeActorOf(request), itemId, part ?? "document");
      void reply.header("cache-control", "no-store");
      return out;
    },
  );
}
