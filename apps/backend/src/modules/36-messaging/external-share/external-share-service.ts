// M36 WP 6.6 (ADR-0096, PROPOSED) - the external partner share: STAFF side (create, list, revoke) and PARTNER side (redeem the invitation, prove the
// second factor, read the one shared conversation). Every refusal a partner can cause is the same neutral 404: unknown share, other tenant,
// other conversation, expired, revoked, flag off, wrong stage, bad token (D12). Liveness is judged by the store in the same SQL statement as the
// read, on the database clock, with no cache (D4).
import {
  ChartWardenError,
  ConflictError,
  type CreateExternalShareRequest,
  type CreatedExternalShareDto,
  DegradedError,
  EXTERNAL_PARTNERS_FLAG_KEY,
  EXTERNAL_PARTNER_PAGE_MAX,
  EXTERNAL_SHARE_BAA_MAX,
  EXTERNAL_SHARE_CHANNEL_KINDS,
  EXTERNAL_SHARE_DEFAULT_DAYS,
  EXTERNAL_SHARE_MAX_CODE_ATTEMPTS,
  EXTERNAL_SHARE_MAX_DAYS,
  EXTERNAL_SHARE_MAX_LIVE_PER_TENANT,
  EXTERNAL_SHARE_MAX_PER_CREATOR_DAY,
  EXTERNAL_SHARE_NAME_MAX,
  EXTERNAL_SHARE_PARTNER_KINDS,
  type ExternalShareDto,
  type ExternalSharePartnerKind,
  NotFoundError,
  type PartnerMessageDto,
  type PartnerMessagesDto,
  type PartnerShareStateDto,
  RateLimitedError,
  ValidationError,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { MessageBodyCipher } from "../messaging-write-core";
import { decodeStoredBody } from "../rich-body-codec";
import { publishExternalShareEvent } from "./external-share-events";
import {
  formatSessionToken,
  hashPartnerToken,
  hashVerificationCode,
  newPartnerToken,
  newVerificationCode,
  parseSessionToken,
  verifyVerificationCode,
} from "./external-share-secrets";
import {
  type LiveSession,
  type PartnerTx,
  type SharePartnerStore,
  type ShareRow,
  type ShareStaffStore,
  type StaffActor,
  shareStatus,
} from "./external-share-store";

export interface AttemptLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export interface ExternalShareFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export const EXTERNAL_SHARE_LIMIT_CODE = "EXTERNAL_SHARE_LIMIT";
export const EXTERNAL_SHARE_CODE_INVALID = "EXTERNAL_SHARE_CODE_INVALID";

export interface ExternalShareServiceDeps {
  readonly staffStore: ShareStaffStore;
  readonly partnerStore: SharePartnerStore;
  /** Required for every staff write: it announces itself on the outbox in the same transaction. Absent => the write throws (nothing is written). */
  readonly outbox?: HintOutboxPort | undefined;
  /** The M1 flag reader for `messaging.external_partners`. Absent => the feature is off everywhere. */
  readonly flags?: ExternalShareFlagReader | undefined;
  /** The M36 body cipher. Absent => a partner read is refused 503 before anything is recorded. */
  readonly cipher?: Pick<MessageBodyCipher, "open"> | undefined;
  /**
   * The creator must be able to VIEW the channel by membership (the predicate the message routes use, WITHOUT the break-glass read grant).
   * Absent => nobody may share (fail closed, the uniform 404).
   */
  readonly canViewChannel?:
    | ((orgId: string, userId: string, channelId: string) => Promise<boolean>)
    | undefined;
  /**
   * Budgets before any database work, per client address. There is deliberately no per-organisation budget: unauthenticated junk naming a
   * tenant must not be able to exhaust it (ADR-0096 D10).
   */
  readonly redeemIpLimiter?: AttemptLimiter | undefined;
  readonly verifyIpLimiter?: AttemptLimiter | undefined;
  /** Per client address on the partner state and messages routes, so a wrong bearer cannot be replayed for free. */
  readonly bearerIpLimiter?: AttemptLimiter | undefined;
  /** Per share, on reads (60/min). */
  readonly readLimiter?: AttemptLimiter | undefined;
}

export interface PartnerRequestMeta {
  readonly ip: string;
}

export interface ExternalShareService {
  isEnabled(orgId: string): Promise<boolean>;
  create(actor: StaffActor, body: CreateExternalShareRequest): Promise<CreatedExternalShareDto>;
  list(actor: StaffActor): Promise<ExternalShareDto[]>;
  revoke(actor: StaffActor, shareId: string): Promise<ExternalShareDto>;
  redeem(
    input: { readonly organizationId: string; readonly token: string },
    meta: PartnerRequestMeta,
  ): Promise<{
    readonly sessionToken: string;
    readonly shareId: string;
    readonly stage: "enrolment";
    readonly expiresAt: string;
  }>;
  state(
    bearer: string | null,
    shareId: string,
    meta: PartnerRequestMeta,
  ): Promise<PartnerShareStateDto>;
  /** `rawBody` is validated only AFTER the bearer resolves, so an unauthenticated caller never gets validation detail (D12). */
  verify(
    bearer: string | null,
    shareId: string,
    rawBody: unknown,
    meta: PartnerRequestMeta,
  ): Promise<PartnerShareStateDto>;
  /** `rawQuery` is validated only AFTER the bearer resolves. */
  messages(
    bearer: string | null,
    shareId: string,
    rawQuery: unknown,
    meta: PartnerRequestMeta,
  ): Promise<PartnerMessagesDto>;
}

const shareNotFound = (): NotFoundError => new NotFoundError("share");
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?)?)\|([0-9a-f-]{36})$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

