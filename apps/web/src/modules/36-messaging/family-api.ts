// M36 WP 6.7 (ADR-0099 D1, D12) - the family contact page's network layer. DELIBERATELY not the staff API client (same rules as partner-api.ts): no cookies
// (`credentials: "omit"`), no CSRF or idempotency middleware, no global 401 watcher. The bearer is passed in from memory and goes only in the Authorization
// header. Every outcome is reduced to a closed kind, so no response text, id or message ever reaches an error string, the console or a log: "gone" is ONE
// kind for 401/403/404/410 (revoked, expired, locked, closed to this person, never existed).
import {
  FAMILY_CODE_INVALID_CODE,
  FAMILY_THREAD_CLOSED_CODE,
  type FamilyContactMessagesDto,
  type FamilyContactStateDto,
  type FamilyContactVerifiedDto,
} from "@chartwarden/types";

export type FamilyResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "gone" }
  | { readonly kind: "bad-code" }
  | { readonly kind: "closed" }
  | { readonly kind: "limited" }
  | { readonly kind: "failed" };

const BASE = "/api/v1/messaging/family-contact";

interface CallInit {
  readonly method: "GET" | "POST";
  readonly bearer?: string;
  readonly body?: unknown;
}

async function errorCodeOf(res: Response): Promise<string | undefined> {
  const parsed = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  const code = parsed?.error?.code;
  return typeof code === "string" ? code : undefined;
}

async function call<T>(path: string, init: CallInit): Promise<FamilyResult<T>> {
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
    });
    if (res.status === 429) return { kind: "limited" };
    if ([401, 403, 404, 410].includes(res.status)) return { kind: "gone" };
    if (res.status === 422) {
      return (await errorCodeOf(res)) === FAMILY_CODE_INVALID_CODE
        ? { kind: "bad-code" }
        : { kind: "failed" };
    }
    if (res.status === 409) {
      return (await errorCodeOf(res)) === FAMILY_THREAD_CLOSED_CODE
        ? { kind: "closed" }
        : { kind: "failed" };
    }
    if (!res.ok) return { kind: "failed" };
    return { kind: "ok", data: (await res.json()) as T };
  } catch {
    return { kind: "failed" };
  }
}

export interface FamilyRedeemed {
  readonly sessionToken: string;
  readonly stage: "enrolment";
  readonly expiresAt: string;
}

export const redeemFamilyInvitation = (organizationId: string, token: string) =>
  call<FamilyRedeemed>("/redeem", { method: "POST", body: { organizationId, token } });

export const readFamilyState = (bearer: string) =>
  call<FamilyContactStateDto>("/state", { method: "GET", bearer });

export const verifyFamilyCode = (bearer: string, code: string) =>
  call<FamilyContactVerifiedDto>("/verify", { method: "POST", bearer, body: { code } });

/** One page of the thread, oldest first. `cursor` continues after the last message already shown. */
export const readFamilyMessages = (bearer: string, cursor: string | null) =>
  call<FamilyContactMessagesDto>(
    `/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { method: "GET", bearer },
  );

export const sendFamilyMessage = (bearer: string, body: string) =>
  call<{ messageId: string; createdAt: string }>("/messages", {
    method: "POST",
    bearer,
    body: { body },
  });
