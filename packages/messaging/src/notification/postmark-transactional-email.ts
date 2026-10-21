// @chartwarden/messaging — Postmark adapter for the M36 transactional email PORT (DR/INT #14).
//
// Implements `TransactionalEmailTransport` over Postmark's single-message HTTP API
// (`POST {baseUrl}/email`, auth header `X-Postmark-Server-Token`). The port stays provider-agnostic: SES can
// follow as a sibling file that implements the same interface and is passed to
// `selectTransactionalEmailTransport({ provider })`.
//
// PHI / secrets rule (architecture INTEGRATIONS §6.14, §6.22): the message handed to us is already PHI-free
// (a secure link, token in the URL fragment). This adapter never logs the recipient, subject, body or token,
// and never logs the server token; it logs the provider MessageID and the HTTP status only.
//
// Delivery semantics: 429 and 5xx (and network / timeout failures) are retried with bounded exponential
// backoff; any other 4xx is a permanent failure (bad token, unverified sender, inactive recipient). Postmark
// has no idempotency-key header, so delivery is at-least-once on a retry after an ambiguous timeout; the
// links being delivered are single-use, so a duplicate is harmless. A per-send `Metadata.dedupe_key` is sent
// so a duplicate is traceable in the Postmark activity feed.
import { randomUUID } from "node:crypto";
import type { OutboundEmail, TransactionalEmailTransport } from "./transactional-email";

export type EmailDeliveryErrorCode =
  | "PROVIDER_REJECTED" // permanent: 4xx other than 429
  | "RATE_LIMITED" // 429 after retries exhausted
  | "PROVIDER_UNAVAILABLE" // 5xx after retries exhausted
  | "TIMEOUT" // request exceeded timeoutMs on every attempt
  | "NETWORK" // fetch rejected on every attempt
  | "INVALID_RESPONSE"; // 2xx without a usable Postmark body

/** A typed, PHI-free delivery failure. `message` never contains the recipient, subject, body or credentials. */
export class EmailDeliveryError extends Error {
  readonly code: EmailDeliveryErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly providerErrorCode: number | undefined;
  constructor(input: {
    code: EmailDeliveryErrorCode;
    retryable: boolean;
    status?: number;
    providerErrorCode?: number;
  }) {
    const http = input.status === undefined ? "" : ` (http ${input.status})`;
    const provider =
      input.providerErrorCode === undefined ? "" : ` (provider code ${input.providerErrorCode})`;
    super(`transactional email delivery failed: ${input.code}${http}${provider}`);
    this.name = "EmailDeliveryError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
    this.providerErrorCode = input.providerErrorCode;
  }
}

