// @chartwarden/billing — MAC-credential schemas: route #34 `GET /mac-credentials` (list, secrets masked),
// route #35 `POST /mac-credentials` (upsert — M34 wizard; step-up), route #36 `POST /mac-credentials/:id:test`
// (synthetic claim to MAC sandbox) — §4.1.
//
// The client secret is WRITE-ONLY: carried inbound only, encrypted at rest, redacted from audit
// value-capture (§3.6), and NEVER projected on read (only its presence + last-test status). Mirrors the
// `UpsertMacCredentialsDto` / `MacCredentialSummaryDto` contracts.
import { type Static, Type } from "@sinclair/typebox";
import { IfVersion, IsoDateTimeSchema, MacJurisdictionApi, Uuid } from "./common";

// ── route #35: upsert credentials ───────────────────────────────────────────────────────────────────────
export const MacCredentialUpsertRequest = Type.Object({
  providerEntityId: Uuid,
  macJurisdiction: MacJurisdictionApi,
  submitterId: Type.String({ minLength: 1, maxLength: 64 }),
  tradingPartnerId: Type.String({ minLength: 1, maxLength: 64 }),
  clientId: Type.String({ minLength: 1, maxLength: 256 }),
  /** Write-only: encrypted at rest, redacted from audit value-capture (§3.6). */
  clientSecret: Type.String({ minLength: 1, maxLength: 4096 }),
  baaRecordRef: Type.Optional(Type.String({ maxLength: 256 })),
  credentialExpiresAt: Type.Optional(IsoDateTimeSchema),
  /** Present on update (optimistic concurrency); absent on first insert. */
  ifVersion: Type.Optional(IfVersion),
});
export type MacCredentialUpsertRequest = Static<typeof MacCredentialUpsertRequest>;

/** The masked summary projection (the secret is NEVER present). */
export const MacCredentialSummaryView = Type.Object({
  credentialId: Uuid,
  providerEntityId: Uuid,
  macJurisdiction: MacJurisdictionApi,
  submitterId: Type.String(),
  tradingPartnerId: Type.String(),
  clientId: Type.String(),
  /** Presence only — never the secret. */
  hasSecret: Type.Boolean(),
  baaRecordRef: Type.Union([Type.String(), Type.Null()]),
  credentialExpiresAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  lastSandboxTestAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  version: Type.Integer(),
});
export type MacCredentialSummaryView = Static<typeof MacCredentialSummaryView>;

export const MacCredentialUpsertResponse = MacCredentialSummaryView;
export type MacCredentialUpsertResponse = Static<typeof MacCredentialUpsertResponse>;

// ── route #34: list per-PE credentials ──────────────────────────────────────────────────────────────────
export const MacCredentialListResponse = Type.Object({
  credentials: Type.Array(MacCredentialSummaryView),
});
export type MacCredentialListResponse = Static<typeof MacCredentialListResponse>;

// ── route #36: test against MAC sandbox ─────────────────────────────────────────────────────────────────
export const MacCredentialTestResponse = Type.Object({
  ok: Type.Boolean(),
  lastSandboxTestAt: IsoDateTimeSchema,
  errorMessage: Type.Optional(Type.String()),
});
export type MacCredentialTestResponse = Static<typeof MacCredentialTestResponse>;

// Errors (per §4.2 patterns):
//   412 STALE_VERSION       — If-Match / ifVersion mismatch on update
//   403 STEP_UP_REQUIRED    — M2 session profile not satisfied (upsert)
//   503 MAC_SANDBOX_UNREACHABLE — sandbox round-trip failed (test)
