// apps/backend/src/modules/29-external-interfaces/feed/cert-pin.ts — the ONE canonical `channelCertPin`
// convention (F-178, #248).
//
// `external_feed.channel_cert_pin` used to be documented as "sha256(certPEM)" while the F-175 outbound
// transport computed sha256 of the peer certificate's DER bytes, and NOTHING minted the value — the admin
// routes took an opaque 64-hex string. A pin an operator hashed from a PEM file would therefore have failed
// every `mllp_tls` send as a "mismatch". PEM text is not byte-stable (line-wrap width, CRLF vs LF, trailing
// newline, header whitespace all vary by tool), so hashing it makes a useless pin. The canonical value is:
//
//     lowercase-hex( sha256( DER encoding of the leaf certificate ) )
//
// — the one encoding every TLS stack hands back identically (`getPeerCertificate().raw`). These helpers are
// pure: the transport uses `certPinFromDer` on the peer's raw bytes, and the admin routes use
// `normalizeCertPin` so an operator may paste either the 64-hex pin or the certificate PEM itself and the
// server derives the pin. Nothing here logs or returns certificate contents.
import { X509Certificate, createHash } from "node:crypto";

const HEX_PIN = /^[0-9a-f]{64}$/i;
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class CertPinError extends Error {
  constructor(readonly code: "cert_pin_pem_invalid" | "cert_pin_hex_invalid") {
    super(code);
    this.name = "CertPinError";
  }
}

/** sha256(DER) as lowercase hex. */
export function certPinFromDer(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

/** Parse the FIRST certificate in a PEM string to its DER bytes. Tolerates CRLF/LF, arbitrary line-wrap,
 *  surrounding text and extra whitespace inside the base64 body; refuses anything that is not a parseable
 *  X.509 certificate (so a private key or garbage can never become a "pin"). */
export function derFromPem(pem: string): Buffer {
  const match = PEM_BLOCK.exec(pem);
  if (!match) throw new CertPinError("cert_pin_pem_invalid");
  const body = (match[1] ?? "").replace(/\s+/g, "");
  if (body.length === 0 || !BASE64.test(body)) throw new CertPinError("cert_pin_pem_invalid");
  const der = Buffer.from(body, "base64");
  try {
    // Structural validation only — proves the bytes are a real certificate, never trusts it.
    new X509Certificate(der);
  } catch {
    throw new CertPinError("cert_pin_pem_invalid");
  }
  return der;
}

/** sha256(DER) hex of the first certificate in `pem`. Byte-stable across line-wrap / CRLF / whitespace. */
export function certPinFromPem(pem: string): string {
  return certPinFromDer(derFromPem(pem));
}

/** Admin-input normaliser: a raw 64-hex pin (case-insensitive) or a certificate PEM → the canonical
 *  lowercase-hex pin. */
export function normalizeCertPin(input: string): string {
  const trimmed = input.trim();
  if (HEX_PIN.test(trimmed)) return trimmed.toLowerCase();
  if (trimmed.includes("-----BEGIN")) return certPinFromPem(trimmed);
  throw new CertPinError("cert_pin_hex_invalid");
}
