// apps/backend/src/modules/26-cap/routes/m26-typebox.ts — the M26 route request/response TypeBox schemas.
//
// These serve TWO consumers, and until now only the first one used them:
//   1. the OpenAPI enrichment registry (scripts/openapi/enrichments.ts), which publishes them as the
//      §4.2 request contract;
//   2. the route handlers, at RUNTIME, via `parse()`.
//
// (2) did not exist. Every M26 mutation did `const body = request.body as { … }` — a TypeScript cast,
// erased at runtime — so the module PUBLISHED a contract it did not enforce. The spec promised
// `graceWindowDays` was an integer 0–90, `resolutionNotes` at least 20 characters, `attestation` at
// least 20, `aggregateCapAmountCents` a Cents integer, `macRegion` one of a closed set; the server
// accepted `graceWindowDays: -99999` on a Medicare cap grace window, an `attestation` of `true` or
// `null` recorded as a legal artifact, and an unbounded base64 blob up to the 10 MB body limit.
//
// Note the shape of the gap: `arch:openapi-coverage` counted these routes as ENRICHED throughout,
// because it measures whether a contract is published, not whether one is applied. Nothing joined the
// two — the same "two registries no gate joins" pattern as the AI capability catalog.
//
// Mass assignment was never reachable (write-service-drizzle.ts allowlists columns explicitly), so the
// impact was business-logic corruption and unhandled `pg` errors rather than takeover.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { contracts } from "@wardenx/cap-management";
import { ValidationError } from "@wardenx/types";

/**
 * Validate `raw` against `schema` (Convert-then-Check), throwing M1's VALIDATION_FAILED envelope on
 * the first error (the M23/M27/M30/M33 `parse(...)` precedent). Convert first so a query/param string
 * coerces to its declared type; Check then refuses anything the schema does not admit.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}

/**
 * Params validation as a PREHANDLER, placed FIRST in the chain.
 *
 * Every M26 mutation addresses a uuid (`:periodId`, `:eventId`, `:lineId`, `:importId`), read
 * previously with an unchecked `pParam()`.
 *
 * Parsing params inside the handler is too late: the §4.7 ABAC guards resolve the addressed row to
 * load their owner facts, so a malformed `:periodId` reached Drizzle ahead of any check and came back
 * as Postgres `22P02 invalid input syntax for type uuid` — surfacing as a **500** for what is simply a
 * malformed request. Running it first turns that into a 422 naming the param.
 *
 * This does not weaken the repo's 403/404-before-422 rule, which exists so validation detail is not
 * leaked to a caller who is not entitled to know the resource exists. That rule is about the BODY: a
 * syntactically invalid uuid is refused identically for every caller and discloses nothing about what
 * does or does not exist.
 */
export const validateParams =
  <T extends TSchema>(schema: T) =>
  async (request: { params: unknown }): Promise<void> => {
    parse(schema, request.params);
  };

/**
 * A uuid by PATTERN, not by `format: "uuid"`.
 *
 * `format` in TypeBox resolves through a global `FormatRegistry`, and the only thing that populates
 * `uuid` in this repo is `packages/supplies/src/kinds/formats.ts` — an M21 module. So every
 * `Type.String({ format: "uuid" })` in the codebase (including `@wardenx/billing`'s shared `Uuid` and
 * the M26 contracts) validates ONLY because M21 happens to have been imported first; TypeBox treats an
 * unregistered format as a FAILURE ("Unknown format 'uuid'"), so in any context that does not load
 * M21 these checks reject valid uuids. A params guard must not depend on which sibling module was
 * imported, so it carries the pattern itself. (The wider `format`-registry coupling is a real platform
 * hazard and is left flagged rather than silently changed across every module here.)
 */
const UuidString = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});

export const UuidParam = Type.Object({ id: UuidString });
export const PeriodIdParams = Type.Object({ periodId: UuidString });
export const EventIdParams = Type.Object({ eventId: UuidString });
export const LineIdParams = Type.Object({ importId: UuidString, lineId: UuidString });
/** `^FY\d{4}$` — the same pattern `contracts.ts` applies to a cap-year body field (it keeps it private). */
export const CapYearParams = Type.Object({ capYear: Type.String({ pattern: "^FY\\d{4}$" }) });

