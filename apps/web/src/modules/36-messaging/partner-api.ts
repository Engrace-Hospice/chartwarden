// M36 WP 6.6 (ADR-0096 D19) - the partner page's network layer. DELIBERATELY not the staff API client: no cookies (`credentials: "omit"`, so the staff
// session can never ride along), no CSRF or idempotency middleware, no global 401 watcher that would bounce a partner to the staff sign-in. The bearer
// is passed in by the caller from memory and goes only in the Authorization header. Every outcome is reduced to a closed kind, so no response text, id
// or message ever reaches an error string, the console or a log (D20): "gone" is ONE kind for 401/403/404 (revoked, expired, locked, never existed).
import type {
  PartnerMessageDto,
  PartnerMessagesDto,
  PartnerShareStateDto,
  PartnerVerifiedDto,
} from "@chartwarden/types";

export type PartnerResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "gone" }
  | { readonly kind: "bad-code" }
  | { readonly kind: "limited" }
  | { readonly kind: "failed" };

const BASE = "/api/v1/messaging/partner";
const CODE_INVALID = "EXTERNAL_SHARE_CODE_INVALID";
/** Pages followed per refresh; a longer conversation shows its first MAX_PAGES * 50 messages (ADR-0096 limit r). */
export const PARTNER_MAX_PAGES = 4;

interface CallInit {
  readonly method: "GET" | "POST";
  readonly bearer?: string;
  readonly body?: unknown;
}

async function call<T>(
  path: string,
  init: CallInit,
  signal?: AbortSignal,
): Promise<PartnerResult<T>> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (res.status === 429) return { kind: "limited" };
    if (res.status === 401 || res.status === 403 || res.status === 404) return { kind: "gone" };
    if (res.status === 422) {
      const parsed = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      return parsed?.error?.code === CODE_INVALID ? { kind: "bad-code" } : { kind: "failed" };
    }
    if (!res.ok) return { kind: "failed" };
    return { kind: "ok", data: (await res.json()) as T };
  } catch {
    return { kind: "failed" };
  }
}

export interface PartnerRedeemed {
  readonly sessionToken: string;
  readonly shareId: string;
  readonly expiresAt: string;
}

export const redeemInvitation = (organizationId: string, token: string) =>
  call<PartnerRedeemed>("/redeem", { method: "POST", body: { organizationId, token } });

export const readPartnerState = (bearer: string, shareId: string, signal?: AbortSignal) =>
  call<PartnerShareStateDto>(`/shares/${encodeURIComponent(shareId)}`, { method: "GET", bearer }, signal);

export const verifyPartnerCode = (bearer: string, shareId: string, code: string) =>
  call<PartnerVerifiedDto>(`/shares/${encodeURIComponent(shareId)}/verify`, {
    method: "POST",
    bearer,
    body: { code },
  });

/** The readable conversation (oldest first), following the cursor for at most {@link PARTNER_MAX_PAGES} pages. */
export async function readPartnerConversation(
  bearer: string,
  shareId: string,
  signal?: AbortSignal,
): Promise<PartnerResult<readonly PartnerMessageDto[]>> {
  const all: PartnerMessageDto[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < PARTNER_MAX_PAGES; page += 1) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const r: PartnerResult<PartnerMessagesDto> = await call<PartnerMessagesDto>(
      `/shares/${encodeURIComponent(shareId)}/messages${query}`,
      { method: "GET", bearer },
      signal,
    );
    if (r.kind !== "ok") return r;
    all.push(...r.data.messages);
    cursor = r.data.nextCursor;
    if (!cursor) break;
  }
  return { kind: "ok", data: all };
}
