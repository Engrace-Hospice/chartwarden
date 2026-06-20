// @wardenx/consent — the published `ConsentEvaluator` seam (§4.3, D11).
//
// M39-T05. The disclosure/redaction gate every PHI-egress module imports (M28 FHIR, M22 disclosure
// subsetter, M5 right-of-access, M27 cost report, M29 interop, M30/M33 aggregates) + the surface the
// eleven ABAC predicates resolve through. The rich interface lives HERE in the feature package (not
// the leaf @wardenx/types — `leaves-stay-leaves`, ARCHITECTURE §25.15); the M1 registry holds the
// instance opaquely (`SeamContracts["ConsentEvaluator"] = unknown`) and the module-39 typed accessor
// (apps/backend/src/modules/39-consent/seams.ts) re-applies the type at the boundary.
//
// The implementation composes the T04 engine (post-death scope, per-recipient activeness, validation
// rules) over an injectable `ConsentStore` port — pure + slice-safe (in-memory by default; the
// Drizzle-backed store + the synchronous consent_eval_audit write wire in T07/T09). Redaction flags
// are FAIL-CLOSED by construction (§4.3.1 / ADR-0014): a flag is `false` (disclose) only when an
// authoritative backing says so; SUD + family-violence are decided here, HIV/MH/genetic are delegated
// to M5's PrivacyFlag snapshot (read via PatientReader, wired T06) and default to redact.
import { type ConsentTypeKey, CONSENT_TYPE_STRUCTURE } from "../interfaces/kinds";
import { evaluatePostDeathScope } from "../validation/rules";
import { hasActiveRecipient } from "../lifecycle/recipient-machine";

/** The session classes a consent decision may be made under (M2 owns the canonical set; kept as a
 *  permissive union here so the leaf seam stays decoupled from M2's internals). */
export type ConsentSessionClass =
  | "staff"
  | "patient_portal"
  | "caregiver_portal"
  | "external_collaborator"
  | "auditor"
  | (string & {});

/** A caller module token, e.g. `"m28"` (FHIR Gateway), `"m22"`, `"m5"`. */
export type CallerModule = string;

/** The resolved recipient class on a disclosure path (subset of consent_recipient_kind). */
export type RecipientResolvedKind =
  | "external_physician"
  | "facility"
  | "pharmacy"
  | "irb"
  | "family_member"
  | "researcher";

/** The stable deny reasons (§4.3). */
export type ConsentDenyReason =
  | "no_active_consent_on_file"
  | "consent_expired"
  | "consent_revoked"
  | "consent_superseded_with_narrower_scope"
  | "no_active_recipient_matches"
  | "patient_deceased_consent_terminated"
  | "patient_aged_out_parental_consent"
  | "grantor_authority_expired"
  | "primary_dpoa_revoked"
  | "jurisdiction_mismatch"
  | "scope_does_not_cover_request";

export interface ConsentSessionContext {
  readonly sessionClass: ConsentSessionClass;
  readonly sessionId?: string;
  readonly membershipId?: string;
  readonly portalDelegateCaregiverId?: string;
  readonly recipientClientId?: string;
}

export interface ConsentEvaluator {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: ConsentTypeKey;
    asOf?: string;
    sessionContext: ConsentSessionContext;
    callerModule: CallerModule;
    callerRoute?: string;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number;
    expiresAt?: string;
    scopeDescriptor?: unknown;
    denyReason?: ConsentDenyReason;
  }>;

  evaluateForDisclosure(args: {
    organizationId: string;
    patientId: string;
    recipientClientId?: string;
    recipientResolvedKind?: RecipientResolvedKind;
    recipientResolvedId?: string;
    asOf?: string;
    callerModule: CallerModule;
    callerRoute?: string;
  }): Promise<{
    allowed: boolean;
    redactSudContent: boolean;
    redactHivContent: boolean;
    redactMentalHealthContent: boolean;
    redactGeneticContent: boolean;
    redactFamilyViolenceContent: boolean;
    expiresAt?: string;
    recipientScopeDescriptor?: unknown;
    denyReason?: ConsentDenyReason;
  }>;

  evaluateForIngressRedaction(args: {
    organizationId: string;
    patientId: string;
    asOf?: string;
    callerModule: CallerModule;
    callerRoute?: string;
  }): Promise<{
    redactSubstanceUseDisorderFields: boolean;
    redactHivFields: boolean;
    redactMentalHealthFields: boolean;
    redactGeneticFields: boolean;
    redactFamilyViolenceFields: boolean;
  }>;

  evaluateBulk(args: {
    organizationId: string;
    patientIds: readonly string[];
    consentType: ConsentTypeKey;
    asOf?: string;
    callerModule: CallerModule;
    callerRoute?: string;
    batchContext?: {
      recipientClientId: string;
      recipientResolvedKind?: RecipientResolvedKind;
      recipientResolvedId?: string;
      exportRequestId: string;
    };
  }): Promise<
    Map<string, { allowed: boolean; consentRecordId?: string; expiresAt?: string; denyReason?: ConsentDenyReason }>
  >;
}

