// apps/backend/src/modules/20-field-safety/routes/sos.routes.ts — M20 (§4.1) rows 5-11: the SOS spine.
//
// ── ROW 5 IS THE ONE ROUTE ON THE PLATFORM THAT TAKES NO IDEMPOTENCY KEY ────────────────────────────
//
// §4.1's Idempotent column says `no` for `POST /safety/sos`, and §2.6 / M20-F10 say why: every press is a
// separate call for help, and collapsing two onto one alert IS the suppression S13 forbids. The D15
// offline replay is the ONE dedupe, it is a BODY field (`localIdempotencyKey` + `offlineSync`) rather
// than an HTTP header, and the write service applies it only when the press is a REPLAY — see
// ./concurrency.ts's header.
//
// ── ROW 6 TAKES NO `If-Match` EITHER, AND FOR A DIFFERENT REASON ───────────────────────────────────
//
// The cancel is a five-second, one-tap act on a phone the clinician may be palming under a table (§7.4).
// Requiring the client to have read and echoed a version number is a round-trip that does not fit inside
// D5's window. The guard the cancel actually needs — are you the raiser, is the window still open, did the
// biometric pass — is stronger than a version compare and runs inside `cancelSos`.
//
// ── ROW 10 IS THE ONLY COORDINATE-BEARING ROUTE IN THE MODULE ──────────────────────────────────────
//
// Its own permission (`safety.sos.read_coords`, separate from `safety.sos.read` by §4.6's own emphasis),
// its own §4.7 disjunction (`active_sos_responder` during ∨ `safety_supervisor_or_above` after), its own
// `warn`-severity read-audit declaration, and — once the alert closes — a ≥40-character reason the read
// service enforces and the clinician later sees on her self-service surface (§6, §8.7). Every other read
// in this file answers "when did we last hear from her", which needs a timestamp, not a latitude.
import type { FastifyInstance } from "fastify";
import { actorOf, writeActorOf } from "./actor";
import { ifMatchVersion, rejectOffsetPagination, requireIdempotencyKey } from "./concurrency";
import {
  ABAC_FIELD_ELIGIBLE,
  ABAC_SELF,
  ABAC_SELF_OR_SUPERVISOR,
  ABAC_SOS_COORDS,
  ABAC_SOS_RESPONDER,
  ABAC_SUPERVISOR_OR_SELF,
  P,
} from "./guards";
import {
  AcknowledgeSosBody,
  CancelSosBody,
  LocationStreamQuery,
  RaiseSosBody,
  ResolveSosBody,
  SosIdParams,
  parse,
  parseQuery,
} from "./m20-typebox";
import type { M20ReadService } from "./read-service";
import type { M20WriteService } from "./write-service";

export interface SosRouteDeps {
  readonly readService: M20ReadService;
  readonly writeService: M20WriteService;
}

const IDEMPOTENT = requireIdempotencyKey();
const NO_OFFSET = rejectOffsetPagination();

/** §4.1 rows 9, 11 — the alert record names a clinician, a visit and a resolution narrative. */
const SOS_PHI = {
  resourceKind: "safety_sos_alert",
  fields: ["last_known_visit_id", "resolution_narrative_cipher", "lifecycle_state"],
} as const;

/**
 * §4.1 row 10's "yes (warn)".
 *
 * The `fields` list names the coordinate columns explicitly because §8.7's promise to the clinician is
 * that she can see WHAT was read, not merely that something was. The `resourceKind` is deliberately its
 * own (`safety_sos_location_stream`, not `safety_sos_alert`) so a §164.528 accounting query can separate
 * "a supervisor opened the alert" from "a supervisor watched her move".
 */
const SOS_COORDS_PHI = {
  resourceKind: "safety_sos_location_stream",
  resourceIdParam: "sosAlertId",
  fields: ["coordinates_cipher", "accuracy_m", "sampled_at"],
  list: true,
} as const;

