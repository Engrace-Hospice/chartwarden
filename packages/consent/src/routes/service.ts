// @wardenx/consent — the ConsentRouteService (M39 §4.1 route backend).
//
// The injectable surface the M39 routes compose over. Originally a representative slice (create-draft
// → sign → revoke, the patient list, the catalog, the decision audit); now the full §4.1 inventory
// minus the three portal routes (#25–27), which cannot exist until a portal `session_class` does
// (the pgEnum carries staff | auditor | external_collaborator | funeral_home — M31 is unbuilt).
//
// Every regulatory decision delegates to the PURE machines/validators in ../lifecycle and
// ../validation — this service is the transactional shell that sequences them and owns nothing but
// wiring. In-memory here (slice + tests); the Drizzle-backed production impl (consent-store-db.ts)
// implements the same interface, so the route layer never changes.
import {
  CONSENT_TYPE_STRUCTURE,
  type ConsentCaptureMethod,
  type ConsentDpoaActivationCondition,
  type ConsentDpoaAgentKind,
  type ConsentDpoaScopeKind,
  type ConsentDpoaTermKind,
  type ConsentGrantorKind,
  type ConsentRecipientKind,
  type ConsentRenewalCycleStatus,
  type ConsentRevocationCascadeStatus,
  type ConsentStatus,
  type ConsentTypeKey,
} from "../interfaces/kinds";
import {
  CASCADE_MAX_ATTEMPTS,
  type CascadeProgress,
  nextCascadeStatus,
} from "../lifecycle/cascade-machine";
import { consentTerminatesOnDeath } from "../lifecycle/death";
import {
  removeRecipient as decideRemoveRecipient,
  recipientActive,
} from "../lifecycle/recipient-machine";
import { closeRenewalCycle } from "../lifecycle/renewal-machine";
import { nextConsentStatus } from "../lifecycle/status-machine";
import { type ConsentTypeFloor, type ConsentTypeOverlay, validateConsentOverlay } from "../overlay";
import {
  validateBereavementGrantor,
  validateDpoaAgents,
  validateRecipientFk,
  validateRenewal,
  validateRevocation,
  validateSupersession,
  validateSurvivesDeath,
} from "../validation/rules";

export interface ConsentRecordView {
  id: string;
  organizationId: string;
  patientId: string;
  typeKey: ConsentTypeKey;
  grantorKind: ConsentGrantorKind;
  captureMethod: ConsentCaptureMethod;
  scopeDescriptor: unknown;
  status: ConsentStatus;
  version: number;
  effectiveAt: string | null;
  expiresAt: string | null;
  signedAt: string | null;
  createdById: string;
  /** D1 append-only supersession chain — the row this one replaced. */
  supersedesConsentRecordId?: string | null;
  /** D13 renewal chain — distinct from supersession (the prior row is expired/revoked, not active). */
  renewedFromConsentRecordId?: string | null;
  /** D13 — only family_caregiver_access / media_release / research_participation may set this. */
  survivesDeath?: boolean;
}

export interface CreateConsentDraftInput {
  patientId: string;
  typeKey: ConsentTypeKey;
  grantorKind: ConsentGrantorKind;
  captureMethod: ConsentCaptureMethod;
  scopeDescriptor: unknown;
  createdById: string;
  survivesDeath?: boolean;
}

export interface RevokeConsentInput {
  actorIsStaff: boolean;
  revokedByKind:
    | "patient_self_via_portal"
    | "staff"
    | "dpoa_agent"
    | "court_order"
    | "platform_admin_break_glass";
  reasonText: string;
  evidenceDocumentId: string | null;
  revokedById: string;
}

export interface EvalAuditRow {
  id: string;
  organizationId: string;
  patientId: string;
  consentRecordId: string | null;
  typeKey: ConsentTypeKey;
  allowed: boolean;
  denyReason: string | null;
  callerModule: string;
  evaluatedAt: string; // ISO; the cursor key (with id as tiebreak)
}

export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

export class ConsentRouteError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition" | "validation",
    message: string,
  ) {
    super(message);
    this.name = "ConsentRouteError";
  }
}

/** Raise the pure machines' refusal as the service's typed error (409 vs 422 at the route). */
function refuse(d: { ok: false; code: string; message: string }): never {
  const validationCodes = new Set([
    "overlay_loosens_platform_floor",
    "revocation_reason_too_short",
    "revocation_evidence_required",
    "survives_death_not_eligible_for_type",
    "recipient_fk_kind_mismatch",
    "dpoa_primary_required",
    "dpoa_duplicate_agent_kind",
    "bereavement_grantor_invalid",
    "bereavement_patient_not_deceased",
    "supersedes_type_mismatch",
    "renewed_from_type_mismatch",
  ]);
  throw new ConsentRouteError(
    validationCodes.has(d.code) ? "validation" : "invalid_transition",
    d.message,
  );
}

/** A value the routes `await`: the in-memory slice returns it synchronously; the Drizzle-backed
 *  production impl (FB-T03, `consent-store-db.ts`) returns a Promise. Widening to this union lets the
 *  one route layer drive both backends without forcing the in-memory slice (+ its M39 acceptance
 *  tests, which read `.id`/`.status` synchronously) onto Promises. */
export type Awaitable<T> = T | Promise<T>;

/** Wrap every method's return type in {@link Awaitable} — the awaitable view of a service interface a
 *  Drizzle backend can implement while the in-memory slice still returns synchronously. */
export type AwaitableService<S> = {
  [K in keyof S]: S[K] extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : S[K];
};

export interface ConsentCatalogView {
  typeKey: ConsentTypeKey;
  displayNameEn: string;
  scopeDiscriminator: string;
  isPerRecipient: boolean;
}