// ── The injectable data port ──────────────────────────────────────────────────────────────

/** One active-or-historical consent record, as the store hands it to the evaluator. */
export interface StoredConsent {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly typeKey: ConsentTypeKey;
  readonly status: "draft" | "active" | "superseded" | "revoked" | "expired";
  readonly version: number;
  readonly effectiveAtMs: number;
  readonly expiresAtMs: number | null;
  readonly survivesDeath: boolean;
  readonly scopeDescriptor: unknown;
  readonly recipients: readonly StoredRecipient[];
}

export interface StoredRecipient {
  readonly recipientResolvedKind?: RecipientResolvedKind;
  readonly recipientResolvedId?: string;
  readonly recipientClientId?: string;
  readonly removedAtMs: number | null;
  readonly expiresAtMs: number | null;
}

/** The data the evaluator reads. The Drizzle-backed impl (T07/T09) implements this over the consent
 *  tables; the slice ships an in-memory version for boot + unit tests. */
export interface ConsentStore {
  /** Consent records of `typeKey` for the patient, as-of the instant (active or not — the evaluator
   *  applies status/expiry/post-death itself). */
  consentsFor(args: {
    organizationId: string;
    patientId: string;
    typeKey: ConsentTypeKey;
    asOfMs: number;
  }): Promise<readonly StoredConsent[]>;
  /** Whether the patient is deceased (drives the D13 post-death scope). M5 owns the truth; the
   *  Drizzle store reads it via PatientReader (T06). */
  isPatientDeceased(args: { organizationId: string; patientId: string }): Promise<boolean>;
}

// ── The evaluator over the store ────────────────────────────────────────────────────────────

function toMs(asOf?: string): number {
  if (!asOf) return Date.now();
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? Date.now() : t;
}

/** Pick the governing record: the highest-version `active` record effective at `asOfMs` and not
 *  expired. Returns the reason a record is unusable when none governs. */
function pickGoverning(
  records: readonly StoredConsent[],
  asOfMs: number,
): { record: StoredConsent } | { denyReason: ConsentDenyReason } {
  if (records.length === 0) return { denyReason: "no_active_consent_on_file" };
  const effective = records.filter((r) => r.effectiveAtMs <= asOfMs);
  if (effective.length === 0) return { denyReason: "no_active_consent_on_file" };
  const active = effective
    .filter((r) => r.status === "active" && (r.expiresAtMs === null || r.expiresAtMs > asOfMs))
    .sort((a, b) => b.version - a.version);
  if (active.length > 0) return { record: active[0]! };
  // Nothing active — surface the most informative reason from the newest effective record.
  const newest = [...effective].sort((a, b) => b.version - a.version)[0]!;
  if (newest.status === "revoked") return { denyReason: "consent_revoked" };
  if (newest.status === "expired" || (newest.expiresAtMs !== null && newest.expiresAtMs <= asOfMs))
    return { denyReason: "consent_expired" };
  return { denyReason: "no_active_consent_on_file" };
}

