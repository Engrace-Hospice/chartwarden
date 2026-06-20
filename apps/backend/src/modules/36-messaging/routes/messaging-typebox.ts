// apps/backend/src/modules/36-messaging/routes/messaging-typebox.ts — M36-T07 complete TypeBox
// route schemas for the messaging / notification / alert-rule API surface (M36 spec §4.1–4.2).
// Named `messaging-typebox` (not `*schema*`) so the table-ownership import heuristic never
// mistakes a TypeBox-schema import for a Drizzle one.
//
// Validation runs through TypeBox's `Value` (not the Fastify ajv pipeline) so a bad request fails
// with M1's `VALIDATION_FAILED` envelope — the same house style M1/M2/M3/M4/M38 routes use — and
// query-string scalars are coerced (`limit=50` → 50, `upTo=true` → true) before the shape check.
// Routing-map / quiet-hours SEMANTICS (unknown category/severity/channel → INVALID_ROUTING_MAP)
// are validated in the service, not here: the structural schema accepts the record shape and the
// service maps an unknown key to the §4.2 422 domain error.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import { CHANNEL_KINDS } from "@wardenx/messaging";

// --- shared scalars ---------------------------------------------------------------------------

/** Free-form opaque id (channels/messages/endpoints/rules). minLength:1, not uuid-format, so the
 *  slice's deterministic ids and production uuids both route. */
const Id = Type.String({ minLength: 1, maxLength: 64 });
const ChannelKindSchema = Type.Union(CHANNEL_KINDS.map((k) => Type.Literal(k)));
const SeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warn"),
  Type.Literal("critical"),
]);
const MemberRoleSchema = Type.Union([
  Type.Literal("owner"),
  Type.Literal("member"),
  Type.Literal("read_only"),
  Type.Literal("portal_caregiver"),
]);
const ResolverSchema = Type.Union([
  Type.Literal("care_team"),
  Type.Literal("on_call"),
  Type.Literal("discipline"),
  Type.Literal("role_set"),
  Type.Literal("tenant_admins"),
  Type.Literal("user_list"),
  Type.Literal("broadcast"),
]);

// --- channels & messages (§4.2) ---------------------------------------------------------------

export const ChannelParamsSchema = Type.Object({ id: Id });
export const MessageParamsSchema = Type.Object({ id: Id });
export const MemberParamsSchema = Type.Object({ id: Id, userId: Id });

export const ListMessagesQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const AttachmentSchema = Type.Object({
  storageKey: Type.String({ minLength: 1 }),
  fileName: Type.String({ minLength: 1, maxLength: 255 }),
  contentType: Type.String({ minLength: 1 }),
  byteSize: Type.Integer({ minimum: 0, maximum: 25_000_000 }),
});

export const SendMessageBodySchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
  bodyKind: Type.Optional(Type.Union([Type.Literal("plain"), Type.Literal("markdown")])),
  parentMessageId: Type.Optional(Id),
  quotedMessageId: Type.Optional(Id),
  attachments: Type.Optional(Type.Array(AttachmentSchema, { maxItems: 10 })),
});

export const EditMessageBodySchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

export const ReadBodySchema = Type.Object({
  upTo: Type.Optional(Type.Boolean()),
});

export const OpenDmBodySchema = Type.Object({
  userId: Id, // the peer user to open/find a DM with
});

export const AddMemberBodySchema = Type.Object({
  userId: Id,
  role: Type.Optional(MemberRoleSchema),
});

export const AnnounceBodySchema = Type.Object({
  body: Type.String({ minLength: 1, maxLength: 8000 }),
});

// --- notification preferences & endpoints (§4.2) ----------------------------------------------

const RoutingMapSchema = Type.Record(
  Type.String(),
  Type.Record(Type.String(), Type.Array(Type.String())),
);
const QuietRangeSchema = Type.Object({
  daysOfWeek: Type.Array(Type.Integer({ minimum: 0, maximum: 6 })),
  start: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
  end: Type.String({ pattern: "^[0-2][0-9]:[0-5][0-9]$" }),
});
const QuietHoursSchema = Type.Object({
  tz: Type.String({ minLength: 1 }),
  ranges: Type.Array(QuietRangeSchema),
  severityOverride: SeveritySchema,
});

export const PreferencesBodySchema = Type.Object({
  routingMap: RoutingMapSchema,
  quietHours: QuietHoursSchema,
  vacationForwardToUserId: Type.Optional(Type.Union([Id, Type.Null()])),
  vacationUntil: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export const RegisterEndpointBodySchema = Type.Object({
  channel: Type.Union([Type.Literal("push"), Type.Literal("sms"), Type.Literal("email")]),
  target: Type.String({ minLength: 1, maxLength: 512 }),
});

export const EndpointParamsSchema = Type.Object({ id: Id });
export const VerifyEndpointBodySchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 64 }),
});

// --- alert rules (§4.2) -----------------------------------------------------------------------

export const AlertRuleParamsSchema = Type.Object({ id: Id });
export const AlertRulePatchSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  severityFloor: Type.Optional(SeveritySchema),
  recipientResolver: Type.Optional(ResolverSchema),
});

export type SendMessageBody = Static<typeof SendMessageBodySchema>;
export type PreferencesBody = Static<typeof PreferencesBodySchema>;
export type AlertRulePatchBody = Static<typeof AlertRulePatchSchema>;

/**
 * Validate `raw` against `schema`, coercing query-string scalars first (`limit=50` → 50,
 * `upTo=true` → true), and return the typed value. Throws M1's `VALIDATION_FAILED` envelope on a
 * miss (the same `parse` contract M38's routes use), so a malformed request renders the standard
 * 422 envelope rather than a Fastify ajv 400.
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