// ── §4.1 view projections for the surface beyond the original slice ────────────────────────────

/** Route 11/12/13 — a named disclosure recipient on a per-recipient consent (D6). */
export interface ConsentRecipientView {
  id: string;
  organizationId: string;
  consentRecordId: string;
  recipientKind: ConsentRecipientKind;
  recipientEntityId: string | null;
  recipientDisplayName: string;
  purposeCode: string | null;
  expiresAt: string | null;
  addedAt: string;
  addedById: string;
  removedAt: string | null;
  removedReasonText: string | null;
  /** Derived through the pure `recipientActive` machine (not removed, not self-expired). */
  active: boolean;
}

/** Route 14/15/16/17 — a named DPOA agent on a per-named-agent consent (D5). */
export interface ConsentDpoaAgentView {
  id: string;
  organizationId: string;
  consentRecordId: string;
  patientId: string;
  agentKind: ConsentDpoaAgentKind;
  agentName: string;
  agentRelationship: string;
  scopeKind: ConsentDpoaScopeKind;
  activationCondition: ConsentDpoaActivationCondition;
  termKind: ConsentDpoaTermKind;
  termUntil: string | null;
  addedAt: string;
  addedById: string;
  removedAt: string | null;
  active: boolean;
}

/** Route 5 — the two ancestor chains a consent record carries (supersession D1, renewal D13). */
export interface ConsentVersionChainView {
  consentId: string;
  /** Oldest → newest ancestors reached through `supersedesConsentRecordId`. */
  supersedes: ConsentRecordView[];
  /** Oldest → newest ancestors reached through `renewedFromConsentRecordId`. */
  renewedFrom: ConsentRecordView[];
}

/** Route 19 — a renewal cycle opened by the reminder cadence (D8). */
export interface ConsentRenewalCycleView {
  id: string;
  organizationId: string;
  sourceConsentRecordId: string;
  patientId: string;
  status: ConsentRenewalCycleStatus;
  cycleStartedAt: string;
  nextActionDueAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  resolvedConsentRecordId: string | null;
  assignedToMembershipId: string | null;
}

/** Route 21 — the delegated-access projection a portal/caregiver session resolves against (D10). */
export interface DelegatedAccessView {
  id: string;
  organizationId: string;
  patientId: string;
  consentRecordId: string;
  consentRecordRecipientId: string | null;
  delegateUserId: string | null;
  delegateCaregiverId: string;
  scope: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  portalSessionClass: string;
  revokedAt: string | null;
  active: boolean;
}

/** Route 18 — an active consent inside the 90-day expiry window, with its countdown. */
export interface ExpiringConsentView extends ConsentRecordView {
  /** Whole days from `nowIso` to `expiresAt` (never negative — an elapsed row is not "expiring"). */
  daysUntilExpiry: number;
}

/** Route 28 — the M16-consumer verdict for each of a patient's consents at death (D13). */
export interface PostMortemEligibilityView {
  consentId: string;
  typeKey: ConsentTypeKey;
  status: ConsentStatus;
  survivesDeath: boolean;
  /** True when this consent TERMINATES at death (the inverse of "survives"). */
  terminatesOnDeath: boolean;
}

/** Route 2 — the published tenant overlay row (tighten-only, §7.6). */
export interface ConsentTypeOverlayView {
  id: string;
  organizationId: string;
  typeKey: ConsentTypeKey;
  tighterExpirationSeconds: number | null;
  tighterCaptureMethods: string[] | null;
  tighterReminderCadence: string[] | null;
  stateAddendumText: string | null;
  jurisdictionCodeRequired: boolean | null;
  publishedAt: string | null;
  publishedById: string | null;
}

/** Route 30 — the cascade sweep verdict after a retry (D7). */
export interface CascadeRetryView {
  consentRecordId: string;
  revocationId: string;
  status: ConsentRevocationCascadeStatus;
  attempts: number;
  /** Consumers that still owe an ACK after this sweep. */
  pendingConsumers: string[];
}

/** Route 24 — the re-render request receipt (the emit itself is the outbox's job). */
export interface ReRenderReceiptView {
  consentRecordId: string;
  requestedAt: string;
  requestedById: string;
  /** The event the outbox re-publishes so M22 re-renders the signed document. */
  eventType: "m39.consent.signed";
}

// ── §4.1 write inputs ──────────────────────────────────────────────────────────────────────────

export interface UpsertConsentOverlayInput {
  typeKey: ConsentTypeKey;
  tighterExpirationSeconds?: number | null;
  tighterCaptureMethods?: ConsentCaptureMethod[];
  tighterReminderCadence?: string[];
  stateAddendumText?: string | null;
  jurisdictionCodeRequired?: boolean;
  publishedById: string;
}

export interface UpdateConsentDraftInput {
  scopeDescriptor?: unknown;
  captureMethod?: ConsentCaptureMethod;
  grantorKind?: ConsentGrantorKind;
  survivesDeath?: boolean;
}

export interface SupersedeConsentInput {
  scopeDescriptor: unknown;
  captureMethod: ConsentCaptureMethod;
  grantorKind: ConsentGrantorKind;
  createdById: string;
  survivesDeath?: boolean;
}

export interface RenewConsentInput {
  scopeDescriptor: unknown;
  captureMethod: ConsentCaptureMethod;
  grantorKind: ConsentGrantorKind;
  createdById: string;
  expiresAt?: string | null;
}

export interface AddRecipientInput {
  recipientKind: ConsentRecipientKind;
  recipientEntityId: string | null;
  recipientFreeText: string | null;
  recipientDisplayName: string;
  purposeCode?: string | null;
  expiresAt?: string | null;
  addedById: string;
}

