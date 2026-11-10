// apps/backend/src/modules/12-dosespot/tenant-config/secret-cipher.ts — seals a tenant's DoseSpot clinic credential (the clinic
// key, and the Subscription-Key when the tenant has its own) in `dosespot_clinic_registration.secret_cipher`.
//
// SEALED UNDER THE M34 TENANT KEY RING (the same `TenantKeyProvider` the webhook-body cipher uses), so a tenant shred (key-ring
// destruction) makes the credential permanently unreadable, and the DEK version rides in `secret_dek_ref` for rotation. The
// bundle is ONE JSON envelope: AES-256-GCM, a fresh random 96-bit nonce, `v1.<nonce>.<tag>.<ciphertext>` (base64url).
//   AAD   m12:dosespot_clinic_registration:secret:v1 | organization | environment | clinic id. The envelope is bound to the row
//         it was sealed for: a ciphertext copied to another tenant, the other environment (a sandbox key read as production) or
//         another clinic fails authentication.
// Fail-closed: an envelope that does not open throws ONE generic error (never the key ring's message, never a node crypto
// message: neither is an oracle) and never yields an empty secret; plaintext is never put in an error, a log line or an audit row.
import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DoseSpotEnvironment } from "@chartwarden/dosespot";
import type { DoseSpotWebhookKeyProvider } from "../webhooks/body-crypto";

const VERSION = "v1";
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const UNREADABLE = "clinic secret cipher: ciphertext did not open";

/** What is sealed: the clinic key, and the Subscription-Key only when the tenant has its own (else the platform's applies). */
export interface ClinicSecretBundle {
  readonly clinicKey: string;
  readonly subscriptionKey?: string;
}

/** What a sealed secret is bound to besides the tenant. */
export interface ClinicSecretContext {
  readonly environment: DoseSpotEnvironment;
  readonly clinicId: string;
}

export interface ClinicSecretCipher {
  encrypt(
    organizationId: string,
    bundle: ClinicSecretBundle,
    context: ClinicSecretContext,
  ): Promise<{ readonly cipher: string; readonly dekRef: string }>;
  decrypt(
    organizationId: string,
    context: ClinicSecretContext,
    sealed: string,
    dekRef: string,
  ): Promise<ClinicSecretBundle>;
}

const aadFor = (organizationId: string, context: ClinicSecretContext): Buffer =>
  Buffer.from(
    [
      `m12:dosespot_clinic_registration:secret:${VERSION}`,
      organizationId.toLowerCase(),
      context.environment,
      context.clinicId,
    ].join("|"),
    "utf8",
  );

/** The bundle out of the opened plaintext; a payload of any other shape is unreadable, never a partial secret. */
function bundleOf(plaintext: string): ClinicSecretBundle {
  const parsed: unknown = JSON.parse(plaintext);
  const r = parsed as { clinicKey?: unknown; subscriptionKey?: unknown } | null;
  if (typeof r?.clinicKey !== "string" || r.clinicKey === "") throw new Error("shape");
  if (r.subscriptionKey !== undefined && typeof r.subscriptionKey !== "string") {
    throw new Error("shape");
  }
  return {
    clinicKey: r.clinicKey,
    ...(r.subscriptionKey ? { subscriptionKey: r.subscriptionKey } : {}),
  };
}

export function buildClinicSecretCipher(keys: DoseSpotWebhookKeyProvider): ClinicSecretCipher {
  return {
    async encrypt(organizationId, bundle, context) {
      const { version, key } = await keys.dekForOrg(organizationId);
      if (key.byteLength !== KEY_LEN) throw new Error(`tenant DEK must be ${KEY_LEN} bytes`);
      const nonce = randomBytes(NONCE_LEN);
      const c = createCipheriv("aes-256-gcm", key, nonce);
      c.setAAD(aadFor(organizationId, context));
      const ct = Buffer.concat([c.update(JSON.stringify(bundle), "utf8"), c.final()]);
      return {
        cipher: [
          VERSION,
          nonce.toString("base64url"),
          c.getAuthTag().toString("base64url"),
          ct.toString("base64url"),
        ].join("."),
        dekRef: version,
      };
    },
    async decrypt(organizationId, context, sealed, dekRef) {
      try {
        const [v, nonce, tag, ct] = sealed.split(".");
        if (v !== VERSION || !nonce || !tag || !ct) throw new Error("envelope");
        const { key } = keys.dekForOrgVersion
          ? await keys.dekForOrgVersion(organizationId, dekRef)
          : await keys.dekForOrg(organizationId);
        // `authTagLength` AND an explicit length check: Node accepts a truncated GCM tag unless told otherwise, which would leave a
        // 32-bit forgery surface to anyone who can write the row
        const tagBytes = Buffer.from(tag, "base64url");
        if (tagBytes.byteLength !== TAG_LEN) throw new Error("tag");
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"), {
          authTagLength: TAG_LEN,
        });
        d.setAAD(aadFor(organizationId, context));
        d.setAuthTag(tagBytes);
        return bundleOf(
          Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8"),
        );
      } catch {
        throw new Error(UNREADABLE); // one generic refusal: no cause is an oracle
      }
    },
  };
}