function toDto(row: ShareRow): ExternalShareDto {
  return {
    id: row.id,
    channelId: row.channelId,
    channelTitle: row.channelTitle,
    partnerName: row.partnerName,
    partnerKind: row.partnerKind,
    status: shareStatus(row),
    sharedFrom: row.sharedFrom.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    redeemed: row.redeemed,
    codeLocked: row.codeAttempts >= EXTERNAL_SHARE_MAX_CODE_ATTEMPTS,
  };
}

function validateCreate(body: CreateExternalShareRequest): {
  readonly channelId: string;
  readonly partnerName: string;
  readonly partnerKind: ExternalSharePartnerKind;
  readonly baaReference: string;
  readonly expiresInDays: number;
} {
  if (!UUID_RE.test(body.channelId ?? "")) invalid("channelId", "a conversation id");
  const partnerName = (body.partnerName ?? "").trim();
  if (partnerName.length < 1 || partnerName.length > EXTERNAL_SHARE_NAME_MAX) {
    invalid("partnerName", `a partner name of 1 to ${EXTERNAL_SHARE_NAME_MAX} characters`);
  }
  if (!(EXTERNAL_SHARE_PARTNER_KINDS as readonly string[]).includes(body.partnerKind)) {
    invalid("partnerKind", "choose pharmacy, dme or other");
  }
  const baaReference = (body.baaReference ?? "").trim();
  if (baaReference.length < 1 || baaReference.length > EXTERNAL_SHARE_BAA_MAX) {
    invalid("baaReference", `a BAA reference of 1 to ${EXTERNAL_SHARE_BAA_MAX} characters`);
  }
  const expiresInDays = body.expiresInDays ?? EXTERNAL_SHARE_DEFAULT_DAYS;
  if (
    !Number.isInteger(expiresInDays) ||
    expiresInDays < 1 ||
    expiresInDays > EXTERNAL_SHARE_MAX_DAYS
  ) {
    invalid("expiresInDays", `a whole number of days from 1 to ${EXTERNAL_SHARE_MAX_DAYS}`);
  }
  return {
    channelId: body.channelId,
    partnerName,
    partnerKind: body.partnerKind,
    baaReference,
    expiresInDays,
  };
}

function codeOf(raw: unknown): string {
  const code = (raw as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) invalid("code", "the 8-digit code");
  return code as string;
}

function pageOf(raw: unknown): {
  readonly limit: number;
  readonly after: { createdAtText: string; id: string } | null;
} {
  const q = (raw ?? {}) as { cursor?: unknown; limit?: unknown };
  let limit = EXTERNAL_PARTNER_PAGE_MAX;
  if (q.limit !== undefined) {
    const n = typeof q.limit === "number" ? q.limit : Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > EXTERNAL_PARTNER_PAGE_MAX) {
      invalid("limit", `a whole number from 1 to ${EXTERNAL_PARTNER_PAGE_MAX}`);
    }
    limit = n;
  }
  if (q.cursor === undefined) return { limit, after: null };
  const m = typeof q.cursor === "string" ? CURSOR_RE.exec(q.cursor) : null;
  if (!m) invalid("cursor", "an opaque cursor from a previous page");
  return { limit, after: { createdAtText: m![1]!, id: m![2]! } };
}