export interface RemoveRecipientInput {
  removedById: string;
  removedReasonText: string;
}

export interface AddDpoaAgentInput {
  agentKind: ConsentDpoaAgentKind;
  agentName: string;
  agentRelationship: string;
  agentContact: unknown;
  scopeKind: ConsentDpoaScopeKind;
  activationCondition: ConsentDpoaActivationCondition;
  termKind: ConsentDpoaTermKind;
  termUntil?: string | null;
  addedById: string;
}

export interface UpdateDpoaAgentInput {
  scopeKind?: ConsentDpoaScopeKind;
  activationCondition?: ConsentDpoaActivationCondition;
  termKind?: ConsentDpoaTermKind;
  termUntil?: string | null;
  removedById?: string;
  remove?: boolean;
}

export interface BereavementOutreachInput {
  patientId: string;
  grantorKind: ConsentGrantorKind;
  captureMethod: ConsentCaptureMethod;
  scopeDescriptor: unknown;
  createdById: string;
}

/** The SYNCHRONOUS consent route backend — the canonical method shapes. The in-memory slice (+ its
 *  M39 acceptance tests, which chain `.id`/`.status` synchronously) implements this directly. */
export interface SyncConsentRouteService {
  // ── catalog + overlay (routes 1–2) ──
  readCatalog(organizationId: string): ConsentCatalogView[];
  upsertTenantOverlay(
    organizationId: string,
    input: UpsertConsentOverlayInput,
    nowIso: string,
  ): ConsentTypeOverlayView;

  // ── record reads (routes 3–5) ──
  listConsentsForPatient(organizationId: string, patientId: string): ConsentRecordView[];
  getConsent(organizationId: string, consentId: string): ConsentRecordView | null;
  getVersionChain(organizationId: string, consentId: string): ConsentVersionChainView;

  // ── record lifecycle (routes 6–10, 20) ──
  createDraft(organizationId: string, input: CreateConsentDraftInput): ConsentRecordView;
  updateDraft(
    organizationId: string,
    consentId: string,
    input: UpdateConsentDraftInput,
  ): ConsentRecordView;
  signConsent(
    organizationId: string,
    consentId: string,
    signerId: string,
    nowIso: string,
  ): ConsentRecordView;
  supersedeConsent(
    organizationId: string,
    consentId: string,
    input: SupersedeConsentInput,
    nowIso: string,
  ): ConsentRecordView;
  revokeConsent(
    organizationId: string,
    consentId: string,
    input: RevokeConsentInput,
    nowIso: string,
  ): ConsentRecordView;
  renewConsent(
    organizationId: string,
    consentId: string,
    input: RenewConsentInput,
    nowIso: string,
  ): ConsentRecordView;

  // ── recipients (routes 11–13) ──
  listRecipients(organizationId: string, consentId: string, nowIso: string): ConsentRecipientView[];
  addRecipient(
    organizationId: string,
    consentId: string,
    input: AddRecipientInput,
    nowIso: string,
  ): ConsentRecipientView;
  removeRecipient(
    organizationId: string,
    consentId: string,
    recipientId: string,
    input: RemoveRecipientInput,
    nowIso: string,
  ): ConsentRecipientView;

  // ── DPOA agents (routes 14–17) ──
  listDpoaAgents(organizationId: string, consentId: string, nowIso: string): ConsentDpoaAgentView[];
  addDpoaAgent(
    organizationId: string,
    consentId: string,
    input: AddDpoaAgentInput,
    nowIso: string,
  ): ConsentDpoaAgentView;
  updateDpoaAgent(
    organizationId: string,
    consentId: string,
    agentId: string,
    input: UpdateDpoaAgentInput,
    nowIso: string,
  ): ConsentDpoaAgentView;
  activePrimaryDpoa(
    organizationId: string,
    patientId: string,
    nowIso: string,
  ): ConsentDpoaAgentView | null;

  // ── expiry + renewal cycles (routes 18–19) ──
  listExpiringConsents(
    organizationId: string,
    patientId: string,
    windowDays: number,
    nowIso: string,
    page: { cursor?: string; pageSize: number },
  ): CursorPage<ExpiringConsentView>;
  listRenewalCycles(organizationId: string, consentId: string): ConsentRenewalCycleView[];

  // ── delegated access (route 21) ──
  listDelegatedAccess(
    organizationId: string,
    patientId: string,
    nowIso: string,
  ): DelegatedAccessView[];

  // ── decision audit (routes 22–23) ──
  /** §4.12 cursor-paginated consent-decision audit, by consent or by patient. */
  listEvalAudit(
    organizationId: string,
    filter: { consentId?: string; patientId?: string },
    page: { cursor?: string; pageSize: number },
  ): CursorPage<EvalAuditRow>;

  // ── admin + post-mortem (routes 24, 28–30) ──
  requestDocumentReRender(
    organizationId: string,
    consentId: string,
    requestedById: string,
    nowIso: string,
  ): ReRenderReceiptView;
  listPostMortemEligible(organizationId: string, patientId: string): PostMortemEligibilityView[];
  createBereavementOutreachDraft(
    organizationId: string,
    input: BereavementOutreachInput,
  ): ConsentRecordView;
  retryRevocationCascade(
    organizationId: string,
    consentId: string,
    nowIso: string,
  ): CascadeRetryView;
}

/** What the routes consume: the awaitable view of {@link SyncConsentRouteService}. The in-memory slice
 *  (sync) is assignable to it (a `T` satisfies `T | Promise<T>`); the Drizzle-backed production impl
 *  (FB-T03) returns Promises. The one route layer `await`s either. */
export type ConsentRouteService = AwaitableService<SyncConsentRouteService>;

