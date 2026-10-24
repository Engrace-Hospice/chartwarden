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
  buildDrizzleAdrReadinessService,
  type AdrReadinessService,
} from "./adr-readiness-service";
export {
  buildDrizzleDenialRouteService,
  type DenialRouteService,
} from "./denial-route-service";
export { buildDrizzlePlaybookService, type PlaybookService } from "./playbook-service";
export {
  buildMedicalReviewReportService,
  type MedicalReviewReportService,
} from "./medical-review-report-service";
export { buildDrizzleReopeningService, type ReopeningService } from "./reopening-service";
export { buildDrizzleTpeService, type TpeService } from "./tpe-service";
export { buildDrizzleQicService, type QicService } from "./qic-service";
export {
  buildDrizzleAuditRequestService,
  type AuditRequestService,
} from "./audit-request-service";
export { buildDrizzleLaterTierService, type LaterTierService } from "./later-tier-service";
export { buildDrizzleCaseViewService, type CaseViewService } from "./case-view-service";
export {
  buildDrizzleSubmissionService,
  type SubmissionService,
} from "./submission-service";

import type { M25IngestService } from "../ingest/service";
import type { AdrReadinessService } from "./adr-readiness-service";
import type { AdrService } from "./adr-service";
import type { AuditRequestService } from "./audit-request-service";
import type { CaseViewService } from "./case-view-service";
import type { DenialRouteService } from "./denial-route-service";
import type { LaterTierService } from "./later-tier-service";
import type { MedicalReviewReportService } from "./medical-review-report-service";
import type { PlaybookService } from "./playbook-service";
import type { QicService } from "./qic-service";
import type { M25ReadService } from "./read-service";
import type { ReopeningService } from "./reopening-service";
import type { SubmissionService } from "./submission-service";
import type { TpeService } from "./tpe-service";
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
  /** TPE program tracker (milestone 5); the routes mount only when supplied. */
  readonly tpeService?: TpeService;
  /** QIC reconsideration evidence, decision clock and OMHA escalation (milestone 4); the routes mount only when supplied. */
  readonly qicService?: QicService;
  /** Submission attempts and receipts (milestone 6a); the routes mount only when supplied. */
  readonly submissionService?: SubmissionService;
  /** Audit request intake (milestone 7a-1); the routes mount only when both audit and later-tier services are supplied. */
  readonly auditRequestService?: AuditRequestService;
  /** Later-tier record-keeping + recorded deadlines (milestone 7a-1); the routes mount only when supplied. */
  readonly laterTierService?: LaterTierService;
  /** The one claim-keyed case view (milestone 7a-1); the route mounts only when supplied. */
  readonly caseViewService?: CaseViewService;
  /** Advisory ADR documentation readiness (milestone 8a-1); the routes mount only when supplied. */
  readonly adrReadinessService?: AdrReadinessService;
  /** The denial-reason playbook library and the per-denial panel (milestone 9a-1); the routes mount only when supplied. */
  readonly playbookService?: PlaybookService;
  /** The leadership medical-review report (milestone 9a-2); the route mounts only when supplied. */
  readonly medicalReviewReportService?: MedicalReviewReportService;
  /** Optional per-route rate limit for the report (built in the composition root from the shared store). */
  readonly medicalReviewReportRateLimit?: (request: never, reply: never) => Promise<void>;
}
