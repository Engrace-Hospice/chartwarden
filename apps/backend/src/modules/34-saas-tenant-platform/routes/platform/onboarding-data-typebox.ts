// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-data-typebox.ts — request/response
// contracts for the platform onboarding-data routes (`/api/v1/platform/tenants/:orgSlug/{provider-entities,
// locations,mac-credentials}`). The create/patch bodies are the tenant routes' OWN published bodies (M2's
// `org-admin-typebox`, which M34 may import) plus the platform-only `reason`, so the two surfaces cannot drift;
// the views are re-exported unchanged. Named `*-typebox` so the table-ownership heuristic never reads it as a
// Drizzle import.
import { EXTERNAL_NOTICE_FILING_LIST_CAP, ValidationError } from "@chartwarden/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { TENANT_BAA_MAX_BYTES } from "../../../../bootstrap/onboarding-baa-document-port";
import {
  LocationDetailSchema,
  ProviderEntityDetailSchema,
  LocationCreateRequestSchema as TenantLocationCreateRequest,
  LocationPatchRequestSchema as TenantLocationPatchRequest,
  ProviderEntityCreateRequestSchema as TenantProviderEntityCreateRequest,
  ProviderEntityPatchRequestSchema as TenantProviderEntityPatchRequest,
} from "../../../02-identity/routes/org-admin-typebox";
import { assertNoPatientIdentifier } from "../../onboarding/evidence";

export { LocationDetailSchema, ProviderEntityDetailSchema };

const Nullable = <T extends TSchema>(s: T) => Type.Union([s, Type.Null()]);
const Iso = Type.String({ format: "date-time" });

/** The NORMALISED length is checked again in the route (`minLength` counts the spaces a whitespace-only reason is made of). */
export const ONBOARDING_REASON_MIN = 8;
export const ONBOARDING_REASON_MAX = 500;

/**
 * The reason as it is stored in the tenant-visible audit trail: whitespace runs (line breaks and tabs included) become
 * one space, control and format characters (`\p{C}`: NUL, zero-width, bidi overrides) are removed, and the ends are
 * trimmed. Whitespace is folded BEFORE the strip so "line one\nline two" never fuses into one word.
 */
export function normalizeReason(raw: string): string {
  // The reason is copied into the tenant-visible audit trail: it is no place for a patient, so it goes through the same
  // identifier screen as every other wizard free text, AS TYPED first (a control character between digits is a separator to the
  // screen; stripped first it would join them into an unbroken run, which the screen lets through on purpose) ...
  assertNoPatientIdentifier("reason", raw);
  const reason = raw
    .replace(/\s+/gu, " ")
    .replace(/\p{C}+/gu, "")
    .replace(/ {2,}/gu, " ")
    .trim();
  // ... and again AS STORED (a run of control characters longer than the screen's separator window hides nothing once stripped).
  assertNoPatientIdentifier("reason", reason);
  return reason;
}

/**
 * The body without its `reason`, plus the reason normalised and checked. `minLength` counts the spaces and invisible
 * characters a padded reason is made of, so the NORMALISED length is what is enforced: a reason of "abcd    " is a 422,
 * not an audit row, and what reaches the tenant-visible audit trail has no control or format characters in it.
 */
export function splitReason<B extends { reason: string }>(
  body: B,
): { reason: string; fields: Omit<B, "reason"> } {
  const { reason, ...fields } = body;
  const normalized = normalizeReason(reason);
  if (normalized.length < ONBOARDING_REASON_MIN || normalized.length > ONBOARDING_REASON_MAX) {
    throw new ValidationError("request validation failed", [
      {
        field: "reason",
        code: "INVALID",
        message: `reason must be ${ONBOARDING_REASON_MIN}-${ONBOARDING_REASON_MAX} characters after whitespace is collapsed and control characters are removed`,
      },
    ]);
  }
  return { reason: normalized, fields };
}

export const OnboardingReasonSchema = Type.Object({
  reason: Type.String({
    minLength: ONBOARDING_REASON_MIN,
    maxLength: ONBOARDING_REASON_MAX,
    description: `Why the operator is entering this on the tenant's behalf (${ONBOARDING_REASON_MIN}-${ONBOARDING_REASON_MAX} characters after whitespace is collapsed and control characters are removed; a ticket reference, no patient information). Recorded on the audit row beside the operator and the tenant.`,
  }),
});

