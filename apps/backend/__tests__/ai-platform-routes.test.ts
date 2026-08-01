/**
 * M32-T07 — the §4.1 route layer: the §4.6 permission keys, the §4.7 ABAC predicates, the §4.9 typed M36
 * alert payloads and the §4.11 `m32.*` outbox catalog.
 *
 * These tests are about the DECISIONS, not the SQL: every rule below is expressed so it can be exercised
 * with no database, and the Drizzle services compose over them. The §8.2 cross-tenant isolation and the
 * end-to-end paths run against a real PostgreSQL in the live suites (M32-T08).
 *
 * The properties pinned here are the ones the task exists to guarantee:
 *   • all twenty-two §4.6 keys reach M3's catalog, are single-owner, and the step-up set is EXACTLY the
 *     three acts whose blast radius leaves the tenant that performed them;
 *   • the six §4.7 names — and only those — are registered; the four ROLE-shaped cells §4.1 also names
 *     (`organization.member`, `tenant_admin`, `compliance_officer`, `phi.full_read`) are deliberately NOT
 *     registered, because three are already expressed and one is a masking grant rather than a guard;
 *   • `ai_kill_switch_inactive` fails CLOSED on an unreadable table — the inversion that would let an
 *     outage of the safety table resume a capability somebody paused during a SEV-1;
 *   • `ai_capability_clinician_opted_out` fails to FALSE on an unreadable table, which is the OPPOSITE
 *     direction and correct for the same reason: the SDK gate inverts it, so `null → true` would kill a
 *     capability org-wide whenever the consent table blinked;
 *   • `ai_capability_tenant_opted_in` treats `paused` as NOT opted in, so §5.3's pause is not a no-op;
 *   • `ai_safety_owner` passes on the SESSION's role set with no membership — it is the one cross-tenant
 *     authority, and an org-scoped resolver has no row for a platform operator;
 *   • `ai_prohibited_zone_respected` denies on an unreadable registry and allows only on a genuine `[]`;
 *   • R16's masking removes the patient identity and the free-text error and NOTHING else, and
 *     `touchedPatientChart` survives masking (the fact §164.528 turns on);
 *   • every §4.9 alert type has a payload arm, and the two system-locked ones are unsuppressible;
 *   • every §4.11 event is `m32.`-namespaced, owned by `m32`, and names only real consumer modules.
 */
import {
  M32_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  createPredicateRegistry,
} from "@wardenx/auth";
import { describe, expect, it } from "vitest";

import {
  type AiPlatformAbacResolver,
  AI_COMPLIANCE_READER_ROLE_KEYS,
  AI_SAFETY_OWNER_ROLE_KEYS,
  M32_ABAC_PREDICATES,
  buildAiPlatformAbacPredicates,
  denyStubAiPlatformAbacResolver,
} from "../src/modules/32-ai-platform/abac-predicates";
import {
  type M32AlertPayload,
  M32_ALERT_TYPES,
  M32_SYSTEM_LOCKED_ALERT_TYPES,
  alertOrganizationId,
  emitAiAlert,
  isAiAlertSuppressible,
} from "../src/modules/32-ai-platform/alerts";
import { M32_OUTBOX_EVENTS } from "../src/modules/32-ai-platform/events-by-m32";
import {
  M32_PERMISSION_KEY_LIST,
  M32_READ_AUDITED_PERMISSION_KEYS,
  M32_STEP_UP_PERMISSION_KEYS,
} from "../src/modules/32-ai-platform/permission-keys";
import {
  type AiInvocationLedgerView,
  M32_PAGE_SIZES,
  clampLimit,
  maskInvocationForActor,
} from "../src/modules/32-ai-platform/routes/read-service";
import { calendarMonthWindow } from "../src/modules/32-ai-platform/routes/read-service-drizzle";

// ── §4.6 permission keys ────────────────────────────────────────────────────────────────────────────

