// M36 WP 6.7 (ADR-0099, PROPOSED) - family messaging, CONTACT side: redeem the one-time link, prove the spoken code, read the one thread, send text. The
// principal is a bearer bound to ONE invitation, hence to ONE person for ONE patient; it has no roles and no user. Every refusal a contact can cause is
// the same neutral 404 (D12): unknown, expired, revoked, locked, wrong stage, flag off, wrong tenant, bad token, and any loss of eligibility. Liveness AND
// eligibility are judged by the store in the same SQL statement as the request, on the database clock, with no cache. The conversation is read from the
// invitation row, never from the request: there is no id for a contact to guess.
import {
  ChartWardenError,
  DegradedError,
  FAMILY_CODE_INVALID_CODE,
  FAMILY_MESSAGING_FLAG_KEY,
  FAMILY_PAGE_MAX,
  FAMILY_SEND_PER_DAY,
  FAMILY_SEND_PER_HOUR,
  FAMILY_THREAD_CAP_MESSAGE,
  FAMILY_THREAD_CLOSED_CODE,
  FAMILY_THREAD_UNANSWERED_CAP,
  type FamilyContactMessageDto,
  type FamilyContactMessagesDto,
  type FamilyContactStateDto,
  type FamilyContactVerifiedDto,
  RateLimitedError,
} from "@chartwarden/types";
import {
  PARTNER_TOKEN_RE,
  formatSessionToken,
  hashPartnerToken,
  newPartnerToken,
  parseSessionToken,
  verifyVerificationCode,
} from "../external-share/external-share-secrets";
import type { HintOutboxPort } from "../message-hint-events";
import { type MessageBodyCipher, type Tx, insertEncryptedMessage } from "../messaging-write-core";
import { decodeStoredBody } from "../rich-body-codec";
import {
  type AttemptLimiter,
  type FamilyFlagReader,
  UUID_RE,
  familyNotFound,
  invalid,
  spend,
  validateMessageText,
} from "./family-common";
import { publishFamilyEvent } from "./family-events";
import type { FamilyContactStore, FamilyContactTx, FamilyLiveSession } from "./family-store-types";

export interface FamilyContactServiceDeps {
  readonly store: FamilyContactStore;
  /** The per-deployment code pepper (D3). */
  readonly pepper: string;
  readonly outbox?: HintOutboxPort | undefined;
  readonly flags?: FamilyFlagReader | undefined;
  readonly cipher?: Pick<MessageBodyCipher, "open" | "seal"> | undefined;
  /** The one message writer (default: `insertEncryptedMessage`); a seam so the unit matrix runs without a database. */
  readonly insertMessage?: typeof insertEncryptedMessage | undefined;
  /** Budgets before any database work, per client address (D8). There is deliberately no per-organisation budget: junk naming a tenant must not exhaust it. */
  readonly redeemIpLimiter?: AttemptLimiter | undefined;
  readonly verifyIpLimiter?: AttemptLimiter | undefined;
  readonly bearerIpLimiter?: AttemptLimiter | undefined;
  /** Per thread-link, on reads (60/min) and sends (a second guard beside the database counts). */
  readonly readLimiter?: AttemptLimiter | undefined;
}

export interface FamilyRequestMeta {
  readonly ip: string;
}

export interface FamilyContactService {
  isEnabled(orgId: string): Promise<boolean>;
  /** `rawInput` is checked only after the budget is spent, and a wrong shape is the same 404 as a wrong token. */
  redeem(
    rawInput: unknown,
    meta: FamilyRequestMeta,
  ): Promise<{ readonly sessionToken: string; readonly stage: "enrolment"; readonly expiresAt: string }>;
  state(bearer: string | null, meta: FamilyRequestMeta): Promise<FamilyContactStateDto>;
  /** `rawBody` is validated only AFTER the bearer resolves, so an unauthenticated caller never gets validation detail. */
  verify(bearer: string | null, rawBody: unknown, meta: FamilyRequestMeta): Promise<FamilyContactVerifiedDto>;
  messages(bearer: string | null, rawQuery: unknown, meta: FamilyRequestMeta): Promise<FamilyContactMessagesDto>;
  send(
    bearer: string | null,
    rawBody: unknown,
    meta: FamilyRequestMeta,
  ): Promise<{ readonly messageId: string; readonly createdAt: string }>;
}

const FAMILY_TOKEN_RE = PARTNER_TOKEN_RE;
const CURSOR_RE =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[+-]\d{2}(?::?\d{2})?)?)\|([0-9a-f-]{36})$/i;