// ── request bodies (§4.2) ────────────────────────────────────────────────────────────────────────
/**
 * CLOSED objects. The domain contracts do not set `additionalProperties`, so an unknown field was
 * accepted and forwarded to the write service. Mass assignment was never reachable
 * (write-service-drizzle.ts allowlists columns), but a silently-ignored field is how a caller comes to
 * believe it set something it did not — and it is exactly how a caller would smuggle back the
 * `stepUpAssertionId` this module deliberately drops. `InvokeBreakGlassBody` in M3 uses the same
 * `{ additionalProperties: false }` for the same reason: it is what makes REMOVING a field effective
 * rather than merely cosmetic.
 */
const strict = <T extends Parameters<typeof Type.Object>[0]>(props: T) =>
  Type.Object(props, { additionalProperties: false });

export const OpenCapPeriodRequest = strict(contracts.OpenCapPeriodRequest.properties);
export const CloseCapPeriodRequest = strict(contracts.CloseCapPeriodRequest.properties);
export const AcknowledgeEventRequest = strict(contracts.AcknowledgeEventRequest.properties);
export const PsrImportRequest = strict(contracts.PsrImportRequest.properties);
export const ResolveVarianceRequest = strict(contracts.ResolveVarianceRequest.properties);
export const PublishConstantRequest = strict(contracts.PublishConstantRequest.properties);
export const AmendConstantRequest = strict(contracts.AmendConstantRequest.properties);

/**
 * `stepUpAssertionId` is OMITTED from the three contracts that declare it (lock-methodology, finalize and, as of
 * GAP-079, reopen — whose body used to demand a caller-supplied uuid nothing read, so no UI could ever call it).
 *
 * It is a step-up assertion supplied BY THE CALLER, and neither write-service input consumes it
 * (`LockMethodologyInput` is `{ methodology, reason }`; `FinalizeInput` is `{ attestation }`). Step-up
 * on these two routes is enforced server-side by the `STEP_UP(...)` preHandler over M3's
 * `step_up_recent` predicate, which reads the session — the only place that fact can be trusted.
 * Requiring it in the body would demand a field nothing reads AND invite the caller to assert its own
 * re-authentication, which is the defect class the audit-C2 fix removed from break-glass
 * (`cosignRequired` in the request body). Omitting it here keeps the PUBLISHED contract and the
 * ENFORCED contract identical, which is the whole point of this file having one definition.
 */
export const LockMethodologyRequest = strict(
  Type.Omit(contracts.LockMethodologyRequest, ["stepUpAssertionId"]).properties,
);
export const ReopenCapPeriodRequest = strict(
  Type.Omit(contracts.ReopenCapPeriodRequest, ["stepUpAssertionId"]).properties,
);
export const FinalizeSettlementRequest = strict(
  Type.Omit(contracts.FinalizeSettlementRequest, ["stepUpAssertionId"]).properties,
);

// ── response shapes (assembled from the §4.2 DTOs) ──
export const CapPeriodDto = contracts.CapPeriodDto;
export const CapPeriodListResponse = Type.Array(contracts.CapPeriodDto);
export const ProjectionSnapshotDto = contracts.ProjectionSnapshotDto;
export const ProjectionListResponse = Type.Array(contracts.ProjectionSnapshotDto);
export const InpatientProjectionDto = contracts.InpatientProjectionDto;
export const SettlementDto = contracts.SettlementDto;