/**
 * Verify a tenant's BAA: the platform's usual `reason`, plus an explicit acknowledgement that is required (409
 * CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED otherwise) when the tenant re-recorded the very document an operator revoked before.
 */
export const OnboardingBaaVerifyRequest = Type.Composite([
  OnboardingReasonSchema,
  Type.Object({
    acknowledgePreviousRevocation: Type.Optional(
      Type.Boolean({
        description:
          "Send true to verify a record whose document is the one a platform operator revoked before (the platform view's baa.previousRevocation.sameDocument says so). Without it the verify is refused with 409 CLEARINGHOUSE_BAA_PREVIOUSLY_REVOKED. The audit row records the supersession.",
      }),
    ),
  }),
]);

/** The closed reasons for revoking a BAA (M23's `BAA_REVOKE_REASON_CODES`, which M34 may not import; M23 re-validates). */
const BaaRevokeReasonCodeSchema = Type.Union([
  Type.Literal("vendor_terminated"),
  Type.Literal("account_closed"),
  Type.Literal("baa_expired"),
  Type.Literal("other"),
]);

/**
 * Revoke a tenant's vendor BAA. NO free text: a closed reason code and the ticket the operator acts under (a tenant-readable audit
 * row and a durable column copy these, so nothing a person types freely may reach them). There is no `reason` field on this route.
 */
export const OnboardingBaaRevokeRequest = Type.Object(
  {
    reasonCode: BaaRevokeReasonCodeSchema,
    ticketRef: Type.String({
      pattern: "^[A-Z][A-Z0-9]{1,9}-[0-9]{1,8}$",
      description:
        "The ticket the revoke was ordered under, such as SEC-42 (capital letters and digits, a dash, a number). Platform-only: the tenant's view never shows it, but the audit trail does.",
    }),
  },
  { additionalProperties: false },
);

export const OnboardingResourceParamsSchema = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
  id: Type.String({ format: "uuid" }),
});

export const OnboardingProviderEntityCreateRequest = Type.Composite([
  TenantProviderEntityCreateRequest,
  OnboardingReasonSchema,
]);
export const OnboardingProviderEntityPatchRequest = Type.Composite([
  TenantProviderEntityPatchRequest,
  OnboardingReasonSchema,
]);
export const OnboardingLocationCreateRequest = Type.Composite([
  TenantLocationCreateRequest,
  OnboardingReasonSchema,
]);
export const OnboardingLocationPatchRequest = Type.Composite([
  TenantLocationPatchRequest,
  OnboardingReasonSchema,
]);

/**
 * The identifier pattern of M23's `UpsertMacCredentialBodySchema` (billing-typebox.ts `MAC_IDENTIFIER_PATTERN`), copied because M34 may
 * not import M23; a test pins the two strings equal. A separator-formed SSN shape in an id is refused (422 EVIDENCE_LOOKS_LIKE_PHI).
 */
const MAC_IDENTIFIER_PATTERN = String.raw`^(?![\s\S]*(?<![0-9\uFF10-\uFF19])[0-9\uFF10-\uFF19]{3}[\s.\-\u2010-\u2015\u2212\uFF0D\uFF0E][0-9\uFF10-\uFF19]{2}[\s.\-\u2010-\u2015\u2212\uFF0D\uFF0E][0-9\uFF10-\uFF19]{4}(?![0-9\uFF10-\uFF19]))`;
const MAC_IDENTIFIER_NOTE =
  "The identifier the MAC issued. Never a social security number: a ###-##-#### shape (any separator) is refused with 422 EVIDENCE_LOOKS_LIKE_PHI, and the value is never echoed in the error; a plain digit string is accepted.";

/**
 * The MAC credential body is M23's (`UpsertMacCredentialBodySchema`, which M34 may not import); M23 re-validates it
 * with that schema, so this is the published copy. `clientSecret` is write-only.
 */
