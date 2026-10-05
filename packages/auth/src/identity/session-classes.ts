// @wardenx/auth · identity — Session classes + lifecycle (M2-T03; M2 spec §2.2.4, §3.6).
//
// The `session` table (M1-owned) is the SAME row shape for every class; the class
// drives timeout policy, scope, and allowed operations. This module is the canonical
// taxonomy + lifecycle state machine + scoping predicates. The Better Auth config
// (./auth) carries these as session additionalFields; their at-rest columns + CHECK
// invariants live in `packages/db/src/schema/sessions.ts`.
//
// Split with M2-T04: the per-class *timeout* values (idle / absolute) are policy numbers
// that land in `SESSION_POLICY` (packages/types, M2-T04). This module owns the class
// *definition* — scope kind, concurrency, screen-lock applicability, lifecycle states,
// and the scope-shape predicate that mirrors the DB `session_scope_chk` CHECK.
import { schema } from "@wardenx/db";

/** Every session class (single source: the M1-owned `session_class` pgEnum). */
export const SESSION_CLASSES = schema.sessionClass.enumValues;
export type SessionClass = (typeof SESSION_CLASSES)[number];

/**
 * Lifecycle states (M2 spec §2.2.4 state machine). `active` and `screen_locked` are live
 * states; the remaining four are terminal (the session is over).
 */
export type SessionLifecycleState =
  | "active"
  | "screen_locked"
  | "expired_idle"
  | "expired_absolute"
  | "revoked"
  | "window_closed";

/** Terminal lifecycle states — no outbound transition. */
export const TERMINAL_SESSION_STATES: readonly SessionLifecycleState[] = [
  "expired_idle",
  "expired_absolute",
  "revoked",
  "window_closed",
];

/**
 * Allowed lifecycle transitions, exactly per the §2.2.4 diagram:
 *   active        → screen_locked | expired_idle | expired_absolute | revoked | window_closed
 *   screen_locked → active (re-auth: password / biometric / passkey)
 */
export const SESSION_LIFECYCLE_TRANSITIONS: Record<
  SessionLifecycleState,
  readonly SessionLifecycleState[]
> = {
  active: ["screen_locked", "expired_idle", "expired_absolute", "revoked", "window_closed"],
  screen_locked: ["active"],
  expired_idle: [],
  expired_absolute: [],
  revoked: [],
  window_closed: [],
};

