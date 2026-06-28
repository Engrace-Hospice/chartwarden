// apps/backend/src/modules/27-cost-report/routes/index.ts — M27 route-service barrel.
//
// The split READ + WRITE route services the §4.1 cost-report route plugins compose over (the M30
// `M30RouteServices` precedent), plus the request-scoped actor resolver and the cursor/idempotency
// helpers. The route plugins + their TypeBox schemas land in the routes agent's slice; this barrel
// publishes the service CONTRACTS + the Drizzle-backed factories so the composition root can bind them.
//
// The read and write surfaces share no method name, so a combined route service is the total spread merge
// of the two (the M30 combined-service precedent).
import type { M27ReadRouteService } from "./read-service";
import type { M27WriteRouteService } from "./write-service";

export {
  type M27ReadActor,
  type M27WriteActor,
  type PreHandler,
  actorOf,
  writeActorOf,
} from "./actor";

export {
  type CursorKeyset,
  type CursorPage,
  encodeCursor,
  decodeCursor,
  paginate,
  pageSizeOf,
  requireIdempotencyKey,
  IdempotencyKeyRequiredError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "./concurrency";

export type { M27ReadRouteService } from "./read-service";
export type { M27WriteRouteService } from "./write-service";
export type {
  RecomputeEnqueuePort,
  WriteOutboxPort,
} from "./write-service";

export {
  type M27ReadServicePorts,
  buildDrizzleM27ReadService,
} from "./read-service-drizzle";
export {
  type M27WriteServicePorts,
  type ProviderEntityPort,
  type WriteTx,
  buildDrizzleM27WriteService,
} from "./write-service-drizzle";

/** The combined READ + WRITE route service the QAPI-style combined plugins bind (no method-name overlap). */
export type M27CombinedRouteService = M27ReadRouteService & M27WriteRouteService;

/** The split route-service deps the §4.1 route plugins mount over. */
export interface M27RouteServices {
  readonly readService: M27ReadRouteService;
  readonly writeService: M27WriteRouteService;
}