export const POSTMARK_DEFAULT_BASE_URL = "https://api.postmarkapp.com";
export const POSTMARK_DEFAULT_MESSAGE_STREAM = "outbound";
export const POSTMARK_DEFAULT_TIMEOUT_MS = 10_000;
export const POSTMARK_DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface PostmarkTransportOptions {
  readonly serverToken: string;
  /** A From address whose sender signature / domain is verified in Postmark. */
  readonly from: string;
  readonly baseUrl?: string;
  readonly messageStream?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  /** PHI-free log sink (message id + status only). */
  readonly log?: (line: string) => void;
  readonly newDedupeKey?: () => string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with a cap; a numeric Retry-After (seconds) from the provider wins, also capped. */
function backoffMs(attempt: number, retryAfterHeader: string | null): number {
  const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

interface PostmarkSendBody {
  readonly ErrorCode?: number;
  readonly MessageID?: string;
}

async function readBody(res: Response): Promise<PostmarkSendBody | undefined> {
  try {
    const parsed: unknown = await res.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as PostmarkSendBody) : undefined;
  } catch {
    return undefined;
  }
}

type AttemptResult =
  | { readonly ok: true; readonly messageId: string; readonly status: number }
  | { readonly ok: false; readonly error: EmailDeliveryError; readonly retryAfter: string | null };

function classifyResponse(res: Response, body: PostmarkSendBody | undefined): AttemptResult {
  const retryAfter = res.headers.get("retry-after");
  if (res.status >= 200 && res.status < 300) {
    if (!body?.MessageID || (body.ErrorCode !== undefined && body.ErrorCode !== 0)) {
      return {
        ok: false,
        retryAfter: null,
        error: new EmailDeliveryError({
          code: "INVALID_RESPONSE",
          retryable: false,
          status: res.status,
        }),
      };
    }
    return { ok: true, messageId: body.MessageID, status: res.status };
  }
  const detail = {
    status: res.status,
    ...(body?.ErrorCode === undefined ? {} : { providerErrorCode: body.ErrorCode }),
  };
  if (res.status === 429) {
    return {
      ok: false,
      retryAfter,
      error: new EmailDeliveryError({ code: "RATE_LIMITED", retryable: true, ...detail }),
    };
  }
  if (res.status >= 500) {
    return {
      ok: false,
      retryAfter,
      error: new EmailDeliveryError({ code: "PROVIDER_UNAVAILABLE", retryable: true, ...detail }),
    };
  }
  return {
    ok: false,
    retryAfter: null,
    error: new EmailDeliveryError({ code: "PROVIDER_REJECTED", retryable: false, ...detail }),
  };
}

export function createPostmarkTransactionalEmailTransport(
  options: PostmarkTransportOptions,
): TransactionalEmailTransport {
  const baseUrl = (options.baseUrl ?? POSTMARK_DEFAULT_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? POSTMARK_DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? POSTMARK_DEFAULT_MAX_ATTEMPTS);
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? (() => {});
  const newDedupeKey = options.newDedupeKey ?? randomUUID;

  async function attemptOnce(payload: string): Promise<AttemptResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${baseUrl}/email`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": options.serverToken,
        },
        body: payload,
        signal: controller.signal,
      });
      return classifyResponse(res, await readBody(res));
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        retryAfter: null,
        error: new EmailDeliveryError({ code: aborted ? "TIMEOUT" : "NETWORK", retryable: true }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async send(email: OutboundEmail): Promise<void> {
      const payload = JSON.stringify({
        From: options.from,
        To: email.to,
        Subject: email.subject,
        TextBody: email.text,
        ...(email.html === undefined ? {} : { HtmlBody: email.html }),
        MessageStream: options.messageStream ?? POSTMARK_DEFAULT_MESSAGE_STREAM,
        // Transactional links are not engagement content: no open/click tracking (click tracking would
        // rewrite the link and route the token through a third-party redirect).
        TrackOpens: false,
        TrackLinks: "None",
        Metadata: { dedupe_key: newDedupeKey() },
      });
      let last: EmailDeliveryError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await attemptOnce(payload);
        if (result.ok) {
          log(
            `[m36:email] provider=postmark status=${result.status} message_id=${result.messageId}`,
          );
          return;
        }
        last = result.error;
        log(
          `[m36:email] provider=postmark attempt=${attempt} failed code=${last.code}${last.status === undefined ? "" : ` status=${last.status}`}`,
        );
        if (!last.retryable || attempt === maxAttempts) break;
        await sleep(backoffMs(attempt, result.retryAfter));
      }
      throw last as EmailDeliveryError;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Boot configuration: credentials come ONLY from env; the adapter binds ONLY when all are present and valid.
// ---------------------------------------------------------------------------------------------------------------

export const POSTMARK_ENV = {
  token: "POSTMARK_SERVER_TOKEN",
  from: "POSTMARK_FROM_ADDRESS",
  senderVerified: "POSTMARK_SENDER_VERIFIED",
  stream: "POSTMARK_MESSAGE_STREAM",
  baseUrl: "POSTMARK_API_BASE_URL",
} as const;

export type PostmarkConfigResult =
  | { readonly bound: true; readonly options: PostmarkTransportOptions }
  | {
      readonly bound: false;
      readonly missing: readonly string[];
      readonly invalid: readonly string[];
    };

const EMAIL_SHAPE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Resolve the Postmark adapter config from an env map. `POSTMARK_SENDER_VERIFIED=true` is the operator's
 * attestation that the From address has a verified sender signature / domain in Postmark (the adapter cannot
 * prove it; Postmark rejects unverified senders with a permanent 4xx, which surfaces as PROVIDER_REJECTED).
 * In production an API base override must be https.
 */
export function resolvePostmarkConfig(
  env: Record<string, string | undefined>,
): PostmarkConfigResult {
  const token = env[POSTMARK_ENV.token]?.trim();
  const from = env[POSTMARK_ENV.from]?.trim();
  const verified = env[POSTMARK_ENV.senderVerified]?.trim().toLowerCase();
  const stream = env[POSTMARK_ENV.stream]?.trim();
  const baseUrl = env[POSTMARK_ENV.baseUrl]?.trim();
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!token) missing.push(POSTMARK_ENV.token);
  if (!from) missing.push(POSTMARK_ENV.from);
  else if (!EMAIL_SHAPE.test(from)) invalid.push(POSTMARK_ENV.from);
  if (verified !== "true") {
    (verified === undefined || verified === "" ? missing : invalid).push(
      POSTMARK_ENV.senderVerified,
    );
  }
  if (baseUrl) {
    const schemeRule = env.NODE_ENV === "production" ? /^https:\/\//i : /^https?:\/\//i;
    if (!schemeRule.test(baseUrl)) invalid.push(POSTMARK_ENV.baseUrl);
  }
  if (missing.length > 0 || invalid.length > 0 || !token || !from) {
    return { bound: false, missing, invalid };
  }
  return {
    bound: true,
    options: {
      serverToken: token,
      from,
      ...(stream ? { messageStream: stream } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

/** True when ANY Postmark credential var is set: a partial configuration is a deploy mistake to fail loudly on. */
export function postmarkConfigAttempted(env: Record<string, string | undefined>): boolean {
  return [POSTMARK_ENV.token, POSTMARK_ENV.from, POSTMARK_ENV.senderVerified].some(
    (k) => (env[k]?.trim() ?? "") !== "",
  );
}
