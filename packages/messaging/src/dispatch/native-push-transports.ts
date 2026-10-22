// @chartwarden/messaging — native push transports (WP 5.11 / W6): FCM v1 (Android) and APNs (iOS), plus the router that
// lets the one `push` channel serve Web Push, FCM and APNs.
//
// WHAT CROSSES THE WIRE. Nothing from the notification: a native push carries a FIXED generic title/body and an opaque
// `{ type, alertId }` hint. The app opens, authenticates, and re-fetches the alert itself (mobile PR-L contract). A device
// token, a body, a patient name or a deep link never appears in a payload, a log line or a TransportError reason.
//
// DESTINATION. The dispatch port hands a transport one string. For a native endpoint the dispatch store encodes
// `{"provider","token","alertId"}` ({@link encodeNativeDestination}); a Web Push subscription is a different JSON, so the
// router tells them apart by the `provider` field. No new port, no change to dispatchClaimedDelivery.
//
// NOT HERE: credentials. The service-account JSON / .p8 key come from the boot binding (names-only env), never a literal.
import { createPrivateKey, createSign, sign as cryptoSign } from "node:crypto";
import http2 from "node:http2";
import {
  type OutOfBandTransport,
  TRANSPORT_NOT_CONFIGURED,
  TransportError,
  type TransportSendRequest,
} from "./transports";
import { type VendorFetch, postToVendor } from "./vendor-http";

export type NativePushProvider = "fcm" | "apns";

/** The opaque payload type the mobile app parses (`native-push.ts` in chartwarden-mobile). Legacy-named on purpose: the app still checks this exact string. */
export const NATIVE_PUSH_TYPE = "wardenx.alert";
export const NATIVE_PUSH_TITLE = "ChartWarden";
export const NATIVE_PUSH_BODY = "You have a new alert";
/** The reason a dead device token settles with: terminal, PHI-free, stable for ops dashboards. */
export const PUSH_TOKEN_UNREGISTERED = "push_token_unregistered";

const NATIVE_TTL_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Shape checks only (bounded, no whitespace or URL syntax): the vendor decides whether a well-formed token is live.
const TOKEN_SHAPE: Readonly<Record<NativePushProvider, RegExp>> = {
  fcm: /^[A-Za-z0-9_:.-]{32,512}$/,
  apns: /^[0-9a-fA-F]{32,200}$/,
};

export function isValidNativePushToken(provider: NativePushProvider, token: string): boolean {
  return TOKEN_SHAPE[provider].test(token);
}

export interface NativeDestination {
  readonly provider: NativePushProvider;
  readonly token: string;
  readonly alertId: string;
}

export function encodeNativeDestination(destination: NativeDestination): string {
  return JSON.stringify(destination);
}

/** Null for anything that is not a well-formed native destination (a Web Push subscription JSON included). */
export function parseNativeDestination(raw: string): NativeDestination | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { provider, token, alertId } = value as Record<string, unknown>;
  if (provider !== "fcm" && provider !== "apns") return null;
  if (typeof token !== "string" || !isValidNativePushToken(provider, token)) return null;
  if (typeof alertId !== "string" || !UUID.test(alertId)) return null;
  return { provider, token, alertId };
}

const b64u = (input: Buffer | string): string => Buffer.from(input).toString("base64url");
const nowSeconds = (now: () => Date): number => Math.floor(now().getTime() / 1000);

/** A native destination that does not parse is a stored-data fault, not a vendor one: terminal. */
function requireNative(
  request: TransportSendRequest,
  provider: NativePushProvider,
): NativeDestination {
  const destination = parseNativeDestination(request.destination);
  if (destination === null || destination.provider !== provider)
    throw new TransportError("push_destination_invalid", false);
  return destination;
}

// ── FCM v1 ─────────────────────────────────────────────────────────────────────────────────────────

export interface FcmServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

/** Parse the service-account JSON; null when it lacks the three fields or the key is not a usable private key. */
export function parseFcmServiceAccount(raw: string): FcmServiceAccount | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const { project_id, client_email, private_key } = v;
    if (
      typeof project_id !== "string" ||
      !/^[a-z][a-z0-9-]{3,62}$/.test(project_id) ||
      typeof client_email !== "string" ||
      typeof private_key !== "string"
    )
      return null;
    createPrivateKey(private_key);
    return { project_id, client_email, private_key };
  } catch {
    return null;
  }
}

