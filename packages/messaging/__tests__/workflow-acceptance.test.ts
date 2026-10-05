// @wardenx/messaging — M36-T11 §7 Workflow Acceptance Criteria (the consolidated done-means suite).
//
// The §9 unit/integration coverage lives in the per-task suites (fan-out, outcome, sanitize,
// recipient-resolution, alert-rules-seed, destruction, webhooks, cache, jobs, realtime,
// cross-module-composition); the RLS-isolation half (§7.4 DB-level, §9.5) lives in the live
// Postgres suite `packages/db/migrations/__tests__/rls-isolation.live.test.ts`. THIS file is the
// traceability layer the spec frames as §7: one named scenario per §7.1–§7.8 "Done means",
// composing the pure engines into the end-to-end chains the unit suites prove only piecewise.
//
// Everything here is pure and deterministic — no DB, no clock, no vendor. Where a criterion's
// "Done means" is inherently DB- or live-only (§7.4 RLS WITH CHECK, multi-instance pub/sub), the
// scenario asserts the data-layer contract the engines own and points at the live suite.
import { describe, expect, it } from "vitest";
import {
  type Alert,
  type AlertContext,
  DekDestroyedError,
  type DeliverySettlement,
  type FanOutInput,
  // §7.4 / §7.7 — the platform-default alert-rule seed + system_locked floor
  PLATFORM_DEFAULT_ALERT_RULES,
  type PlannedDelivery,
  type RecipientPreferences,
  type RecipientSourcePorts,
  type RoutingMap,
  SYSTEM_LOCKED_EVENT_TYPES,
  computeOutcome,
  createInMemoryMessagingEraseStore,
  // §7.3 — dynamic recipient resolution against the source-of-truth seam
  createRecipientResolverRegistry,
  // §7.8 — D9 tenant-offboarding cryptographic erasure
  eraseTenantMessaging,
  // §7.1 / §7.5 / §7.6 / §7.7 — the fan-out planner + outcome roll-up
  planFanOut,
  resolveRecipients,
  // §7.2 — the PHI sanitizer chokepoint
  sanitizeForOutOfBand,
  validateAlertRuleSeed,
} from "../src/index";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function prefs(over: Partial<RecipientPreferences> & { userId: string }): RecipientPreferences {
  return {
    routingMap: {},
    quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
    vacationForwardToUserId: null,
    vacationUntil: null,
    ...over,
  };
}

function input(over: Partial<FanOutInput> & { alert: AlertContext }): FanOutInput {
  return {
    channelsOverride: null,
    recipientUserIds: [],
    preferences: new Map(),
    at: new Date("2026-06-15T12:00:00Z"), // mid-day UTC, outside any quiet window
    ...over,
  };
}

const rows = (p: PlannedDelivery[], userId: string) =>
  p.filter((r) => r.recipientUserId === userId);

/** Settle a fan-out plan with an outage matrix: any channel in `down` fails for everyone, the
 *  rest ack. Mirrors how the M36-T08 dispatcher collects vendor/socket callbacks into the §2.4.3
 *  outcome roll-up — here driven by a chaos stub so the acceptance assertion turns only on which
 *  transports are "down". */
function settle(
  plan: PlannedDelivery[],
  down: ReadonlySet<PlannedDelivery["channel"]>,
): DeliverySettlement[] {
  // Quiet-hours-skipped / forwarded-original rows never reach a vendor — they don't settle.
  return plan
    .filter((r) => r.status === "pending")
    .map((r) => ({
      recipientUserId: r.forwardedFromUserId ?? r.recipientUserId,
      channel: r.channel,
      delivered: !down.has(r.channel),
    }));
}