export function registerSosRoutes(app: FastifyInstance, deps: SosRouteDeps): void {
  const { readService, writeService } = deps;

  // 5 — the press. NO idempotency key (see the header). `field_eligible_for_sos` gates who may PRESS;
  //     nothing downstream of the row gates the FAN-OUT (M20-F05 / S13).
  app.post(
    "/api/v1/safety/sos",
    { preHandler: [P("safety.sos.raise"), ABAC_FIELD_ELIGIBLE("safety.sos.raise")] },
    async (request, reply) => {
      const body = parse(RaiseSosBody, request.body);
      const result = await writeService.raiseSos(writeActorOf(request), body);
      return reply.code(201).send(result);
    },
  );

  // 6 — the D5 cancel. A REJECTED cancel is a 200 with `cancel_attempted_but_rejected`, never a 4xx:
  //     returning an error would tell a hostile actor holding the device that their tap did something.
  app.post(
    "/api/v1/safety/sos/:sosAlertId/cancel",
    {
      preHandler: [
        P("safety.sos.cancel"),
        ABAC_SELF("safety.sos.cancel", (r) => ({
          sosAlertId: (r.params as Record<string, string>).sosAlertId,
        })),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      const body = parse(CancelSosBody, request.body);
      return writeService.cancelSos(writeActorOf(request), sosAlertId, body);
    },
  );

  // 7 — a responder answers. The §2.2.6 acknowledgment row is written in the SAME transaction, so an
  //     `acknowledged` alert nobody signed is unrepresentable.
  app.post(
    "/api/v1/safety/sos/:sosAlertId/acknowledge",
    {
      preHandler: [
        P("safety.sos.acknowledge"),
        ABAC_SOS_RESPONDER("safety.sos.acknowledge"),
        IDEMPOTENT,
      ],
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      const body = parse(AcknowledgeSosBody, request.body);
      return writeService.acknowledgeSos(writeActorOf(request), sosAlertId, {
        ...body,
        expectedVersion: ifMatchVersion(request),
      });
    },
  );

  // 8 — resolve, or convert into an incident. `openIncidentFromOutcome` dispatches to a DIFFERENT §2.2.2
  //     command (`openIncident`, not `resolve`) because they are different terminal states.
  app.post(
    "/api/v1/safety/sos/:sosAlertId/resolve",
    {
      preHandler: [P("safety.sos.resolve"), ABAC_SOS_RESPONDER("safety.sos.resolve"), IDEMPOTENT],
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      const body = parse(ResolveSosBody, request.body);
      return writeService.resolveSos(writeActorOf(request), sosAlertId, {
        ...body,
        expectedVersion: ifMatchVersion(request),
      });
    },
  );

  // 11 — the active-SOS board. Registered BEFORE the `:sosAlertId` detail so the static segment wins the
  //      radix match on every Fastify version, rather than relying on the router's static-over-param
  //      preference to keep `/sos/active` from being read as an alert id.
  app.get(
    "/api/v1/safety/sos/active",
    {
      preHandler: [P("safety.sos.read"), ABAC_SUPERVISOR_OR_SELF("safety.sos.read"), NO_OFFSET],
      config: { auditRead: { ...SOS_PHI, list: true } },
    },
    async (request) => readService.listActiveSos(actorOf(request)),
  );

  // 9 — the alert detail, with its §2.2.2 ledger and its §2.2.6 acknowledgments.
  app.get(
    "/api/v1/safety/sos/:sosAlertId",
    {
      preHandler: [
        P("safety.sos.read"),
        ABAC_SELF_OR_SUPERVISOR("safety.sos.read", "sosAlertId", "sosAlertId"),
      ],
      config: { auditRead: { ...SOS_PHI, resourceIdParam: "sosAlertId" } },
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      return readService.getSosAlert(actorOf(request), sosAlertId);
    },
  );

  // 10 — the D6 coordinate stream (see the header).
  app.get(
    "/api/v1/safety/sos/:sosAlertId/location-stream",
    {
      preHandler: [
        P("safety.sos.read_coords"),
        ABAC_SOS_COORDS("safety.sos.read_coords"),
        NO_OFFSET,
      ],
      config: { auditRead: SOS_COORDS_PHI },
    },
    async (request) => {
      const { sosAlertId } = parse(SosIdParams, request.params);
      return readService.getLocationStream(
        actorOf(request),
        sosAlertId,
        parseQuery(LocationStreamQuery, request.query),
      );
    },
  );
}