function codeOf(raw: unknown): string {
  const code = (raw as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string" || !/^\d{8}$/.test(code)) invalid("code", "the 8-digit code");
  return code as string;
}

function textOf(raw: unknown): unknown {
  return (raw as { body?: unknown } | null | undefined)?.body;
}

function pageOf(raw: unknown): {
  readonly limit: number;
  readonly after: { createdAtText: string; id: string } | null;
} {
  const q = (raw ?? {}) as { cursor?: unknown; limit?: unknown };
  let limit = FAMILY_PAGE_MAX;
  if (q.limit !== undefined) {
    const n = typeof q.limit === "number" ? q.limit : Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > FAMILY_PAGE_MAX) {
      invalid("limit", `a whole number from 1 to ${FAMILY_PAGE_MAX}`);
    }
    limit = n;
  }
  if (q.cursor === undefined) return { limit, after: null };
  const m = typeof q.cursor === "string" ? CURSOR_RE.exec(q.cursor) : null;
  if (!m) invalid("cursor", "an opaque cursor from a previous page");
  return { limit, after: { createdAtText: m![1]!, id: m![2]! } };
}

export function createFamilyContactService(deps: FamilyContactServiceDeps): FamilyContactService {
  const isEnabled = async (orgId: string): Promise<boolean> =>
    deps.flags ? (await deps.flags.forOrg(orgId))[FAMILY_MESSAGING_FLAG_KEY] === true : false;

  /**
   * Every request after the link: flag, bearer shape, then ONE org-bound transaction in which the session, the invitation and the whole eligibility are
   * resolved live. The first time the person is eligible only as a bereaved contact, that switch is recorded in the same transaction (D15).
   */
  async function withLive<T>(
    bearer: string | null,
    fn: (tx: FamilyContactTx, live: FamilyLiveSession) => Promise<T>,
  ): Promise<T> {
    const parsed = bearer ? parseSessionToken(bearer) : null;
    if (!parsed) throw familyNotFound();
    if (!(await isEnabled(parsed.organizationId))) throw familyNotFound();
    return deps.store.run(parsed.organizationId, async (tx) => {
      const live = await tx.resolveSession(hashPartnerToken(parsed.token));
      if (!live) throw familyNotFound();
      if (live.mode === "bereavement" && live.storedMode === "standard") {
        if (!deps.outbox) throw new DegradedError("messaging", "the outbox is not configured");
        await tx.switchToBereavement(live.contactId);
        await publishFamilyEvent(deps.outbox, tx.raw, {
          kind: "bereavement_mode",
          orgId: live.organizationId,
          contactId: live.contactId,
          at: new Date(),
        });
      }
      return fn(tx, live);
    });
  }

  const stateOf = async (
    tx: FamilyContactTx,
    live: FamilyLiveSession,
    stage: FamilyContactStateDto["stage"],
  ): Promise<FamilyContactStateDto> => {
    const settings = await tx.getSettings();
    return {
      stage,
      mode: live.mode,
      agencyName: settings.agencyName,
      agencyPhone: settings.agencyPhone,
      bereavementPhone: settings.bereavementPhone,
      language: live.language,
      closed: live.closed,
      expiresAt: live.sessionExpiresAt.toISOString(),
    };
  };

  return {
    isEnabled,

    async redeem(rawInput, meta) {
      await spend(deps.redeemIpLimiter, meta.ip, "link attempts");
      const raw = (rawInput ?? {}) as { organizationId?: unknown; token?: unknown };
      if (
        typeof raw.organizationId !== "string" ||
        !UUID_RE.test(raw.organizationId) ||
        typeof raw.token !== "string" ||
        !FAMILY_TOKEN_RE.test(raw.token)
      ) {
        throw familyNotFound();
      }
      const input = { organizationId: raw.organizationId, token: raw.token };
      if (!(await isEnabled(input.organizationId))) throw familyNotFound();
      const sessionToken = newPartnerToken();
      const result = await deps.store.run(input.organizationId, async (tx) => {
        const redeemed = await tx.redeemInvite(hashPartnerToken(input.token));
        if (!redeemed) return null;
        await tx.insertSession(redeemed.invitationId, hashPartnerToken(sessionToken));
        return redeemed;
      });
      if (!result) throw familyNotFound();
      return {
        sessionToken: formatSessionToken(input.organizationId, sessionToken),
        stage: "enrolment",
        expiresAt: result.expiresAt.toISOString(),
      };
    },

    async state(bearer, meta) {
      await spend(deps.bearerIpLimiter, meta.ip, "requests");
      return withLive(bearer, (tx, live) => stateOf(tx, live, live.stage));
    },

    async verify(bearer, rawBody, meta) {
      await spend(deps.verifyIpLimiter, meta.ip, "verification attempts");
      const outcome = await withLive(bearer, async (tx, live) => {
        // Past this point the caller holds a live bearer, so a validation message is no oracle.
        const code = codeOf(rawBody);
        if (live.stage === "active") return { ok: true as const, rotated: null, state: await stateOf(tx, live, "active") };
        // The attempt is counted (and committed) BEFORE the code is compared, so a wrong code cannot be retried for free.
        const stored = await tx.takeCodeAttempt(live.invitationId);
        if (stored === null) throw familyNotFound(); // locked (5 attempts) or no longer live
        if (!verifyVerificationCode(code, stored, deps.pepper)) {
          return { ok: false as const, rotated: null, state: null };
        }
        // D3: activation ROTATES the bearer. The enrolment token is replaced in the same update, so one captured earlier is useless from here on.
        const fresh = newPartnerToken();
        await tx.activate(live.sessionId, hashPartnerToken(fresh));
        return {
          ok: true as const,
          rotated: formatSessionToken(live.organizationId, fresh),
          state: await stateOf(tx, live, "active"),
        };
      });
      if (!outcome.ok || !outcome.state) {
        throw new ChartWardenError(FAMILY_CODE_INVALID_CODE, "that code is not correct", 422);
      }
      return { ...outcome.state, sessionToken: outcome.rotated };
    },

    async messages(bearer, rawQuery, meta) {
      await spend(deps.bearerIpLimiter, meta.ip, "requests");
      return withLive(bearer, async (tx, live) => {
        // Validated only now that the bearer is live.
        const { limit, after } = pageOf(rawQuery);
        const cipher = deps.cipher;
        if (!cipher) throw new DegradedError("messaging", "message decryption is not configured");
        // Enrolment-stage sessions read nothing.
        if (live.stage !== "active") throw familyNotFound();
        await spend(deps.readLimiter, live.contactId, "reads");
        const rows = await tx.visibleMessages(live, after, limit + 1);
        const page = rows.slice(0, limit);
        const out: FamilyContactMessageDto[] = [];
        for (const r of page) {
          let plaintext: string;
          try {
            plaintext = await cipher.open(live.organizationId, r.bodyCipher);
          } catch {
            throw new DegradedError("messaging", "a message could not be read; nothing was returned");
          }
          const decoded = decodeStoredBody(r.bodyKind as Parameters<typeof decodeStoredBody>[0], plaintext);
          if (decoded.unreadable) continue; // never show a guess
          const createdAt = new Date(r.createdAtText);
          const mine = r.authorKind === "family_contact";
          out.push({
            messageId: r.id,
            from: mine ? "you" : "care_team",
            body: decoded.body,
            createdAt: createdAt.toISOString(),
            receivedByCareTeam:
              mine && live.staffSeenThrough !== null && createdAt.getTime() <= live.staffSeenThrough.getTime(),
          });
        }
        // The trail row is written BEFORE any byte leaves; the database guard refuses it for a dead invitation or a blocked contact.
        try {
          await tx.recordAccess(live, "read", out.length, null);
        } catch {
          throw familyNotFound();
        }
        const last = page[page.length - 1];
        return {
          messages: out,
          nextCursor: rows.length > limit && last ? `${last.createdAtText}|${last.id}` : null,
        };
      });
    },

    async send(bearer, rawBody, meta) {
      await spend(deps.bearerIpLimiter, meta.ip, "requests");
      return withLive(bearer, async (tx, live) => {
        if (live.stage !== "active") throw familyNotFound();
        const body = validateMessageText(textOf(rawBody));
        const cipher = deps.cipher;
        if (!cipher) throw new DegradedError("messaging", "message encryption is not configured");
        if (live.closed) {
          throw new ChartWardenError(
            FAMILY_THREAD_CLOSED_CODE,
            "this conversation is closed, please call the agency",
            409,
          );
        }
        // The thread-link row is locked here, so two concurrent sends serialise and the budgets below cannot both pass at the cap.
        const channelId = await tx.ensureChannel(live);
        const budget = await tx.sendBudget({ ...live, channelId });
        if (budget.lastHour >= FAMILY_SEND_PER_HOUR || budget.lastDay >= FAMILY_SEND_PER_DAY) {
          throw new RateLimitedError("you have sent several messages; please wait before sending another");
        }
        if (budget.sinceStaffReply >= FAMILY_THREAD_UNANSWERED_CAP) {
          throw new RateLimitedError(FAMILY_THREAD_CAP_MESSAGE);
        }
        const write = deps.insertMessage ?? insertEncryptedMessage;
        const sent = await write(tx.raw as Tx, cipher as MessageBodyCipher, {
          orgId: live.organizationId,
          channelId,
          authorUserId: null,
          body,
          familyThread: "contact",
        });
        await tx.touchContactMessage(live.contactId);
        try {
          await tx.recordAccess(live, "send", 1, sent.messageId);
        } catch {
          throw familyNotFound();
        }
        return { messageId: sent.messageId, createdAt: sent.createdAt };
      });
    },
  };
}
