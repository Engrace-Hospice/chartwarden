// @wardenx/auth · identity — Session classes + lifecycle (M2-T03; M2 spec §2.2.4, §3.6).
//
// The `session` table (M1-owned) is the SAME row shape for all four classes; the class
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

/** The four session classes (single source: the M1-owned `session_class` pgEnum). */
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
export type SessionScopeKind = "organization" | "patient" | "deceased_patient";

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
  /** Concurrency policy. */
  readonly concurrency: SessionConcurrency;
  /** Whether the UI screen-lock lifecycle applies (staff / auditor). */
  readonly screenLockApplies: boolean;
}

export const SESSION_CLASS_DESCRIPTORS: Record<SessionClass, SessionClassDescriptor> = {
  staff: {
    scopeKind: "organization",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: false,
    concurrency: "allowed",
    screenLockApplies: true,
  },
  auditor: {
    scopeKind: "organization",
    readOnly: true,
    requiresEngagementWindow: true,
    requiresPatientScope: false,
    concurrency: "none",
    screenLockApplies: true,
  },
  external_collaborator: {
    scopeKind: "patient",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: true,
    concurrency: "one_active_per_link",
    screenLockApplies: false,
  },
  funeral_home: {
    scopeKind: "deceased_patient",
    readOnly: false,
    requiresEngagementWindow: false,
    requiresPatientScope: true,
    concurrency: "one_active_per_link",
    screenLockApplies: false,
  },
};

/** Descriptor lookup. */
export function sessionClassDescriptor(cls: SessionClass): SessionClassDescriptor {
  return SESSION_CLASS_DESCRIPTORS[cls];
}

/** The class-specific scope fields carried on a session (mirrors the §3.6 columns). */
export interface SessionScopeFields {
  readonly sessionClass: SessionClass;
  readonly scope?: { patientId?: string } | null;
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
  return desc.requiresPatientScope ? (fields.scope?.patientId ?? null) : null;
}

/** Whether a class permits concurrent sessions (auditor: never). */
export function sessionAllowsConcurrent(cls: SessionClass): boolean {
  return SESSION_CLASS_DESCRIPTORS[cls].concurrency === "allowed";
}
