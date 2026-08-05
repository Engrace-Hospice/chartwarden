// apps/backend/src/modules/25-remittance/routes/index.ts — M25 route-service surface barrel. The split
// `{ readService, writeService }` deps each route plugin takes, plus the Drizzle-backed builders the
// composition root binds (the M27 routes/index.ts precedent). The read + write surfaces share no method
// name, so each plugin binds the two services directly.
export type { M25ReadService } from "./read-service";
export type { M25WriteService, WriteOutboxPort, OutboxEmission } from "./write-service";
export {
  buildDrizzleM25ReadService,
  type TerminologyLookupPort,
} from "./read-service-drizzle";
export { buildDrizzleM25WriteService } from "./write-service-drizzle";

import type { M25IngestService } from "../ingest/service";
import type { M25ReadService } from "./read-service";
import type { M25WriteService } from "./write-service";

/**
 * The services every M25 route plugin composes over (bound to Drizzle, or in-memory in tests).
 * `ingestService` is OPTIONAL (WX-PR-012, route #32 `POST /internal/remittance/advices`) — every
 * pre-existing caller that assembles `{ readService, writeService }` keeps compiling unchanged; the
 * internal receive route mounts only when a real ingest service is supplied.
 */
export interface M25RouteServices {
  readonly readService: M25ReadService;
  readonly writeService: M25WriteService;
  readonly ingestService?: M25IngestService;
}
