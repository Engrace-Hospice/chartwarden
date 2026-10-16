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
export { buildDrizzleAdrService, type AdrService } from "./adr-service";
export {
  buildDrizzleDenialRouteService,
  type DenialRouteService,
} from "./denial-route-service";
export { buildDrizzleReopeningService, type ReopeningService } from "./reopening-service";
export { buildDrizzleQicService, type QicService } from "./qic-service";

import type { M25IngestService } from "../ingest/service";
import type { AdrService } from "./adr-service";
import type { DenialRouteService } from "./denial-route-service";
import type { QicService } from "./qic-service";
import type { M25ReadService } from "./read-service";
import type { ReopeningService } from "./reopening-service";
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
  /** ADR intake + MAC rules (milestone 2a); the ADR routes mount only when supplied. */
  readonly adrService?: AdrService;
  /** Non-response routing + MAC reopenings (milestone 3); the routes mount only when both are supplied. */
  readonly reopeningService?: ReopeningService;
  readonly denialRouteService?: DenialRouteService;
  /** QIC reconsideration evidence, decision clock and OMHA escalation (milestone 4); the routes mount only when supplied. */
  readonly qicService?: QicService;
}