export function createConsentEvaluator(store: ConsentStore): ConsentEvaluator {
  async function evaluateOne(args: {
    organizationId: string;
    patientId: string;
    consentType: ConsentTypeKey;
    asOfMs: number;
  }): Promise<{
    allowed: boolean;
    consentRecordId?: string;
    consentVersionAtEval?: number;
    expiresAt?: string;
    scopeDescriptor?: unknown;
    denyReason?: ConsentDenyReason;
  }> {
    const records = await store.consentsFor({
      organizationId: args.organizationId,
      patientId: args.patientId,
      typeKey: args.consentType,
      asOfMs: args.asOfMs,
    });
    const governing = pickGoverning(records, args.asOfMs);
    if ("denyReason" in governing) return { allowed: false, denyReason: governing.denyReason };
    const record = governing.record;

    // D13 post-death scope.
    const deceased = await store.isPatientDeceased({
      organizationId: args.organizationId,
      patientId: args.patientId,
    });
    const death = evaluatePostDeathScope({
      typeKey: record.typeKey,
      survivesDeath: record.survivesDeath,
      patientDeceased: deceased,
    });
    if (!death.ok) return { allowed: false, denyReason: "patient_deceased_consent_terminated" };

    // Per-recipient types need at least one active recipient (§2.2.2).
    if (CONSENT_TYPE_STRUCTURE[record.typeKey].isPerRecipient) {
      const active = hasActiveRecipient(
        record.recipients.map((r) => ({ removedAtMs: r.removedAtMs, expiresAtMs: r.expiresAtMs })),
        args.asOfMs,
      );
      if (!active) return { allowed: false, denyReason: "no_active_recipient_matches" };
    }

    return {
      allowed: true,
      consentRecordId: record.id,
      consentVersionAtEval: record.version,
      expiresAt: record.expiresAtMs !== null ? new Date(record.expiresAtMs).toISOString() : undefined,
      scopeDescriptor: record.scopeDescriptor,
    };
  }

  /** A specific recipient is named & active on an active 42 CFR Part 2 release (the SUD backing). */
  async function sudDisclosurePermitted(args: {
    organizationId: string;
    patientId: string;
    asOfMs: number;
    recipientResolvedId?: string;
    recipientClientId?: string;
  }): Promise<boolean> {
    const records = await store.consentsFor({
      organizationId: args.organizationId,
      patientId: args.patientId,
      typeKey: "42_cfr_part_2_release",
      asOfMs: args.asOfMs,
    });
    const governing = pickGoverning(records, args.asOfMs);
    if ("denyReason" in governing) return false;
    return governing.record.recipients.some((r) => {
      if (r.removedAtMs !== null) return false;
      if (r.expiresAtMs !== null && r.expiresAtMs <= args.asOfMs) return false;
      if (args.recipientResolvedId && r.recipientResolvedId === args.recipientResolvedId) return true;
      if (args.recipientClientId && r.recipientClientId === args.recipientClientId) return true;
      return false;
    });
  }

  return {
    async evaluate(args) {
      return evaluateOne({
        organizationId: args.organizationId,
        patientId: args.patientId,
        consentType: args.consentType,
        asOfMs: toMs(args.asOf),
      });
    },

    async evaluateForDisclosure(args) {
      const asOfMs = toMs(args.asOf);
      const sudOk = await sudDisclosurePermitted({
        organizationId: args.organizationId,
        patientId: args.patientId,
        asOfMs,
        recipientResolvedId: args.recipientResolvedId,
        recipientClientId: args.recipientClientId,
      });
      // §4.3.1 / ADR-0014 fail-closed: only SUD (+ family-violence, M15 resolver — deny-stub here)
      // are M39-decided; HIV/MH/genetic are delegated to M5 PrivacyFlag (T06) → default redact.
      return {
        allowed: true, // a disclosure path returns flags, not a hard block; redaction enforces minimum-necessary
        redactSudContent: !sudOk,
        redactHivContent: true,
        redactMentalHealthContent: true,
        redactGeneticContent: true,
        redactFamilyViolenceContent: true,
      };
    },

    async evaluateForIngressRedaction(args) {
      const asOfMs = toMs(args.asOf);
      // No recipient on ingress — SUD redaction flips off only if ANY active Part 2 release exists
      // for the patient (the inbound frame is being persisted, not disclosed to a named recipient).
      const records = await store.consentsFor({
        organizationId: args.organizationId,
        patientId: args.patientId,
        typeKey: "42_cfr_part_2_release",
        asOfMs,
      });
      const hasPart2 = !("denyReason" in pickGoverning(records, asOfMs));
      return {
        redactSubstanceUseDisorderFields: !hasPart2,
        redactHivFields: true,
        redactMentalHealthFields: true,
        redactGeneticFields: true,
        redactFamilyViolenceFields: true,
      };
    },

    async evaluateBulk(args) {
      const asOfMs = toMs(args.asOf);
      const out = new Map<
        string,
        { allowed: boolean; consentRecordId?: string; expiresAt?: string; denyReason?: ConsentDenyReason }
      >();
      for (const patientId of args.patientIds) {
        const r = await evaluateOne({
          organizationId: args.organizationId,
          patientId,
          consentType: args.consentType,
          asOfMs,
        });
        out.set(patientId, {
          allowed: r.allowed,
          consentRecordId: r.consentRecordId,
          expiresAt: r.expiresAt,
          denyReason: r.denyReason,
        });
      }
      // M39-F15: a batch with a recipient context writes ONE eval-audit row (the audit write wires
      // in T09); per-resource correctness is preserved above. The slice records no audit yet.
      return out;
    },
  };
}

// ── In-memory store (boot slice + unit tests) ────────────────────────────────────────────────

export interface InMemoryConsentDataset {
  consents: StoredConsent[];
  deceasedPatientIds: Set<string>;
}

export function createInMemoryConsentStore(
  dataset: InMemoryConsentDataset = { consents: [], deceasedPatientIds: new Set() },
): { store: ConsentStore; dataset: InMemoryConsentDataset } {
  const store: ConsentStore = {
    async consentsFor({ organizationId, patientId, typeKey }) {
      return dataset.consents.filter(
        (c) => c.organizationId === organizationId && c.patientId === patientId && c.typeKey === typeKey,
      );
    },
    async isPatientDeceased({ patientId }) {
      return dataset.deceasedPatientIds.has(patientId);
    },
  };
  return { store, dataset };
}