/** A revocation row + its cascade progress (the in-memory mirror of `consent_revocation`). */
export interface StoredRevocation {
  id: string;
  organizationId: string;
  consentRecordId: string;
  revokedAt: string;
  reasonText: string;
  cascadeStatus: ConsentRevocationCascadeStatus;
  /** consumer name → ACKed. */
  cascadeConsumers: Record<string, boolean>;
  attempts: number;
}

export interface InMemoryConsentRouteData {
  records: ConsentRecordView[];
  evalAudit: EvalAuditRow[];
  catalog: ConsentCatalogView[];
  recipients: ConsentRecipientView[];
  dpoaAgents: ConsentDpoaAgentView[];
  renewalCycles: ConsentRenewalCycleView[];
  delegatedAccess: DelegatedAccessView[];
  overlays: ConsentTypeOverlayView[];
  revocations: StoredRevocation[];
  /** Per-type platform floors the overlay validator tightens against (§7.6). */
  floors: Partial<Record<ConsentTypeKey, ConsentTypeFloor>>;
  /** Patients M5 has marked deceased (D14 — the bereavement-grantor precondition). */
  deceasedPatientIds: string[];
}

const DEFAULT_CATALOG: ConsentCatalogView[] = [
  {
    typeKey: "hipaa_release",
    displayNameEn: "HIPAA Authorization",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
  },
  {
    typeKey: "42_cfr_part_2_release",
    displayNameEn: "42 CFR Part 2 Release",
    scopeDiscriminator: "per_recipient",
    isPerRecipient: true,
  },
  {
    typeKey: "portal_access",
    displayNameEn: "Portal Access",
    scopeDiscriminator: "categorical",
    isPerRecipient: false,
  },
  {
    typeKey: "dpoa_healthcare",
    displayNameEn: "DPOA — Healthcare",
    scopeDiscriminator: "per_named_agent",
    isPerRecipient: false,
  },
];

/** The platform floor every type falls back to when the slice seeds none (§7.6 tighten-only). */
const DEFAULT_FLOOR: ConsentTypeFloor = {
  defaultExpirationSeconds: 365 * 24 * 3600,
  captureMethodFloor: [
    "electronic_portal_signature",
    "typed_signature_in_app",
    "uploaded_signed_pdf",
    "witnessed_verbal_documented",
    "notarized",
  ],
  reminderCadenceFloor: ["90_days", "30_days", "14_days", "7_days", "1_day"],
  jurisdictionCodeRequired: false,
};

/** The revocation-cascade consumers M39 fans out to (§2.2.3 D7) — the retry sweep re-dispatches
 *  whichever have not ACKed. */
export const CASCADE_CONSUMERS = ["m31_portal", "m36_messaging", "m28_fhir", "m22_documents"];

/** Encode/decode the opaque cursor (base64 of `sortKey|id`). Never an offset (§4.12). */
function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`, "utf8").toString("base64url");
}
function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
  try {
    const [sortKey, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!sortKey || !id) return null;
    return { sortKey, id };
  } catch {
    return null;
  }
}

let idSeq = 0;
function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq.toString(16).padStart(8, "0")}`;
}

const ms = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso));

