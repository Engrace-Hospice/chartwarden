// @chartwarden/saas-tenant-platform — §2.2 D2 tenant-lifecycle state machine (M34).
//
// Proves the pure, IO-free eleven-state lifecycle (src/services/lifecycle-transition.ts):
//   - every §2.2 LEGAL transition is allowed and lands on the right state;
//   - every ILLEGAL (off-graph) transition is rejected with ILLEGAL_TENANT_TRANSITION;
//   - the §2.4 guards reject on the precise failure code (TENANT_KEY_MISSING, BAA_*,
//     RETENTION_NOT_ELAPSED, LEGAL_HOLD_ACTIVE, NOT_SHRED_WORKER, NO_PART_TWO_REFUSAL,
//     TRANSITION_REASON_REQUIRED);
//   - the §2.5 in-transaction side-effect intents (status_event ledger row, m34.tenant.*
//     outbox event, worker queue job, session cascade, alerts) are surfaced per transition.
//
// The M11/M12 order-machine test precedent (packages/dosespot/__tests__/medication-order-machine.test.ts):
// the machine returns DECISIONS as data, so we assert the returned state + effect list with no DB/IO.
import { describe, expect, it } from "vitest";
import {
  type LifecycleEvent,
  type LifecycleSideEffect,
  type LifecycleTransition,
  TENANT_LIFECYCLE_GRAPH,
  TenantLifecycleError,
  type TenantLifecycleState,
  transitionTenant,
} from "../src/services";

// ── helpers ─────────────────────────────────────────────────────────────────

/** Collect the `m34.tenant.*` outbox events a transition declares (order-preserving). */
function outboxEvents(t: LifecycleTransition): string[] {
  return t.effects
    .filter((e): e is Extract<LifecycleSideEffect, { kind: "outbox" }> => e.kind === "outbox")
    .map((e) => e.event);
}

/** Collect the worker queue jobs a transition declares (§2.5). */
function queueJobs(t: LifecycleTransition): string[] {
  return t.effects
    .filter((e): e is Extract<LifecycleSideEffect, { kind: "queue_job" }> => e.kind === "queue_job")
    .map((e) => e.job);
}

/** Collect the M36 alert keys a transition declares (§2.5). */
function alertKeys(t: LifecycleTransition): string[] {
  return t.effects
    .filter((e): e is Extract<LifecycleSideEffect, { kind: "alert" }> => e.kind === "alert")
    .map((e) => e.alertKey);
}

/** The ordered set of effect kinds a transition declares. */
function effectKinds(t: LifecycleTransition): string[] {
  return t.effects.map((e) => e.kind);
}

const REASON = "platform-ops decision" as const;

/**
 * A complete, guard-passing event for each lifecycle event type (the §2.4 happy path).
 *
 * Generic in the type so it returns the ONE arm asked for. Returning the whole `LifecycleEvent` union
 * made the `{ ...validEvent("activate"), canonicalTasksComplete: false }` override pattern this suite is
 * built on illegal — the spread distributes over every arm and no single arm satisfies the union.
 */
function validEvent<T extends LifecycleEvent["type"]>(
  type: T,
): Extract<LifecycleEvent, { type: T }> {
  return validEventOfType(type) as Extract<LifecycleEvent, { type: T }>;
}

function validEventOfType(type: LifecycleEvent["type"]): LifecycleEvent {
  switch (type) {
    case "accept":
      return { type, actorKind: "platform_ops", transitionReason: REASON };
    case "provisioned":
      return {
        type,
        actorKind: "system_automated",
        transitionReason: REASON,
        tenantKeyRingReady: true,
      };
    case "activate":
      return {
        type,
        actorKind: "platform_ops",
        transitionReason: REASON,
        canonicalTasksComplete: true,
        baaExecuted: true,
        baaExpiryClearsNinetyDays: true,
      };
    case "suspend":
      return { type, actorKind: "platform_ops", transitionReason: REASON };
    case "reactivate":
      return { type, actorKind: "platform_ops", transitionReason: REASON };
    case "flagAtRisk":
      return { type, actorKind: "system_automated", transitionReason: REASON };
    case "resolveAtRisk":
      return { type, actorKind: "system_automated", transitionReason: REASON };
    case "suspendFromAtRisk":
      return { type, actorKind: "platform_ops", transitionReason: REASON };
    case "initiateOffboarding":
      return {
        type,
        actorKind: "platform_security_owner",
        transitionReason: REASON,
        exportPurpose: "baa_termination",
      };
    case "requestFinalExport":
      return { type, actorKind: "org_admin", transitionReason: REASON };
    case "completeExport":
      return { type, actorKind: "org_admin", transitionReason: REASON };
    case "scheduleDestruction":
      return {
        type,
        actorKind: "platform_security_owner",
        transitionReason: REASON,
        retentionElapsed: true,
        legalHoldClear: true,
      };
    case "shred":
      return {
        type,
        actorKind: "system_automated",
        transitionReason: REASON,
        isShredWorker: true,
      };
    case "deferForPartTwoRetention":
      return {
        type,
        actorKind: "system_automated",
        transitionReason: REASON,
        eraserRefusedPartTwo: true,
      };
  }
}