import type { CursorPage as ServiceCursorPage } from "./concurrency";
// ── §4.2 RESPONSE DTOs (F0 enrichment) ─────────────────────────────────────────────────────────────
// The handlers do not return the `contracts.*` DTOs above; they return the READ/WRITE-service VIEW
// interfaces (`PeriodView`, `ProjectionView`, `SettlementView`, …) verbatim. Those views published NO
// response contract, so the generated client typed every read body as `never`. The DTOs below mirror the
// service views 1:1 and are pinned to them by the compile-time `Conforms` aliases at the end of the file,
// so a view field added or renamed breaks `bun run build` rather than drifting silently from the client.
// Money crosses as integer cents; scope/status/band/methodology are open `string` in the view, so they are
// published as `Type.String()` (the view does not narrow them to a closed set here).
import type {
  AccrualLineView as ServiceAccrualLineView,
  DashboardView as ServiceDashboardView,
  InpatientAccrualView as ServiceInpatientAccrualView,
  PatientAccrualView as ServicePatientAccrualView,
  PeriodView as ServicePeriodView,
  PlatformConstantView as ServicePlatformConstantView,
  ProjectionView as ServiceProjectionView,
  PsrImportView as ServicePsrImportView,
  PsrVarianceView as ServicePsrVarianceView,
  SettlementView as ServiceSettlementView,
  ThresholdEventView as ServiceThresholdEventView,
} from "./read-service";

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const NullStr = () => Nullable(Type.String());
const NullInt = () => Nullable(Type.Integer());
const NullNum = () => Nullable(Type.Number());

export const CapPeriodViewDto = Type.Object({
  id: Type.String(),
  capYear: Type.String(),
  ccn: Type.String(),
  startDate: Type.String(),
  endDate: Type.String(),
  status: Type.String(),
  methodology: NullStr(),
  methodologyLockedAt: NullStr(),
  graceWindowDays: Type.Integer(),
  aggregateCapAmountCents: Type.Integer(),
  inpatientCapPct: Type.Number(),
  openedAt: Type.String(),
});
export const CapPeriodViewListResponse = Type.Array(CapPeriodViewDto);

export const CapProjectionViewDto = Type.Object({
  id: Type.String(),
  capPeriodId: Type.String(),
  scope: Type.String(),
  patientId: NullStr(),
  methodology: Type.String(),
  paidYtdCents: Type.Integer(),
  outstandingBilledCents: Type.Integer(),
  projectedYearEndCents: Type.Integer(),
  capAmountCents: NullInt(),
  inpatientDaysYtd: NullInt(),
  inpatientPctYtd: NullNum(),
  pctOfCap: Type.Number(),
  alertBand: Type.String(),
  beneficiaryCount: NullInt(),
  computedAt: Type.String(),
  computedBy: Type.String(),
});
export const CapProjectionViewListResponse = Type.Array(CapProjectionViewDto);

export const CapPatientAccrualViewDto = Type.Object({
  patientId: Type.String(),
  capPeriodId: Type.String(),
  paidCents: Type.Integer(),
  outstandingBilledCents: Type.Integer(),
  firstElectionInPeriod: Type.String(),
  lastPaidThrough: NullStr(),
});

export const CapAccrualLineViewDto = Type.Object({
  id: Type.String(),
  sourceKind: Type.String(),
  sourceId: Type.String(),
  amountCents: Type.Integer(),
  serviceFrom: Type.String(),
  serviceTo: Type.String(),
  postedAt: Type.String(),
});
export const CapAccrualLinePageResponse = Type.Object({
  items: Type.Array(CapAccrualLineViewDto),
  nextCursor: NullStr(),
});

export const CapInpatientAccrualViewDto = Type.Object({
  capPeriodId: Type.String(),
  gipDays: Type.Integer(),
  ircDays: Type.Integer(),
  totalPatientDays: Type.Integer(),
  inpatientPct: Type.Number(),
});

export const CapThresholdEventViewDto = Type.Object({
  id: Type.String(),
  capPeriodId: Type.String(),
  scope: Type.String(),
  patientId: NullStr(),
  priorBand: Type.String(),
  currentBand: Type.String(),
  raisedAt: Type.String(),
  acknowledgedAt: NullStr(),
  resolvedAt: NullStr(),
});
export const CapThresholdEventViewListResponse = Type.Array(CapThresholdEventViewDto);