async function spend(
  limiter: AttemptLimiter | undefined,
  key: string,
  what: string,
): Promise<void> {
  const verdict = await limiter?.consume(key);
  if (verdict && !verdict.allowed) throw new RateLimitedError(`too many ${what}`);
}

export function createExternalShareService(deps: ExternalShareServiceDeps): ExternalShareService {
  const isEnabled = async (orgId: string): Promise<boolean> =>
    deps.flags ? (await deps.flags.forOrg(orgId))[EXTERNAL_PARTNERS_FLAG_KEY] === true : false;

  /**
   * Every partner request after the invitation: flag, bearer shape, then ONE org-bound transaction in which the session and its share are
   * resolved live. A share id in the URL is only ever compared with the session's own.
   */
  async function withLive<T>(
    bearer: string | null,
    shareId: string,
    fn: (tx: PartnerTx, live: LiveSession) => Promise<T>,
  ): Promise<T> {
    const parsed = bearer ? parseSessionToken(bearer) : null;
    if (!parsed || !UUID_RE.test(shareId)) throw shareNotFound();
    if (!(await isEnabled(parsed.organizationId))) throw shareNotFound();
    return deps.partnerStore.run(parsed.organizationId, async (tx) => {
      const live = await tx.resolveSession(hashPartnerToken(parsed.token));
      if (!live || live.shareId !== shareId) throw shareNotFound();
      return fn(tx, live);
    });
  }

  const stateOf = (
    live: LiveSession,
    stage: PartnerShareStateDto["stage"],
  ): PartnerShareStateDto => ({
    shareId: live.shareId,
    stage,
    partnerName: live.partnerName,
    expiresAt: live.shareExpiresAt.toISOString(),
  });

  return {
    isEnabled,

    async create(actor, body) {
      if (!(await isEnabled(actor.organizationId))) throw new NotFoundError("conversation");
      const input = validateCreate(body);
      const outbox = deps.outbox;
      if (!outbox)
        throw new DegradedError("messaging", "the outbox is not configured; nothing was shared");
      // Membership first (no break-glass bypass): a non-member holder of the permission gets the SAME 404 as an unknown channel.
      if (
        !deps.canViewChannel ||
        !(await deps.canViewChannel(actor.organizationId, actor.userId, input.channelId))
      ) {
        throw new NotFoundError("conversation");
      }
      const inviteToken = newPartnerToken();
      const verificationCode = newVerificationCode();
      const row = await deps.staffStore.run(actor, async (tx) => {
        await tx.lockTenant();
        const kind = await tx.channelKind(input.channelId);
        // One 404 for an unknown channel and a channel of a kind that may never be shared: no kind oracle.
        if (!kind || !(EXTERNAL_SHARE_CHANNEL_KINDS as readonly string[]).includes(kind)) {
          throw new NotFoundError("conversation");
        }
        const counts = await tx.counts(actor.userId);
        if (
          counts.live >= EXTERNAL_SHARE_MAX_LIVE_PER_TENANT ||
          counts.creatorDay >= EXTERNAL_SHARE_MAX_PER_CREATOR_DAY
        ) {
          throw new ChartWardenError(
            EXTERNAL_SHARE_LIMIT_CODE,
            "too many partner shares; revoke one or wait",
            429,
          );
        }
        const inserted = await tx.insertShare(actor.userId, {
          ...input,
          inviteTokenHash: hashPartnerToken(inviteToken),
          codeHash: hashVerificationCode(verificationCode),
        });
        await publishExternalShareEvent(outbox, tx.raw, {
          kind: "created",
          orgId: actor.organizationId,
          shareId: inserted.id,
          channelId: inserted.channelId,
          actorUserId: actor.userId,
          at: inserted.createdAt,
          expiresAt: inserted.expiresAt,
        });
        return inserted;
      });
      return { ...toDto(row), organizationId: actor.organizationId, inviteToken, verificationCode };
    },

    async list(actor) {
      return (await deps.staffStore.run(actor, (tx) => tx.listShares())).map(toDto);
    },

    async revoke(actor, shareId) {
      const outbox = deps.outbox;
      if (!outbox)
        throw new DegradedError("messaging", "the outbox is not configured; nothing was revoked");
      return deps.staffStore.run(actor, async (tx) => {
        const existing = await tx.getShare(shareId);
        if (!existing) throw new NotFoundError("share", shareId);
        const revoked = await tx.revoke(shareId, actor.userId);
        if (!revoked) throw new ConflictError("this share is already revoked");
        await publishExternalShareEvent(outbox, tx.raw, {
          kind: "revoked",
          orgId: actor.organizationId,
          shareId,
          channelId: revoked.channelId,
          actorUserId: actor.userId,
          at: revoked.dbNow,
        });
        return toDto(revoked);
      });
    },

    async redeem(input, meta) {
      // The per-address budget BEFORE any database work: a flood costs a counter increment, not a query.
      await spend(deps.redeemIpLimiter, meta.ip, "invitation attempts");
      if (!(await isEnabled(input.organizationId))) throw shareNotFound();
      const sessionToken = newPartnerToken();
      const result = await deps.partnerStore.run(input.organizationId, async (tx) => {
        const redeemed = await tx.redeemInvite(hashPartnerToken(input.token));
        if (!redeemed) return null;
        await tx.insertSession(redeemed.shareId, hashPartnerToken(sessionToken));
        return redeemed;
      });
      if (!result) throw shareNotFound();
      return {
        sessionToken: formatSessionToken(input.organizationId, sessionToken),
        shareId: result.shareId,
        stage: "enrolment",
        expiresAt: result.expiresAt.toISOString(),
      };
    },

    async state(bearer, shareId, meta) {
      await spend(deps.bearerIpLimiter, meta.ip, "requests");
      return withLive(bearer, shareId, async (_tx, live) => stateOf(live, live.stage));
    },

    async verify(bearer, shareId, rawBody, meta) {
      await spend(deps.verifyIpLimiter, meta.ip, "verification attempts");
      const outcome = await withLive(bearer, shareId, async (tx, live) => {
        // Past this point the caller holds a live bearer, so a validation message is no oracle.
        const code = codeOf(rawBody);
        if (live.stage === "active") return { ok: true as const, live };
        // The attempt is counted (and committed) BEFORE the code is compared, so a wrong code cannot be retried for free.
        const stored = await tx.takeCodeAttempt(live.shareId);
        if (stored === null) throw shareNotFound(); // locked (5 attempts) or no longer live
        if (!verifyVerificationCode(code, stored)) return { ok: false as const, live };
        await tx.activate(live.sessionId);
        return { ok: true as const, live };
      });
      if (!outcome.ok) {
        throw new ChartWardenError(EXTERNAL_SHARE_CODE_INVALID, "that code is not correct", 422);
      }
      return stateOf(outcome.live, "active");
    },

    async messages(bearer, shareId, rawQuery, meta) {
      await spend(deps.bearerIpLimiter, meta.ip, "requests");
      return withLive(bearer, shareId, async (tx, live) => {
        // Validated only now that the bearer is live (D12).
        const { limit, after } = pageOf(rawQuery);
        const cipher = deps.cipher;
        if (!cipher) throw new DegradedError("messaging", "message decryption is not configured");
        // Enrolment-stage sessions read nothing; a channel kind that may never be shared is the same 404 (D1).
        if (live.stage !== "active") throw shareNotFound();
        if (!(EXTERNAL_SHARE_CHANNEL_KINDS as readonly string[]).includes(live.channelKind))
          throw shareNotFound();
        await spend(deps.readLimiter, live.shareId, "reads");
        const rows = await tx.visibleMessages(live, after, limit + 1);
        const page = rows.slice(0, limit);
        const out: PartnerMessageDto[] = [];
        for (const r of page) {
          let plaintext: string;
          try {
            plaintext = await cipher.open(live.organizationId, r.bodyCipher);
          } catch {
            throw new DegradedError(
              "messaging",
              "a message could not be read; nothing was returned",
            );
          }
          const decoded = decodeStoredBody(
            r.bodyKind as Parameters<typeof decodeStoredBody>[0],
            plaintext,
          );
          if (decoded.unreadable) continue; // never show a guess
          out.push({
            messageId: r.id,
            authorName: r.authorName,
            body: decoded.body,
            createdAt: new Date(r.createdAtText).toISOString(),
            edited: r.status === "edited",
          });
        }
        // The trail row is written BEFORE any byte leaves; the database guard refuses it for a revoked or expired share.
        try {
          await tx.recordRead(live, out.length);
        } catch {
          throw shareNotFound();
        }
        const last = page[page.length - 1];
        return {
          messages: out,
          nextCursor: rows.length > limit && last ? `${last.createdAtText}|${last.id}` : null,
        };
      });
    },
  };
}