// ── §2.2 — the legal transition graph ────────────────────────────────────────

/** Each legal §2.2 edge: from-state, the event, the to-state, and its lead `m34.tenant.*` outbox. */
const LEGAL_EDGES: ReadonlyArray<{
  readonly from: TenantLifecycleState;
  readonly type: LifecycleEvent["type"];
  readonly to: TenantLifecycleState;
  readonly outbox: string;
}> = [
  {
    from: "signup_intent",
    type: "accept",
    to: "provisioning",
    outbox: "m34.tenant.provision_started",
  },
  { from: "provisioning", type: "provisioned", to: "onboarding", outbox: "m34.tenant.provisioned" },
  { from: "onboarding", type: "activate", to: "active", outbox: "m34.tenant.activated" },
  { from: "active", type: "suspend", to: "suspended", outbox: "m34.tenant.suspension_initiated" },
  { from: "suspended", type: "reactivate", to: "active", outbox: "m34.tenant.reactivated" },
  { from: "active", type: "flagAtRisk", to: "at_risk", outbox: "m34.tenant.at_risk" },
  { from: "at_risk", type: "resolveAtRisk", to: "active", outbox: "m34.tenant.reactivated" },
  {
    from: "at_risk",
    type: "suspendFromAtRisk",
    to: "suspended",
    outbox: "m34.tenant.suspension_initiated",
  },
  {
    from: "active",
    type: "initiateOffboarding",
    to: "offboarding_initiated",
    outbox: "m34.tenant.offboarding_initiated",
  },
  {
    from: "suspended",
    type: "initiateOffboarding",
    to: "offboarding_initiated",
    outbox: "m34.tenant.offboarding_initiated",
  },
  {
    from: "at_risk",
    type: "initiateOffboarding",
    to: "offboarding_initiated",
    outbox: "m34.tenant.offboarding_initiated",
  },
  {
    from: "offboarding_initiated",
    type: "requestFinalExport",
    to: "final_export_pending",
    outbox: "m34.tenant.final_export_pending",
  },
  {
    from: "final_export_pending",
    type: "completeExport",
    to: "retained",
    outbox: "m34.tenant.retained",
  },
  {
    from: "retained",
    type: "scheduleDestruction",
    to: "destruction_pending",
    outbox: "m34.tenant.destruction_pending",
  },
  { from: "destruction_pending", type: "shred", to: "destroyed", outbox: "m34.tenant.destroyed" },
  {
    from: "destruction_pending",
    type: "deferForPartTwoRetention",
    to: "retained",
    outbox: "m34.tenant.retained",
  },
];

describe("§2.2 tenant-lifecycle transition graph", () => {
  it("covers all eleven lifecycle states", () => {
    expect(Object.keys(TENANT_LIFECYCLE_GRAPH).sort()).toEqual(
      [
        "active",
        "at_risk",
        "destroyed",
        "destruction_pending",
        "final_export_pending",
        "offboarding_initiated",
        "onboarding",
        "provisioning",
        "retained",
        "signup_intent",
        "suspended",
      ].sort(),
    );
  });

  it("the terminal `destroyed` state accepts no events", () => {
    expect(TENANT_LIFECYCLE_GRAPH.destroyed).toEqual([]);
  });

  it("`destruction_pending` forks to both shred (→destroyed) and the F08 re-defer (→retained)", () => {
    expect([...TENANT_LIFECYCLE_GRAPH.destruction_pending].sort()).toEqual(
      ["deferForPartTwoRetention", "shred"].sort(),
    );
  });

  it("offboarding is reachable from active, suspended, AND at_risk (§2.5 r5)", () => {
    expect(TENANT_LIFECYCLE_GRAPH.active).toContain("initiateOffboarding");
    expect(TENANT_LIFECYCLE_GRAPH.suspended).toContain("initiateOffboarding");
    expect(TENANT_LIFECYCLE_GRAPH.at_risk).toContain("initiateOffboarding");
  });
});

