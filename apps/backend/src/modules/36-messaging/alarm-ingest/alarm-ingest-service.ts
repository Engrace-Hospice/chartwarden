// M36 WP 6.10 (ADR-0101, PROPOSED) - alarm ingest, WATCH ONLY. The service holds every rule; the store holds only SQL.
//
// INBOUND (a machine, no session): cheap secret-free refusals first (budget per client address, key id / timestamp / signature SHAPE, replay
// window, tenant flag), then the credential is loaded under its OWN tenant's RLS, its secret is opened from the tenant-DEK envelope and the HMAC is
// compared in constant time. EVERY failure up to and including a wrong signature is the SAME 401 body, so an unknown credential, a disabled one,
// a stale timestamp and a forged signature are indistinguishable. Only after that: the per-source budget, the strict body, the idempotent event
// row, the severity cap, and an ordinary M36 ALERT through the existing emitter. Nothing here touches the response-request aggregate or the
// routing machinery (pinned by m36-alarm-ingest-static.test.ts, which also bans those words from this directory); the alert is in-app only by default and carries a FIXED generic message: no sender text exists to carry.
import type { AlertEmitter } from "@chartwarden/messaging";
import {
  ALARM_INGEST_ALERT_MESSAGE,
  ALARM_INGEST_ALERT_TYPES,
  ALARM_INGEST_FLAG_KEY,
  ALARM_INGEST_UNAVAILABLE_CODE,
  ALARM_INGEST_MAX_BODY_BYTES,
  ALARM_INGEST_OCCURRED_AT_SKEW_SECONDS,
  ALARM_KIND_PATTERN,
  ALARM_MAX_MAPPINGS_PER_SOURCE,
  ALARM_MAX_SOURCES_PER_TENANT,
  ALARM_SEVERITY_CEILINGS,
  ALARM_SOURCE_NAME_MAX,
  type AlarmIngestAcceptedDto,
  type AlarmMappingInput,
  type AlarmSourceCredentialDto,
  type AlarmSourceDto,
  ChartWardenError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import type { MessageBodyCipher } from "../messaging-write-core";
import {
  alarmKeyId,
  alarmPayloadDigest,
  alarmSignatureMatches,
  effectiveAlarmSeverity,
  inAlarmReplayWindow,
  isAlarmSignatureShape,
  newAlarmSecret,
  parseAlarmKeyId,
} from "./alarm-ingest-core";
import { type AlarmEventBody, AlarmEventBodySchema } from "./alarm-ingest-schema";
import type { AlarmIngestStore, SourceView, StaffActor } from "./alarm-ingest-store";

export interface AttemptLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export interface AlarmIngestServiceDeps {
  readonly store: AlarmIngestStore;
  /** The M1 flag reader for `messaging.alarm_ingest` (absent or off => the inbound route and create / rotate are refused). */
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  /** Lazy: the AlertEmitter seam is bound after the routes are mounted. */
  readonly alerts: () => Pick<AlertEmitter, "emit">;
  readonly cipher: Pick<MessageBodyCipher, "sealRing" | "open">;
  /** Per client address, before any database work. */
  readonly ipLimiter?: AttemptLimiter | undefined;
  /** Per source, after the signature is proven. */
  readonly sourceLimiter?: AttemptLimiter | undefined;
  /**
   * ADR-0096 D17 gate, reused: false when the deployment cannot key per-address budgets on a real client address (production without a valid
   * TRUSTED_PROXY_CIDRS). Create and rotate then answer ALARM_INGEST_UNAVAILABLE (503) so a credential nobody can use is never made. Default true.
   */
  readonly ingestAvailable?: boolean | undefined;
  readonly now?: () => Date;
  /** Ids and counts only. */
  readonly warn?: (event: string, context: Record<string, unknown>) => void;
}

export interface InboundAlarmRequest {
  readonly keyId: unknown;
  readonly timestamp: unknown;
  readonly signature: unknown;
  readonly rawBody: unknown;
  readonly ip: string;
}

export interface AlarmIngestService {
  isEnabled(organizationId: string): Promise<boolean>;
  ingest(request: InboundAlarmRequest): Promise<AlarmIngestAcceptedDto>;
  create(actor: StaffActor, body: unknown): Promise<AlarmSourceCredentialDto>;
  list(actor: StaffActor): Promise<AlarmSourceDto[]>;
  rotate(actor: StaffActor, id: string): Promise<AlarmSourceCredentialDto>;
  disable(actor: StaffActor, id: string): Promise<AlarmSourceDto>;
}

/** The one refusal body of the inbound route. */
const refused = (): UnauthorizedError => new UnauthorizedError("Alarm request refused");
/** Compared against when the credential is unknown or disabled, so a missing source costs one HMAC like a present one. */
const DUMMY_SECRET = "wxas_unknown_credential_equalises_timing";

function invalid(field: string, message: string): ValidationError {
  return new ValidationError(message, [{ field, code: "INVALID", message }]);
}

function toDto(v: SourceView): AlarmSourceDto {
  return {
    id: v.id,
    name: v.name,
    enabled: v.enabled,
    secretGeneration: v.secretGeneration,
    createdAt: v.createdAt.toISOString(),
    rotatedAt: v.rotatedAt?.toISOString() ?? null,
    disabledAt: v.disabledAt?.toISOString() ?? null,
    lastAcceptedAt: v.lastAcceptedAt?.toISOString() ?? null,
    mappings: v.mappings,
    last24h: v.last24h,
  };
}

const KIND_RE = new RegExp(ALARM_KIND_PATTERN);
const ALERT_TYPES: ReadonlySet<string> = new Set(ALARM_INGEST_ALERT_TYPES);
const CEILINGS: ReadonlySet<string> = new Set(ALARM_SEVERITY_CEILINGS);

/** Staff input, validated again here (the route's schema is the first pass, the table CHECKs the last). */
export function validateCreate(body: unknown): { name: string; mappings: AlarmMappingInput[] } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name.length < 1 || name.length > ALARM_SOURCE_NAME_MAX)
    throw invalid("name", `name must be 1 to ${ALARM_SOURCE_NAME_MAX} characters`);
  const raw = Array.isArray(b.mappings) ? (b.mappings as unknown[]) : [];
  if (raw.length < 1 || raw.length > ALARM_MAX_MAPPINGS_PER_SOURCE)
    throw invalid("mappings", `1 to ${ALARM_MAX_MAPPINGS_PER_SOURCE} mappings are required`);
  const seen = new Set<string>();
  const mappings = raw.map((entry, i) => {
    const m = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof m.alarmKind !== "string" || !KIND_RE.test(m.alarmKind))
      throw invalid(`mappings.${i}.alarmKind`, "alarm kind must be 1 to 40 of a-z, 0-9, _");
    if (typeof m.alertType !== "string" || !ALERT_TYPES.has(m.alertType))
      throw invalid(`mappings.${i}.alertType`, "alert type is not an alarm ingest catalog type");
    // Tighten-only: only info or warn exist. `critical` is not a ceiling anyone can configure.
    if (typeof m.severityCeiling !== "string" || !CEILINGS.has(m.severityCeiling))
      throw invalid(`mappings.${i}.severityCeiling`, "severity ceiling must be info or warn");
    if (seen.has(m.alarmKind)) throw invalid(`mappings.${i}.alarmKind`, "alarm kind repeated");
    seen.add(m.alarmKind);
    return {
      alarmKind: m.alarmKind,
      alertType: m.alertType,
      severityCeiling: m.severityCeiling,
    } as AlarmMappingInput;
  });
  return { name, mappings };
}

