// apps/backend/src/modules/19-oncall/vendor/handoff.ts — M19-T07 (§7.5, §7.10, D13, §8.3.4).
//
// THE PHI BOUNDARY. Every byte M19 sends to an external triage vendor leaves through
// {@link handOffCallToVendor} and through nothing else. The path is fixed and each step refuses rather
// than degrades:
//
//   1. RESOLVE the adapter from `external_triage_vendor.adapter_key` (§8.5 registry). A miss is a refusal.
//   2. GATE the binding with `assertVendorBindingActive` — BAA on file, not expired, RN coverage attested,
//      profile supported (D13). Checked at every handoff, not only at binding creation, because a BAA
//      expires on a date nobody is watching at 02:00.
//   3. MINIMIZE with `minimizeForVendor`, which copies field by NAME (no spread anywhere).
//   4. ASSERT with `assertVendorPayloadMinimized` — both directions: no unpermitted KEY (a widened
//      projection) and no denylisted VALUE (a permitted key stuffed with an MRN).
//   5. TRANSMIT. Only now does an adapter see anything.
//
// WHY STEP 4 EXISTS WHEN STEP 3 IS TYPE-SAFE. §7.10's penetration-test criterion is about the BODY ON THE
// WIRE, and the type system stops caring the moment a value is `unknown` — an adapter that builds its own
// body, a future profile whose union gains a field, a well-meaning operator interpolating "Mary Chen, MRN
// 40182" into `firstName`. Step 3 is the compile-time guarantee §7.10 names; step 4 is the runtime one it
// also names ("a property-based fuzz test confirms that no combination of inputs produces a request body
// that includes denylisted fields"), and they catch different bugs.
//
// THE OPAQUE PATIENT REF IS PER (VENDOR, CALL), NOT PER PATIENT. `patientId` is a stable cross-tenant
// correlator a vendor could accumulate across engagements into a re-identification key; the handle here is
// an HMAC over (vendorId, triageCallId, patientId) under a per-org secret, so the same patient calling
// twice presents two different refs to the vendor and the same ref is stable within one call's lifetime
// (which is what a vendor's own call record needs). Without a configured secret the ref falls back to the
// TRIAGE CALL ID — which is opaque to the vendor, already scoped to this one call, and is NOT the patient
// id; the fallback narrows the vendor's correlation surface rather than widening it.
//
// M19 STORES NO VENDOR CREDENTIAL (ADR-0026). `external_triage_vendor` has no secret column by design; the
// per-(org, vendor) secrets come from the platform secret store through {@link VendorCredentialPort}, and
// an unbound port yields an empty secret map, which every real adapter will reject at its own auth step.
import { createHmac } from "node:crypto";
import {
  type ExternalTriageVendorAdapter,
  type TriageVendorBinding,
  type TriageVendorCredentials,
  type TriageVendorHandoffResult,
  type TriageVendorSourceContext,
  type VendorMinimizationProfile,
  type VendorOutboundPayload,
  assertVendorBindingActive,
  assertVendorPayloadMinimized,
  minimizeForVendor,
} from "@wardenx/triage-vendors";
import type { OrgId, TriageCallId } from "@wardenx/types";
import {
  type TriageVendorAdapterRegistry,
  TriageVendorAdapterUnavailableError,
  triageVendorAdapters,
} from "./registry";

/** The per-(org, vendor) secret map. Unbound ⇒ `{}` — see the module header. */
export interface VendorCredentialPort {
  secretsFor(input: {
    readonly organizationId: string;
    readonly adapterKey: string;
  }): Promise<Record<string, string>>;
}

/** The default port: no secrets. An adapter that needs one refuses at its own auth step, loudly. */
export const emptyVendorCredentialPort: VendorCredentialPort = {
  async secretsFor() {
    return {};
  },
};