export interface FcmOptions {
  readonly serviceAccount: FcmServiceAccount;
  readonly fetch?: VendorFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_REFRESH_SKEW_SECONDS = 60;

export function createFcmTransport(opts: FcmOptions): OutOfBandTransport {
  const now = opts.now ?? (() => new Date());
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeout = opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs };
  let cached: { token: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    const iat = nowSeconds(now);
    if (cached && cached.expiresAt - TOKEN_REFRESH_SKEW_SECONDS > iat) return cached.token;
    const unsigned = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64u(
      JSON.stringify({
        iss: opts.serviceAccount.client_email,
        scope: FCM_SCOPE,
        aud: GOOGLE_TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    )}`;
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(opts.serviceAccount.private_key);
    const res = await postToVendor({
      vendor: "fcm_auth",
      url: GOOGLE_TOKEN_URL,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${b64u(signature)}`,
      }).toString(),
      fetch: doFetch,
      ...timeout,
    });
    const token = res.json?.access_token;
    const expiresIn = res.json?.expires_in;
    if (typeof token !== "string" || token === "")
      throw new TransportError("fcm_auth_no_token", false);
    cached = { token, expiresAt: iat + (typeof expiresIn === "number" ? expiresIn : 3600) };
    return token;
  }

  return {
    async send(request) {
      const destination = requireNative(request, "fcm");
      const bearer = await accessToken();
      try {
        const res = await postToVendor({
          vendor: "fcm",
          url: `https://fcm.googleapis.com/v1/projects/${opts.serviceAccount.project_id}/messages:send`,
          headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              token: destination.token,
              notification: { title: NATIVE_PUSH_TITLE, body: NATIVE_PUSH_BODY },
              data: { type: NATIVE_PUSH_TYPE, alertId: destination.alertId },
              android: { priority: "HIGH", ttl: `${NATIVE_TTL_SECONDS}s` },
            },
          }),
          fetch: doFetch,
          ...timeout,
        });
        const name = res.json?.name;
        return {
          vendorMessageId:
            typeof name === "string" ? name : `fcm:${request.notification.notificationDeliveryId}`,
          settlesOnAcceptance: true,
        };
      } catch (err) {
        // Only an explicit UNREGISTERED marks the token dead. A bare 404 is also a wrong/disabled project (a config fault that
        // must not expire every user's endpoint); a 401 means the cached access token was revoked, so drop it.
        if (err instanceof TransportError) {
          if (err.reason === "fcm_rejected:404:UNREGISTERED")
            throw new TransportError(PUSH_TOKEN_UNREGISTERED, false);
          if (err.reason.startsWith("fcm_rejected:401")) cached = undefined;
        }
        throw err;
      }
    },
  };
}

// ── APNs ───────────────────────────────────────────────────────────────────────────────────────────

export interface ApnsResponse {
  readonly status: number;
  readonly apnsId: string | undefined;
  readonly body: string;
}
/** One APNs request. Injectable so tests need no network; the default speaks HTTP/2 (APNs accepts nothing else). */
export type ApnsRequest = (input: {
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
}) => Promise<ApnsResponse>;

export interface ApnsOptions {
  /** PEM contents of the .p8 auth key. */
  readonly keyP8: string;
  readonly keyId: string;
  readonly teamId: string;
  /** The app's bundle id, sent as `apns-topic`. */
  readonly bundleId: string;
  readonly sandbox?: boolean;
  readonly request?: ApnsRequest;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

const APNS_HOST = "api.push.apple.com";
const APNS_SANDBOX_HOST = "api.sandbox.push.apple.com";
const APNS_JWT_TTL_SECONDS = 50 * 60; // Apple wants a fresh provider token between 20 and 60 minutes.
const APNS_DEFAULT_TIMEOUT_MS = 10_000;

// ponytail: one HTTP/2 session per send. Fine at alert volume; keep a pooled session per host if sends become hot.
const http2Request: ApnsRequest = ({ host, path, headers, body, timeoutMs }) =>
  new Promise<ApnsResponse>((resolve, reject) => {
    const session = http2.connect(`https://${host}`);
    const timer = setTimeout(
      () => finish(() => reject(new TransportError("apns_timeout", true))),
      timeoutMs,
    );
    function finish(settle: () => void): void {
      clearTimeout(timer);
      session.destroy();
      settle();
    }
    session.on("error", () => finish(() => reject(new TransportError("apns_unreachable", true))));
    const req = session.request({ ":method": "POST", ":path": path, ...headers });
    let status = 0;
    let apnsId: string | undefined;
    let text = "";
    req.setEncoding("utf8");
    req.on("response", (h) => {
      status = Number(h[":status"]);
      const id = h["apns-id"];
      apnsId = typeof id === "string" ? id : undefined;
    });
    req.on("data", (chunk: string) => {
      if (text.length < 1024) text += chunk;
    });
    req.on("end", () => finish(() => resolve({ status, apnsId, body: text })));
    req.on("error", () => finish(() => reject(new TransportError("apns_unreachable", true))));
    req.end(body);
  });

/** Apple's `reason` is a short fixed CamelCase vocabulary; anything else is dropped so no free text reaches a reason code. */
function apnsReason(body: string): string {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" && /^[A-Za-z]{1,40}$/.test(reason) ? reason : "";
  } catch {
    return "";
  }
}