export function createAlarmIngestService(deps: AlarmIngestServiceDeps): AlarmIngestService {
  const now = deps.now ?? (() => new Date());
  const warn = deps.warn ?? (() => undefined);
  const isEnabled = async (organizationId: string): Promise<boolean> => {
    try {
      return deps.flags
        ? (await deps.flags.forOrg(organizationId))[ALARM_INGEST_FLAG_KEY] === true
        : false;
    } catch {
      return false; // fail closed
    }
  };
  const assertAvailable = (): void => {
    if (deps.ingestAvailable === false)
      throw new ChartWardenError(
        ALARM_INGEST_UNAVAILABLE_CODE,
        "alarm ingest needs trusted proxy configuration",
        503,
      );
  };
  const spend = async (limiter: AttemptLimiter | undefined, key: string): Promise<void> => {
    const verdict = await limiter?.consume(key);
    if (verdict && !verdict.allowed) throw new RateLimitedError("Too many alarm requests");
  };
  const credential = (
    organizationId: string,
    view: SourceView,
    secret: string,
  ): AlarmSourceCredentialDto => ({
    ...toDto(view),
    keyId: alarmKeyId(organizationId, view.id),
    secret,
  });

  async function authenticate(request: InboundAlarmRequest): Promise<{
    readonly organizationId: string;
    readonly source: NonNullable<Awaited<ReturnType<AlarmIngestStore["loadSource"]>>>;
    readonly rawBody: string;
  }> {
    const key = parseAlarmKeyId(request.keyId);
    if (
      !key ||
      typeof request.rawBody !== "string" ||
      !isAlarmSignatureShape(request.signature) ||
      !inAlarmReplayWindow(request.timestamp, now().getTime())
    )
      throw refused();
    if (!(await isEnabled(key.organizationId))) throw refused();
    const source = await deps.store.loadSource(key.organizationId, key.sourceId);
    const live = source?.enabled === true;
    // A key-unavailable failure is infrastructure (503), not a verdict on the caller: it propagates so a real sender retries.
    const secret = live
      ? await deps.cipher.open(key.organizationId, source.secretCipher)
      : DUMMY_SECRET;
    const matches = alarmSignatureMatches(
      {
        secret,
        keyId: request.keyId as string,
        timestamp: request.timestamp as string,
        rawBody: request.rawBody,
      },
      request.signature,
    );
    if (!live || !matches) throw refused();
    return { organizationId: key.organizationId, source, rawBody: request.rawBody };
  }

  function parseBody(rawBody: string): AlarmEventBody {
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw invalid("(root)", "body must be a JSON object");
    }
    if (!Value.Check(AlarmEventBodySchema, json)) {
      const first = [...Value.Errors(AlarmEventBodySchema, json)][0];
      throw invalid(
        first?.path.replace(/^\//, "").replace(/\//g, ".") || "(root)",
        first?.message ?? "invalid body",
      );
    }
    return json;
  }

  function parseOccurredAt(body: AlarmEventBody): Date | null {
    if (body.occurredAt === undefined) return null;
    const at = new Date(body.occurredAt);
    const skew = Math.abs(at.getTime() - now().getTime()) / 1000;
    if (Number.isNaN(skew) || skew > ALARM_INGEST_OCCURRED_AT_SKEW_SECONDS)
      throw invalid("occurredAt", "occurredAt is too far from the server clock");
    return at;
  }

  return {
    isEnabled,

    async ingest(request) {
      await spend(deps.ipLimiter, request.ip);
      const { organizationId, source, rawBody } = await authenticate(request);
      await spend(deps.sourceLimiter, `${organizationId}:${source.id}`);
      if (Buffer.byteLength(rawBody, "utf8") > ALARM_INGEST_MAX_BODY_BYTES)
        throw invalid("(root)", "body too large");
      const body = parseBody(rawBody);
      const occurredAt = parseOccurredAt(body);

      const mapping = source.mappings.get(body.alarmKind);
      const stored = await deps.store.recordEvent(organizationId, {
        sourceId: source.id,
        eventId: body.eventId,
        payloadDigest: alarmPayloadDigest(rawBody),
        alarmKind: body.alarmKind,
        alertType: mapping?.alertType ?? null,
        requestedSeverity: body.severity ?? null,
        effectiveSeverity: mapping
          ? effectiveAlarmSeverity(body.severity, mapping.severityCeiling)
          : null,
        occurredAt,
      });
      const { row, created } = stored;
      if (!created && row.payloadDigest !== alarmPayloadDigest(rawBody))
        throw new ConflictError("eventId was already used with a different body");
      if (row.status === "unmapped") {
        // Recorded (the screen counts it) and refused loudly: the sender must learn its alarm kind reaches nobody.
        warn("m36.alarm_ingest.unmapped", { organizationId, sourceId: source.id });
        throw new ChartWardenError(
          "ALARM_KIND_UNMAPPED",
          "alarm kind is not mapped for this source",
          422,
        );
      }
      if (row.status !== "received") {
        return { status: "duplicate", outcome: row.status };
      }

      // received: first delivery, or a retry after a failed emit. The alert's correlation id is the event row id, so a repeat is absorbed by the
      // emitter's (organization, correlation) dedupe and can never page twice.
      if (!row.alertType || !row.effectiveSeverity)
        throw new Error("a received alarm event has no alert type"); // unreachable: the table CHECKs forbid it
      let emitted: Awaited<ReturnType<ReturnType<AlarmIngestServiceDeps["alerts"]>["emit"]>>;
      try {
        emitted = await deps.alerts().emit(organizationId, {
          eventType: row.alertType,
          severity: row.effectiveSeverity,
          correlationId: `alarm:${row.id}`,
          payload: {
            eventType: row.alertType,
            message: ALARM_INGEST_ALERT_MESSAGE,
            alarmEventId: row.id,
            sourceId: source.id,
            alarmKind: body.alarmKind,
          },
        });
      } catch {
        warn("m36.alarm_ingest.emit_failed", { organizationId, sourceId: source.id });
        throw new ChartWardenError(
          "ALARM_NOT_ALERTED",
          "the alarm was received but not yet alerted; retry with the same eventId",
          503,
        );
      }
      const outcome = emitted.resolvedRecipientCount > 0 ? "alerted" : "no_recipients";
      try {
        await deps.store.settleEvent(
          organizationId,
          row.id,
          outcome,
          emitted.alertId,
          emitted.resolvedRecipientCount,
        );
      } catch {
        // The alert exists (its correlation id absorbs a repeat); only the row's outcome is unsettled, so the sender's retry settles it.
        warn("m36.alarm_ingest.settle_failed", { organizationId, sourceId: source.id });
        throw new ChartWardenError(
          "ALARM_NOT_ALERTED",
          "the alarm was received but not yet alerted; retry with the same eventId",
          503,
        );
      }
      if (outcome === "no_recipients")
        warn("m36.alarm_ingest.no_recipients", { organizationId, sourceId: source.id });
      return { status: created ? "accepted" : "duplicate", outcome };
    },

    async create(actor, body) {
      if (!(await isEnabled(actor.organizationId))) throw new NotFoundError("alarm source");
      assertAvailable();
      const input = validateCreate(body);
      const secret = newAlarmSecret();
      const sealed = await deps.cipher.sealRing(actor.organizationId, secret);
      const created = await deps.store.createSource(actor, {
        name: input.name,
        secretCipher: sealed.cipher,
        mappings: input.mappings,
        maxSources: ALARM_MAX_SOURCES_PER_TENANT,
      });
      if (created === "cap_reached")
        throw new ConflictError(
          `a tenant may have at most ${ALARM_MAX_SOURCES_PER_TENANT} enabled alarm sources`,
        );
      return credential(actor.organizationId, created, secret);
    },

    async list(actor) {
      return (await deps.store.listSources(actor)).map(toDto);
    },

    async rotate(actor, id) {
      if (!(await isEnabled(actor.organizationId))) throw new NotFoundError("alarm source", id);
      assertAvailable();
      const secret = newAlarmSecret();
      const sealed = await deps.cipher.sealRing(actor.organizationId, secret);
      const view = await deps.store.rotateSource(actor, id, sealed.cipher);
      if (!view) throw new NotFoundError("alarm source", id);
      return credential(actor.organizationId, view, secret);
    },

    async disable(actor, id) {
      // Never depends on the flag: a source that exists stays disable-able.
      const view = await deps.store.disableSource(actor, id);
      if (!view) throw new NotFoundError("alarm source", id);
      return toDto(view);
    },
  };
}