export const OnboardingMacCredentialUpsertRequest = Type.Composite([
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    macJurisdiction: Type.String({
      minLength: 1,
      maxLength: 32,
      description:
        "The MAC jurisdiction key the tenant's billing screen offers (e.g. noridian_jf, ngs_j6, cgs_j15); M23 refuses any other with a 422.",
    }),
    submitterId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: MAC_IDENTIFIER_PATTERN,
      description: MAC_IDENTIFIER_NOTE,
    }),
    tradingPartnerId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: MAC_IDENTIFIER_PATTERN,
      description: MAC_IDENTIFIER_NOTE,
    }),
    clientId: Type.String({
      minLength: 1,
      maxLength: 256,
      pattern: MAC_IDENTIFIER_PATTERN,
      description: MAC_IDENTIFIER_NOTE,
    }),
    clientSecret: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: "Write-only: sealed under the tenant's own key and never returned.",
    }),
    baaRecordRef: Type.Optional(
      Type.String({
        maxLength: 256,
        description:
          "Where the MAC BAA is kept (a title, folder or document id; 1-256 characters after whitespace is collapsed; omit it to leave it unset). Never patient information: a social-security-number or MBI shape is refused with 422 EVIDENCE_LOOKS_LIKE_PHI, and the value is never echoed in the error.",
      }),
    ),
    credentialExpiresAt: Type.Optional(Type.String({ format: "date-time" })),
  }),
  OnboardingReasonSchema,
]);

export const OnboardingMacCredentialViewSchema = Type.Object({
  credentialId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  macJurisdiction: Type.String(),
  submitterId: Type.String(),
  tradingPartnerId: Type.String(),
  clientId: Type.String(),
  hasSecret: Type.Boolean({ description: "The secret itself is never projected." }),
  baaRecordRef: Nullable(Type.String()),
  credentialExpiresAt: Nullable(Iso),
  lastSandboxTestAt: Type.Union([Iso, Type.Null()], {
    description:
      "When the MAC portal for this credential's jurisdiction last answered the portal check, or null if it has not. It does not validate the credential: the secret, client id and submitter id are not sent (the first real submission is the first time they are used).",
  }),
  version: Type.Integer(),
  createdAt: Iso,
  updatedAt: Iso,
});

/** One active member of the tenant, as the compliance officer picker needs it (no user id, no credential state). */
export const OnboardingMemberViewSchema = Type.Object({
  membershipId: Type.String({ format: "uuid" }),
  displayName: Nullable(Type.String()),
  email: Nullable(Type.String()),
  roleKeys: Type.Array(Type.String(), {
    description:
      "Enabled, unexpired roles the member holds in the tenant (compliance_officer first in a picker).",
  }),
});
export const OnboardingMemberListSchema = Type.Object({
  items: Type.Array(OnboardingMemberViewSchema),
  truncated: Type.Boolean({
    description:
      "True when the tenant has more active staff than the 500 returned (the first 500 by name, then id).",
  }),
});

export const OnboardingProviderEntityListSchema = Type.Object({
  items: Type.Array(ProviderEntityDetailSchema),
});
export const OnboardingLocationListSchema = Type.Object({
  items: Type.Array(LocationDetailSchema),
});
export const OnboardingMacCredentialListSchema = Type.Object({
  items: Type.Array(OnboardingMacCredentialViewSchema),
});

/**
 * The state Medicaid trading-partner credential body is M24's (`UpsertCredentialBody`, which M34 may not import);
 * M24 re-validates it with that schema (unknown keys refused). Secrets (`clientSecret`, `sftpKey`) are write-only;
 * an omitted secret leaves the stored one untouched.
 */
export const OnboardingMedicaidCredentialUpsertRequest = Type.Composite([
  Type.Object({
    providerEntityId: Type.String({ format: "uuid" }),
    serviceState: Type.String({ pattern: "^[A-Z]{2}$", description: "Two-letter state code." }),
    channel: Type.Union([
      Type.Literal("direct_mmis"),
      Type.Literal("cco_clearinghouse"),
      Type.Literal("sftp"),
      Type.Literal("portal"),
      Type.Literal("state_proprietary"),
    ]),
    mcoId: Type.Optional(Type.String({ format: "uuid" })),
    tradingPartnerId: Type.String({ minLength: 1, maxLength: 128 }),
    clientId: Type.Optional(Type.String({ maxLength: 256 })),
    clientSecret: Type.Optional(Type.String({ maxLength: 4096 })),
    sftpHost: Type.Optional(Type.String({ maxLength: 256 })),
    sftpUser: Type.Optional(Type.String({ maxLength: 256 })),
    sftpKey: Type.Optional(Type.String({ maxLength: 16384 })),
    portalUrl: Type.Optional(Type.String({ maxLength: 1024 })),
    activeFrom: Type.String({ format: "date" }),
    activeTo: Type.Optional(Type.String({ format: "date" })),
  }),
  OnboardingReasonSchema,
]);

