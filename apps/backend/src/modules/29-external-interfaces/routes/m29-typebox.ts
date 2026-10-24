import {
  EXTERNAL_FEED_CREDENTIAL_KINDS,
  EXTERNAL_FEED_KINDS,
  EXTERNAL_FEED_PROTOCOLS,
  EXTERNAL_FEED_STATUSES,
  HL7_INBOUND_PARSE_STATUSES,
  HL7_INBOUND_PROPOSAL_STATUSES,
  HL7_OUTBOUND_STATUSES,
  HL7_PROPOSAL_OWNER_MODULES,
  LAB_ABNORMAL_FLAGS,
  NPPES_SYNC_KINDS,
  ValidationError,
  XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS,
} from "@chartwarden/types";
// apps/backend/src/modules/29-external-interfaces/routes/m29-typebox.ts — M29-T08 (§4.1 / §4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 operator + §4.2 clinician routes. Named
// `m29-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for
// a Drizzle one (the M21-T01 gotcha).
//
// THE STRING-LITERAL UNIONS MIRROR the frozen `@chartwarden/types` unions (`packages/types/src/external-interfaces.ts`,
// M29-T01), which mirror the `@chartwarden/db` pgEnums and the §3 CHECK vocabularies. The DB wins on conflict —
// the §4.3 spec sketch used a different feed-type vocabulary (`hl7v2_inbound_adt` …); the enrichment publishes
// what the validator enforces (the T02 schema's `adt_inbound` | `lab_inbound` | `orm_outbound`), not the prose.
//
// FOUR THINGS NOTHING HERE ACCEPTS: (1) no organization id and no acting membership — both are server-side
// (./actor.ts); (2) no channel SECRET readable back — a rotated credential's plaintext is minted/accepted
// once and never returned; (3) no `status` a caller may set directly — every status change walks the §2.2
// FSM through a named transition route; (4) no decrypted HL7 payload on a list route — the plaintext is a
// dedicated step-up decrypt route.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/** Validate a request BODY at the route boundary (no `Value.Convert` — a JSON body carries real types). */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const Instant = Type.String({ format: "date-time" });
const Lit = <T extends string>(members: readonly T[]) =>
  Type.Union(members.map((m) => Type.Literal(m)));

// ── vocabulary mirrors (`@chartwarden/types` is the source of truth) ──────────────────────────────────────

export const FeedKindSchema = Lit(EXTERNAL_FEED_KINDS);
export const FeedStatusSchema = Lit(EXTERNAL_FEED_STATUSES);
export const FeedProtocolSchema = Lit(EXTERNAL_FEED_PROTOCOLS);
export const CredentialKindSchema = Lit(EXTERNAL_FEED_CREDENTIAL_KINDS);
export const ProposalStatusSchema = Lit(HL7_INBOUND_PROPOSAL_STATUSES);
export const ProposalOwnerModuleSchema = Lit(HL7_PROPOSAL_OWNER_MODULES);
export const ParseStatusSchema = Lit(HL7_INBOUND_PARSE_STATUSES);
export const OutboundStatusSchema = Lit(HL7_OUTBOUND_STATUSES);
export const AbnormalFlagSchema = Lit(LAB_ABNORMAL_FLAGS);
export const NppesSyncKindSchema = Lit(NPPES_SYNC_KINDS);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const FeedIdParams = Type.Object({ feedId: Uuid });
export const ProposalIdParams = Type.Object({ proposalId: Uuid });
export const MessageIdParams = Type.Object({ messageId: Uuid });
export const ObservationIdParams = Type.Object({ observationId: Uuid });
export const NpiParams = Type.Object({ npi: Type.String({ pattern: "^[0-9]{10}$" }) });

const Cursor = Type.Optional(Type.String({ maxLength: 200 }));
const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }));

// ── §4.1.1 feed management ────────────────────────────────────────────────────────────────────────────

export const FeedListQuery = Type.Object({
  kind: Type.Optional(FeedKindSchema),
  status: Type.Optional(FeedStatusSchema),
  limit: Limit,
  cursor: Cursor,
});
export type FeedListQueryInput = Static<typeof FeedListQuery>;

/** F-181 (#248) — an HL7 v2 MSH identity value: no field/component/repetition/escape/subcomponent delimiter and
 *  no control characters (mirrors the migration-0262 CHECK), 1–180 chars. */