/** What a handoff attempt is asked to do. */
export interface TriageVendorHandoffRequest {
  readonly organizationId: OrgId;
  readonly triageCallId: TriageCallId;
  readonly binding: TriageVendorBinding;
  /** The FULL internal context. Never transmitted — the minimizer's return value is (§7.10). */
  readonly source: TriageVendorSourceContext;
  /** ADR-0021 — the client/worker idempotency token the adapter forwards to the vendor. */
  readonly idempotencyKey: string;
  /** The instant the D13 BAA-expiry comparison is made against (injected, so the gate is deterministic). */
  readonly asOfIsoDate: string;
}

/** Deps the composition root binds. */
export interface TriageVendorHandoffDeps {
  readonly registry?: TriageVendorAdapterRegistry;
  readonly credentials?: VendorCredentialPort;
  /** Per-org HMAC secret for the opaque patient ref. Absent ⇒ the triage-call-id fallback. */
  readonly patientRefSecret?: (organizationId: string) => string | undefined;
}

/**
 * The §8.7.2 `triage.vendor_access` audit facts a completed (or refused) handoff yields.
 *
 * `patientFirstNameHash` is an HMAC, never cleartext — §8.7.2 says so verbatim, and an audit row that
 * carried the first name would put the one identifier the vendor DOES receive into a second store with a
 * different retention class.
 */
export interface TriageVendorAccessAudit {
  readonly vendorId: string;
  readonly adapterKey: string;
  readonly triageCallId: TriageCallId;
  readonly profile: VendorMinimizationProfile;
  readonly patientFirstNameHash: string;
  readonly outcome: "accepted" | "refused" | "transport_failure" | "not_attempted";
}

/** What a handoff attempt produced. */
export interface TriageVendorHandoffOutcome {
  readonly result: TriageVendorHandoffResult | null;
  /** The body that was transmitted, for the §7.10 test surface. `null` when nothing was sent. */
  readonly transmitted: VendorOutboundPayload | null;
  readonly audit: TriageVendorAccessAudit;
}

const hmac = (secret: string, value: string): string =>
  createHmac("sha256", secret).update(value).digest("hex");

/**
 * The per-(vendor, call) opaque handle the vendor sees instead of a patient id. See the module header for
 * why it is not the patient id and why the no-secret fallback is the CALL id.
 */
export function opaquePatientRefFor(input: {
  readonly vendorId: string;
  readonly triageCallId: string;
  readonly patientId: string;
  readonly secret?: string;
}): string {
  if (input.secret === undefined || input.secret.length === 0) return input.triageCallId;
  return hmac(input.secret, `${input.vendorId}:${input.triageCallId}:${input.patientId}`);
}

/**
 * §7.5 / §7.10 — hand a call to the tenant's configured external triage vendor.
 *
 * REFUSALS PROPAGATE. An unregistered adapter, an inactive binding and a minimization violation all THROW,
 * and the caller's contract is to keep the call in-agency. That is the opposite of the medication-context
 * read (M19-T05), which degrades to an `unavailable` VALUE — and the difference is which way the error
 * points: an unreadable medication list makes a clinician work blind but harms nobody else, while a
 * transmitted body that failed its minimization check IS the harm.
 *
 * A `transport_failure` from the adapter is NOT a throw: the vendor was reachable enough to be asked and
 * the §4.8 retry path owns it. `refused` is likewise a real answer — the vendor declining a call is
 * information the agency acts on, not an error to retry into.
 */