export const OnboardingMedicaidCredentialIdSchema = Type.Object({ id: Type.String() });

export const OnboardingMedicaidCredentialViewSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  serviceState: Type.String(),
  channel: Type.String(),
  mcoId: Nullable(Type.String()),
  tradingPartnerId: Type.String(),
  clientId: Nullable(Type.String()),
  sftpHost: Nullable(Type.String()),
  portalUrl: Nullable(Type.String()),
  activeFrom: Type.String(),
  activeTo: Nullable(Type.String()),
  lastSandboxTestAt: Nullable(Iso),
  lastSandboxTestResult: Nullable(Type.String()),
  version: Type.Integer(),
  hasClientSecret: Type.Boolean({ description: "The secret itself is never projected." }),
  hasSftpKey: Type.Boolean({ description: "The key itself is never projected." }),
});

export const OnboardingMedicaidCredentialListSchema = Type.Object({
  items: Type.Array(OnboardingMedicaidCredentialViewSchema),
});

/**
 * The tenant's clearinghouse choice (ADR-0053 amendment 2026-11-06). The body is M23's (`PutClearinghouseBodySchema`, which
 * M34 may not import); M23 re-validates it with that schema (unknown keys refused). `secret` is write-only: sealed under the
 * tenant's own key and never returned.
 */
export const OnboardingClearinghousePutRequest = Type.Composite([
  Type.Object({
    vendor: Type.Union([Type.Literal("stedi"), Type.Literal("claimmd"), Type.Literal("outside")]),
    mode: Type.Optional(Type.Union([Type.Literal("test"), Type.Literal("production")])),
    secret: Type.Optional(
      Type.String({
        minLength: 8,
        maxLength: 512,
        description:
          "The vendor credential (the Stedi API key, or the Claim.MD account key). Write-only: sealed under the tenant's own key and never returned. Required with a first choice and whenever vendor or mode changes.",
      }),
    ),
    billingServiceMode: Type.Optional(
      Type.Union(
        [Type.Literal("none"), Type.Literal("billing_software"), Type.Literal("managed_billing")],
        {
          description:
            "The billing service mode the tenant's contract takes when it LEAVES `outside` for a vendor (a tenant that bills outside is on none, and only an operator may switch it). Required for exactly that switch while the tenant has a contract (422 BILLING_SERVICE_MODE_REQUIRED), set before the vendor and put back if the vendor change fails, dated like any mode change; `none` is the explicit choice to keep it. Refused (422 BILLING_SERVICE_MODE_NOT_APPLICABLE) on any other write.",
        },
      ),
    ),
  }),
  OnboardingReasonSchema,
]);

export const OnboardingClearinghouseVerifyRequest = Type.Composite([
  Type.Object({
    evidenceNote: Type.Optional(
      Type.String({
        maxLength: 2000,
        description:
          "Required where the vendor has no safe connection test (Stedi): what was checked and by whom (8-500 characters; no patient information).",
      }),
    ),
    confirmNoPatientInformation: Type.Optional(
      Type.Boolean({
        description:
          "Required, and must be true, with an evidence note: the operator confirms the note names no patient information.",
      }),
    ),
  }),
  OnboardingReasonSchema,
]);

const ClearinghouseOutcome = Type.Union([
  Type.Literal("ok"),
  Type.Literal("credential_rejected"),
  Type.Literal("unreachable"),
]);

