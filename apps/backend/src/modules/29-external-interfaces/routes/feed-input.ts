// apps/backend/src/modules/29-external-interfaces/routes/feed-input.ts — admin feed input policy (F-181, #248).
//
// Three server-side rules the create/update/activate routes apply BEFORE the store is touched:
//   1. `channelCertPin` has ONE canonical form (`../feed/cert-pin.ts`: sha256 of the certificate DER, lowercase
//      hex). The operator may instead paste the certificate PEM (`channelCertPem`) and the server derives the
//      pin — so nobody has to hash a file by hand and get a value the transport can never match.
//   2. A configured host on the destination deny list (link-local / cloud-metadata; loopback in production) is
//      refused at configuration time as well as at send time, so the mistake surfaces to the operator rather
//      than as a DLQ'd order later.
//   3. In production NO feed — outbound sender (F-181) or inbound listener (F-182) — may be `mllp_plain`
//      (cleartext PHI): refused on create AND on activate (a feed created before a deployment became production
//      must not be activatable). The inbound listener repeats the check at bind time (`listener/protocol-policy`).
import { ValidationError } from "@chartwarden/types";

import { CertPinError, certPinFromPem } from "../feed/cert-pin";
import { parseQuietWindows } from "../listener/quiet-window";
import {
  classifyHostname,
  isProductionEnv,
  resolveDestinationPolicy,
} from "../outbound/destination-policy";

type Env = Readonly<Record<string, string | undefined>>;

function refuse(field: string, code: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code, message }]);
}

/** Resolve the pin to store: PEM (derived) or the raw 64-hex pin; both present must agree. */
export function resolveCertPin(input: {
  readonly channelCertPin?: string;
  readonly channelCertPem?: string;
}): string | undefined {
  if (input.channelCertPem === undefined) return input.channelCertPin;
  let derived: string;
  try {
    derived = certPinFromPem(input.channelCertPem);
  } catch (err) {
    if (err instanceof CertPinError) {
      refuse(
        "channelCertPem",
        "CERT_PEM_INVALID",
        "must contain a valid X.509 certificate in PEM form",
      );
    }
    throw err;
  }
  if (input.channelCertPin !== undefined && input.channelCertPin.toLowerCase() !== derived) {
    refuse(
      "channelCertPin",
      "CERT_PIN_MISMATCH",
      "does not match the pin derived from channelCertPem — send only one, or make them agree",
    );
  }
  return derived;
}

export function assertHostAcceptable(host: string | undefined, env: Env): void {
  if (host === undefined) return;
  const refusal = classifyHostname(host, resolveDestinationPolicy(env));
  if (refusal !== null) {
    refuse("host", "DESTINATION_REFUSED", `is not an acceptable feed destination (${refusal})`);
  }
}

/** GAP-043 - reject quiet windows with an unknown zone, equal start/end or duplicate days at write time (re-read at watch time). */
export function assertQuietWindowsAcceptable(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  const parsed = parseQuietWindows(raw);
  if (!parsed.ok) refuse("expectedQuietWindows", "QUIET_WINDOW_INVALID", parsed.reason);
}

export function assertProtocolAcceptable(
  feed: { readonly kind: string; readonly protocol: string },
  env: Env,
): void {
  if (feed.protocol === "mllp_plain" && isProductionEnv(env)) {
    const direction = feed.kind === "orm_outbound" ? "an outbound" : "an inbound";
    refuse(
      "protocol",
      "PLAIN_MLLP_REFUSED",
      `mllp_plain (cleartext PHI) is not permitted for ${direction} feed in production — use mllp_tls`,
    );
  }
}