describe("M32-T07 §4.6 — the twenty-two permission keys", () => {
  it("registers exactly the §4.6 catalog", () => {
    expect(M32_PERMISSION_KEY_LIST.length).toBe(22);
    expect(M32_PERMISSION_KEY_LIST.every((key) => key.startsWith("ai."))).toBe(true);
  });

  it("does not leak into M3's locked cross-cutting catalog", () => {
    for (const key of M32_PERMISSION_KEY_LIST) {
      expect(key in PERMISSIONS).toBe(false);
    }
  });

  it("reaches the platform mirror exactly once each (single-owner)", () => {
    const mirror = allPermissionMirrorRows().map((r) => r.key);
    for (const key of M32_PERMISSION_KEY_LIST) {
      expect(mirror.filter((k) => k === key).length).toBe(1);
    }
  });

  it("files the disclosure ledger under `compliance` and the opt-out under `self_service`", () => {
    // Decisions 1 and 2 in contributed.ts: an `ai_invocation` read is an accounting-of-disclosures act,
    // and a clinician's opt-out row has the clinician as its own data subject.
    expect(M32_CONTRIBUTED_PERMISSIONS["ai.invocation.read"].category).toBe("compliance");
    expect(M32_CONTRIBUTED_PERMISSIONS["ai.clinician_opt_out"].category).toBe("self_service");
    expect(M32_CONTRIBUTED_PERMISSIONS["ai.clinician_opt_out.read"].category).toBe("self_service");
  });

  it("gives activate and deactivate ONE kill-switch key (decision 3)", () => {
    // Splitting them would let a tenant hold "may un-pause" without "may pause".
    const killKeys = M32_PERMISSION_KEY_LIST.filter((k) => k.startsWith("ai.kill_switch."));
    expect(killKeys.sort()).toEqual(["ai.kill_switch.activate", "ai.kill_switch.read"]);
  });

  it("carries step-up on EXACTLY the three acts whose blast radius leaves the tenant", () => {
    expect([...M32_STEP_UP_PERMISSION_KEYS].sort()).toEqual(
      ["ai.capability.transition", "ai.kill_switch.activate", "ai.prompt.activate"].sort(),
    );
    // A capability REGISTRATION is deliberately absent: PROPOSED serves nothing, so it changes no
    // clinician's screen. So is the tenant opt-in — §5.3's gate is the acknowledgment evidence, and
    // stacking a re-auth would train admins to step up for a form rather than for a consequence.
    expect(M32_STEP_UP_PERMISSION_KEYS).not.toContain("ai.capability.create");
    expect(M32_STEP_UP_PERMISSION_KEYS).not.toContain("ai.tenant_opt_in");
  });

  it("read-audits the disclosure ledger and nothing else", () => {
    expect([...M32_READ_AUDITED_PERMISSION_KEYS]).toEqual(["ai.invocation.read"]);
  });
});

// ── §4.7 ABAC predicates ────────────────────────────────────────────────────────────────────────────

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const CAPABILITY = "44444444-4444-4444-8444-444444444444";

function contextOf(overrides: Partial<Parameters<ReturnType<typeof buildAiPlatformAbacPredicates>["ai_safety_owner"]>[0]> = {}) {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [] as readonly string[],
    providerEntityIds: [] as readonly string[],
    locationIds: [] as readonly string[],
    attributes: { membershipId: MEMBER } as Record<string, unknown>,
    ...overrides,
  };
}

/** A resolver whose every answer is supplied per-test; anything unset falls back to the deny-stub. */
function resolverOf(overrides: Partial<AiPlatformAbacResolver>): AiPlatformAbacResolver {
  return { ...denyStubAiPlatformAbacResolver, ...overrides };
}

