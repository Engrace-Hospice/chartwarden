// CW-MON-01 — the security detection rules and their pure evaluator. Every rule in SECURITY_RULES gets a positive and a negative
// fixture BUILT FROM ITS OWN DEFINITION, so a rule added later (by CW-AC-48 and the other Tier 4 controls: one entry in
// rules.ts) is exercised here without a new test. All identifiers are synthetic (RFC 5737 documentation prefixes, made-up ids).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../src/actions";
import {
  ACCOUNT_HASH_REF_CHARS,
  type AlwaysRule,
  type BulkAccessRule,
  type BurstRule,
  type DistinctRule,
  MAX_SAMPLE_EVENT_IDS,
  REVIEW_NOTICE_RULES,
  type ReviewEvent,
  SECURITY_RULES,
  type SecurityRule,
  type SignalRule,
  type SubjectKind,
  bulkAccessFindings,
  evaluateSignalRules,
  maxRuleWindowMs,
  rulesForLane,
  signalEventTypes,
  toSecurityAlert,
} from "../src/review";

const T0 = Date.parse("2026-11-26T10:00:00.000Z");
const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000a2";
const FULL_HASH = "0123456789abcdef0123456789abcdef";

let seq = 0;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const event = (eventType: string, offsetMs: number, over: Partial<ReviewEvent> = {}): ReviewEvent => {
  seq += 1;
  return {
    id: uuid(seq),
    createdAt: at(offsetMs),
    eventType,
    actorUserId: null,
    contextUserId: null,
    ipPrefix: null,
    accountHash: null,
    ...over,
  };
};

/** The event fields that make `value` this event's subject of `kind`. */
const subjectFields = (kind: SubjectKind, value: string): Partial<ReviewEvent> =>
  kind === "actor"
    ? { actorUserId: value }
    : kind === "ip_prefix"
      ? { ipPrefix: value }
      : { accountHash: value };

const scopeOf = (rule: SecurityRule) => ({ organizationId: rule.lane === "org" ? ORG : null });
const evaluate = (rule: SignalRule, events: readonly ReviewEvent[]) =>
  evaluateSignalRules([rule], events, scopeOf(rule));

const signalRules = SECURITY_RULES.filter((r): r is SignalRule => r.kind !== "bulk_access");
const alwaysRules = SECURITY_RULES.filter((r): r is AlwaysRule => r.kind === "always");
const burstRules = SECURITY_RULES.filter((r): r is BurstRule => r.kind === "burst");
const distinctRules = SECURITY_RULES.filter((r): r is DistinctRule => r.kind === "distinct");
const bulkRules = SECURITY_RULES.filter((r): r is BulkAccessRule => r.kind === "bulk_access");

describe("the rule catalog", () => {
  it("has unique, non-empty ids, a control and a title on every rule", () => {
    const ids = SECURITY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SECURITY_RULES) {
      expect(rule.title.length).toBeGreaterThan(0);
      expect(rule.controls.length).toBeGreaterThan(0);
    }
  });

  it("names only audit actions that are in the action catalog (a typo would never fire)", () => {
    const catalogued = new Set(ACTION_CATALOG.map((a) => a.action));
    const unknown = signalRules.flatMap((r) => r.eventTypes).filter((t) => !catalogued.has(t));
    expect(unknown).toEqual([]);
  });

  it("puts only org-less authentication events in the platform lane (an org-bound event type there could never fire)", () => {
    for (const rule of rulesForLane(signalRules, "platform")) {
      expect(rule.eventTypes.every((t) => t.startsWith("m2.auth."))).toBe(true);
    }
  });

  it("has positive thresholds and windows, and keeps bulk access in the org lane", () => {
    for (const rule of [...burstRules, ...distinctRules, ...bulkRules]) {
      expect(rule.threshold).toBeGreaterThan(1);
      expect(rule.windowMs).toBeGreaterThan(0);
    }
    expect(bulkRules.every((r) => r.lane === "org")).toBe(true);
  });

  it("covers every scenario in the register's reason: brute force, impossible travel, mass export, break-glass", () => {
    const ids = SECURITY_RULES.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "auth.brute_force_by_network",
        "auth.brute_force_by_account",
        "auth.rapid_origin_change",
        "access.bulk_record_access",
        "export.request_burst",
        "access.break_glass_invoked",
      ]),
    );
  });

  it("has a section in the runbook for every rule (an alert links to `#<ruleId>`), and none for a rule that is gone", () => {
    const runbook = readFileSync(
      join(__dirname, "../../../docs/runbooks/security-alert-review.md"),
      "utf8",
    );
    const anchors = [...runbook.matchAll(/<a id="([^"]+)"><\/a>/g)].map((m) => m[1]);
    const noticeIds = Object.values(REVIEW_NOTICE_RULES).map((r) => r.id); // the review's own alerts have sections too
    expect(anchors.sort()).toEqual([...SECURITY_RULES.map((r) => r.id), ...noticeIds].sort());
  });

  it("looks back over the widest window and prefilters on every signal event type", () => {
    expect(maxRuleWindowMs(SECURITY_RULES)).toBe(60 * 60_000);
    expect(maxRuleWindowMs(alwaysRules)).toBe(0);
    expect(signalEventTypes(SECURITY_RULES)).toEqual(
      expect.arrayContaining(["m3.breakglass.invoked", "m2.auth.login_failed", "m3.authz.denied"]),
    );
  });
});

