// @chartwarden/audit — the PURE evaluator of the security detection rules (CW-MON-01). No database, no clock, no I/O:
// events in, findings out, so every rule is unit-testable with synthetic rows.
//
// FINGERPRINTS make the review idempotent. A scan range overlaps the previous one (a burst can straddle two runs, and a
// row's `created_at` is its transaction START, so it can commit after a run read past it), so the same finding is seen
// again; the job drops any finding whose fingerprint it already raised. A fingerprint is a hash of the rule, the scope,
// the subject and an ANCHOR that does not move between runs: the first event of the triggering window (burst/distinct), the
// event itself (always), or the bucket start (bulk access).
//
// NO PHI: a finding holds a rule id, counts, a window, event ids and a subject REFERENCE (a user id, a /24 prefix, the first
// 12 characters of a credential hash). Nothing else leaves this file.
import { createHash } from "node:crypto";
import type {
  BulkAccessRule,
  SecurityReviewLane,
  SecuritySeverity,
  SignalRule,
  SubjectKind,
} from "./rules";

/** The columns the reader extracts from one audit row — all the evaluator ever sees of an event. */
export interface ReviewEvent {
  readonly id: string;
  /** ISO-8601 UTC. */
  readonly createdAt: string;
  readonly eventType: string;
  readonly actorUserId: string | null;
  /** `context.userId`: the user a pre-organization authentication event concerns (the actor column is null there). */
  readonly contextUserId: string | null;
  /** `context.ipPrefix`: the /24 (or /48) network prefix; the trail never keeps a full address for these events. */
  readonly ipPrefix: string | null;
  /** `context.emailHash`: a hash of the credential identifier. */
  readonly accountHash: string | null;
}

/** One actor's read/disclose count in one fixed bucket, aggregated by the reader (see `BulkAccessRule`). */
export interface BulkAccessHit {
  readonly actorUserId: string;
  /** ISO-8601 UTC start of the fixed bucket. */
  readonly bucketStart: string;
  readonly distinctRecords: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly sampleEventIds: readonly string[];
}

export type FindingSubjectKind = SubjectKind | "event";

export interface SecurityFinding {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: SecuritySeverity;
  readonly lane: SecurityReviewLane;
  readonly controls: readonly string[];
  /** The organization the finding concerns; null in the platform lane. */
  readonly organizationId: string | null;
  readonly subject: { readonly kind: FindingSubjectKind; readonly ref: string };
  /** The metric that crossed the threshold: events (burst), distinct values (distinct), distinct records (bulk), 1 (always). */
  readonly count: number;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly sampleEventIds: readonly string[];
  readonly fingerprint: string;
}

export const MAX_SAMPLE_EVENT_IDS = 5;
/**
 * How much of a credential hash an alert may carry: enough to correlate with the trail. The hash is an unsalted SHA-256 of the email
 * address, so a reader who can guess the address can still confirm it: the alert's destination is workforce-confidential.
 */
export const ACCOUNT_HASH_REF_CHARS = 12;

export interface FindingScope {
  /** Null for the platform lane. */
  readonly organizationId: string | null;
}

const ms = (iso: string): number => Date.parse(iso);

function subjectOf(event: ReviewEvent, kind: SubjectKind): string | null {
  switch (kind) {
    case "actor":
      return event.contextUserId ?? event.actorUserId;
    case "ip_prefix":
      // "unknown" is what the auth bridge writes for an address it could not parse: not a network, so never a subject.
      return event.ipPrefix === "unknown" ? null : event.ipPrefix;
    case "account_hash":
      return event.accountHash;
  }
}

/** What an alert may show of a subject (a credential hash is truncated; ids and prefixes are shown whole). */
const refOf = (kind: SubjectKind, value: string): string =>
  kind === "account_hash" ? value.slice(0, ACCOUNT_HASH_REF_CHARS) : value;

const fingerprintOf = (scope: FindingScope, ruleId: string, ...parts: readonly string[]): string =>
  createHash("sha256")
    .update([ruleId, scope.organizationId ?? "platform", ...parts].join("|"))
    .digest("hex")
    .slice(0, 32);