// The in-memory service is typed `SyncConsentRouteService` (NOT the awaitable `ConsentRouteService`)
// so the existing M39 route/workflow acceptance tests read `service.createDraft(...).id`
// synchronously. The sync service is still structurally assignable to the awaitable
// `ConsentRouteService` the routes consume (a `T` satisfies `T | Promise<T>`).
export function createInMemoryConsentRouteService(data: Partial<InMemoryConsentRouteData> = {}): {
  service: SyncConsentRouteService;
  data: InMemoryConsentRouteData;
} {
  const store: InMemoryConsentRouteData = {
    records: data.records ?? [],
    evalAudit: data.evalAudit ?? [],
    catalog: data.catalog ?? DEFAULT_CATALOG,
    recipients: data.recipients ?? [],
    dpoaAgents: data.dpoaAgents ?? [],
    renewalCycles: data.renewalCycles ?? [],
    delegatedAccess: data.delegatedAccess ?? [],
    overlays: data.overlays ?? [],
    revocations: data.revocations ?? [],
    floors: data.floors ?? {},
    deceasedPatientIds: data.deceasedPatientIds ?? [],
  };

  const find = (organizationId: string, consentId: string): ConsentRecordView | null =>
    store.records.find((r) => r.organizationId === organizationId && r.id === consentId) ?? null;

  /** Resolve a consent or raise the 404 the route maps. */
  const mustFind = (organizationId: string, consentId: string): ConsentRecordView => {
    const record = find(organizationId, consentId);
    if (!record) throw new ConsentRouteError("not_found", "consent not found");
    return record;
  };

  const floorFor = (typeKey: ConsentTypeKey): ConsentTypeFloor =>
    store.floors[typeKey] ?? DEFAULT_FLOOR;

  const recipientView = (r: ConsentRecipientView, nowMs: number): ConsentRecipientView => ({
    ...r,
    active: recipientActive({
      removedAtMs: ms(r.removedAt),
      expiresAtMs: ms(r.expiresAt),
      nowMs,
    }),
  });

  const dpoaView = (a: ConsentDpoaAgentView, nowMs: number): ConsentDpoaAgentView => ({
    ...a,
    active: a.removedAt === null && (a.termUntil === null || Date.parse(a.termUntil) > nowMs),
  });

  const service: SyncConsentRouteService = {
    // ── 1. catalog ──
    readCatalog() {
      return [...store.catalog];
    },

    // ── 2. tenant overlay (tighten-only, §7.6) ──
    upsertTenantOverlay(organizationId, input, nowIso) {
      const overlay: ConsentTypeOverlay = {
        tighterExpirationSeconds: input.tighterExpirationSeconds,
        tighterCaptureMethods: input.tighterCaptureMethods,
        tighterReminderCadence:
          input.tighterReminderCadence as ConsentTypeOverlay["tighterReminderCadence"],
        jurisdictionCodeRequired: input.jurisdictionCodeRequired,
      };
      const v = validateConsentOverlay(floorFor(input.typeKey), overlay);
      if (!v.ok) refuse(v);

      const existing = store.overlays.find(
        (o) => o.organizationId === organizationId && o.typeKey === input.typeKey,
      );
      const row: ConsentTypeOverlayView = {
        id: existing?.id ?? newId("overlay"),
        organizationId,
        typeKey: input.typeKey,
        tighterExpirationSeconds: input.tighterExpirationSeconds ?? null,
        tighterCaptureMethods: input.tighterCaptureMethods ?? null,
        tighterReminderCadence: input.tighterReminderCadence ?? null,
        stateAddendumText: input.stateAddendumText ?? null,
        jurisdictionCodeRequired: input.jurisdictionCodeRequired ?? null,
        publishedAt: nowIso,
        publishedById: input.publishedById,
      };
      if (existing) Object.assign(existing, row);
      else store.overlays.push(row);
      return row;
    },

    // ── 3. patient's active consents ──
    listConsentsForPatient(organizationId, patientId) {
      return store.records.filter(
        (r) =>
          r.organizationId === organizationId && r.patientId === patientId && r.status === "active",
      );
    },

    // ── 4. single record ──
    getConsent(organizationId, consentId) {
      return find(organizationId, consentId);
    },

    // ── 5. version chain (both ancestor chains, oldest → newest) ──
    getVersionChain(organizationId, consentId) {
      const head = mustFind(organizationId, consentId);
      const walk = (startId: string | null | undefined, edge: keyof ConsentRecordView) => {
        const chain: ConsentRecordView[] = [];
        const seen = new Set<string>([head.id]);
        let cursor = startId ?? null;
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          const prior = find(organizationId, cursor);
          if (!prior) break;
          chain.push(prior);
          cursor = (prior[edge] as string | null | undefined) ?? null;
        }
        return chain.reverse(); // oldest first
      };
      return {
        consentId: head.id,
        supersedes: walk(head.supersedesConsentRecordId, "supersedesConsentRecordId"),
        renewedFrom: walk(head.renewedFromConsentRecordId, "renewedFromConsentRecordId"),
      };
    },

    // ── 6. create draft ──
    createDraft(organizationId, input) {
      const sd = validateSurvivesDeath(input.typeKey, input.survivesDeath ?? false);
      if (!sd.ok) refuse(sd);
      const record: ConsentRecordView = {
        id: newId("consent"),
        organizationId,
        patientId: input.patientId,
        typeKey: input.typeKey,
        grantorKind: input.grantorKind,
        captureMethod: input.captureMethod,
        scopeDescriptor: input.scopeDescriptor,
        status: "draft",
        version: 0,
        effectiveAt: null,
        expiresAt: null,
        signedAt: null,
        createdById: input.createdById,
        supersedesConsentRecordId: null,
        renewedFromConsentRecordId: null,
        survivesDeath: input.survivesDeath ?? false,
      };
      store.records.push(record);
      return record;
    },

    // ── 7. patch a DRAFT (only `status='draft'` is editable — D1 append-only) ──
    updateDraft(organizationId, consentId, input) {
      const record = mustFind(organizationId, consentId);
      if (record.status !== "draft")
        throw new ConsentRouteError(
          "invalid_transition",
          "only a draft consent is editable (D1: an edit to a signed consent is a supersession)",
        );
      if (input.survivesDeath !== undefined) {
        const sd = validateSurvivesDeath(record.typeKey, input.survivesDeath);
        if (!sd.ok) refuse(sd);
        record.survivesDeath = input.survivesDeath;
      }
      if (input.scopeDescriptor !== undefined) record.scopeDescriptor = input.scopeDescriptor;
      if (input.captureMethod !== undefined) record.captureMethod = input.captureMethod;
      if (input.grantorKind !== undefined) record.grantorKind = input.grantorKind;
      return record;
    },

    // ── 8. sign ──
    signConsent(organizationId, consentId, signerId, nowIso) {
      const record = mustFind(organizationId, consentId);
      const t = nextConsentStatus(record.status, "sign");
      if (!t.ok) refuse(t);
      // A per-named-agent consent cannot go active without a valid agent roster (D5).
      if (CONSENT_TYPE_STRUCTURE[record.typeKey].isPerNamedAgent) {
        const nowMs = Date.parse(nowIso);
        const kinds = store.dpoaAgents
          .filter((a) => a.consentRecordId === record.id)
          .map((a) => dpoaView(a, nowMs))
          .filter((a) => a.active)
          .map((a) => a.agentKind);
        const d = validateDpoaAgents(kinds);
        if (!d.ok) refuse(d);
      }
      record.status = "active";
      record.effectiveAt = nowIso;
      record.signedAt = nowIso;
      void signerId;
      return record;
    },

    // ── 9. supersede (D1: a new row points at this one; the prior goes `superseded`) ──
    supersedeConsent(organizationId, consentId, input, nowIso) {
      const prior = mustFind(organizationId, consentId);
      const v = validateSupersession({
        prior: {
          typeKey: prior.typeKey,
          patientId: prior.patientId,
          organizationId: prior.organizationId,
          status: prior.status,
        },
        next: {
          typeKey: prior.typeKey,
          patientId: prior.patientId,
          organizationId,
        },
      });
      if (!v.ok) refuse(v);
      const t = nextConsentStatus(prior.status, "supersede");
      if (!t.ok) refuse(t);
      const sd = validateSurvivesDeath(prior.typeKey, input.survivesDeath ?? false);
      if (!sd.ok) refuse(sd);

      const next: ConsentRecordView = {
        id: newId("consent"),
        organizationId,
        patientId: prior.patientId,
        typeKey: prior.typeKey,
        grantorKind: input.grantorKind,
        captureMethod: input.captureMethod,
        scopeDescriptor: input.scopeDescriptor,
        status: "active",
        version: prior.version + 1,
        effectiveAt: nowIso,
        expiresAt: prior.expiresAt,
        signedAt: nowIso,
        createdById: input.createdById,
        supersedesConsentRecordId: prior.id,
        renewedFromConsentRecordId: null,
        survivesDeath: input.survivesDeath ?? false,
      };
      prior.status = "superseded";
      store.records.push(next);
      return next;
    },

    // ── 10. revoke ──
    revokeConsent(organizationId, consentId, input, nowIso) {
      const record = mustFind(organizationId, consentId);
      const v = validateRevocation({
        actorIsStaff: input.actorIsStaff,
        reasonText: input.reasonText,
        evidenceDocumentId: input.evidenceDocumentId,
      });
      if (!v.ok) refuse(v);
      const t = nextConsentStatus(record.status, "revoke");
      if (!t.ok) refuse(t);
      record.status = "revoked";
      // Open the §2.2.3 cascade so the retry route (30) has progress to sweep.
      store.revocations.push({
        id: newId("revocation"),
        organizationId,
        consentRecordId: record.id,
        revokedAt: nowIso,
        reasonText: input.reasonText,
        cascadeStatus: "pending",
        cascadeConsumers: Object.fromEntries(CASCADE_CONSUMERS.map((c) => [c, false])),
        attempts: 0,
      });
      // A revocation closes any open renewal cycle on the record (D8).
      for (const cycle of store.renewalCycles) {
        if (cycle.sourceConsentRecordId !== record.id || cycle.status !== "open") continue;
        const closed = closeRenewalCycle(cycle.status, "revoked");
        if (closed.ok) {
          cycle.status = closed.value;
          cycle.closedAt = nowIso;
          cycle.closedReason = "revoked";
        }
      }
      return record;
    },

    // ── 20. renew (D13: the prior row is expired/revoked, NOT active — a distinct chain) ──
    renewConsent(organizationId, consentId, input, nowIso) {
      const prior = mustFind(organizationId, consentId);
      const v = validateRenewal({
        prior: { typeKey: prior.typeKey, patientId: prior.patientId, status: prior.status },
        next: { typeKey: prior.typeKey, patientId: prior.patientId },
      });
      if (!v.ok) refuse(v);

      const next: ConsentRecordView = {
        id: newId("consent"),
        organizationId,
        patientId: prior.patientId,
        typeKey: prior.typeKey,
        grantorKind: input.grantorKind,
        captureMethod: input.captureMethod,
        scopeDescriptor: input.scopeDescriptor,
        status: "active",
        version: prior.version + 1,
        effectiveAt: nowIso,
        expiresAt: input.expiresAt ?? null,
        signedAt: nowIso,
        createdById: input.createdById,
        supersedesConsentRecordId: null,
        renewedFromConsentRecordId: prior.id,
        survivesDeath: prior.survivesDeath ?? false,
      };
      store.records.push(next);
      // Close the open renewal cycle as `renewed`, resolving it to the new row (D8).
      for (const cycle of store.renewalCycles) {
        if (cycle.sourceConsentRecordId !== prior.id || cycle.status !== "open") continue;
        const closed = closeRenewalCycle(cycle.status, "renewed");
        if (closed.ok) {
          cycle.status = closed.value;
          cycle.closedAt = nowIso;
          cycle.closedReason = "renewed";
          cycle.resolvedConsentRecordId = next.id;
        }
      }
      return next;
    },

    // ── 11. recipients ──
    listRecipients(organizationId, consentId, nowIso) {
      mustFind(organizationId, consentId);
      const nowMs = Date.parse(nowIso);
      return store.recipients
        .filter((r) => r.organizationId === organizationId && r.consentRecordId === consentId)
        .map((r) => recipientView(r, nowMs));
    },

    // ── 12. add recipient ──
    addRecipient(organizationId, consentId, input, nowIso) {
      const record = mustFind(organizationId, consentId);
      if (!CONSENT_TYPE_STRUCTURE[record.typeKey].isPerRecipient)
        throw new ConsentRouteError(
          "validation",
          `consent type '${record.typeKey}' does not enumerate named recipients (D6)`,
        );
      const fk = validateRecipientFk({
        kind: input.recipientKind,
        entityId: input.recipientEntityId,
        freeText: input.recipientFreeText,
      });
      if (!fk.ok) refuse(fk);

      const row: ConsentRecipientView = {
        id: newId("recipient"),
        organizationId,
        consentRecordId: consentId,
        recipientKind: input.recipientKind,
        recipientEntityId: input.recipientEntityId,
        recipientDisplayName: input.recipientDisplayName,
        purposeCode: input.purposeCode ?? null,
        expiresAt: input.expiresAt ?? null,
        addedAt: nowIso,
        addedById: input.addedById,
        removedAt: null,
        removedReasonText: null,
        active: true,
      };
      store.recipients.push(row);
      return recipientView(row, Date.parse(nowIso));
    },

    // ── 13. remove recipient (flips removed_at; the row is never deleted) ──
    removeRecipient(organizationId, consentId, recipientId, input, nowIso) {
      mustFind(organizationId, consentId);
      const row = store.recipients.find(
        (r) =>
          r.organizationId === organizationId &&
          r.consentRecordId === consentId &&
          r.id === recipientId,
      );
      if (!row) throw new ConsentRouteError("not_found", "recipient not found");
      const d = decideRemoveRecipient(ms(row.removedAt));
      if (!d.ok) refuse(d);
      row.removedAt = nowIso;
      row.removedReasonText = input.removedReasonText;
      void input.removedById;
      return recipientView(row, Date.parse(nowIso));
    },

    // ── 14. DPOA agents ──
    listDpoaAgents(organizationId, consentId, nowIso) {
      mustFind(organizationId, consentId);
      const nowMs = Date.parse(nowIso);
      return store.dpoaAgents
        .filter((a) => a.organizationId === organizationId && a.consentRecordId === consentId)
        .map((a) => dpoaView(a, nowMs));
    },

    // ── 15. add DPOA agent ──
    addDpoaAgent(organizationId, consentId, input, nowIso) {
      const record = mustFind(organizationId, consentId);
      if (!CONSENT_TYPE_STRUCTURE[record.typeKey].isPerNamedAgent)
        throw new ConsentRouteError(
          "validation",
          `consent type '${record.typeKey}' does not enumerate named agents (D5)`,
        );
      const nowMs = Date.parse(nowIso);
      const activeKinds = store.dpoaAgents
        .filter((a) => a.consentRecordId === consentId)
        .map((a) => dpoaView(a, nowMs))
        .filter((a) => a.active)
        .map((a) => a.agentKind);
      // The roster INCLUDING the proposed agent must satisfy the D5 ≤1-per-kind rule. A duplicate
      // kind is refused here rather than at the partial-unique index.
      if (activeKinds.includes(input.agentKind))
        throw new ConsentRouteError(
          "validation",
          `an active ${input.agentKind} agent already exists on this consent (D5)`,
        );

      const row: ConsentDpoaAgentView = {
        id: newId("dpoa"),
        organizationId,
        consentRecordId: consentId,
        patientId: record.patientId,
        agentKind: input.agentKind,
        agentName: input.agentName,
        agentRelationship: input.agentRelationship,
        scopeKind: input.scopeKind,
        activationCondition: input.activationCondition,
        termKind: input.termKind,
        termUntil: input.termUntil ?? null,
        addedAt: nowIso,
        addedById: input.addedById,
        removedAt: null,
        active: true,
      };
      store.dpoaAgents.push(row);
      return dpoaView(row, nowMs);
    },

    // ── 16. mutate a DPOA agent's scope / term / activation (or remove it) ──
    updateDpoaAgent(organizationId, consentId, agentId, input, nowIso) {
      mustFind(organizationId, consentId);
      const row = store.dpoaAgents.find(
        (a) =>
          a.organizationId === organizationId &&
          a.consentRecordId === consentId &&
          a.id === agentId,
      );
      if (!row) throw new ConsentRouteError("not_found", "DPOA agent not found");
      if (row.removedAt !== null)
        throw new ConsentRouteError("invalid_transition", "DPOA agent is already removed");

      if (input.scopeKind !== undefined) row.scopeKind = input.scopeKind;
      if (input.activationCondition !== undefined)
        row.activationCondition = input.activationCondition;
      if (input.termKind !== undefined) row.termKind = input.termKind;
      if (input.termUntil !== undefined) row.termUntil = input.termUntil;
      if (input.remove === true) row.removedAt = nowIso;
      return dpoaView(row, Date.parse(nowIso));
    },

    // ── 17. the patient's ACTIVE primary DPOA agent (consumed by M7/M11/M14) ──
    activePrimaryDpoa(organizationId, patientId, nowIso) {
      const nowMs = Date.parse(nowIso);
      const activeDpoaConsents = new Set(
        store.records
          .filter(
            (r) =>
              r.organizationId === organizationId &&
              r.patientId === patientId &&
              r.status === "active" &&
              CONSENT_TYPE_STRUCTURE[r.typeKey].isPerNamedAgent,
          )
          .map((r) => r.id),
      );
      const match = store.dpoaAgents
        .filter(
          (a) => a.organizationId === organizationId && activeDpoaConsents.has(a.consentRecordId),
        )
        .map((a) => dpoaView(a, nowMs))
        .find((a) => a.active && a.agentKind === "primary");
      return match ?? null;
    },

    // ── 18. expiring consents inside the window, cursor-paginated (§4.12) ──
    listExpiringConsents(organizationId, patientId, windowDays, nowIso, page) {
      const nowMs = Date.parse(nowIso);
      const horizon = nowMs + windowDays * 24 * 3600 * 1000;
      let rows: ExpiringConsentView[] = store.records
        .filter(
          (r) =>
            r.organizationId === organizationId &&
            r.patientId === patientId &&
            r.status === "active" &&
            r.expiresAt !== null,
        )
        .filter((r) => {
          const exp = Date.parse(r.expiresAt as string);
          return exp > nowMs && exp <= horizon;
        })
        .map((r) => ({
          ...r,
          daysUntilExpiry: Math.max(
            0,
            Math.ceil((Date.parse(r.expiresAt as string) - nowMs) / (24 * 3600 * 1000)),
          ),
        }))
        // soonest-expiring first, stable by id
        .sort((a, b) =>
          a.expiresAt === b.expiresAt
            ? a.id.localeCompare(b.id)
            : (a.expiresAt as string).localeCompare(b.expiresAt as string),
        );

      if (page.cursor) {
        const c = decodeCursor(page.cursor);
        if (c)
          rows = rows.filter(
            (r) =>
              (r.expiresAt as string) > c.sortKey ||
              ((r.expiresAt as string) === c.sortKey && r.id > c.id),
          );
      }
      const pageRows = rows.slice(0, page.pageSize);
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        rows.length > page.pageSize && last
          ? encodeCursor(last.expiresAt as string, last.id)
          : null;
      return { rows: pageRows, nextCursor };
    },

    // ── 19. renewal cycles on a record ──
    listRenewalCycles(organizationId, consentId) {
      mustFind(organizationId, consentId);
      return store.renewalCycles.filter(
        (c) => c.organizationId === organizationId && c.sourceConsentRecordId === consentId,
      );
    },

    // ── 21. delegated-access projection rows ──
    listDelegatedAccess(organizationId, patientId, nowIso) {
      const nowMs = Date.parse(nowIso);
      return store.delegatedAccess
        .filter((d) => d.organizationId === organizationId && d.patientId === patientId)
        .map((d) => ({
          ...d,
          active:
            d.revokedAt === null &&
            Date.parse(d.effectiveFrom) <= nowMs &&
            (d.effectiveUntil === null || Date.parse(d.effectiveUntil) > nowMs),
        }));
    },

    // ── 22/23. consent-decision audit ──
    listEvalAudit(organizationId, filter, page) {
      let rows = store.evalAudit
        .filter((r) => r.organizationId === organizationId)
        .filter((r) => (filter.consentId ? r.consentRecordId === filter.consentId : true))
        .filter((r) => (filter.patientId ? r.patientId === filter.patientId : true))
        // newest first, stable by id
        .sort((a, b) =>
          b.evaluatedAt === a.evaluatedAt
            ? b.id.localeCompare(a.id)
            : b.evaluatedAt.localeCompare(a.evaluatedAt),
        );

      if (page.cursor) {
        const c = decodeCursor(page.cursor);
        if (c) {
          rows = rows.filter(
            (r) => r.evaluatedAt < c.sortKey || (r.evaluatedAt === c.sortKey && r.id < c.id),
          );
        }
      }
      const pageRows = rows.slice(0, page.pageSize);
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        rows.length > page.pageSize && last ? encodeCursor(last.evaluatedAt, last.id) : null;
      return { rows: pageRows, nextCursor };
    },

    // ── 24. force an M22 re-render by re-emitting m39.consent.signed ──
    requestDocumentReRender(organizationId, consentId, requestedById, nowIso) {
      const record = mustFind(organizationId, consentId);
      if (record.status !== "active" && record.status !== "superseded")
        throw new ConsentRouteError(
          "invalid_transition",
          "only a signed consent (active or superseded) has a document to re-render",
        );
      return {
        consentRecordId: record.id,
        requestedAt: nowIso,
        requestedById,
        eventType: "m39.consent.signed",
      };
    },

    // ── 28. which of the patient's consents survive death (M16 consumer view, D13) ──
    listPostMortemEligible(organizationId, patientId) {
      return store.records
        .filter((r) => r.organizationId === organizationId && r.patientId === patientId)
        .map((r) => ({
          consentId: r.id,
          typeKey: r.typeKey,
          status: r.status,
          survivesDeath: r.survivesDeath ?? false,
          terminatesOnDeath: consentTerminatesOnDeath(r.typeKey, r.survivesDeath ?? false),
        }));
    },

    // ── 29. post-mortem bereavement-outreach capture (D14) ──
    createBereavementOutreachDraft(organizationId, input) {
      // D14 is enforced through the pure validator: the grantor must be `bereaved_person_self`,
      // the type must be the bereavement type, and the patient must actually be deceased.
      if (input.grantorKind !== "bereaved_person_self")
        throw new ConsentRouteError(
          "validation",
          "bereavement outreach consent must be granted by bereaved_person_self (D14)",
        );
      const v = validateBereavementGrantor({
        grantorKind: input.grantorKind,
        typeKey: "bereavement_outreach_consent",
        patientDeceased: store.deceasedPatientIds.includes(input.patientId),
      });
      if (!v.ok) refuse(v);

      const record: ConsentRecordView = {
        id: newId("consent"),
        organizationId,
        patientId: input.patientId,
        typeKey: "bereavement_outreach_consent",
        grantorKind: input.grantorKind,
        captureMethod: input.captureMethod,
        scopeDescriptor: input.scopeDescriptor,
        status: "draft",
        version: 0,
        effectiveAt: null,
        expiresAt: null,
        signedAt: null,
        createdById: input.createdById,
        supersedesConsentRecordId: null,
        renewedFromConsentRecordId: null,
        survivesDeath: false,
      };
      store.records.push(record);
      return record;
    },

    // ── 30. re-fire a stuck revocation cascade (D7) ──
    retryRevocationCascade(organizationId, consentId, nowIso) {
      mustFind(organizationId, consentId);
      const revocation = store.revocations.find(
        (r) => r.organizationId === organizationId && r.consentRecordId === consentId,
      );
      if (!revocation)
        throw new ConsentRouteError("not_found", "no revocation cascade on this consent");

      revocation.attempts += 1;
      const progress: CascadeProgress = {
        status: revocation.cascadeStatus,
        consumers: revocation.cascadeConsumers,
        attempts: revocation.attempts,
      };
      const next = nextCascadeStatus(progress);
      // A budget-exhausted sweep is not a client error — it lands the cascade in its terminal
      // `partial_failed` state (which fires the M36 alert), and the route reports that honestly.
      revocation.cascadeStatus = next.ok ? next.value : "partial_failed";
      void nowIso;
      return {
        consentRecordId: consentId,
        revocationId: revocation.id,
        status: revocation.cascadeStatus,
        attempts: revocation.attempts,
        pendingConsumers: Object.entries(revocation.cascadeConsumers)
          .filter(([, acked]) => !acked)
          .map(([name]) => name),
      };
    },
  };

  return { service, data: store };
}
