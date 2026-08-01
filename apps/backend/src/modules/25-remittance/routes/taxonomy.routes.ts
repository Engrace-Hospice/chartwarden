// apps/backend/src/modules/25-remittance/routes/taxonomy.routes.ts — M25 (§4.1 routes 27-28) the denial
// taxonomy: the merged M38-catalog + per-tenant-overlay view, and the overlay edit. `category` is the M38
// regulatory floor and is NEVER editable here (M25-F09 — the PATCH body schema has no category field). The
// edit is optimistic-concurrency (If-Match) and idempotency-keyed.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, requireIdempotencyKey } from "./concurrency";
import { P } from "./guards";
import { TaxonomyOverlayPatchSchema, parse } from "./m25-typebox";
import type { M25ReadService } from "./read-service";
import type { M25WriteService } from "./write-service";

export interface TaxonomyRouteDeps {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
}

const READ = P("taxonomy.read");
const EDIT = P("taxonomy.edit");
const IDEMPOTENT = requireIdempotencyKey();

export function registerTaxonomyRoutes(app: FastifyInstance, deps: TaxonomyRouteDeps): void {
  const { readService, writeService } = deps;

  app.get(
    "/api/v1/taxonomy/carc/:code",
    {
      preHandler: [READ],
      config: {
        auditRead: { none: "static CARC/RARC code taxonomy — reference data, no patient data" },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const code = (request.params as { code: string }).code;
      return reply.send(await readService.taxonomyView(actor, code));
    },
  );

  app.patch(
    "/api/v1/taxonomy/overlays/:carc",
    { preHandler: [EDIT, IDEMPOTENT] },
    async (request, reply) => {
      const actor = writeActorOf(request);
      const carc = (request.params as { carc: string }).carc;
      const body = parse(TaxonomyOverlayPatchSchema, request.body);
      const res = await writeService.editTaxonomyOverlay(
        actor,
        carc,
        {
          rarcCode: body.rarcCode,
          plainLanguageOverride: body.plainLanguageOverride,
          suggestedAction: body.suggestedAction,
          ownerRole: body.ownerRole,
          severity: body.severity,
        },
        ifMatchVersion(request),
      );
      return reply.send(res);
    },
  );
}
