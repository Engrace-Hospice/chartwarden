// Planted violation for `check-request-body-contract.ts` — ONE route per direction, and nothing else.
//
// The gate joins the SCANNED route tree (this directory, via CHARTWARDEN_FITNESS_ROOT) against the REAL
// `ROUTE_ENRICHMENTS`, because the enrichment registry is a static import and a fixture cannot substitute
// one. So each plant is a route path chosen for what the real registry says about it:
//
//   · `POST /api/v1/patients` carries a `body` in the real registry (M5 admit). The handler below never
//     reads one → direction A, a payload the caller is told to send and the server discards.
//   · `POST /api/v1/fixture/unpublished` is in no registry at all. The handler below reads `request.body`
//     → direction B, a payload `client:gen` types as `never`.
//
// Neither is registered in `PUBLISHES_UNREAD` / `READS_UNPUBLISHED`, so both must be reported as
// violations. If a future edit removes M5's admit body from the enrichments, direction A stops being a
// violation and this fixture goes GREEN — the self-test asserts a non-zero exit, so that surfaces as a
// failing test, never as a gate that quietly stopped proving anything.
import type { FastifyInstance } from "fastify";

export function registerFixtureRoutes(app: FastifyInstance): void {
  // Direction A — publishes a body, reads only the path/query.
  app.post("/api/v1/patients", async (request) => {
    const { organizationId } = request.params as { organizationId: string };
    return { ok: true, organizationId };
  });

  // Direction B — reads a body no contract publishes.
  app.post("/api/v1/fixture/unpublished", async (request) => {
    const body = request.body as { note: string };
    return { ok: true, note: body.note };
  });
}