describe("§2.2 every LEGAL transition is allowed", () => {
  for (const edge of LEGAL_EDGES) {
    it(`${edge.from} --${edge.type}--> ${edge.to}`, () => {
      const t = transitionTenant(edge.from, validEvent(edge.type));
      expect(t.from).toBe(edge.from);
      expect(t.event).toBe(edge.type);
      expect(t.to).toBe(edge.to);
      // §2.5 outbox: every transition emits exactly its catalog event.
      expect(outboxEvents(t)).toEqual([edge.outbox]);
    });
  }

  it("walks the full happy path signup_intent → destroyed", () => {
    let state: TenantLifecycleState = "signup_intent";
    const path: LifecycleEvent["type"][] = [
      "accept",
      "provisioned",
      "activate",
      "initiateOffboarding",
      "requestFinalExport",
      "completeExport",
      "scheduleDestruction",
      "shred",
    ];
    for (const type of path) {
      state = transitionTenant(state, validEvent(type)).to;
    }
    expect(state).toBe("destroyed");
  });
});

// ── illegal (off-graph) transitions ──────────────────────────────────────────

describe("§2.2 ILLEGAL transitions are rejected (ILLEGAL_TENANT_TRANSITION, 409)", () => {
  /** Pick one event type each from-state does NOT accept. */
  const OFF_GRAPH: ReadonlyArray<{ from: TenantLifecycleState; type: LifecycleEvent["type"] }> = [
    { from: "signup_intent", type: "suspend" },
    { from: "signup_intent", type: "activate" },
    { from: "provisioning", type: "accept" },
    { from: "onboarding", type: "suspend" },
    { from: "active", type: "accept" },
    { from: "active", type: "reactivate" },
    { from: "active", type: "shred" },
    { from: "active", type: "completeExport" },
    { from: "suspended", type: "suspend" },
    { from: "at_risk", type: "suspend" },
    { from: "offboarding_initiated", type: "completeExport" },
    { from: "final_export_pending", type: "scheduleDestruction" },
    { from: "retained", type: "shred" },
    { from: "destruction_pending", type: "scheduleDestruction" },
  ];

  for (const c of OFF_GRAPH) {
    it(`${c.from} cannot ${c.type}`, () => {
      expect(() => transitionTenant(c.from, validEvent(c.type))).toThrowError(
        expect.objectContaining({ code: "ILLEGAL_TENANT_TRANSITION", statusCode: 409 }),
      );
    });
  }

  it("the terminal `destroyed` state rejects every event", () => {
    for (const type of [
      "accept",
      "provisioned",
      "shred",
      "scheduleDestruction",
      "deferForPartTwoRetention",
    ] as const) {
      expect(() => transitionTenant("destroyed", validEvent(type))).toThrowError(
        expect.objectContaining({ code: "ILLEGAL_TENANT_TRANSITION" }),
      );
    }
  });

  it("throws a TenantLifecycleError instance", () => {
    expect(() => transitionTenant("active", validEvent("accept"))).toThrow(TenantLifecycleError);
  });
});

// ── §2.4 guards ───────────────────────────────────────────────────────────────

