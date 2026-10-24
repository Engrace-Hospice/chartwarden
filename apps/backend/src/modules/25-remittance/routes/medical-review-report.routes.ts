// apps/backend/src/modules/25-remittance/routes/medical-review-report.routes.ts - M25 milestone 9a-2: the leadership
// medical-review report. One read, gated on `medical_review.report.read`. AGGREGATES ONLY: the contract has no patient,
// claim or person field, and there is no per-staff dimension (the ADR-0092 decision). The window is whole UTC days, ends no
// later than today and is bounded (`REPORT_MAX_RANGE_DAYS`); the figures are narrowed by the actor's provider-entity scope
// server-side. Drill-through goes only to the existing worklists, which enforce their own permission and read audit.
// Responses are `Cache-Control: no-store`.
import { FormatRegistry, Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { type PreHandler, actorOf } from "./actor";
import { P } from "./guards";
import { parse } from "./m25-typebox";
import type { MedicalReviewReportService } from "./medical-review-report-service";

export interface MedicalReviewReportRouteDeps {
  readonly medicalReviewReportService: MedicalReviewReportService;
  /** Optional per-route cap (a report is a live aggregate): runs after the permission check. */
  readonly rateLimit?: PreHandler;
}

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_FORMAT.test(v));
}

const DAY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const NUM_OR_NULL = Type.Union([Type.Number(), Type.Null()]);

export const MedicalReviewReportQuerySchema = Type.Object({
  from: DAY,
  to: DAY,
  providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
});

const Figure = Type.Object({ value: NUM_OR_NULL, previous: NUM_OR_NULL, change: NUM_OR_NULL });
const Money = Type.String({ pattern: "^-?\\d+\\.\\d{2}$" });
const MoneyFigure = Type.Object({ value: Money, previous: Money, change: Money });
const Reason = Type.Object({
  codeKind: Type.String(),
  code: Type.String(),
  count: Type.Integer(),
  dollars: Money,
});
const Ranked = Type.Object({ rows: Type.Array(Reason), omitted: Type.Integer() });
const Outcomes = Type.Array(Type.Object({ outcome: Type.String(), count: Type.Integer() }));

export const MedicalReviewReportSchema = Type.Object({
  window: Type.Object({
    from: Type.String(),
    to: Type.String(),
    days: Type.Integer(),
    previous: Type.Object({ from: Type.String(), to: Type.String() }),
  }),
  generatedAt: Type.String(),
  adrs: Type.Object({
    received: Figure,
    filed: Figure,
    filedOnOrBeforeDue: Figure,
    filedAfterDue: Figure,
    onOrBeforeDueShareOfFiled: Figure,
    withRecordedProof: Figure,
    medianDaysToFile: Figure,
    deniedNoResponse: Figure,
    dueDatesFromUnverifiedWindows: Figure,
    byMac: Type.Array(
      Type.Object({
        macName: Type.String(),
        received: Type.Integer(),
        filed: Type.Integer(),
        filedOnOrBeforeDue: Type.Integer(),
        deniedNoResponse: Type.Integer(),
      }),
    ),
  }),
  denials: Type.Object({
    opened: Figure,
    openedDollars: MoneyFigure,
    macReasonAsTyped: Type.Object({ code: Type.String(), figure: Figure }),
    byReason: Ranked,
    byMonth: Type.Array(
      Type.Object({ month: Type.String(), count: Type.Integer(), dollars: Money }),
    ),
    closureOutcomes: Outcomes,
  }),
  appeals: Type.Object({
    filed: Figure,
    decided: Figure,
    filedByTier: Type.Array(
      Type.Object({
        tier: Type.String(),
        filed: Type.Integer(),
        filedOnOrBeforeDeadline: Type.Integer(),
        deadlineWindowUnconfirmed: Type.Boolean(),
      }),
    ),
    decidedByOutcome: Outcomes,
    favorableShareOfDecided: NUM_OR_NULL,
    openByTier: Type.Array(Type.Object({ tier: Type.String(), count: Type.Integer() })),
  }),
  reopenings: Type.Object({ opened: Figure, decidedByOutcome: Outcomes }),
  tpe: Type.Object({
    available: Type.Boolean(),
    truncated: Type.Boolean(),
    byState: Type.Array(Type.Object({ state: Type.String(), count: Type.Integer() })),
    active: Type.Array(
      Type.Object({
        macName: Type.String(),
        currentRound: Type.Union([Type.Integer(), Type.Null()]),
        latestMacErrorRatePct: NUM_OR_NULL,
        thresholdPct: NUM_OR_NULL,
        thresholdVerified: Type.Boolean(),
        aboveThreshold: Type.Union([Type.Boolean(), Type.Null()]),
      }),
    ),
  }),
  audits: Type.Object({ open: Type.Integer(), openWithNoRecordedDeadline: Type.Integer() }),
  playbookCoverage: Type.Object({
    denialsSeen: Type.Integer(),
    denialsWithoutPlaybook: Type.Integer(),
    reasonsSeen: Type.Integer(),
    reasonsWithoutPlaybook: Type.Integer(),
    withoutPlaybook: Ranked,
  }),
});

const READ = P("medical_review.report.read");

export function registerMedicalReviewReportRoutes(
  app: FastifyInstance,
  deps: MedicalReviewReportRouteDeps,
): void {
  app.get(
    "/api/v1/medical-review/report",
    {
      preHandler: [READ, ...(deps.rateLimit ? [deps.rateLimit] : [])],
      // The report carries no patient field, but who read leadership figures, for which window and entity, is still
      // accountable: one aggregate read event per request (the window and entity are the query filter).
      config: { auditRead: { resourceKind: "medical_review_report", list: true } },
    },
    async (request, reply) => {
      const q = parse(MedicalReviewReportQuerySchema, request.query);
      void reply.header("Cache-Control", "no-store");
      return reply.send(await deps.medicalReviewReportService.getReport(actorOf(request), q));
    },
  );
}