// ── §7.1 In-app is the always-available floor ───────────────────────────────────────────────
// Done means: every emit produces ≥1 in_app row per recipient and the floor survives a total
// out-of-band outage — the alert settles `partial`, never `failed`.
describe("§7.1 in-app is the always-available floor", () => {
  const routingMap: RoutingMap = {
    clinical_urgent: { critical: ["in_app", "push", "sms", "email"] },
  };
  const ALERT: AlertContext = {
    eventType: "lab.critical",
    category: "clinical_urgent",
    severity: "critical",
  };

  it("plans an in_app floor for every recipient and survives all out-of-band vendors down (→ partial)", () => {
    const plan = planFanOut(
      input({
        alert: ALERT,
        recipientUserIds: ["u-1", "u-2"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap })],
          ["u-2", prefs({ userId: "u-2", routingMap })],
        ]),
      }),
    );

    // Every recipient has exactly one in_app row, and it is the floor (pending, unconditional).
    for (const u of ["u-1", "u-2"]) {
      const floor = rows(plan, u).filter((r) => r.channel === "in_app");
      expect(floor).toEqual([expect.objectContaining({ channel: "in_app", status: "pending" })]);
    }

    // Chaos: Twilio (sms/voice) + Postmark (email) + web-push (push) all fail; only in_app acks.
    const outcome = computeOutcome(settle(plan, new Set(["push", "sms", "email", "voice"])));
    expect(outcome).toBe("partial"); // not "failed" — the floor reached every recipient
  });

  it("settles `failed` only when even the in-app floor is lost (nobody reached)", () => {
    const plan = planFanOut(
      input({
        alert: ALERT,
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1", routingMap })]]),
      }),
    );
    expect(computeOutcome(settle(plan, new Set(["in_app", "push", "sms", "email"])))).toBe(
      "failed",
    );
  });
});

// ── §7.2 No PHI leaves the perimeter in out-of-band payloads ─────────────────────────────────
// Done means: a red-team alert with PHI in every payload field produces a sanitizer output that
// is PHI-free for every out-of-band channel. (The exhaustive category × channel golden matrix is
// in sanitize.test.ts; this is the acceptance-level chokepoint assertion.)
describe("§7.2 no PHI leaves the perimeter in out-of-band payloads", () => {
  const PHI = "Jane-Doe-MRN-12345-stage-IV";
  const redTeamAlert: Alert = {
    kind: "alert",
    alertId: "al-1",
    notificationDeliveryId: "nd-1",
    category: "clinical_urgent",
    payload: { patientName: PHI, diagnosis: PHI, body: PHI, mrn: PHI },
  };

  it("the sanitizer output carries no payload field for any out-of-band channel", () => {
    for (const channel of ["sms", "email", "push", "voice"] as const) {
      const out = sanitizeForOutOfBand({
        alertOrMessage: redTeamAlert,
        channel,
        recipientUserId: "u-1",
        baseUrl: "https://app.wardenx.test",
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain(PHI);
      expect(serialized).not.toContain("Jane");
      // Only the content-free allowlist (id + generic short + deep link) crosses.
      expect(Object.keys(out).sort()).toEqual(["deepLink", "notificationDeliveryId", "short"]);
      expect(out.deepLink).toBe("https://app.wardenx.test/n/nd-1"); // carries no patient/channel id
    }
  });
});

// ── §7.3 Auto-managed channel membership tracks source-of-truth ─────────────────────────────
// Done means: care-team membership is resolved dynamically from the source-of-truth seam at emit
// time — a change at the source is reflected on the next resolve (never a frozen list on the rule).
describe("§7.3 auto-managed membership tracks source-of-truth", () => {
  function portsWith(careTeam: Map<string, readonly string[]>): RecipientSourcePorts {
    return {
      careTeamMembers: async (_org, patientId) => careTeam.get(patientId) ?? [],
      onCallMembers: async () => [],
      disciplineMembers: async () => [],
      roleSetMembers: async () => [],
      tenantAdmins: async () => [],
      orgMembers: async () => [],
    };
  }

  it("re-resolves care-team recipients when the source-of-truth changes between emits", async () => {
    const careTeam = new Map<string, readonly string[]>([["pt-1", ["rn-1", "md-1"]]]);
    const registry = createRecipientResolverRegistry(portsWith(careTeam));
    const payload = { patientId: "pt-1" };

    const before = await resolveRecipients(
      registry,
      "care_team",
      "org-1",
      { patientIdPath: "patientId" },
      payload,
    );
    expect(before).toEqual(["rn-1", "md-1"]);

    // The care team changes at the source (RN swapped out, social worker added).
    careTeam.set("pt-1", ["md-1", "sw-1"]);
    const after = await resolveRecipients(
      registry,
      "care_team",
      "org-1",
      { patientIdPath: "patientId" },
      payload,
    );
    expect(after).toEqual(["md-1", "sw-1"]); // re-synced, not frozen on the rule
  });
});

// ── §7.4 Tenant cannot disable system_locked rules ──────────────────────────────────────────
// Done means: SOS, NOE late-risk, and backup-failure are seeded system_locked + enabled, and the
// seed validator refuses any attempt to loosen or drop one. (The RLS WITH CHECK that rejects a
// tenant UPDATE on a system_locked row is proven on real Postgres in the live suite — §7.4/§9.4.)
describe("§7.4 tenant cannot disable system_locked rules", () => {
  it("the three life/revenue/data-safety floors are present, system_locked, and enabled", () => {
    expect([...SYSTEM_LOCKED_EVENT_TYPES].sort()).toEqual(
      [
        "field_safety.sos",
        "m3.breakglass.invoked",
        "noe.late_risk",
        "system.backup_failure",
      ].sort(),
    );
    for (const eventType of SYSTEM_LOCKED_EVENT_TYPES) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
      expect(rule).toBeDefined();
      expect(rule?.systemLocked).toBe(true);
      expect(rule?.enabled).toBe(true);
    }
    expect(validateAlertRuleSeed(PLATFORM_DEFAULT_ALERT_RULES)).toEqual([]);
  });

  it("the validator refuses a loosened (disabled) system_locked floor", () => {
    const loosened = PLATFORM_DEFAULT_ALERT_RULES.map((r) =>
      r.eventType === "field_safety.sos" ? { ...r, enabled: false } : r,
    );
    const violations = validateAlertRuleSeed(loosened);
    expect(violations.some((v) => v.type === "system_locked_disabled")).toBe(true);
  });
});

// ── §7.5 Quiet hours respect severity override ──────────────────────────────────────────────
// Done means: an `info` alert in a user's quiet window is in-app only (out-of-band
// skipped_quiet_hours); a `critical` in the same window punches through every preferred channel.
describe("§7.5 quiet hours respect severity override", () => {
  const quietNight = {
    tz: "UTC",
    ranges: [{ daysOfWeek: ALL_DAYS, start: "21:00", end: "07:00" }],
    severityOverride: "critical" as const,
  };
  const routingMap: RoutingMap = {
    administrative: { info: ["in_app", "push"] },
    clinical_urgent: { critical: ["in_app", "push"] },
  };
  const atNight = new Date("2026-06-15T22:00:00Z"); // inside 21:00–07:00 UTC

  it("info in the window → in-app delivered, out-of-band skipped_quiet_hours", () => {
    const plan = planFanOut(
      input({
        alert: { eventType: "x.info", category: "administrative", severity: "info" },
        recipientUserIds: ["u-1"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap, quietHours: quietNight })],
        ]),
        at: atNight,
      }),
    );
    expect(rows(plan, "u-1")).toEqual([
      expect.objectContaining({ channel: "in_app", status: "pending" }),
      expect.objectContaining({ channel: "push", status: "skipped_quiet_hours" }),
    ]);
  });

  it("critical in the same window → every preferred channel punches through (at/above the floor)", () => {
    const plan = planFanOut(
      input({
        alert: { eventType: "lab.critical", category: "clinical_urgent", severity: "critical" },
        recipientUserIds: ["u-1"],
        preferences: new Map([
          ["u-1", prefs({ userId: "u-1", routingMap, quietHours: quietNight })],
        ]),
        at: atNight,
      }),
    );
    expect(plan.every((r) => r.status === "pending")).toBe(true);
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "push"]);
  });
});