describe("M32-T07 §4.7 — the six registered predicates", () => {
  it("registers exactly the six §4.7 names", () => {
    expect([...M32_ABAC_PREDICATES].sort()).toEqual(
      [
        "ai_capability_clinician_opted_out",
        "ai_capability_tenant_opted_in",
        "ai_invocation_same_org_or_safety_owner",
        "ai_kill_switch_inactive",
        "ai_prohibited_zone_respected",
        "ai_safety_owner",
      ].sort(),
    );
  });

  it("does NOT register the four role-shaped cells §4.1 also names", () => {
    // `organization.member` IS M3's intrinsic `inOrg`; `tenant_admin` / `compliance_officer` are already
    // expressed by §4.6's default grants; `phi.full_read` is a masking grant consumed by the projection,
    // not a guard. Registering any of them would create a second copy of a rule that must never disagree.
    for (const name of ["inOrg", "org_scope", "tenant_admin", "compliance_officer", "phi.full_read"]) {
      expect(M32_ABAC_PREDICATES).not.toContain(name as never);
    }
  });

  it("registers into a fresh M3 registry without collision", () => {
    const registry = createPredicateRegistry();
    const predicates = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
    for (const [name, predicate] of Object.entries(predicates)) registry.register(name, predicate);
    expect(registry.names().length).toBeGreaterThanOrEqual(M32_ABAC_PREDICATES.length);
    // Single-owner: a second registration of the same name throws (catches a double-wire bug at boot).
    expect(() => registry.register("ai_safety_owner", predicates.ai_safety_owner)).toThrow();
  });

  describe("ai_safety_owner — the ONE cross-tenant authority", () => {
    it("passes on the SESSION's role set with no membership at all", () => {
      // A platform operator acting on a tenant they hold no membership in has no row for an org-scoped
      // resolver to find. The assembled role set is the only place that authority is visible.
      const p = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
      return expect(
        p.ai_safety_owner(contextOf({ roles: ["platform_ops"], attributes: {} }), {}),
      ).resolves.toBe(true);
    });

    it("falls back to the resolver for a tenant-side designee", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({ roleKeysOf: async () => ["clinical_safety_lead"] }),
      });
      await expect(p.ai_safety_owner(contextOf(), {})).resolves.toBe(true);
    });

    it("denies an unreadable resolver and a role set that carries no safety authority", async () => {
      const p = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
      await expect(p.ai_safety_owner(contextOf({ roles: ["registered_nurse"] }), {})).resolves.toBe(
        false,
      );
    });

    it("keeps the compliance reader OUT of the safety-owner role set", () => {
      // §4.1 lists `compliance_officer` beside `ai_safety_owner` as a SEPARATE arm; folding it in would
      // silently grant the compliance officer the R1/R4/R7 write surface.
      for (const role of AI_COMPLIANCE_READER_ROLE_KEYS) {
        expect(AI_SAFETY_OWNER_ROLE_KEYS).not.toContain(role as never);
      }
    });
  });

  describe("ai_capability_tenant_opted_in", () => {
    const optIn = (status: string, optedOutAt: string | null = null) =>
      buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          loadTenantOptIn: async () => ({
            organizationId: ORG,
            capabilityId: CAPABILITY,
            status,
            optedOutAt,
          }),
        }),
      });

    it("passes only on `active`", async () => {
      await expect(
        optIn("active").ai_capability_tenant_opted_in(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(true);
    });

    it("treats `paused` as NOT opted in — otherwise §5.3's pause is a no-op", async () => {
      await expect(
        optIn("paused").ai_capability_tenant_opted_in(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(false);
    });

    it("denies an absent or unreadable opt-in row", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({ resolveCapabilityId: async () => CAPABILITY }),
      });
      await expect(
        p.ai_capability_tenant_opted_in(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(false);
    });
  });

  describe("ai_capability_clinician_opted_out — the INVERTED one", () => {
    it("is TRUE when the clinician HAS opted out (the name states the measurement)", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          clinicianOptedOut: async () => true,
        }),
      });
      await expect(
        p.ai_capability_clinician_opted_out(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(true);
    });

    it("answers FALSE on an unreadable consent table — the OPPOSITE direction from the kill switch", async () => {
      // The SDK gate INVERTS this predicate, so a `null → true` reading would fail the gate closed for a
      // clinician who never opted out: a capability silently dead org-wide whenever the table blinked.
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          clinicianOptedOut: async () => null,
        }),
      });
      await expect(
        p.ai_capability_clinician_opted_out(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(false);
    });
  });

  describe("ai_kill_switch_inactive — fails CLOSED", () => {
    it("passes only when the table says no switch is active", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          killSwitchActive: async () => false,
        }),
      });
      await expect(
        p.ai_kill_switch_inactive(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(true);
    });

    it("REFUSES on an unreadable table (`null` is not `inactive`)", async () => {
      // Guessing "no switch" from a failed read would let an outage of the safety table resume a
      // capability somebody paused during a SEV-1.
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          killSwitchActive: async () => null,
        }),
      });
      await expect(
        p.ai_kill_switch_inactive(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(false);
    });

    it("refuses when a switch IS active", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          resolveCapabilityId: async () => CAPABILITY,
          killSwitchActive: async () => true,
        }),
      });
      await expect(
        p.ai_kill_switch_inactive(contextOf(), { capabilityId: CAPABILITY }),
      ).resolves.toBe(false);
    });
  });

  describe("ai_invocation_same_org_or_safety_owner", () => {
    const withRow = (organizationId: string) =>
      buildAiPlatformAbacPredicates({
        resolver: resolverOf({
          loadInvocation: async () => ({
            invocationId: "inv-1",
            organizationId,
            invokedAt: "2026-07-01T00:00:00.000Z",
          }),
        }),
      });

    it("passes for the row's own org", async () => {
      await expect(
        withRow(ORG).ai_invocation_same_org_or_safety_owner(contextOf(), { invocationId: "inv-1" }),
      ).resolves.toBe(true);
    });

    it("refuses a cross-tenant row", async () => {
      await expect(
        withRow(OTHER_ORG).ai_invocation_same_org_or_safety_owner(contextOf(), {
          invocationId: "inv-1",
        }),
      ).resolves.toBe(false);
    });

    it("passes the cross-tenant safety owner WITHOUT resolving the row", async () => {
      // The disjunction lives inside the predicate, which is why the route binds ONE requireAbac.
      const p = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
      await expect(
        p.ai_invocation_same_org_or_safety_owner(contextOf({ roles: ["platform_ops"] }), {
          invocationId: "inv-1",
        }),
      ).resolves.toBe(true);
    });
  });

  describe("ai_prohibited_zone_respected — D18", () => {
    it("allows only on a genuine empty answer", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({ activePromptsTargeting: async () => [] }),
      });
      await expect(
        p.ai_prohibited_zone_respected(contextOf(), { consumerModulePrefix: "medication_" }),
      ).resolves.toBe(true);
    });

    it("REFUSES on an unreadable registry — `[]` minted from a failed read is a clean bill nobody issued", async () => {
      const p = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
      await expect(
        p.ai_prohibited_zone_respected(contextOf(), { consumerModulePrefix: "medication_" }),
      ).resolves.toBe(false);
    });

    it("refuses when a template targets the zone", async () => {
      const p = buildAiPlatformAbacPredicates({
        resolver: resolverOf({ activePromptsTargeting: async () => [{ templateKey: "bad" }] }),
      });
      await expect(
        p.ai_prohibited_zone_respected(contextOf(), { consumerModulePrefix: "medication_" }),
      ).resolves.toBe(false);
    });
  });

  it("every predicate denies a context with no organization (except the cross-tenant owner)", async () => {
    const p = buildAiPlatformAbacPredicates({ resolver: denyStubAiPlatformAbacResolver });
    const orgless = contextOf({ organizationId: "" });
    for (const name of [
      "ai_capability_tenant_opted_in",
      "ai_capability_clinician_opted_out",
      "ai_kill_switch_inactive",
      "ai_invocation_same_org_or_safety_owner",
    ] as const) {
      await expect(p[name](orgless, { capabilityId: CAPABILITY, invocationId: "inv-1" })).resolves.toBe(
        false,
      );
    }
  });
});

