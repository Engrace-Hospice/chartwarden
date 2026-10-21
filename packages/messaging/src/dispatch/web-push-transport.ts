// @chartwarden/messaging — Web Push transport (M36 GAP-062, spec §4.4 / §4.7), RFC 8030 + RFC 8291 + RFC 8292.
//
// Implemented on node:crypto alone (no `web-push` dependency): VAPID (ES256 JWT) authorizes the sender to the
// push service, and the sanitized payload is encrypted for the browser with aes128gcm content coding. Web Push
// has no delivery callback, so the push service's `201 Created` IS the only delivery confirmation the channel offers
// and the row settles on acceptance (`settlesOnAcceptance: true`).
//
// DESTINATION is the verified push endpoint's value: the browser's `PushSubscription.toJSON()` serialized as
// `{"endpoint": "https://…", "keys": {"p256dh": "<b64url>", "auth": "<b64url>"}}`.
//
// The payload is the content-free {@link SanitizedNotification} (id, one generic line, deep link) — nothing a
// push service could read is PHI (§4.7), and it is additionally end-to-end encrypted to the subscription.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { renderOutOfBand } from "../notification/sanitize";
import { TransportError } from "./transports";
import type { OutOfBandTransport } from "./transports";
import { type VendorFetch, postToVendor } from "./vendor-http";

const RECORD_SIZE = 4096;
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const P256_PUBLIC_KEY_BYTES = 65;
const AUTH_SECRET_BYTES = 16;

export interface WebPushOptions {
  /** VAPID public key, base64url, 65-byte uncompressed P-256 point. */
  readonly vapidPublicKey: string;
  /** VAPID private key, base64url, 32-byte scalar. */
  readonly vapidPrivateKey: string;
  /** `mailto:` or `https:` contact for the push service operator (RFC 8292 `sub`). */
  readonly subject: string;
  readonly fetch?: VendorFetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");

interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly p256dh: Buffer;
  readonly auth: Buffer;
}

function parseSubscription(destination: string): PushSubscriptionLike {
  let raw: unknown;
  try {
    raw = JSON.parse(destination);
  } catch {
    throw new TransportError("push_destination_invalid", false);
  }
  const sub = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    throw new TransportError("push_destination_invalid", false);
  }
  if (!/^https:\/\//i.test(endpoint)) throw new TransportError("push_destination_invalid", false);
  const key = fromB64u(p256dh);
  const secret = fromB64u(auth);
  if (
    key.length !== P256_PUBLIC_KEY_BYTES ||
    key[0] !== 0x04 ||
    secret.length !== AUTH_SECRET_BYTES
  ) {
    throw new TransportError("push_destination_invalid", false);
  }
  return { endpoint, p256dh: key, auth: secret };
}

/** RFC 8291 §3: aes128gcm-encode `plaintext` for the subscription. Exported for the round-trip unit test. */
export function encryptWebPushPayload(
  plaintext: Buffer,
  subscription: { readonly p256dh: Buffer; readonly auth: Buffer },
  ephemeral?: { readonly ecdh: ReturnType<typeof createECDH>; readonly salt: Buffer },
): Buffer {
  const ecdh = ephemeral?.ecdh ?? createECDH("prime256v1");
  if (!ephemeral) ecdh.generateKeys();
  const salt = ephemeral?.salt ?? randomBytes(16);
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(subscription.p256dh);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    subscription.p256dh,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, subscription.auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12),
  );
  // A single record: plaintext followed by the 0x02 "last record" delimiter (RFC 8188 §2).
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function vapidKey(publicKey: string, privateKey: string) {
  const pub = fromB64u(publicKey);
  const raw = fromB64u(privateKey);
  // A P-256 scalar printed without its leading zero bytes (Node's ECDH does this) is still the same key.
  const d =
    raw.length > 0 && raw.length < 32 ? Buffer.concat([Buffer.alloc(32 - raw.length), raw]) : raw;
  if (pub.length !== P256_PUBLIC_KEY_BYTES || pub[0] !== 0x04 || d.length !== 32) {
    throw new Error("web push: VAPID key pair is malformed");
  }
  return createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(d),
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
  });
}

/** RFC 8292 `Authorization: vapid t=<jwt>, k=<public key>` for an endpoint's origin. */
export function buildVapidAuthorization(
  opts: Pick<WebPushOptions, "vapidPublicKey" | "vapidPrivateKey" | "subject">,
  endpoint: string,
  nowSeconds: number,
): string {
  const aud = new URL(endpoint).origin;
  const encode = (v: unknown) => b64u(Buffer.from(JSON.stringify(v)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud,
    exp: nowSeconds + VAPID_TTL_SECONDS,
    sub: opts.subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: vapidKey(opts.vapidPublicKey, opts.vapidPrivateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${opts.vapidPublicKey}`;
}

export function createWebPushTransport(opts: WebPushOptions): OutOfBandTransport {
  // Fail at construction, not on the first page: a malformed key pair must stop the boot binding.
  vapidKey(opts.vapidPublicKey, opts.vapidPrivateKey);
  const now = opts.now ?? (() => new Date());
  return {
    async send({ notification, destination }) {
      const subscription = parseSubscription(destination);
      const rendered = renderOutOfBand(notification, "push");
      const payload = Buffer.from(
        JSON.stringify({
          id: rendered.id,
          title: rendered.title,
          short: rendered.body,
          deepLink: rendered.link,
        }),
      );
      const res = await postToVendor({
        vendor: "webpush",
        url: subscription.endpoint,
        headers: {
          Authorization: buildVapidAuthorization(
            opts,
            subscription.endpoint,
            Math.floor(now().getTime() / 1000),
          ),
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: String(PUSH_TTL_SECONDS),
          Urgency: "high",
        },
        body: encryptWebPushPayload(payload, subscription),
        fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      });
      return {
        vendorMessageId: res.headers.get("location") ?? `webpush:${rendered.id}`,
        settlesOnAcceptance: true,
      };
    },
  };
}