// ── §7.6 Vacation forwarding works and is bounded ───────────────────────────────────────────
// Done means: an active vacation redirect produces a `forwarded` row for the original + delivery
// rows for the backup; an expired window delivers to the original; forwarding is single-hop.
describe("§7.6 vacation forwarding works and is bounded", () => {
  const routingMap: RoutingMap = { clinical_routine: { warn: ["in_app", "sms"] } };
  const ALERT: AlertContext = {
    eventType: "m10.hope.sfv_created",
    category: "clinical_routine",
    severity: "warn",
  };
  const now = new Date("2026-06-15T12:00:00Z");

  it("active window → forwarded row for the original + the backup receives out-of-band", () => {
    const plan = planFanOut(
      input({
        alert: ALERT,
        recipientUserIds: ["u-orig"],
        preferences: new Map([
          [
            "u-orig",
            prefs({
              userId: "u-orig",
              routingMap,
              vacationForwardToUserId: "u-backup",
              vacationUntil: new Date("2026-06-20T00:00:00Z"),
            }),
          ],
          ["u-backup", prefs({ userId: "u-backup", routingMap })],
        ]),
        at: now,
      }),
    );
    // original: in_app floor (always) + a `forwarded` sms marker; backup: a pending sms.
    expect(rows(plan, "u-orig")).toEqual([
      expect.objectContaining({ channel: "in_app", status: "pending", forwardedFromUserId: null }),
      expect.objectContaining({ channel: "sms", status: "forwarded", forwardedFromUserId: null }),
    ]);
    expect(rows(plan, "u-backup")).toEqual([
      expect.objectContaining({ channel: "sms", status: "pending", forwardedFromUserId: "u-orig" }),
    ]);
  });

  it("expired window → delivers to the original, no forwarding", () => {
    const plan = planFanOut(
      input({
        alert: ALERT,
        recipientUserIds: ["u-orig"],
        preferences: new Map([
          [
            "u-orig",
            prefs({
              userId: "u-orig",
              routingMap,
              vacationForwardToUserId: "u-backup",
              vacationUntil: new Date("2026-06-10T00:00:00Z"),
            }),
          ],
        ]),
        at: now,
      }),
    );
    expect(plan.every((r) => r.recipientUserId === "u-orig")).toBe(true);
    expect(plan.some((r) => r.status === "forwarded")).toBe(false);
  });
});