// ── R16's masking (§4.1) ────────────────────────────────────────────────────────────────────────────

const LEDGER_ROW: AiInvocationLedgerView = {
  invocationId: "inv-1",
  organizationId: ORG,
  providerEntityId: "pe-1",
  locationId: null,
  capabilityId: CAPABILITY,
  capabilityKey: "hearthnote_layer2",
  backendId: "backend-1",
  backendKey: "anthropic_sonnet",
  modelVersionPin: "claude-sonnet-5",
  promptTemplateVersion: "3",
  actorMembershipId: MEMBER,
  actorRole: "registered_nurse",
  patientId: "patient-1",
  touchedPatientChart: true,
  consumerCorrelationId: null,
  routingDecision: "cloud",
  routingReason: "capability_default",
  inputTokenCount: 1200,
  outputTokenCount: 340,
  durationMs: 900,
  status: "completed",
  errorClass: null,
  errorMessage: "upstream returned 429 for request abc",
  hitlOutcome: "pending",
  zdrConfirmed: true,
  invokedAt: "2026-07-01T12:00:00.000Z",
  completedAt: "2026-07-01T12:00:01.000Z",
  disclosedToVendor: true,
};

describe("M32-T07 §4.1 R16 — the masking rule", () => {
  it("removes the patient identity and the free-text error, and nothing else", () => {
    const masked = maskInvocationForActor(LEDGER_ROW, false);
    expect(masked.patientId).toBeNull();
    expect(masked.errorMessage).toBeNull();
    // Everything a §164.528 accounting needs survives: who it went to, when, under what model pin, and
    // whether Zero-Data-Retention was confirmed.
    expect(masked.capabilityKey).toBe(LEDGER_ROW.capabilityKey);
    expect(masked.backendKey).toBe(LEDGER_ROW.backendKey);
    expect(masked.modelVersionPin).toBe(LEDGER_ROW.modelVersionPin);
    expect(masked.zdrConfirmed).toBe(true);
    expect(masked.disclosedToVendor).toBe(true);
  });

  it("keeps `touchedPatientChart` TRUE through masking", () => {
    // The fact §164.528 turns on. Deriving it from `patientId !== null` would make "you may not see the
    // patient" indistinguishable from "there was no patient" — opposite answers to the same question.
    expect(maskInvocationForActor(LEDGER_ROW, false).touchedPatientChart).toBe(true);
  });

  it("is the identity for an actor holding phi.full_read", () => {
    expect(maskInvocationForActor(LEDGER_ROW, true)).toEqual(LEDGER_ROW);
  });

  it("has no field for a prompt, a response or a chart context at all", () => {
    // Structural, not a runtime branch: the strongest grant on the platform cannot surface them.
    for (const field of ["promptPayloadCipher", "responsePayloadCipher", "chartContextCipher"]) {
      expect(field in LEDGER_ROW).toBe(false);
    }
  });
});

