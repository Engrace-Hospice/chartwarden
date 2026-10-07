// apps/backend/src/modules/29-external-interfaces/listener/credential-loader.ts — GAP-086. Loads + decrypts the ACTIVE
// `mllp_client_cert` credential of a feed into the `TlsCredentialMaterial` the §4.11.2 TLS listener binds with.
//
// THE BUNDLE. `external_feed_credential.secret_cipher` of kind `mllp_client_cert` seals, under the tenant DEK, a JSON
// document `{ "serverCertPem", "serverKeyPem", "expectedClientCaPem" }`: the certificate + private key WardenX presents
// on that feed's port and the per-feed pinned CA the partner's client certificate must chain to (D23). The mint route
// validates the bundle (`parseCredentialBundle`) BEFORE sealing, so a credential that cannot bind never lands.
//
// FAIL CLOSED. A row that is not a sealed envelope (the Phase-1 sha256 digest rows minted before a cipher was bound),
// an envelope that will not open (wrong org / tampered / DEK gone), or a bundle that fails validation are each a typed
// error — the supervisor treats a thrown `loadCredential` as "this feed cannot bind" and alerts; nothing falls back to
// plain TCP or to an unpinned listener.
import { X509Certificate, createPrivateKey } from "node:crypto";

import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, desc, eq } from "drizzle-orm";

import { type InboundCipher, isSealedEnvelope } from "../inbound/inbound-crypto";
import type { TlsCredentialMaterial } from "./index";
import type { SupervisorFeedDescriptor } from "./supervisor";

const CRED = schema.externalFeedCredential;
const SYSTEM_USER_ID = "";

export type CredentialLoadErrorCode =
  | "credential_missing"
  | "credential_not_sealed"
  | "credential_undecryptable"
  | "credential_bundle_invalid";

export class CredentialLoadError extends Error {
  constructor(
    readonly code: CredentialLoadErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CredentialLoadError";
  }
}

const BEGIN_CERT = /-----BEGIN CERTIFICATE-----/;

/**
 * Validate + parse a credential bundle (the JSON plaintext). Checks: all three PEMs present; the server certificate
 * parses and is in its validity window; the private key parses AND belongs to that certificate; the client CA parses.
 * Never echoes PEM content in an error.
 */
export function parseCredentialBundle(
  plaintext: string,
  at: Date = new Date(),
): TlsCredentialMaterial {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new CredentialLoadError("credential_bundle_invalid", "bundle is not JSON");
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const field = (name: string): string => {
    const v = obj[name];
    if (typeof v !== "string" || v.trim() === "") {
      throw new CredentialLoadError("credential_bundle_invalid", `${name} is required`);
    }
    return v;
  };
  const serverCertPem = field("serverCertPem");
  const serverKeyPem = field("serverKeyPem");
  const expectedClientCaPem = field("expectedClientCaPem");
  if (!BEGIN_CERT.test(serverCertPem) || !BEGIN_CERT.test(expectedClientCaPem)) {
    throw new CredentialLoadError("credential_bundle_invalid", "certificate PEM expected");
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(serverCertPem);
    new X509Certificate(expectedClientCaPem);
  } catch {
    throw new CredentialLoadError("credential_bundle_invalid", "certificate does not parse");
  }
  if (at < new Date(cert.validFrom) || at > new Date(cert.validTo)) {
    throw new CredentialLoadError(
      "credential_bundle_invalid",
      "server certificate is not in its validity window",
    );
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(serverKeyPem))) {
      throw new CredentialLoadError(
        "credential_bundle_invalid",
        "private key does not match the server certificate",
      );
    }
  } catch (err) {
    if (err instanceof CredentialLoadError) throw err;
    throw new CredentialLoadError("credential_bundle_invalid", "private key does not parse");
  }
  return { serverCertPem, serverKeyPem, expectedClientCaPem };
}

export interface CredentialLoaderDeps {
  readonly db: DbClient;
  readonly cipher: InboundCipher;
  readonly now?: () => Date;
}

/** `loadCredential` for `createTlsListenerRegistry`. */
export function createCredentialLoader(
  deps: CredentialLoaderDeps,
): (feed: SupervisorFeedDescriptor) => Promise<TlsCredentialMaterial> {
  const now = deps.now ?? (() => new Date());
  return async (feed) => {
    const rows = await withOrgContext(
      deps.db,
      { organizationId: feed.organizationId, userId: SYSTEM_USER_ID },
      (tx) =>
        (tx as DbClient)
          .select({ secretCipher: CRED.secretCipher })
          .from(CRED)
          .where(
            and(
              eq(CRED.organizationId, feed.organizationId),
              eq(CRED.feedId, feed.id),
              eq(CRED.kind, "mllp_client_cert"),
              eq(CRED.status, "active"),
            ),
          )
          .orderBy(desc(CRED.rotatedAt))
          .limit(1),
    );
    const row = rows[0];
    if (!row)
      throw new CredentialLoadError(
        "credential_missing",
        `feed ${feed.id} has no active mllp_client_cert`,
      );
    if (!isSealedEnvelope(row.secretCipher)) {
      throw new CredentialLoadError(
        "credential_not_sealed",
        `feed ${feed.id}'s credential predates the sealed-bundle format — re-mint it`,
      );
    }
    let plaintext: string;
    try {
      plaintext = await deps.cipher.decrypt(
        feed.organizationId,
        "external_feed_credential.secret",
        row.secretCipher,
      );
    } catch {
      throw new CredentialLoadError(
        "credential_undecryptable",
        `feed ${feed.id}'s credential did not open`,
      );
    }
    return parseCredentialBundle(plaintext, now());
  };
}