export const CapPsrImportViewDto = Type.Object({
  id: Type.String(),
  capPeriodId: Type.String(),
  macRegion: Type.String(),
  psrPeriodFrom: Type.String(),
  psrPeriodTo: Type.String(),
  parseStatus: Type.String(),
  parseError: NullStr(),
  beneficiaryCountPsr: NullInt(),
  paidTotalCentsPsr: NullInt(),
  rowsQuarantined: Type.Optional(NullInt()),
  quarantineDetail: Type.Optional(
    Nullable(
      Type.Object({
        lines: Type.Array(Type.Object({ line: Type.Integer(), code: Type.String() })),
        truncated: Type.Boolean(),
        flaggedBeneficiaries: Type.Integer(),
        unattributableRows: Type.Integer(),
      }),
    ),
  ),
  importedAt: Type.String(),
});

export const CapPsrVarianceViewDto = Type.Object({
  id: Type.String(),
  scope: Type.String(),
  patientId: NullStr(),
  m26AccrualCents: NullInt(),
  psrAmountCents: NullInt(),
  varianceCents: NullInt(),
  varianceReason: NullStr(),
  status: Type.String(),
});
export const CapPsrVarianceViewListResponse = Type.Array(CapPsrVarianceViewDto);

/** POST psr-imports returns `{ ...{ importId }, status: "queued" }` (202) — an ad-hoc envelope, not a view. */
export const CapPsrImportQueuedResponse = Type.Object({
  importId: Type.String(),
  status: Type.String(),
});

export const CapSettlementViewDto = Type.Object({
  id: Type.String(),
  capPeriodId: Type.String(),
  status: Type.String(),
  paidTotalCents: Type.Integer(),
  beneficiaryCount: Type.Integer(),
  aggregateCapAmountCents: Type.Integer(),
  aggregateOverageCents: Type.Integer(),
  inpatientTotalDays: Type.Integer(),
  inpatientOverageDays: Type.Integer(),
  inpatientOverageCents: Type.Integer(),
  proposedAt: Type.String(),
  finalizedAt: NullStr(),
});

export const CapPlatformConstantViewDto = Type.Object({
  capYear: Type.String(),
  aggregateCapAmountCents: NullInt(),
  inpatientCapPct: Type.Number(),
  sourceUrl: NullStr(),
  firstTenantUseAt: NullStr(),
  recordedAt: Type.String(),
});
export const CapPlatformConstantViewListResponse = Type.Array(CapPlatformConstantViewDto);

/** POST platform constants returns `{ capYear }` (201). */
export const CapPublishConstantAckResponse = Type.Object({ capYear: Type.String() });

export const CapDashboardViewDto = Type.Object({
  period: Nullable(CapPeriodViewDto),
  agency: Nullable(CapProjectionViewDto),
  inpatient: Nullable(CapProjectionViewDto),
  topPatients: Type.Array(CapProjectionViewDto),
  recentEvents: Type.Array(CapThresholdEventViewDto),
  openVarianceCount: Type.Integer(),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _Period = Conforms<Static<typeof CapPeriodViewDto>, ServicePeriodView>;
type _Projection = Conforms<Static<typeof CapProjectionViewDto>, ServiceProjectionView>;
type _PatientAccrual = Conforms<Static<typeof CapPatientAccrualViewDto>, ServicePatientAccrualView>;
type _AccrualLine = Conforms<Static<typeof CapAccrualLineViewDto>, ServiceAccrualLineView>;
type _AccrualPage = Conforms<
  Static<typeof CapAccrualLinePageResponse>,
  ServiceCursorPage<ServiceAccrualLineView>
>;
type _InpatientAccrual = Conforms<
  Static<typeof CapInpatientAccrualViewDto>,
  ServiceInpatientAccrualView
>;
type _ThresholdEvent = Conforms<Static<typeof CapThresholdEventViewDto>, ServiceThresholdEventView>;
type _PsrImport = Conforms<Static<typeof CapPsrImportViewDto>, ServicePsrImportView>;
type _PsrVariance = Conforms<Static<typeof CapPsrVarianceViewDto>, ServicePsrVarianceView>;
type _Settlement = Conforms<Static<typeof CapSettlementViewDto>, ServiceSettlementView>;
type _PlatformConstant = Conforms<
  Static<typeof CapPlatformConstantViewDto>,
  ServicePlatformConstantView
>;
type _Dashboard = Conforms<Static<typeof CapDashboardViewDto>, ServiceDashboardView>;
