// @chartwarden/audit — the security detection rules that review the audit trail (CW-MON-01; HIPAA §164.308(a)(1)(ii)(D),
// §164.308(a)(5)(ii)(C); SOC 2 CC7.2–CC7.3).
//
// A rule is DATA. The evaluator (./evaluate.ts) and the review job (apps/backend/.../security-review-job.ts) never name
// a rule, so a control that needs "alert when this audit event happens" adds ONE entry below and nothing else:
//
//   { id: "closure.policy_changed", kind: "always", lane: "org", severity: "warn", controls: ["CW-AC-48"],
//     title: "…", eventTypes: ["m8.encounter.closure_policy_changed"] }
//
// The table-driven test (`security-review-rules.test.ts`) builds a positive and a negative fixture from every entry, so
// a new rule is exercised without a new test, and its event types are checked against the action catalog.
//
// TWO LANES, because the trail has two shapes:
//   · `org`      — events with an organization (break-glass, authz denials, exports, reads). Read per organization under
//                  `withOrgContext`, so RLS scopes the read.
//   · `platform` — pre-organization authentication events (login, failed login, lockout). They have no tenant yet, so
//                  they are org-NULL rows (the SECURITY DEFINER platform writer) that no tenant context can read. Read once
//                  per tick under an audited `withPlatformContext`.
//
// NO PHI. A finding carries rule ids, counts, windows, event ids and a subject REFERENCE (a user id, a /24 network prefix,
// a truncated credential hash) — never a name, a note, a patient or a free-text reason.

export const SECURITY_REVIEW_RULES_VERSION = "2026-11-26.1";

export type SecurityReviewLane = "org" | "platform";
export type SecuritySeverity = "info" | "warn" | "critical";

/** What a burst / distinct rule groups events by. */
export type SubjectKind = "actor" | "ip_prefix" | "account_hash";

const MINUTE_MS = 60_000;

interface RuleBase {
  /** Stable id: it is in every alert, in the runbook and in the fingerprint. Never reuse a retired id. */
  readonly id: string;
  readonly title: string;
  readonly lane: SecurityReviewLane;
  readonly severity: SecuritySeverity;
  /** The register controls this rule serves (`compliance/controls.yaml` ids), for traceability. */
  readonly controls: readonly string[];
}

/** Any matching event is a finding (rare, high-signal events: break-glass, a destruction certificate, …). */
export interface AlwaysRule extends RuleBase {
  readonly kind: "always";
  readonly eventTypes: readonly string[];
}

/** At least `threshold` matching events for one subject within `windowMs`. */
export interface BurstRule extends RuleBase {
  readonly kind: "burst";
  readonly eventTypes: readonly string[];
  readonly subject: SubjectKind;
  readonly threshold: number;
  readonly windowMs: number;
}

/** At least `threshold` DISTINCT `distinctOf` values for one subject within `windowMs` (one account, many networks). */
export interface DistinctRule extends RuleBase {
  readonly kind: "distinct";
  readonly eventTypes: readonly string[];
  readonly subject: SubjectKind;
  readonly distinctOf: SubjectKind;
  readonly threshold: number;
  readonly windowMs: number;
}

/**
 * One actor read or disclosed at least `threshold` distinct records within one fixed `windowMs` bucket. Read-audit events
 * are the highest-volume rows in the trail, so this is aggregated IN SQL (the reader) and never streamed to the job.
 * Org lane only. Fixed buckets: a burst split across a bucket edge counts half in each (the stated limit).
 */
export interface BulkAccessRule extends RuleBase {
  readonly kind: "bulk_access";
  readonly lane: "org";
  readonly threshold: number;
  readonly windowMs: number;
}

export type SecurityRule = AlwaysRule | BurstRule | DistinctRule | BulkAccessRule;
export type SignalRule = AlwaysRule | BurstRule | DistinctRule;

/**
 * Credential-throttle budgets (packages/auth `CREDENTIAL_THROTTLE_POLICY`: 5 failures per username, 30 per IP, in a
 * 10-minute window). The thresholds below sit around them: the throttle REFUSES at its budget, these rules ALERT.
 */
const AUTH_WINDOW_MS = 10 * MINUTE_MS;