describe.each(alwaysRules)("always rule $id", (rule) => {
  it("raises one finding per matching event, each its own", () => {
    const events = rule.eventTypes.map((t, i) => event(t, i * 1000));
    const findings = evaluate(rule, events);
    expect(findings).toHaveLength(events.length);
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(events.length);
    expect(findings[0]).toMatchObject({ ruleId: rule.id, severity: rule.severity, count: 1 });
  });

  it("ignores an event of another type", () => {
    expect(evaluate(rule, [event("patient.viewed", 0)])).toEqual([]);
  });
});

describe.each(burstRules)("burst rule $id", (rule) => {
  const subject = rule.subject === "ip_prefix" ? "192.0.2.0/24" : rule.subject === "actor" ? uuid(900) : FULL_HASH;
  const eventType = rule.eventTypes[0] as string;
  const burst = (count: number, spacingMs: number, who = subject) =>
    Array.from({ length: count }, (_, i) => event(eventType, i * spacingMs, subjectFields(rule.subject, who)));

  it("fires when the threshold is reached inside the window", () => {
    const findings = evaluate(rule, burst(rule.threshold, 1000));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: rule.id, severity: rule.severity, count: rule.threshold });
  });

  it("stays quiet one event short of the threshold", () => {
    expect(evaluate(rule, burst(rule.threshold - 1, 1000))).toEqual([]);
  });

  it("stays quiet when the same number of events is spread wider than the window", () => {
    expect(evaluate(rule, burst(rule.threshold, rule.windowMs))).toEqual([]);
  });

  it("counts each subject on its own", () => {
    const half = Math.ceil(rule.threshold / 2);
    const mixed = [...burst(half, 1000), ...burst(half, 1000, rule.subject === "actor" ? uuid(901) : `${subject}-other`)];
    expect(evaluate(rule, mixed)).toEqual([]);
  });

  it("raises one finding per separate burst, not one per event", () => {
    const first = burst(rule.threshold, 1000);
    const second = Array.from({ length: rule.threshold }, (_, i) =>
      event(eventType, 2 * rule.windowMs + i * 1000, subjectFields(rule.subject, subject)),
    );
    expect(evaluate(rule, [...first, ...second])).toHaveLength(2);
  });

  it("ignores an event that has no such subject", () => {
    const noSubject = Array.from({ length: rule.threshold }, (_, i) => event(eventType, i * 1000));
    expect(evaluate(rule, noSubject)).toEqual([]);
  });
});

describe.each(distinctRules)("distinct rule $id", (rule) => {
  const eventType = rule.eventTypes[0] as string;
  const subject = rule.subject === "actor" ? uuid(910) : FULL_HASH;
  const prefix = (i: number): string => `198.51.${i}.0/24`;
  const run = (distinct: number, count = distinct) =>
    Array.from({ length: count }, (_, i) =>
      event(eventType, i * 1000, {
        ...subjectFields(rule.subject, subject),
        ...subjectFields(rule.distinctOf, rule.distinctOf === "ip_prefix" ? prefix(i % distinct) : `v${i % distinct}`),
      }),
    );

  it("fires when the threshold of distinct values is reached inside the window", () => {
    const findings = evaluate(rule, run(rule.threshold));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: rule.id, count: rule.threshold });
  });

  it("stays quiet one distinct value short, however many events repeat", () => {
    expect(evaluate(rule, run(rule.threshold - 1, rule.threshold * 4))).toEqual([]);
  });

  it("stays quiet when the distinct values are spread wider than the window", () => {
    const spread = Array.from({ length: rule.threshold }, (_, i) =>
      event(eventType, i * rule.windowMs, {
        ...subjectFields(rule.subject, subject),
        ...subjectFields(rule.distinctOf, prefix(i)),
      }),
    );
    expect(evaluate(rule, spread)).toEqual([]);
  });
});

describe.each(bulkRules)("bulk access rule $id", (rule) => {
  const hit = (distinctRecords: number) => ({
    actorUserId: uuid(920),
    bucketStart: at(0),
    distinctRecords,
    firstAt: at(1000),
    lastAt: at(60_000),
    sampleEventIds: [1, 2, 3, 4, 5, 6, 7].map(uuid),
  });

  it("fires at the threshold and not one record below it", () => {
    const over = bulkAccessFindings(rule, [hit(rule.threshold)], { organizationId: ORG });
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ count: rule.threshold, subject: { kind: "actor", ref: uuid(920) } });
    expect(over[0]?.sampleEventIds).toHaveLength(MAX_SAMPLE_EVENT_IDS);
    expect(bulkAccessFindings(rule, [hit(rule.threshold - 1)], { organizationId: ORG })).toEqual([]);
  });
});