export async function handOffCallToVendor(
  request: TriageVendorHandoffRequest,
  deps: TriageVendorHandoffDeps = {},
): Promise<TriageVendorHandoffOutcome> {
  const registry = deps.registry ?? triageVendorAdapters;
  const credentialPort = deps.credentials ?? emptyVendorCredentialPort;
  const { binding, source } = request;

  const auditBase = {
    vendorId: binding.externalTriageVendorId,
    adapterKey: binding.adapterKey,
    triageCallId: request.triageCallId,
    profile: binding.minimizationProfile,
    patientFirstNameHash: hmac(binding.externalTriageVendorId, source.firstName),
  } as const;

  // 1 — resolve the adapter. A miss refuses; there is no default adapter (§8.5).
  const adapter: ExternalTriageVendorAdapter =
    registry.find(binding.adapterKey) ?? never(binding.adapterKey);

  // 2 — D13 binding gate, re-checked on EVERY handoff.
  assertVendorBindingActive(binding, adapter, request.asOfIsoDate);

  // 3 — minimize (field-by-name; no spread).
  const body = minimizeForVendor(
    binding.minimizationProfile,
    source,
    opaquePatientRefFor({
      vendorId: binding.externalTriageVendorId,
      triageCallId: request.triageCallId,
      patientId: source.patientId,
      secret: deps.patientRefSecret?.(request.organizationId),
    }),
  );

  // 4 — the runtime half of §7.10. Throws before any adapter sees the body.
  assertVendorPayloadMinimized(binding.minimizationProfile, source, body);

  // 5 — transmit.
  const credentials: TriageVendorCredentials = {
    organizationId: request.organizationId,
    adapterKey: binding.adapterKey,
    secrets: await credentialPort.secretsFor({
      organizationId: request.organizationId,
      adapterKey: binding.adapterKey,
    }),
  };
  const result = await adapter.handoffCall({
    body,
    idempotencyKey: request.idempotencyKey,
    credentials,
  });

  return { result, transmitted: body, audit: { ...auditBase, outcome: result.result } };
}

/** Narrowing helper — `registry.find` returning null is a refusal, not a nullable adapter. */
function never(adapterKey: string): never {
  throw new TriageVendorAdapterUnavailableError(adapterKey);
}

/**
 * The §3.3 `external_triage_vendor` row, projected onto the {@link TriageVendorBinding} the D13 gate reads.
 *
 * `default_minimization_policy` is `jsonb` and the gate needs a `VendorMinimizationProfile`; a row whose
 * policy names neither known profile is REFUSED rather than defaulted to `hybrid_phi_min`. Defaulting
 * would pick the NARROWER profile, which sounds safe and is not: the tenant configured something the
 * platform does not understand, and quietly transmitting a subset of an unknown contract is exactly the
 * misconfiguration §8.3.4 lists as the vendor disclosure threat.
 */
export function toVendorBinding(row: {
  readonly id: string;
  readonly adapterKey: string;
  readonly defaultMinimizationPolicy: unknown;
  readonly baaInEffect: boolean;
  readonly baaExpiresOn: Date | string | null;
  readonly rnCoverageAttested: boolean;
}): TriageVendorBinding {
  return {
    externalTriageVendorId: row.id,
    adapterKey: row.adapterKey,
    minimizationProfile: minimizationProfileOf(row.defaultMinimizationPolicy),
    baaInEffect: row.baaInEffect,
    baaExpiresOn:
      row.baaExpiresOn === null
        ? null
        : row.baaExpiresOn instanceof Date
          ? row.baaExpiresOn.toISOString().slice(0, 10)
          : String(row.baaExpiresOn).slice(0, 10),
    rnCoverageAttested: row.rnCoverageAttested,
  };
}

/** The known D13 profiles. A `jsonb` policy naming anything else is refused (see {@link toVendorBinding}). */
const KNOWN_PROFILES: readonly VendorMinimizationProfile[] = [
  "hybrid_phi_min",
  "centralized_phi_min",
];

/** Raised when a vendor row's `default_minimization_policy` names no known D13 profile. */
export class UnknownVendorMinimizationProfileError extends Error {
  readonly code = "TRIAGE_VENDOR_PROFILE_UNKNOWN";
  constructor(value: unknown) {
    super(
      `external_triage_vendor.default_minimization_policy names no known D13 profile (got ${JSON.stringify(value)})`,
    );
    this.name = "UnknownVendorMinimizationProfileError";
  }
}

function minimizationProfileOf(policy: unknown): VendorMinimizationProfile {
  const named =
    typeof policy === "string"
      ? policy
      : policy !== null && typeof policy === "object" && "profile" in policy
        ? (policy as { profile?: unknown }).profile
        : undefined;
  if (typeof named === "string" && (KNOWN_PROFILES as readonly string[]).includes(named)) {
    return named as VendorMinimizationProfile;
  }
  throw new UnknownVendorMinimizationProfileError(policy);
}
