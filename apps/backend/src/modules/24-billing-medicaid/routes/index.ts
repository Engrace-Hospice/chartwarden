// apps/backend/src/modules/24-billing-medicaid/routes/index.ts — M24 route-service surface barrel. The split
// `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders the
// composition root binds (the M25/M26 routes/index.ts precedent).
export type { M24ReadService } from "./read-service";
export type { M24WriteService, WriteOutboxPort, OutboxEmission } from "./write-service";
export { buildDrizzleM24ReadService } from "./read-service-drizzle";
export {
  buildDrizzleM24WriteService,
  buildM24MedicaidCoverageResolver,
} from "./write-service-drizzle";

import type { M24ReadService } from "./read-service";
import type { M24WriteService } from "./write-service";

/** The two services every M24 route plugin composes over (bound to Drizzle, or in-memory in tests). */
export interface M24RouteServices {
  readonly readService: M24ReadService;
  readonly writeService: M24WriteService;
}