/**
 * Greedy, non-overlapping windows over one subject's events (sorted ascending): from each event, the window
 * `[t, t + windowMs)`; the first that `qualifies` is taken and scanning resumes after it. A window starting at an event
 * dominates every other window containing that event, so no qualifying burst is missed.
 */
function triggeredWindows(
  sorted: readonly ReviewEvent[],
  windowMs: number,
  threshold: number,
  /** The value whose distinct count is the metric; absent ⇒ the metric is the number of events. */
  distinctOf?: (event: ReviewEvent) => string | null,
): { readonly events: readonly ReviewEvent[]; readonly metric: number }[] {
  const out: { events: readonly ReviewEvent[]; metric: number }[] = [];
  // A sliding window over the events [i, j): linear in the events, so a flood of one subject (tens of thousands of failed
  // sign-ins) cannot make the review quadratic. `counts` holds the distinct-value multiset of the window.
  const counts = new Map<string, number>();
  const add = (e: ReviewEvent): void => {
    const v = distinctOf?.(e) ?? null;
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  };
  const remove = (e: ReviewEvent): void => {
    const v = distinctOf?.(e) ?? null;
    if (v === null) return;
    const left = (counts.get(v) ?? 1) - 1;
    if (left === 0) counts.delete(v);
    else counts.set(v, left);
  };
  let i = 0;
  let j = 0;
  while (i < sorted.length) {
    const startMs = ms((sorted[i] as ReviewEvent).createdAt);
    while (j < sorted.length && ms((sorted[j] as ReviewEvent).createdAt) < startMs + windowMs) {
      add(sorted[j] as ReviewEvent);
      j += 1;
    }
    const metric = distinctOf ? counts.size : j - i;
    if (metric >= threshold) {
      out.push({ events: sorted.slice(i, j), metric });
      counts.clear();
      i = j;
    } else {
      remove(sorted[i] as ReviewEvent);
      i += 1;
    }
  }
  return out;
}

const byTimeThenId = (a: ReviewEvent, b: ReviewEvent): number =>
  ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id);

function findingFrom(
  rule: SignalRule | BulkAccessRule,
  scope: FindingScope,
  fields: Pick<
    SecurityFinding,
    "subject" | "count" | "windowFrom" | "windowTo" | "sampleEventIds"
  > & { readonly anchor: string },
): SecurityFinding {
  const { anchor, ...rest } = fields;
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    lane: rule.lane,
    controls: rule.controls,
    organizationId: scope.organizationId,
    ...rest,
    fingerprint: fingerprintOf(scope, rule.id, rest.subject.ref, anchor),
  };
}

/** Evaluate the always / burst / distinct rules over `events` (any order; events of other rules' types are ignored). */
export function evaluateSignalRules(
  rules: readonly SignalRule[],
  events: readonly ReviewEvent[],
  scope: FindingScope,
): readonly SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  for (const rule of rules) {
    const matching = events.filter((e) => rule.eventTypes.includes(e.eventType)).sort(byTimeThenId);
    if (rule.kind === "always") {
      for (const e of matching) {
        findings.push(
          findingFrom(rule, scope, {
            subject: { kind: "event", ref: e.id },
            count: 1,
            windowFrom: e.createdAt,
            windowTo: e.createdAt,
            sampleEventIds: [e.id],
            anchor: e.id,
          }),
        );
      }
      continue;
    }
    const bySubject = new Map<string, ReviewEvent[]>();
    for (const e of matching) {
      const subject = subjectOf(e, rule.subject);
      if (subject === null) continue; // an event with no such subject (a second-factor failure has no account) cannot count toward it
      const list = bySubject.get(subject); // a local accumulator: appended in place, never shared
      if (list) list.push(e);
      else bySubject.set(subject, [e]);
    }
    const distinctOf =
      rule.kind === "distinct" ? (e: ReviewEvent) => subjectOf(e, rule.distinctOf) : undefined;
    for (const [subject, subjectEvents] of bySubject) {
      for (const { events: window, metric } of triggeredWindows(
        subjectEvents,
        rule.windowMs,
        rule.threshold,
        distinctOf,
      )) {
        const first = window[0] as ReviewEvent;
        const last = window[window.length - 1] as ReviewEvent;
        findings.push(
          findingFrom(rule, scope, {
            subject: { kind: rule.subject, ref: refOf(rule.subject, subject) },
            count: metric,
            windowFrom: first.createdAt,
            windowTo: last.createdAt,
            sampleEventIds: window.slice(0, MAX_SAMPLE_EVENT_IDS).map((e) => e.id),
            anchor: first.id,
          }),
        );
      }
    }
  }
  return findings.sort(
    (a, b) => ms(a.windowFrom) - ms(b.windowFrom) || a.ruleId.localeCompare(b.ruleId),
  );
}