export function createApnsTransport(opts: ApnsOptions): OutOfBandTransport {
  const key = createPrivateKey(opts.keyP8); // fail at construction: a bad key must stop the boot binding
  const now = opts.now ?? (() => new Date());
  const request = opts.request ?? http2Request;
  const host = opts.sandbox ? APNS_SANDBOX_HOST : APNS_HOST;
  let cached: { jwt: string; issuedAt: number } | undefined;

  function providerToken(): string {
    const iat = nowSeconds(now);
    if (cached && iat - cached.issuedAt < APNS_JWT_TTL_SECONDS) return cached.jwt;
    const unsigned = `${b64u(JSON.stringify({ alg: "ES256", kid: opts.keyId }))}.${b64u(
      JSON.stringify({ iss: opts.teamId, iat }),
    )}`;
    const signature = cryptoSign("sha256", Buffer.from(unsigned), {
      key,
      dsaEncoding: "ieee-p1363",
    });
    cached = { jwt: `${unsigned}.${b64u(signature)}`, issuedAt: iat };
    return cached.jwt;
  }

  return {
    async send(sendRequest) {
      const destination = requireNative(sendRequest, "apns");
      const res = await request({
        host,
        path: `/3/device/${destination.token}`,
        headers: {
          authorization: `bearer ${providerToken()}`,
          "apns-topic": opts.bundleId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(nowSeconds(now) + NATIVE_TTL_SECONDS),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          aps: { alert: { title: NATIVE_PUSH_TITLE, body: NATIVE_PUSH_BODY }, sound: "default" },
          type: NATIVE_PUSH_TYPE,
          alertId: destination.alertId,
        }),
        timeoutMs: opts.timeoutMs ?? APNS_DEFAULT_TIMEOUT_MS,
      });
      if (res.status === 200) {
        return {
          vendorMessageId: res.apnsId ?? `apns:${sendRequest.notification.notificationDeliveryId}`,
          settlesOnAcceptance: true,
        };
      }
      const reason = apnsReason(res.body);
      // BadDeviceToken is NOT dead-token evidence: Apple returns it for a sandbox/production mismatch, which would otherwise
      // expire every user's endpoint after one bad APNS_ENVIRONMENT.
      if (res.status === 410 || reason === "Unregistered")
        throw new TransportError(PUSH_TOKEN_UNREGISTERED, false);
      if (res.status === 429) throw new TransportError("apns_rate_limited", true);
      if (res.status >= 500) throw new TransportError(`apns_unavailable:${res.status}`, true);
      throw new TransportError(`apns_rejected:${res.status}${reason ? `:${reason}` : ""}`, false);
    },
  };
}

// ── router ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `push` channel's one transport. A native destination goes to its provider; anything else is a Web Push
 * subscription. A provider with no bound transport refuses terminally, exactly like the deny stub, so the delivery
 * settles `failed/transport_not_configured` rather than sitting `pending`.
 */
export function createPushRouter(transports: {
  readonly web: OutOfBandTransport;
  readonly fcm?: OutOfBandTransport;
  readonly apns?: OutOfBandTransport;
}): OutOfBandTransport {
  return {
    send(request) {
      const native = parseNativeDestination(request.destination);
      if (native === null) return transports.web.send(request);
      const transport = transports[native.provider];
      if (!transport) return Promise.reject(new TransportError(TRANSPORT_NOT_CONFIGURED, false));
      return transport.send(request);
    },
  };
}