export const OnboardingClearinghouseViewSchema = Type.Object({
  vendor: Nullable(
    Type.Union([
      Type.Literal("stedi"),
      Type.Literal("claimmd"),
      Type.Literal("outside"),
      Type.Literal("direct_mac"),
      Type.Literal("in_memory"),
    ]),
  ),
  mode: Nullable(Type.Union([Type.Literal("test"), Type.Literal("production")])),
  status: Nullable(
    Type.Union([Type.Literal("draft"), Type.Literal("verified"), Type.Literal("active")]),
  ),
  source: Type.Union([Type.Literal("tenant"), Type.Literal("platform_env"), Type.Literal("none")]),
  hasSecret: Type.Boolean({ description: "The credential itself is never projected." }),
  verifiableBy: Nullable(
    Type.Union([Type.Literal("connection_test"), Type.Literal("attestation")]),
  ),
  verification: Nullable(
    Type.Object({
      kind: Type.Union([Type.Literal("connection_test"), Type.Literal("attested")]),
      evidence: Nullable(Type.String()),
      verifiedAt: Iso,
    }),
  ),
  lastTest: Nullable(Type.Object({ outcome: ClearinghouseOutcome, at: Iso })),
  baaRequired: Type.Boolean({
    description:
      "True for a tenant-held vendor account: its BAA must be recorded by the tenant and verified by a platform operator before the config may go active.",
  }),
  baa: Nullable(
    Type.Object({
      heldBy: Type.Literal("tenant"),
      effectiveDate: Type.String({ format: "date" }),
      documentRef: Type.String(),
      recordedAt: Iso,
      verified: Nullable(Type.Object({ at: Iso })),
      revoked: Type.Boolean({
        description:
          "True once a platform operator revoked this record (the vendor ended the BAA): it cannot be verified again and the config cannot go active until the tenant records a new BAA, or leaves the vendor.",
      }),
      revokedAt: Nullable(Iso),
      revokedReasonCode: Nullable(BaaRevokeReasonCodeSchema),
      revokedTicketRef: Type.Optional(
        Type.String({
          description:
            "The ticket the revoke was ordered under. Carried on the platform lane's view only; the tenant's own view never has it (it is still on the tenant's audit trail).",
        }),
      ),
      previousRevocation: Type.Optional(
        Type.Object({
          at: Iso,
          sameDocument: Type.Boolean({
            description:
              "True when this record's document is the one that revoked BAA named: verifying it needs acknowledgePreviousRevocation.",
          }),
        }),
      ),
    }),
  ),
  activatedAt: Nullable(Iso),
  version: Nullable(Type.Integer()),
  updatedAt: Nullable(Iso),
});

/** The operator's READ of the choice: the masked view plus whether the tenant holds a contract (the server's answer, never inferred by a screen). */
export const OnboardingClearinghouseReadSchema = Type.Composite([
  OnboardingClearinghouseViewSchema,
  Type.Object({
    hasContract: Type.Boolean({
      description:
        "The tenant holds a pricing contract that is not canceled (live or paused). Moving a tenant that bills outside ChartWarden to a vendor then also takes a billing service mode (billingServiceMode on the write); without a contract it takes none.",
    }),
  }),
]);

/** The answer to the operator's write of the choice: the masked view, plus a flag when the billing mode could not be confirmed. */
export const OnboardingClearinghouseWriteSchema = Type.Composite([
  OnboardingClearinghouseViewSchema,
  Type.Object({
    billingModeConfirmed: Type.Optional(
      Type.Literal(false, {
        description:
          "Present (false) only when the vendor change committed but the billing service mode the write named could not be confirmed afterwards, even after one retry: the tenant has the vendor and its contract may not hold that mode. Read the contract and set the mode if it is not the one chosen.",
      }),
    ),
  }),
]);

export const OnboardingClearinghouseVerifyResponseSchema = Type.Object({
  config: OnboardingClearinghouseViewSchema,
  test: Nullable(Type.Object({ outcome: ClearinghouseOutcome })),
});

/** After the operator released a tenant's earlier clearinghouse credentials: how many (never which), and the config unchanged. */
export const OnboardingClearinghouseReleaseResponseSchema = Type.Object({
  released: Type.Integer({
    minimum: 0,
    description: "How many credentials the tenant held, other than its current one, were released.",
  }),
  config: OnboardingClearinghouseViewSchema,
});

