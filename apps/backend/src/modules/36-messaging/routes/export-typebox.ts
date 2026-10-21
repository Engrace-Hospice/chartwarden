// apps/backend/src/modules/36-messaging/routes/export-typebox.ts - WP 5.7 (ADR-0089, PROPOSED) schemas for the export routes. Wire keys are
// camelCase (the contract in packages/types/src/messaging-export.ts). Responses carry ids, closed codes, counts and instants, plus the
// requester/approver-only free text (justification, decision note) on the DETAIL shape only. Never a message body, an artefact key or a wrapped
// key; Fastify strips anything not listed.
import {
  MESSAGING_EXPORT_DECISION_NOTE_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MIN,
  MESSAGING_EXPORT_SCOPE_KINDS,
  MESSAGING_EXPORT_STATUSES,
} from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { UUID_PATTERN } from "./messaging-typebox";

const Uuid = Type.String({ pattern: UUID_PATTERN });
const NullableString = Type.Union([Type.String(), Type.Null()]);
const NullableUuid = Type.Union([Uuid, Type.Null()]);
const NullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const DateOnly = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const ScopeKind = Type.Union(MESSAGING_EXPORT_SCOPE_KINDS.map((k) => Type.Literal(k)));
const Status = Type.Union(MESSAGING_EXPORT_STATUSES.map((s) => Type.Literal(s)));

export const ExportIdParamsSchema = Type.Object({ id: Uuid }, { additionalProperties: false });

export const CreateExportBodySchema = Type.Object(
  {
    scopeKind: ScopeKind,
    channelId: Type.Optional(Uuid),
    patientId: Type.Optional(Uuid),
    dateFrom: Type.Optional(DateOnly),
    dateTo: Type.Optional(DateOnly),
    // Trimmed length is enforced again by the service and the table CHECK; the schema bounds the raw input.
    justification: Type.String({
      minLength: MESSAGING_EXPORT_JUSTIFICATION_MIN,
      maxLength: MESSAGING_EXPORT_JUSTIFICATION_MAX + 200,
    }),
  },
  { additionalProperties: false },
);

export const DecideExportBodySchema = Type.Object(
  { note: Type.Optional(Type.String({ maxLength: MESSAGING_EXPORT_DECISION_NOTE_MAX + 200 })) },
  { additionalProperties: false },
);

const SummaryShape = {
  id: Uuid,
  status: Status,
  requestedBy: Uuid,
  requestedByName: NullableString,
  requestedAt: Type.String(),
  scope: Type.Object({
    scopeKind: ScopeKind,
    channelId: NullableUuid,
    patientId: NullableUuid,
    dateFrom: NullableString,
    dateTo: NullableString,
  }),
  decidedBy: NullableUuid,
  decidedAt: NullableString,
  readyAt: NullableString,
  expiresAt: NullableString,
  messageCount: NullableCount,
  heldExcluded: NullableCount,
  part2Excluded: NullableCount,
  downloadCount: Type.Integer({ minimum: 0 }),
  failureCode: NullableString,
} as const;

export const ExportSummaryResponseSchema = Type.Object(SummaryShape);
export const ExportListResponseSchema = Type.Object({
  jobs: Type.Array(ExportSummaryResponseSchema),
});

export const ExportDetailResponseSchema = Type.Object({
  ...SummaryShape,
  justification: Type.String(),
  decisionNote: NullableString,
  buildingAt: NullableString,
  artefactBytes: NullableCount,
  artefactSha256: NullableString,
  downloadable: Type.Boolean(),
});