/** Whether a lifecycle transition is permitted (unknown/terminal sources → false). */
export function canTransitionSession(
  from: SessionLifecycleState,
  to: SessionLifecycleState,
): boolean {
  return SESSION_LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** What a class's session is pinned to (drives authorization scope in M3). */
export type SessionScopeKind =
  | "organization"
  | "patient"
  | "deceased_patient"
  /** M31 portal — pinned to a portal ACCOUNT; the one patient is bound within it by select-patient. */
  | "portal_account"
  /** M19 answering service — pinned to an `external_triage_vendor`. Was `organization`, which read as
   *  "unscoped within the org" and is how the vendor came to be required nowhere (F-030). */
  | "external_vendor";

/** Concurrency rule per class (M2 spec §2.2.4 "Concurrency" column). */
export type SessionConcurrency = "allowed" | "one_active_per_link" | "none";

/** Class-definitional facts (NOT timeout values — those are SESSION_POLICY, M2-T04). */
export interface SessionClassDescriptor {
  /** What the session is scoped to. */
  readonly scopeKind: SessionScopeKind;
  /** Auditor sessions are read-only (scope enforced by M3). */
  readonly readOnly: boolean;
  /** Auditor sessions require both engagement-window bounds. */
  readonly requiresEngagementWindow: boolean;
  /** collaborator / funeral sessions require `scope.patientId`. */
  readonly requiresPatientScope: boolean;
  /**
   * The three M31 portal classes require `scope.portalAccountId`.
   *
   * Deliberately NOT `requiresPatientScope`: a portal session exists before `select-patient` binds its
   * one patient (M31 §2.3 / D2), so the patient is optional at mint and the account is not. Mirrors the
   * `session_scope_chk` branch migration 0220 adds.
   */
  readonly requiresPortalAccount: boolean;
  /**
   * The two M19 answering-service classes require `scope.externalActorId` — the `external_triage_vendor`
   * row the session acts for.
   *
   * This IS the authorization subject for `external_triage_actor`: the predicate compares the shift's
   * vendor against the session's, so a vendor session with no vendor on it is not a weaker session, it
   * is one the predicate can never admit. The class used to require nothing (0220's branch, matching
   * `staff`) on the reasoning that a vendor session is org-scoped rather than patient-scoped — true, and
   * beside the point: it is VENDOR-scoped, and nothing carried the vendor.
   */
  readonly requiresExternalActor: boolean;
  /** Concurrency policy. */
  readonly concurrency: SessionConcurrency;
  /** Whether the UI screen-lock lifecycle applies (staff / auditor). */
  readonly screenLockApplies: boolean;
}

export const SESSION_CLASS_DESCRIPTORS: Record<SessionClass, SessionClassDescriptor> = {
  staff: {
    requiresPortalAccount: false,
    requiresExternalActor: false,
    scopeKind: "organization",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed",
    screenLockApplies: true,
  },
  auditor: {
    requiresPortalAccount: false,
    requiresExternalActor: false,
    scopeKind: "organization",
    readOnly: true,
    requiresEngagementWindow: true,
    requiresPatientScope: false,
    concurrency: "none",
    screenLockApplies: true,
  },
  external_collaborator: {
    requiresPortalAccount: false,
    requiresExternalActor: false,
    scopeKind: "patient",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: true,
    concurrency: "one_active_per_link",
    screenLockApplies: false,
  },
  funeral_home: {
    requiresPortalAccount: false,
    requiresExternalActor: false,
    scopeKind: "deceased_patient",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: true,
    concurrency: "one_active_per_link",
    screenLockApplies: false,
  },

  // ── M31 portal (§2.2.1, §6.4, §8.1) ─────────────────────────────────────────────────────────────
  // Three classes rather than one, matching what M16/M19/M31's predicates have always compared
  // against. The distinction is the RELATIONSHIP, which is a durable fact of the grant, not of the
  // session: `patient_self` mints `patient_portal`, any delegated grant mints `caregiver_portal`, and
  // a grant in `bereaved_mode` mints `bereaved_portal`. All three share one policy — M31's §6.4 floor
  // (30-min idle / 8-h hard), enforced server-side from `SESSION_POLICY.byClass` (packages/types) by ./session-timeout — not
  // the staff screen-lock lifecycle.
  patient_portal: {
    requiresPortalAccount: true,
    requiresExternalActor: false,
    scopeKind: "portal_account",
    readOnly: false, // portal users write: messages, amendment requests, caregiver-attested doses
    requiresEngagementWindow: false,
    requiresPatientScope: false, // bound later by select-patient, not at mint
    concurrency: "allowed",
    screenLockApplies: false,
  },
  caregiver_portal: {
    requiresPortalAccount: true,
    requiresExternalActor: false,
    scopeKind: "portal_account",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed",
    screenLockApplies: false,
  },
  bereaved_portal: {
    requiresPortalAccount: true,
    requiresExternalActor: false,
    scopeKind: "portal_account",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed",
    screenLockApplies: false,
  },

  // ── M19 external triage vendor (§4.1 row 36) ────────────────────────────────────────────────────
  // An answering service acting for the agency after hours. VENDOR-scoped: the session names the
  // `external_triage_vendor` it acts for, and `external_triage_actor` compares that against the shift's.
  // These used to be `organization` with no scope requirement, on the reasoning that a vendor session is
  // not PATIENT-scoped — true, and it does not follow that it is unscoped within the org. That reading
  // is how the vendor came to be required nowhere and written by nothing (F-030). Per-call patient
  // access is still gated by M19's own predicates on top.
  external_triage_vendor: {
    requiresPortalAccount: false,
    requiresExternalActor: true,
    scopeKind: "external_vendor",
    readOnly: false, // they log triage calls
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed", // one vendor, many operators
    screenLockApplies: false,
  },
  external_triage_operator: {
    requiresPortalAccount: false,
    requiresExternalActor: true,
    scopeKind: "external_vendor",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed",
    screenLockApplies: false,
  },
};

/** The three M31 portal classes — the set M16/M19/M31's `portal.*` predicates gate on. */
export const PORTAL_SESSION_CLASSES = [
  "patient_portal",
  "caregiver_portal",
  "bereaved_portal",
] as const satisfies readonly SessionClass[];

/** The two M19 answering-service classes. */
export const VENDOR_SESSION_CLASSES = [
  "external_triage_vendor",
  "external_triage_operator",
] as const satisfies readonly SessionClass[];

/** Is this class one of the three M31 portal classes? Accepts any string (an absent class is not). */
export function isPortalSessionClass(cls: string | null | undefined): boolean {
  return (PORTAL_SESSION_CLASSES as readonly string[]).includes(cls ?? "");
}

/** Is this class one of the two M19 answering-service classes? */
export function isVendorSessionClass(cls: string | null | undefined): boolean {
  return (VENDOR_SESSION_CLASSES as readonly string[]).includes(cls ?? "");
}

/** Descriptor lookup. */
export function sessionClassDescriptor(cls: SessionClass): SessionClassDescriptor {
  return SESSION_CLASS_DESCRIPTORS[cls];
}

/** The class-specific scope fields carried on a session (mirrors the §3.6 columns). */
export interface SessionScopeFields {
  readonly sessionClass: SessionClass;
  readonly scope?: {
    patientId?: string;
    portalAccountId?: string;
    /** The `external_triage_vendor` row an M19 answering-service session acts for. */
    externalActorId?: string;
  } | null;
  readonly engagementStart?: Date | string | null;
  readonly engagementEnd?: Date | string | null;
}

/**
 * App-layer mirror of the DB `session_scope_chk` CHECK (M2 spec §3.6): a session's class
 * must carry the scope its class requires. Defense-in-depth — the DB CHECK is the floor,
 * but the auth layer rejects mis-scoped sessions before they are ever written.
 */
export function isSessionScopeValid(fields: SessionScopeFields): boolean {
  const { sessionClass, scope, engagementStart, engagementEnd } = fields;
  const desc = SESSION_CLASS_DESCRIPTORS[sessionClass];
  if (desc.requiresPatientScope) {
    return typeof scope?.patientId === "string" && scope.patientId.length > 0;
  }
  if (desc.requiresEngagementWindow) {
    return engagementStart != null && engagementEnd != null;
  }
  if (desc.requiresPortalAccount) {
    return typeof scope?.portalAccountId === "string" && scope.portalAccountId.length > 0;
  }
  if (desc.requiresExternalActor) {
    return typeof scope?.externalActorId === "string" && scope.externalActorId.length > 0;
  }
  return true; // staff
}

/** Throwing variant for the write path. */
export function assertSessionScope(fields: SessionScopeFields): void {
  if (!isSessionScopeValid(fields)) {
    throw new Error(
      `invalid session scope for class '${fields.sessionClass}' (M2 spec §3.6 session_scope_chk)`,
    );
  }
}

/**
 * The patient a session is pinned to, or null for org-scoped classes. collaborator /
 * funeral sessions may only ever touch this one patient (scope enforced downstream).
 */
export function sessionPinnedPatientId(fields: SessionScopeFields): string | null {
  const desc = SESSION_CLASS_DESCRIPTORS[fields.sessionClass];
  // A portal session is pinned too, once `select-patient` has bound it — but unlike collaborator /
  // funeral it is legitimately unpinned before that, so it reads the same field WITHOUT requiring it.
  if (desc.requiresPortalAccount) return fields.scope?.patientId ?? null;
  return desc.requiresPatientScope ? (fields.scope?.patientId ?? null) : null;
}

/**
 * The `external_triage_vendor` row a session acts for, or null on every class that is not one of M19's
 * two answering-service classes.
 *
 * Class-gated for the same reason `sessionPinnedPatientId` is: `scope` is jsonb, so a staff session that
 * somehow carries an `externalActorId` must still read null. What makes a session a vendor session is
 * its CLASS, not the presence of a key — and this key is the authorization subject of
 * `external_triage_actor`, so reading it straight off the column would let any session that acquired the
 * key reach a vendor-scoped call. M19's own predicate header names exactly that risk: folding the vendor
 * arm into the owner predicate "would let any staff session that happened to carry an `externalActorId`
 * attribute reach a vendor-scoped call".
 */
export function sessionExternalActorId(fields: SessionScopeFields): string | null {
  return SESSION_CLASS_DESCRIPTORS[fields.sessionClass].requiresExternalActor
    ? (fields.scope?.externalActorId ?? null)
    : null;
}

/** Whether a class permits concurrent sessions (auditor: never). */
export function sessionAllowsConcurrent(cls: SessionClass): boolean {
  return SESSION_CLASS_DESCRIPTORS[cls].concurrency === "allowed";
}