/** The notice after an operator withdrew its external-filing record: ids, a state and dates only (no patient, no admission). */
export const OnboardingNoticeWithdrawalViewSchema = Type.Object({
  noticeKind: Type.Union([Type.Literal("noe"), Type.Literal("notr")]),
  noticeId: Type.String({ format: "uuid" }),
  state: Type.String({ description: "The notice's own state, unchanged by the withdrawal." }),
  windowTargetAt: Type.String({ format: "date" }),
  windowBreachedAt: Nullable(
    Type.String({
      format: "date",
      description:
        "The deadline watchdog's breach stamp is kept by a withdrawal; the stamp the withdrawn LATE record wrote itself is cleared with it (null here).",
    }),
  ),
  externalFiling: Type.Null({
    description: "The record is gone: the notice is back to its pre-record state.",
  }),
});

/** One notice the tenant recorded as filed outside ChartWarden: what an operator needs to find it and withdraw it (no patient, no admission, no control number). */
export const OnboardingNoticeFilingSchema = Type.Object({
  noticeKind: Type.Union([Type.Literal("noe"), Type.Literal("notr")]),
  noticeId: Type.String({ format: "uuid" }),
  state: Type.String({ description: "The notice's own state; a filing record never changes it." }),
  windowTargetAt: Type.String({ format: "date" }),
  windowBreachedAt: Nullable(
    Type.String({
      format: "date",
      description: "The breach stamp on the notice, whoever wrote it.",
    }),
  ),
  filedOn: Nullable(
    Type.String({ format: "date", description: "The date the tenant says it filed." }),
  ),
  recordedAt: Nullable(
    Type.String({
      format: "date-time",
      description:
        "When the tenant recorded it: the If-Match a withdrawal must carry (a record changed since is refused).",
    }),
  ),
  breachStampFromRecord: Type.Boolean({
    description:
      "True when this record wrote the breach stamp itself (a late filing): a withdrawal clears it. A stamp the deadline watchdog set stays either way.",
  }),
});
export const OnboardingNoticeFilingListSchema = Type.Object({
  items: Type.Array(OnboardingNoticeFilingSchema),
  truncated: Type.Boolean({
    description: `True when the tenant recorded more than the ${EXTERNAL_NOTICE_FILING_LIST_CAP} newest shown; older records exist that this list does not return.`,
  }),
});

/**
 * The upload cap: `TENANT_BAA_MAX_BYTES` of decoded bytes (10 MiB), base64-expanded 4/3 and padded. M22 enforces the real limit on the
 * decoded bytes; this bounds the text before it is parsed.
 */
const BAA_UPLOAD_MAX_BASE64_CHARS = Math.ceil(TENANT_BAA_MAX_BYTES / 3) * 4;
/** The route-level body limit: the base64 text plus the JSON envelope (`reason`, `mimeType`). */
export const BAA_UPLOAD_BODY_LIMIT_BYTES = BAA_UPLOAD_MAX_BASE64_CHARS + 64 * 1024;
const BAA_UPLOAD_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

/**
 * The signed BAA, uploaded by a platform operator for a tenant that is still onboarding: the bytes, their type and the reason. No
 * document kind, patient, title or retention class is accepted: the route files exactly one kind (`tenant_baa`).
 */
export const OnboardingBaaDocumentUploadRequest = Type.Object(
  {
    contentBase64: Type.String({
      minLength: 4,
      maxLength: BAA_UPLOAD_MAX_BASE64_CHARS,
      description:
        "The signed agreement, base64 (at most 10 MiB decoded). The server checks the size, the type allowlist, the magic bytes and, where one is bound, the malware scan; it recomputes the digest.",
    }),
    mimeType: Type.Union(BAA_UPLOAD_MIME_TYPES.map((m) => Type.Literal(m))),
    reason: OnboardingReasonSchema.properties.reason,
  },
  { additionalProperties: false },
);

/** The document as filed: its id (what the BAA register row links) and what the server verified about the bytes. */
export const OnboardingBaaDocumentViewSchema = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  mimeType: Type.String(),
  byteSize: Type.Integer({ description: "The server-computed size, never the client's claim." }),
  sha256Hex: Type.String({ description: "The server-computed SHA-256 (lower-case hex)." }),
});