/** Turn the reader's bulk-access aggregates into findings (the threshold is applied again here so the rule, not the SQL, decides). */
export function bulkAccessFindings(
  rule: BulkAccessRule,
  hits: readonly BulkAccessHit[],
  scope: FindingScope,
): readonly SecurityFinding[] {
  return hits
    .filter((h) => h.distinctRecords >= rule.threshold)
    .map((h) =>
      findingFrom(rule, scope, {
        subject: { kind: "actor", ref: h.actorUserId },
        count: h.distinctRecords,
        windowFrom: h.firstAt,
        windowTo: h.lastAt,
        sampleEventIds: h.sampleEventIds.slice(0, MAX_SAMPLE_EVENT_IDS),
        anchor: h.bucketStart,
      }),
    );
}

/** An alert this scope already raised and delivered (or had no destination for): the review's memory, read back from the audit trail. */
export interface RaisedAlertRef {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly subjectKind: string;
  readonly subjectRef: string;
  /** ms since epoch of the raised alert's window end. */
  readonly windowToMs: number;
}

/**
 * True when an alert for the same (rule, subject) already covered a window that ended within `cooldownMs` before this finding
 * began, so a sustained pattern is not raised again every run. `always` findings are one per event and are never held back.
 */
export function isWithinCooldown(
  finding: SecurityFinding,
  raised: readonly RaisedAlertRef[],
  cooldownMs: number,
  isAlways: (ruleId: string) => boolean,
): boolean {
  if (isAlways(finding.ruleId)) return false;
  const startsAt = ms(finding.windowFrom);
  return raised.some(
    (r) =>
      r.ruleId === finding.ruleId &&
      r.subjectKind === finding.subject.kind &&
      r.subjectRef === finding.subject.ref &&
      startsAt - r.windowToMs <= cooldownMs &&
      startsAt >= r.windowToMs - cooldownMs,
  );
}

/**
 * A finding about the review itself (see `REVIEW_NOTICE_RULES`): it names no event, so its subject is the run (`ref` is the
 * codes of what went wrong) and its fingerprint is per run.
 */
export function noticeFinding(
  rule: { readonly id: string; readonly title: string; readonly severity: SecuritySeverity; readonly controls: readonly string[] },
  scope: FindingScope,
  fields: { readonly count: number; readonly ref: string; readonly windowFrom: string; readonly windowTo: string },
): SecurityFinding {
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    lane: scope.organizationId === null ? "platform" : "org",
    controls: rule.controls,
    organizationId: scope.organizationId,
    subject: { kind: "event", ref: fields.ref },
    count: fields.count,
    windowFrom: fields.windowFrom,
    windowTo: fields.windowTo,
    sampleEventIds: [],
    fingerprint: fingerprintOf(scope, rule.id, fields.ref, fields.windowTo),
  };
}

export const SECURITY_ALERT_RUNBOOK = "docs/runbooks/security-alert-review.md";

/** What leaves the process: the finding plus the rules version and where the responder looks next. Ids and codes only. */
export interface SecurityAlert extends SecurityFinding {
  readonly kind: "security_alert";
  readonly rulesVersion: string;
  readonly runbook: string;
}

export const toSecurityAlert = (finding: SecurityFinding, rulesVersion: string): SecurityAlert => ({
  kind: "security_alert",
  rulesVersion,
  runbook: `${SECURITY_ALERT_RUNBOOK}#${finding.ruleId}`,
  ...finding,
});
