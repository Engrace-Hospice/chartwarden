// apps/backend/src/modules/26-cap/routes/index.ts — M26 route-service surface barrel. The split
// `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders the
// composition root binds (the M25/M27 routes/index.ts precedent).
export type { M26ReadService } from "./read-service";
export type { M26WriteService, WriteOutboxPort, OutboxEmission } from "./write-service";
export { buildDrizzleM26ReadService } from "./read-service-drizzle";
export { buildDrizzleM26WriteService } from "./write-service-drizzle";

import type { M26ReadService } from "./read-service";
import type { M26WriteService } from "./write-service";

/** The two services every M26 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M26RouteServices {
  readonly readService: M26ReadService;
  readonly writeService: M26WriteService;
}