// ── §7.7 SOS voice path is Tier-1 redundant ─────────────────────────────────────────────────
// Done means: field_safety.sos rides the system-locked channel set including voice (§2.5
// voice-is-SOS-only), and a voice-dispatcher failure does not sink the alert — the in-app floor +
// the other Tier-1 channels still settle (outcome `partial`), which is the redundancy contract.
describe("§7.7 SOS voice path is Tier-1 redundant", () => {
  const SOS_RULE = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === "field_safety.sos")!;
  const SOS: AlertContext = {
    eventType: "field_safety.sos",
    category: "field_safety",
    severity: "critical",
  };

  it("the SOS rule is system_locked and routes the four-channel set including voice", () => {
    expect(SYSTEM_LOCKED_EVENT_TYPES).toContain("field_safety.sos");
    expect(SOS_RULE.systemLocked).toBe(true);
    expect(SOS_RULE.channelsOverride).toEqual(["in_app", "push", "sms", "voice"]);
  });

  it("voice is planned ONLY for the SOS alert (the §2.5 gate), and a voice outage stays `partial`", () => {
    const plan = planFanOut(
      input({
        alert: SOS,
        channelsOverride: SOS_RULE.channelsOverride,
        recipientUserIds: ["oncall-1"],
        preferences: new Map([["oncall-1", prefs({ userId: "oncall-1" })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app", "push", "sms", "voice"]);

    // Twilio Voice down → the floor + push + sms still ack; the alert is partial, not failed.
    expect(computeOutcome(settle(plan, new Set(["voice"])))).toBe("partial");
  });

  it("the same voice channel is DROPPED for a non-SOS critical (voice is SOS-only)", () => {
    const plan = planFanOut(
      input({
        alert: { eventType: "lab.critical", category: "clinical_urgent", severity: "critical" },
        channelsOverride: ["in_app", "voice"], // even if a rule asks for voice
        recipientUserIds: ["u-1"],
        preferences: new Map([["u-1", prefs({ userId: "u-1" })]]),
      }),
    );
    expect(plan.map((r) => r.channel)).toEqual(["in_app"]); // voice gated away
  });
});

// ── §7.8 Message body cryptographic erasure on tenant offboarding ────────────────────────────
// Done means: eraseFn destroys the tenant DEK FIRST → every body becomes undecryptable BEFORE the
// structural delete; a post-erase decrypt attempt throws; the pass is idempotent. (Full carve-out
// matrix — sole-tenant vs multi-tenant cross rows — is in destruction.test.ts.)
describe("§7.8 message-body cryptographic erasure on offboarding", () => {
  it("DEK destruction renders a still-present body undecryptable (the crypto-erase, pre-delete)", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [{ id: "m1", orgId: "org_A", bodyCipher: "phi" }],
    });
    expect(inMem.tryDecrypt("m1")).toBe("phi");
    await inMem.store.destroyTenantDek("org_A"); // the FIRST step of eraseFn (§7.8)
    expect(() => inMem.tryDecrypt("m1")).toThrow(DekDestroyedError); // body unreadable while row still exists
  });

  it("the full eraseFn renders bodies + deletes structural rows, and is idempotent", async () => {
    const inMem = createInMemoryMessagingEraseStore({
      messages: [{ id: "m1", orgId: "org_A", bodyCipher: "phi" }],
      structural: [{ id: "ch1", orgId: "org_A" }],
    });
    const first = await eraseTenantMessaging("org_A", inMem.store);
    expect(first.bodiesRendered).toBe(1);
    expect(first.erased).toBeGreaterThan(first.bodiesRendered); // structural rows deleted too

    const second = await eraseTenantMessaging("org_A", inMem.store);
    expect(second).toEqual({ bodiesRendered: 0, structuralRows: 0, crossTenantRows: 0, erased: 0 });
  });
});