describe("M32-T07 §4.1 — paging + the ledger window", () => {
  it("clamps a caller's limit into the page-size bounds", () => {
    expect(clampLimit(undefined)).toBe(M32_PAGE_SIZES.default);
    expect(clampLimit(0)).toBe(M32_PAGE_SIZES.default);
    expect(clampLimit(10)).toBe(10);
    expect(clampLimit(10_000)).toBe(M32_PAGE_SIZES.max);
  });

  it("computes the CALENDAR month window the ledger is partitioned by", () => {
    const { start, end } = calendarMonthWindow("2026-07-17T09:30:00.000Z");
    expect(start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("rolls the year over at December", () => {
    const { end } = calendarMonthWindow("2026-12-31T23:59:59.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

// ── §4.9 alerts ─────────────────────────────────────────────────────────────────────────────────────

describe("M32-T07 §4.9 — the ten typed M36 alert payloads", () => {
  it("declares ten discriminators", () => {
    expect(M32_ALERT_TYPES.length).toBe(10);
    expect(new Set(M32_ALERT_TYPES).size).toBe(10);
  });

  it("keeps the two safety alerts unsuppressible", () => {
    // An agency under cost pressure has an obvious motive to mute exactly these.
    expect([...M32_SYSTEM_LOCKED_ALERT_TYPES].sort()).toEqual(
      ["ai.hallucination_triage_escalation", "ai.kill_switch_activated"].sort(),
    );
    for (const type of M32_SYSTEM_LOCKED_ALERT_TYPES) {
      expect(isAiAlertSuppressible(type)).toBe(false);
    }
    expect(isAiAlertSuppressible("ai.token_soft_cap_warning")).toBe(true);
  });

  it("carries a null org on a PLATFORM-scoped kill switch and a real one on a tenant alert", () => {
    const platform: M32AlertPayload = {
      alertType: "ai.kill_switch_activated",
      capabilityId: CAPABILITY,
      capabilityKey: "hearthnote_layer2",
      scope: "platform",
      organizationId: null,
      activatedByMembershipId: MEMBER,
      reasonCategory: "sev1_hallucination",
      severity: "sev1",
    };
    const tenant: M32AlertPayload = {
      alertType: "ai.token_soft_cap_warning",
      organizationId: ORG,
      capabilityId: CAPABILITY,
      capabilityKey: "hearthnote_layer2",
      spentTokens: 900,
      softCap: 1000,
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: "2026-08-01T00:00:00.000Z",
    };
    expect(alertOrganizationId(platform)).toBeNull();
    expect(alertOrganizationId(tenant)).toBe(ORG);
  });

  it("reports whether the alert LEFT the building rather than swallowing the answer", async () => {
    const payload: M32AlertPayload = {
      alertType: "ai.evaluation_failed",
      runId: "run-1",
      capabilityId: CAPABILITY,
      capabilityKey: "hearthnote_layer2",
      organizationId: null,
      failureReason: "golden_set_regression",
    };
    // Unmounted M36 → false, never a throw: every M32 alert is ABOUT something already recorded, so a
    // lost page delays a human whereas a throw would 500 the write that made the fact true.
    await expect(emitAiAlert(payload, null)).resolves.toBe(false);
    const sent: unknown[] = [];
    await expect(
      emitAiAlert(payload, {
        emit: async (input) => {
          sent.push(input);
        },
      }),
    ).resolves.toBe(true);
    expect(sent.length).toBe(1);
    // A bus that throws is caught for the same reason.
    await expect(
      emitAiAlert(payload, {
        emit: async () => {
          throw new Error("M36 down");
        },
      }),
    ).resolves.toBe(false);
  });
});

// ── §4.11 outbox catalog ────────────────────────────────────────────────────────────────────────────

describe("M32-T07 §4.11 — the `m32.*` outbox catalog", () => {
  const KNOWN_MODULES = new Set(["m4", "m35", "m36"]);

  it("namespaces every event under `m32.` and owns it", () => {
    for (const entry of M32_OUTBOX_EVENTS) {
      expect(entry.eventName.startsWith("m32.")).toBe(true);
      expect(entry.moduleOwner).toBe("m32");
      // `mN.<resource>.<verb>` — three segments, which is what check-fitness-gaps scans for.
      expect(entry.eventName.split(".").length).toBe(3);
    }
  });

  it("names only real consumer modules", () => {
    for (const entry of M32_OUTBOX_EVENTS) {
      for (const consumer of entry.declaredConsumers) {
        expect(KNOWN_MODULES.has(consumer)).toBe(true);
      }
    }
  });

  it("has no duplicate event name", () => {
    const names = M32_OUTBOX_EVENTS.map((e) => e.eventName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the disclosure feeder a SEPARATE event from the invocation (M32-F03/ADR-0013)", () => {
    // M4's §164.528 accounting sink subscribes to the disclosure event ALONE. A boolean on the
    // invocation event would make the accounting query a filter a future consumer could forget.
    const disclosure = M32_OUTBOX_EVENTS.find((e) => e.eventName === "m32.phi.disclosed");
    const invoked = M32_OUTBOX_EVENTS.find((e) => e.eventName === "m32.capability.invoked");
    expect(disclosure).toBeDefined();
    expect(invoked).toBeDefined();
    expect(disclosure?.declaredConsumers).toContain("m4");
    expect(Object.keys((invoked?.payloadSchema as { properties: object }).properties)).not.toContain(
      "patientId",
    );
  });

  it("emits FOUR discrete HITL events, not one with an outcome field (M32-F03/AI-082)", () => {
    const hitl = M32_OUTBOX_EVENTS.filter((e) => e.eventName.startsWith("m32.output.")).map(
      (e) => e.eventName,
    );
    expect(hitl.sort()).toEqual(
      ["m32.output.accepted", "m32.output.edited", "m32.output.flagged", "m32.output.rejected"].sort(),
    );
  });

  it("keeps token counts OFF the local-inference event (decision 4)", () => {
    // Nothing left the agency's own hardware, so there is nothing for M35 to meter.
    const local = M32_OUTBOX_EVENTS.find((e) => e.eventName === "m32.local_inference.recorded");
    const props = Object.keys((local?.payloadSchema as { properties: object }).properties);
    expect(props).not.toContain("inputTokens");
    expect(props).not.toContain("outputTokens");
    expect(local?.declaredConsumers).not.toContain("m35");
  });

  it("fans the kill switch and the prompt activation OUT (not outbox-only)", () => {
    // §4.8's `ai:kill-switch-broadcast` is what makes every instance's in-memory gate refresh within 5s,
    // and every consumer module's boot cache invalidates off the prompt activation.
    for (const name of [
      "m32.kill_switch.activated",
      "m32.kill_switch.deactivated",
      "m32.prompt_template.activated",
    ]) {
      expect(M32_OUTBOX_EVENTS.find((e) => e.eventName === name)?.isOutboxOnly).toBe(false);
    }
  });

  it("carries no prompt, response, chart excerpt or narrative in any payload (decision 1)", () => {
    const forbidden = [
      "promptPayload",
      "responsePayload",
      "chartContext",
      "narrative",
      "reporterNarrative",
      "promptBody",
    ];
    for (const entry of M32_OUTBOX_EVENTS) {
      const props = Object.keys((entry.payloadSchema as { properties: object }).properties);
      for (const field of forbidden) {
        expect(props).not.toContain(field);
      }
    }
  });
});