describe("§2.4.1 universal guard — a non-empty transition reason is required", () => {
  it("rejects an empty reason (TRANSITION_REASON_REQUIRED, 422)", () => {
    expect(() =>
      transitionTenant("signup_intent", { ...validEvent("accept"), transitionReason: "" }),
    ).toThrowError(
      expect.objectContaining({ code: "TRANSITION_REASON_REQUIRED", statusCode: 422 }),
    );
  });

  it("rejects a whitespace-only reason", () => {
    expect(() =>
      transitionTenant("active", { ...validEvent("suspend"), transitionReason: "   " }),
    ).toThrowError(expect.objectContaining({ code: "TRANSITION_REASON_REQUIRED" }));
  });

  it("the reason guard fires only after the graph guard (off-graph wins)", () => {
    // active does not accept `accept`; the ILLEGAL check precedes the reason check.
    expect(() =>
      transitionTenant("active", { ...validEvent("accept"), transitionReason: "" }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_TENANT_TRANSITION" }));
  });
});

describe("§2.4.4 provisioning → onboarding requires the DEK", () => {
  it("rejects when the tenant_key_ring is not ready (TENANT_KEY_MISSING, 412)", () => {
    expect(() =>
      transitionTenant("provisioning", { ...validEvent("provisioned"), tenantKeyRingReady: false }),
    ).toThrowError(expect.objectContaining({ code: "TENANT_KEY_MISSING", statusCode: 412 }));
  });
});

describe("§2.4.12 / D11 onboarding → active gate", () => {
  it("rejects incomplete canonical tasks (ONBOARDING_TASKS_INCOMPLETE, 412)", () => {
    expect(() =>
      transitionTenant("onboarding", { ...validEvent("activate"), canonicalTasksComplete: false }),
    ).toThrowError(
      expect.objectContaining({ code: "ONBOARDING_TASKS_INCOMPLETE", statusCode: 412 }),
    );
  });

  it("rejects an unexecuted BAA (BAA_NOT_EXECUTED, 412)", () => {
    expect(() =>
      transitionTenant("onboarding", { ...validEvent("activate"), baaExecuted: false }),
    ).toThrowError(expect.objectContaining({ code: "BAA_NOT_EXECUTED", statusCode: 412 }));
  });

  it("rejects a BAA expiring within 90 days (BAA_EXPIRING_SOON, 412)", () => {
    expect(() =>
      transitionTenant("onboarding", {
        ...validEvent("activate"),
        baaExpiryClearsNinetyDays: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "BAA_EXPIRING_SOON", statusCode: 412 }));
  });
});

describe("§2.2 retained → destruction_pending guards", () => {
  it("rejects when retention has not elapsed (RETENTION_NOT_ELAPSED, 412)", () => {
    expect(() =>
      transitionTenant("retained", {
        ...validEvent("scheduleDestruction"),
        retentionElapsed: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "RETENTION_NOT_ELAPSED", statusCode: 412 }));
  });

  it("rejects when a legal hold is active (LEGAL_HOLD_ACTIVE, 409)", () => {
    expect(() =>
      transitionTenant("retained", { ...validEvent("scheduleDestruction"), legalHoldClear: false }),
    ).toThrowError(expect.objectContaining({ code: "LEGAL_HOLD_ACTIVE", statusCode: 409 }));
  });
});

describe("§2.2 destruction_pending guards", () => {
  it("only the shred worker may transition → destroyed (NOT_SHRED_WORKER, 403)", () => {
    expect(() =>
      transitionTenant("destruction_pending", { ...validEvent("shred"), isShredWorker: false }),
    ).toThrowError(expect.objectContaining({ code: "NOT_SHRED_WORKER", statusCode: 403 }));
  });

  it("the F08 re-defer requires a Part 2 eraser refusal (NO_PART_TWO_REFUSAL, 422)", () => {
    expect(() =>
      transitionTenant("destruction_pending", {
        ...validEvent("deferForPartTwoRetention"),
        eraserRefusedPartTwo: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "NO_PART_TWO_REFUSAL", statusCode: 422 }));
  });
});

// ── §2.5 side-effect intents per transition ──────────────────────────────────

describe("§2.5 every transition leads with the status_event ledger row (§2.4.1)", () => {
  for (const edge of LEGAL_EDGES) {
    it(`${edge.from} --${edge.type}--> ${edge.to} appends status_event first`, () => {
      const t = transitionTenant(edge.from, validEvent(edge.type));
      expect(effectKinds(t)[0]).toBe("status_event");
      // every transition emits exactly one m34.tenant.* outbox event in the same tx (§2.6).
      expect(outboxEvents(t)).toHaveLength(1);
    });
  }
});

describe("§2.5 r1 signup_intent → provisioning side effects", () => {
  const t = transitionTenant("signup_intent", validEvent("accept"));
  it("stamps provisionedAt, enqueues tenant.provision, emits provision_started", () => {
    expect(effectKinds(t)).toEqual(["status_event", "set_timestamp", "queue_job", "outbox"]);
    expect(queueJobs(t)).toEqual(["tenant.provision"]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.provision_started"]);
  });
});

describe("§2.5 r2 provisioning → onboarding side effects", () => {
  const t = transitionTenant("provisioning", validEvent("provisioned"));
  it("runs provision_bootstrap (DEK + MinIO + org seed + tasks + invite) then provisioned outbox", () => {
    expect(effectKinds(t)).toEqual(["status_event", "provision_bootstrap", "outbox"]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.provisioned"]);
  });
});

describe("§2.5 r3 onboarding → active side effects", () => {
  const t = transitionTenant("onboarding", validEvent("activate"));
  it("stamps activatedAt, emits activated, alerts platform-ops, enqueues welcome email", () => {
    expect(effectKinds(t)).toEqual([
      "status_event",
      "set_timestamp",
      "outbox",
      "alert",
      "welcome_email",
    ]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.activated"]);
    expect(alertKeys(t)).toEqual(["tenant.onboarding_completed"]);
  });
});

describe("§2.5 r4 active → suspended side effects", () => {
  const t = transitionTenant("active", validEvent("suspend"));
  it("cascades session revocation, alerts compliance + security, emits suspended", () => {
    expect(effectKinds(t)).toContain("session_cascade");
    expect(outboxEvents(t)).toEqual(["m34.tenant.suspension_initiated"]);
    expect(alertKeys(t)).toEqual(["tenant.suspension_initiated"]);
    const alert = t.effects.find(
      (e): e is Extract<LifecycleSideEffect, { kind: "alert" }> => e.kind === "alert",
    );
    expect(alert?.audience).toEqual(["tenant_compliance_officer", "platform_security_owner"]);
  });
});

describe("§2.2 at_risk → suspended mirrors active → suspended", () => {
  it("suspendFromAtRisk produces the same suspend side effects", () => {
    const fromActive = transitionTenant("active", validEvent("suspend"));
    const fromAtRisk = transitionTenant("at_risk", validEvent("suspendFromAtRisk"));
    expect(effectKinds(fromAtRisk)).toEqual(effectKinds(fromActive));
    expect(outboxEvents(fromAtRisk)).toEqual(["m34.tenant.suspension_initiated"]);
  });
});

describe("§2.5 r5 active → offboarding_initiated side effects", () => {
  const t = transitionTenant("active", validEvent("initiateOffboarding"));
  it("cascades sessions, alerts, offers the export job with the requested purpose", () => {
    expect(effectKinds(t)).toContain("session_cascade");
    expect(outboxEvents(t)).toEqual(["m34.tenant.offboarding_initiated"]);
    const offer = t.effects.find(
      (e): e is Extract<LifecycleSideEffect, { kind: "offer_export_job" }> =>
        e.kind === "offer_export_job",
    );
    expect(offer?.purpose).toBe("baa_termination");
  });
});

describe("§2.5 r6 final_export_pending → retained side effects", () => {
  const t = transitionTenant("final_export_pending", validEvent("completeExport"));
  it("sets the retention window, schedules the shred-eligibility cron, alerts countdown", () => {
    expect(effectKinds(t)).toContain("set_retention_window");
    expect(queueJobs(t)).toEqual(["tenant.shred_eligibility_check"]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.retained"]);
    expect(alertKeys(t)).toEqual(["tenant.retention_countdown"]);
  });
});

describe("§2.5 r7 retained → destruction_pending side effects", () => {
  const t = transitionTenant("retained", validEvent("scheduleDestruction"));
  it("calls M4 requestDestruction and alerts the platform security owner", () => {
    expect(effectKinds(t)).toContain("request_destruction");
    expect(outboxEvents(t)).toEqual(["m34.tenant.destruction_pending"]);
    expect(alertKeys(t)).toEqual(["tenant.shred_pending_approval"]);
  });
});

describe("§2.5 r8 destruction_pending → destroyed side effects", () => {
  const t = transitionTenant("destruction_pending", validEvent("shred"));
  it("invokes the shred worker, stamps destroyedAt, emits destroyed", () => {
    expect(effectKinds(t)).toEqual([
      "status_event",
      "set_timestamp",
      "invoke_shred_worker",
      "outbox",
    ]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.destroyed"]);
  });
});

describe("§2.5 r8 refusal branch — destruction_pending → retained (M34-F08 / ADR-0014)", () => {
  const t = transitionTenant("destruction_pending", validEvent("deferForPartTwoRetention"));
  it("marks the eraser-refusal deferral, re-schedules eligibility, re-emits retained", () => {
    expect(t.to).toBe("retained");
    expect(effectKinds(t)).toContain("mark_eraser_refusal_deferred");
    expect(queueJobs(t)).toEqual(["tenant.shred_eligibility_check"]);
    expect(outboxEvents(t)).toEqual(["m34.tenant.retained"]);
    // the DEK survives: no destroyedAt stamp, no invoke_shred_worker on the re-defer branch.
    expect(effectKinds(t)).not.toContain("invoke_shred_worker");
  });
});