describe("findings", () => {
  const login = SECURITY_RULES.find((r) => r.id === "auth.brute_force_by_account") as BurstRule;
  const failures = (extra: readonly ReviewEvent[] = []) => [
    ...extra,
    ...Array.from({ length: login.threshold }, (_, i) =>
      event("m2.auth.login_failed", i * 1000, { accountHash: FULL_HASH, ipPrefix: "203.0.113.0/24" }),
    ),
  ];

  it("keeps the same fingerprint when the next run re-reads the burst with extra earlier context", () => {
    const burst = failures();
    const earlier = event("m2.auth.login_failed", -30 * 60_000, { accountHash: "ffffffffffffffffffffffffffffffff" });
    const first = evaluate(login, burst);
    const second = evaluate(login, [earlier, ...burst]);
    expect(second.map((f) => f.fingerprint)).toEqual(first.map((f) => f.fingerprint));
  });

  it("gives the same burst a different fingerprint in a different organization", () => {
    const burst = failures();
    const a = evaluateSignalRules([login], burst, { organizationId: ORG });
    const b = evaluateSignalRules([login], burst, { organizationId: OTHER_ORG });
    expect(a[0]?.fingerprint).not.toBe(b[0]?.fingerprint);
  });

  it("shows only a truncated credential hash, never the whole hash", () => {
    const [finding] = evaluate(login, failures());
    expect(finding?.subject.ref).toBe(FULL_HASH.slice(0, ACCOUNT_HASH_REF_CHARS));
    expect(JSON.stringify(finding)).not.toContain(FULL_HASH);
  });

  it("stays linear under a flood of one subject (30,000 failures from one network never reach a distinct threshold)", () => {
    const rule = SECURITY_RULES.find((r) => r.id === "auth.distributed_attack_on_account") as DistinctRule;
    const flood = Array.from({ length: 30_000 }, (_, i) =>
      event("m2.auth.login_failed", i * 10, { accountHash: FULL_HASH, ipPrefix: "192.0.2.0/24" }),
    );
    const started = performance.now();
    expect(evaluate(rule, flood)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("never treats an unparseable address (\"unknown\") as a network: thirty failures from it are not one subject", () => {
    const rule = SECURITY_RULES.find((r) => r.id === "auth.brute_force_by_network") as BurstRule;
    const unparseable = Array.from({ length: rule.threshold * 2 }, (_, i) =>
      event("m2.auth.login_failed", i * 1000, { ipPrefix: "unknown" }),
    );
    expect(evaluate(rule, unparseable)).toEqual([]);
  });

  it("only accepts a well-formed /24 or /48 as a network subject (it goes verbatim into an alert and a log line)", () => {
    const rule = SECURITY_RULES.find((r) => r.id === "auth.brute_force_by_network") as BurstRule;
    const fromPrefix = (ipPrefix: string) =>
      evaluate(
        rule,
        Array.from({ length: rule.threshold }, (_, i) =>
          event("m2.auth.login_failed", i * 1000, { ipPrefix }),
        ),
      );
    for (const good of ["192.0.2.0/24", "2001:db8:1::/48"]) expect(fromPrefix(good)).toHaveLength(1);
    for (const bad of ["192.0.2.0/8", "192.0.2.0/24\n🔒 fake alert", "<script>/24", "", "::ffff::/16"]) {
      expect(fromPrefix(bad), JSON.stringify(bad)).toEqual([]);
    }
  });

  it("caps the sample of event ids while still counting the whole burst", () => {
    const [finding] = evaluate(login, failures());
    expect(login.threshold).toBeGreaterThan(MAX_SAMPLE_EVENT_IDS);
    expect(finding?.count).toBe(login.threshold);
    expect(finding?.sampleEventIds).toHaveLength(MAX_SAMPLE_EVENT_IDS);
  });

  it("carries ids and codes only: the alert has exactly the documented keys and no free text", () => {
    const [finding] = evaluate(login, failures());
    const alert = toSecurityAlert(finding as NonNullable<typeof finding>, "test-rules-version");
    expect(Object.keys(alert).sort()).toEqual(
      [
        "controls",
        "count",
        "fingerprint",
        "kind",
        "lane",
        "organizationId",
        "ruleId",
        "rulesVersion",
        "runbook",
        "sampleEventIds",
        "severity",
        "subject",
        "title",
        "windowFrom",
        "windowTo",
      ].sort(),
    );
    expect(alert.runbook).toBe("docs/runbooks/security-alert-review.md#auth.brute_force_by_account");
    expect(alert.organizationId).toBeNull();
  });
});