export const SECURITY_RULES: readonly SecurityRule[] = [
  // ── platform lane: pre-organization authentication events ────────────────────────────────────────────────────────
  {
    id: "auth.brute_force_by_network",
    title: "Many failed sign-ins from one network (credential spraying / brute force)",
    kind: "burst",
    lane: "platform",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auth.login_failed", "m2.auth.account_locked"],
    subject: "ip_prefix",
    threshold: 15, // under the throttle's 30 per IP, so the alert fires before the refusal does
    windowMs: AUTH_WINDOW_MS,
  },
  {
    id: "auth.brute_force_by_account",
    title: "One account kept failing after its failed-attempt budget was spent",
    kind: "burst",
    lane: "platform",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auth.login_failed", "m2.auth.account_locked"],
    subject: "account_hash",
    threshold: 10, // twice the throttle's 5 per username: the attacker carried on through the lockout
    windowMs: AUTH_WINDOW_MS,
  },
  {
    id: "auth.distributed_attack_on_account",
    title: "One account failed from several networks at once (credential stuffing)",
    kind: "distinct",
    lane: "platform",
    severity: "critical",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auth.login_failed", "m2.auth.account_locked"],
    subject: "account_hash",
    distinctOf: "ip_prefix",
    threshold: 3,
    windowMs: AUTH_WINDOW_MS,
  },
  {
    // "Impossible travel" WITHOUT geolocation: the trail carries /24 prefixes, not coordinates, and nothing in the repo
    // resolves an address to a place. One user signing in from three networks inside an hour is the cheap proxy; a true
    // distance-over-time check needs a geo source and is the stated remainder of CW-MON-01.
    id: "auth.rapid_origin_change",
    title: "One user signed in from several networks within an hour (impossible-travel proxy)",
    kind: "distinct",
    lane: "platform",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auth.login_succeeded"],
    subject: "actor",
    distinctOf: "ip_prefix",
    threshold: 3,
    windowMs: 60 * MINUTE_MS,
  },
  // ── org lane: tenant-scoped events ───────────────────────────────────────────────────────────────────────────────
  {
    id: "access.break_glass_invoked",
    title: "Emergency (break-glass) access was invoked",
    kind: "always",
    lane: "org",
    severity: "critical",
    controls: ["CW-MON-01"],
    eventTypes: ["m3.breakglass.invoked"],
  },
  {
    id: "access.privilege_escalation_blocked",
    title: "A privilege-escalation attempt was blocked",
    kind: "always",
    lane: "org",
    severity: "critical",
    controls: ["CW-MON-01"],
    eventTypes: ["m3.authz.escalation_blocked"],
  },
  {
    id: "access.authorization_denial_burst",
    title: "One user was refused authorization repeatedly (probing for access)",
    kind: "burst",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    // m3.authz.denied is SAMPLED (D5), so the observed count is a floor on the real attempts.
    eventTypes: ["m3.authz.denied"],
    subject: "actor",
    threshold: 10,
    windowMs: 15 * MINUTE_MS,
  },
  {
    id: "access.bulk_record_access",
    title: "One user read or disclosed an unusually large number of distinct records",
    kind: "bulk_access",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    threshold: 100,
    windowMs: 15 * MINUTE_MS,
  },
  {
    id: "access.auditor_session_activated",
    title: "An external auditor session was activated",
    kind: "always",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auditor_enrolment.activated"],
  },
  {
    id: "access.second_factor_disabled",
    title: "A user turned off their second factor",
    kind: "always",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.auth.2fa_disabled"],
  },
  {
    id: "export.request_burst",
    title: "One user requested several audit exports within an hour",
    kind: "burst",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    // Only exports that leave an audit event are visible here; a module that audits its own export adds its event type.
    eventTypes: ["m4.audit_export.requested"],
    subject: "actor",
    threshold: 3,
    windowMs: 60 * MINUTE_MS,
  },
  {
    id: "privileged.role_grant_burst",
    title: "One user assigned many roles in a short time",
    kind: "burst",
    lane: "org",
    severity: "warn",
    controls: ["CW-MON-01"],
    eventTypes: ["m3.role.assigned"],
    subject: "actor",
    threshold: 10,
    windowMs: 15 * MINUTE_MS,
  },
  {
    id: "privileged.mass_deactivation",
    title: "One user deactivated several accounts in a short time",
    kind: "burst",
    lane: "org",
    severity: "critical",
    controls: ["CW-MON-01"],
    eventTypes: ["m2.user.deactivated"],
    subject: "actor",
    threshold: 5,
    windowMs: 15 * MINUTE_MS,
  },
  {
    id: "destructive.data_destruction_approved",
    title: "A data-destruction certificate was approved or certified",
    kind: "always",
    lane: "org",
    severity: "critical",
    controls: ["CW-MON-01"],
    eventTypes: ["m4.destruction_certificate.approved", "data.destruction_certified"],
  },
  {
    id: "integrity.audit_chain_mismatch",
    title: "The audit hash chain no longer verifies (the log was altered)",
    kind: "always",
    lane: "org",
    severity: "critical",
    controls: ["CW-MON-01", "CW-AU-01"],
    eventTypes: ["audit.integrity_mismatch"],
  },
];

/** The rules of one lane. */
export const rulesForLane = <R extends SecurityRule>(
  rules: readonly R[],
  lane: SecurityReviewLane,
): readonly R[] => rules.filter((r) => r.lane === lane);

/** The widest window any rule looks back over: the scan range reaches this far before the cursor so a burst that straddles a run is seen whole. */
export const maxRuleWindowMs = (rules: readonly SecurityRule[]): number =>
  rules.reduce((widest, r) => (r.kind === "always" ? widest : Math.max(widest, r.windowMs)), 0);

/** Every event type the signal rules of `rules` look at (the reader's SQL prefilter). */
export const signalEventTypes = (rules: readonly SecurityRule[]): readonly string[] => [
  ...new Set(rules.flatMap((r) => (r.kind === "bulk_access" ? [] : r.eventTypes))),
];