const MshIdentity = Type.String({ pattern: "^[^|^~\\\\&\\u0000-\\u001f\\u007f]{1,180}$" });
const FeedRoutingAndIdentity = {
  labDestinationFacilityId: Type.Optional(Type.String({ format: "uuid" })),
  mshSendingApplication: Type.Optional(MshIdentity),
  mshSendingFacility: Type.Optional(MshIdentity),
  mshReceivingApplication: Type.Optional(MshIdentity),
  mshReceivingFacility: Type.Optional(MshIdentity),
  /** F-183 — the operator's explicit statement that this feed's receiver dedupes on MSH-10. Default (unset) =
   *  false: a send whose outcome was lost (`in_flight` lease expired) is HELD for verification with the lab, never
   *  automatically re-sent. Set true ONLY after confirming the lab dedupes on MSH-10. */
  receiverDedupesControlId: Type.Optional(Type.Boolean()),
};

/** F-183 — per-feed `in_flight` lease in seconds (mirrors the migration-0263 CHECK: 60..3600). */
const InFlightLeaseSeconds = Type.Integer({ minimum: 60, maximum: 3600 });

/** GAP-043 (§4.11.5) - tighten the listener-down threshold to 1..5 minutes; never above the 5 minute platform default
 *  (mirrors the migration-1052 CHECK: 60..300). */
const ListenerDownThresholdSeconds = Type.Integer({ minimum: 60, maximum: 300 });

/** GAP-043 - a window in which silence is expected. Shape only; `parseQuietWindows` validates the zone / times on write. */
const QuietWindowBody = Type.Object(
  {
    days: Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7 }),
    start: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    end: Type.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
    tz: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export const CreateFeedBody = Type.Object({
  kind: FeedKindSchema,
  displayName: Type.String({ minLength: 3, maxLength: 120 }),
  host: Type.Optional(Type.String({ maxLength: 255 })),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: FeedProtocolSchema,
  /** Canonical form: lowercase-hex sha256 of the certificate's DER encoding (F-181). */
  channelCertPin: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  /** F-181 — the feed's server certificate in PEM form; the server derives the canonical `channelCertPin`
   *  (sha256 of the DER) from it. Send this OR `channelCertPin` (or both, if they agree). */
  channelCertPem: Type.Optional(Type.String({ minLength: 64, maxLength: 16384 })),
  sendingFacilityAllowlist: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 64 }),
  ),
  baaContractRef: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  baaExpiresOn: Type.Optional(Instant),
  rateLimitMsgPerSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  inFlightLeaseSeconds: Type.Optional(InFlightLeaseSeconds),
  ...FeedRoutingAndIdentity,
});
export type CreateFeedInput = Static<typeof CreateFeedBody>;

export const UpdateFeedBody = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 3, maxLength: 120 })),
  host: Type.Optional(Type.String({ maxLength: 255 })),
  /** Canonical form: lowercase-hex sha256 of the certificate's DER encoding (F-181). */
  channelCertPin: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
  /** F-181 — the feed's server certificate in PEM form; the server derives the canonical `channelCertPin`
   *  (sha256 of the DER) from it. Send this OR `channelCertPin` (or both, if they agree). */
  channelCertPem: Type.Optional(Type.String({ minLength: 64, maxLength: 16384 })),
  sendingFacilityAllowlist: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 64 }),
  ),
  baaContractRef: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  baaExpiresOn: Type.Optional(Instant),
  rateLimitMsgPerSec: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  /** `null` clears the per-feed lease back to the platform default. */
  inFlightLeaseSeconds: Type.Optional(Type.Union([InFlightLeaseSeconds, Type.Null()])),
  /** GAP-043 - `null` clears back to the 5 minute platform default. */
  listenerDownThresholdSeconds: Type.Optional(
    Type.Union([ListenerDownThresholdSeconds, Type.Null()]),
  ),
  /** GAP-043 - windows in which silence is expected (at most 14); `null` clears. */
  expectedQuietWindows: Type.Optional(
    Type.Union([Type.Array(QuietWindowBody, { maxItems: 14 }), Type.Null()]),
  ),
  ...FeedRoutingAndIdentity,
});
export type UpdateFeedInput = Static<typeof UpdateFeedBody>;

export const SuspendFeedBody = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});
export type SuspendFeedInput = Static<typeof SuspendFeedBody>;

export const RevokeFeedBody = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});
export type RevokeFeedInput = Static<typeof RevokeFeedBody>;

export const MintCredentialBody = Type.Object({
  kind: CredentialKindSchema,
  /** The channel secret / client-cert PEM — encrypted server-side; never persisted or returned in the clear. */
  secret: Type.String({ minLength: 1, maxLength: 20000 }),
});
export type MintCredentialInput = Static<typeof MintCredentialBody>;

// ── §4.1.2 inbound proposal review ───────────────────────────────────────────────────────────────────

export const ProposalListQuery = Type.Object({
  status: Type.Optional(ProposalStatusSchema),
  ownerModule: Type.Optional(ProposalOwnerModuleSchema),
  feedId: Type.Optional(Uuid),
  proposedForPatientId: Type.Optional(Uuid),
  limit: Limit,
  cursor: Cursor,
});
export type ProposalListQueryInput = Static<typeof ProposalListQuery>;

export const AcceptProposalBody = Type.Object({
  decisionNote: Type.Optional(Type.String({ maxLength: 2000 })),
  /** The id of the aggregate the owner module minted on apply (M5 patient / M6 admission), when known. */
  acceptedAggregateId: Type.Optional(Uuid),
});
export type AcceptProposalInput = Static<typeof AcceptProposalBody>;

export const RejectProposalBody = Type.Object({
  rationale: Type.String({
    minLength: XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS,
    maxLength: 2000,
  }),
});
export type RejectProposalInput = Static<typeof RejectProposalBody>;

export const DeferProposalBody = Type.Object({
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type DeferProposalInput = Static<typeof DeferProposalBody>;

// ── §4.1.3 message search / replay / retry / decrypt ─────────────────────────────────────────────────

export const InboundMessageListQuery = Type.Object({
  feedId: Type.Optional(Uuid),
  messageType: Type.Optional(Type.String({ maxLength: 20 })),
  messageControlId: Type.Optional(Type.String({ maxLength: 200 })),
  parseStatus: Type.Optional(ParseStatusSchema),
  limit: Limit,
  cursor: Cursor,
});
export type InboundMessageListQueryInput = Static<typeof InboundMessageListQuery>;

export const OutboundMessageListQuery = Type.Object({
  feedId: Type.Optional(Uuid),
  placerOrderNumber: Type.Optional(Uuid),
  status: Type.Optional(OutboundStatusSchema),
  limit: Limit,
  cursor: Cursor,
});
export type OutboundMessageListQueryInput = Static<typeof OutboundMessageListQuery>;

// ── §4.1.4 NPPES administration ──────────────────────────────────────────────────────────────────────

export const NppesSyncTriggerBody = Type.Object({
  kind: Type.Optional(NppesSyncKindSchema),
});
export type NppesSyncTriggerInput = Static<typeof NppesSyncTriggerBody>;

export const NppesSyncRunListQuery = Type.Object({
  limit: Limit,
  cursor: Cursor,
});
export type NppesSyncRunListQueryInput = Static<typeof NppesSyncRunListQuery>;

// ── §4.2 clinician lab surface ───────────────────────────────────────────────────────────────────────

export const ObservationListQuery = Type.Object({
  patientId: Type.Optional(Uuid),
  loincCode: Type.Optional(Type.String({ maxLength: 20 })),
  abnormalFlag: Type.Optional(AbnormalFlagSchema),
  limit: Limit,
  cursor: Cursor,
});
export type ObservationListQueryInput = Static<typeof ObservationListQuery>;

export const AttachPatientBody = Type.Object({
  patientId: Uuid,
  note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type AttachPatientInput = Static<typeof AttachPatientBody>;

export const DiscardObservationBody = Type.Object({
  // §5.2.4 — "requires a reason ≥10 chars". Was minLength 1, which let "x" through; the pure review core
  // and migration 0200's CHECK enforce the same floor, so the boundary now agrees with both (GAP-044).
  reason: Type.String({ minLength: 10, maxLength: 500 }),
});
export type DiscardObservationInput = Static<typeof DiscardObservationBody>;
