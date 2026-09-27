// apps/backend/__tests__/orders-workflow-acceptance.test.ts — M11-T09 the §5 workflow-acceptance suite
// + §9.3 race tests. One scenario per named §5 workflow, exercised end-to-end over the in-memory
// OrderRouteService (the same backend the §4.1 routes compose over, M11-T06) plus the pure
// `@wardenx/orders` verbal-timer / standing-order engines the §4.8 workers drive. Deterministic: no infra,
// injected clock. The route-auth handshake (§4.6/§4.7) + the wire status codes live in orders-routes.test.ts;
// the pure machines have their own unit suites — this asserts the WORKFLOW outcomes (state transitions,
// verbal-window timer math, cosign routing, standing-order signature inheritance, expiry side-effects) and
// the concurrency guarantees of the §2.2 state graph.
//
// Scope note (§9.3): the spec's §9.3 lab-observation race tests (`m29.lab_observation.attached` last-write-
// wins; concurrent `transmission_status` UPDATEs) belong to the lab-transmission/results consumer track
// (T-M11-28…T-M11-32), which is deferred with M29 (Wave H) and is NOT part of the Wave-E 9-task M11
// decomposition. The race the built surface admits — and the one §9.1 names for `verbal-timer.cron.ts`
// ("idempotency at deadline, race vs in-flight sign") — is the verbal-timer-vs-sign concurrency, proven here
// against the §2.2 transition graph (a single legal terminal transition; the loser raises and is a no-op).
import {
  classifyPreExpiryTier,
  computeNextSpawnAt,
  computeVerbalDeadline,
  isVerbalExpired,
  orgLocalDate,
  planStandingSpawn,
  planVerbalExpiry,
  transitionOrder,
} from "@wardenx/orders";
import { describe, expect, it } from "vitest";
import { createInMemoryOrderBackend } from "../src/modules/11-orders/index";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PHYS = "44444444-4444-4444-8444-444444444444";
const TZ = "America/New_York";
const NOW = "2026-06-08T12:00:00.000Z";
// A ≥100-char verbal attestation (the §2.3 recorder-attestation guard; denylisted in audit per §7.6).
const ATTEST =
  "Telephone order received from Dr. Patel for a comfort kit; patient has uncontrolled pain at the bedside, read back and verified.";

function backend(now: string = NOW) {
  return createInMemoryOrderBackend({ now: () => now, timeZone: TZ });
}

describe("M11-T09 §5 workflow acceptance", () => {
  it("W-VO-01 — verbal order received → 48h timer → physician signs in time", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, "rn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "comfort_kit",
      drafterDiscipline: "rn_case_manager",
      data: { kitSku: "comfort-kit-standard", deploymentSite: "home" },
      orderingPhysicianMdmId: PHYS,
    });
    await svc.requestSignature(ORG, draft.id, { signerDiscipline: "rn_case_manager" });
    svc.drainEvents();

    const verbal = await svc.recordVerbal(ORG, "rn_1", draft.id, {
      recorderDiscipline: "rn_case_manager",
      verbalAttestation: ATTEST,
      readBackVerified: true,
      effectiveAt: NOW,
      receivedAt: NOW,
      orderingPhysicianMdmId: PHYS,
    });
    expect(verbal.status).toBe("verbal_pending");
    // §2.3 D3 — deadline_at = received_at + 48h (wall-clock default policy).
    expect(verbal.verbalDeadlineAt).toBe("2026-06-10T12:00:00.000Z");
    expect(svc.drainEvents().map((e) => e.eventName)).toContain("m11.order.verbal_received");

    // The named practitioner signs 24h after receipt — comfortably before the deadline.
    const signAt = "2026-06-09T12:00:00.000Z";
    expect(isVerbalExpired(signAt, verbal.verbalDeadlineAt as string)).toBe(false);
    const signed = await svc.signOrder(ORG, PHYS, draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: signAt,
    });
    expect(signed.status).toBe("active");
    expect(svc.drainEvents().map((e) => e.eventName)).toContain("m11.order.signed");
  });

  it("W-VO-02 — verbal order expires without signature (verbal-timer worker path)", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, "rn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "comfort_kit",
      drafterDiscipline: "rn_case_manager",
      data: { kitSku: "comfort-kit-standard", deploymentSite: "home" },
      orderingPhysicianMdmId: PHYS,
    });
    await svc.requestSignature(ORG, draft.id, { signerDiscipline: "rn_case_manager" });
    const verbal = await svc.recordVerbal(ORG, "rn_1", draft.id, {
      recorderDiscipline: "rn_case_manager",
      verbalAttestation: ATTEST,
      readBackVerified: true,
      effectiveAt: NOW,
      receivedAt: NOW,
      orderingPhysicianMdmId: PHYS,
    });
    const deadline = verbal.verbalDeadlineAt as string; // 2026-06-10T12:00:00Z

    // §2.3 / §4.9 — the quarter-hourly pre-expiry cron fires 12h-pre (medium) then 2h-pre (high).
    const t12 = classifyPreExpiryTier("2026-06-10T00:00:00.000Z", deadline);
    expect(t12?.tier).toBe("twelve_hour");
    expect(t12?.severity).toBe("medium");
    const t2 = classifyPreExpiryTier("2026-06-10T10:00:00.000Z", deadline);
    expect(t2?.tier).toBe("two_hour");
    expect(t2?.severity).toBe("high");

    // The expire predicate is millisecond-exact at the boundary; before it the worker must NOT expire.
    expect(isVerbalExpired("2026-06-10T11:59:59.999Z", deadline)).toBe(false);
    expect(() => planVerbalExpiry("2026-06-10T11:59:59.999Z", deadline)).toThrowError(
      expect.objectContaining({ code: "VERBAL_DEADLINE_NOT_REACHED" }),
    );
    expect(isVerbalExpired(deadline, deadline)).toBe(true);

    // §2.2 / §2.6 / W-VO-02 — the timer flips both rows + writes the audit-symmetry discontinuation.
    const plan = planVerbalExpiry(deadline, deadline);
    expect(plan.to).toBe("expired_unsigned");
    expect(plan.effects).toContainEqual({ kind: "set_verbal_status", status: "expired_unsigned" });
    expect(plan.effects).toContainEqual({
      kind: "write_discontinuation",
      reason: "expired_verbal",
    });
    expect(plan.effects).toContainEqual({
      kind: "outbox",
      event: "m11.order.verbal_expired_unsigned",
    });
  });

  it("W-CS-01 — LPN draft → RN cosign → physician sign", async () => {
    const svc = backend();
    // An LPN may draft a clinical kind; the order then carries an RN-cosign requirement (§2.5 axis 1).
    const draft = await svc.createDraft(ORG, "lpn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "lab",
      drafterDiscipline: "lpn",
      data: {
        testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
        priority: "routine",
        fastingRequired: false,
      },
      orderingPhysicianMdmId: PHYS,
    });
    const req = await svc.requestSignature(ORG, draft.id, { signerDiscipline: "rn_case_manager" });
    expect(req.cosignRequired).toBe(true);
    expect(req.cosignStatus).toBe("pending");

    // The physician cannot sign while the cosignature is still pending (COSIGN_PENDING gate).
    await expect(
      svc.signOrder(ORG, PHYS, draft.id, {
        signerDiscipline: "medical_director",
        signedAtClient: NOW,
      }),
    ).rejects.toThrow();

    // A DIFFERENT RN cosigns (the author cannot cosign their own order, §7.3).
    const cos = await svc.cosignOrder(ORG, "rn_2", draft.id, {
      cosignerRole: "rn_case_manager",
      attestationText: "Reviewed and cosigned per scope.",
    });
    expect(cos.cosignStatus).toBe("attached");

    const signed = await svc.signOrder(ORG, PHYS, draft.id, {
      signerDiscipline: "medical_director",
      signedAtClient: NOW,
    });
    expect(signed.status).toBe("active");
  });

  it("W-CS-01 edge — the order's own author cannot cosign it (self-cosign blocked)", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, "lpn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "lab",
      drafterDiscipline: "lpn",
      data: {
        testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
        priority: "routine",
        fastingRequired: false,
      },
      orderingPhysicianMdmId: PHYS,
    });
    await svc.requestSignature(ORG, draft.id, { signerDiscipline: "rn_case_manager" });
    await expect(
      svc.cosignOrder(ORG, "lpn_1", draft.id, {
        cosignerRole: "rn_case_manager",
        attestationText: "x".repeat(40),
      }),
    ).rejects.toThrow();
  });

  it("W-SO-01 — standing-order template → scheduled (worker) spawn inherits the template signature", () => {
    // The hourly `orders.standing_spawn` worker composes the pure plan (system actor advances next_spawn_at).
    const plan = planStandingSpawn({
      kind: "lab",
      cadence: "weekly",
      cadenceDetail: { daysOfWeek: ["mon"] },
      spawnedBy: "system",
      now: NOW,
      timeZone: TZ,
    });
    // §2.4 D5 — the spawned order is born `active` (signature inherited), bypassing pending_signature.
    expect(plan.spawnedOrderStatus).toBe("active");
    // The spawn emits standing_spawned → signed → the kind's downstream signed events (lab → HL7 ORM).
    expect(plan.events).toEqual([
      "m11.order.standing_spawned",
      "m11.order.signed",
      "m11.order.hl7_orm_requested",
    ]);
    // The next fire is the next Monday at 06:00 org-local time.
    const next = plan.nextSpawnAt as string;
    expect(orgLocalDate(next, TZ)).toBe("2026-06-15"); // 2026-06-08 is a Monday → next Monday is the 15th
    expect(next).toBe(computeNextSpawnAt("weekly", { daysOfWeek: ["mon"] }, NOW, TZ));
  });

  it("W-SO-02 — PRN standing-order spawns an active order on clinician request", async () => {
    const svc = backend();
    const tmpl = await svc.createStandingOrder(ORG, "phys_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "supply",
      signerDiscipline: "hospice_physician",
      orderingPhysicianMdmId: "00000000-0000-4000-8000-0000000000ff",
      cadence: "prn",
      data: { kitSku: "comfort-kit-standard", deploymentSite: "home" },
    });
    svc.drainEvents();

    const { orderId } = await svc.spawnStandingOrder(ORG, "rn_1", tmpl.id);
    const events = svc.drainEvents().map((e) => e.eventName);
    expect(events).toContain("m11.order.standing_spawned");
    expect(events).toContain("m11.order.signed");

    const spawned = await svc.getOrder(ORG, orderId);
    expect(spawned.status).toBe("active"); // signature-anchored — no pending_signature step
    expect(spawned.cosignStatus).toBe("attached");
    // The template's spawn counter advanced; the PRN schedule is unchanged (no next_spawn_at).
    expect((await svc.getStandingOrder(ORG, tmpl.id)).spawnCount).toBe(1);
  });
});

describe("M11-T09 §9.3 race / concurrency (verbal-timer vs in-flight sign)", () => {
  const deadline = "2026-06-10T12:00:00.000Z";

  it("sign wins the race: a verbal_pending order signed in time cannot then be expired by the worker", () => {
    // The physician's sign commits first → active.
    const signed = transitionOrder("verbal_pending", {
      type: "sign",
      kind: "comfort_kit",
      cosignAttached: true,
      onBehalf: false,
    });
    expect(signed.to).toBe("active");
    // The verbal-timer fires a beat later — the §2.2 graph rejects `expire` from `active` (no-op for the worker).
    expect(() =>
      transitionOrder("active", {
        type: "expire",
        isSystemActor: true,
        deadlineReached: isVerbalExpired(deadline, deadline),
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ORDER_TRANSITION", statusCode: 409 }));
  });

  it("expire wins the race: once expired_unsigned, a late physician sign is rejected", () => {
    const plan = planVerbalExpiry(deadline, deadline);
    expect(plan.to).toBe("expired_unsigned");
    // A physician who sees the alert and signs after expiry hits the terminal-state guard.
    expect(() =>
      transitionOrder("expired_unsigned", {
        type: "sign",
        kind: "comfort_kit",
        cosignAttached: true,
        onBehalf: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ORDER_TRANSITION", statusCode: 409 }));
  });

  it("idempotency at deadline: a re-fired timer cannot double-expire an already-expired order", () => {
    transitionOrder("verbal_pending", {
      type: "expire",
      isSystemActor: true,
      deadlineReached: true,
    });
    // The second delivery finds the order already terminal — the graph makes the redelivery a no-op.
    expect(() =>
      transitionOrder("expired_unsigned", {
        type: "expire",
        isSystemActor: true,
        deadlineReached: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "ILLEGAL_ORDER_TRANSITION", statusCode: 409 }));
  });
});

describe("M11-T09 cross-tenant isolation (service-layer non-leaking 404; live-PG RLS in rls-isolation.live)", () => {
  it("an order created in org_a is invisible to org_b (non-leaking NotFound)", async () => {
    const svc = backend();
    const draft = await svc.createDraft(ORG, "rn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "comfort_kit",
      drafterDiscipline: "rn_case_manager",
      data: {},
      orderingPhysicianMdmId: PHYS,
    });
    await expect(svc.getOrder(ORG_B, draft.id)).rejects.toThrow();
    expect((await svc.listOrders(ORG_B, {})).orders).toEqual([]);
  });
});

describe("M11 correction parity", () => {
  it("creates a draft replacement and discontinues the immutable active original", async () => {
    const svc = backend();
    const original = await svc.createDraft(ORG, "rn_1", {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "lab",
      drafterDiscipline: "rn_case_manager",
      data: {
        testCodes: [{ system: "http://loinc.org", code: "2160-0", display: "Creatinine" }],
        fastingRequired: false,
      },
      orderingPhysicianMdmId: PHYS,
    });
    await svc.requestSignature(ORG, original.id, { signerDiscipline: "rn_case_manager" });
    await svc.signOrder(ORG, PHYS, original.id, {
      signerDiscipline: "medical_director",
      signedAtClient: NOW,
    });
    const replacement = await svc.correctOrder(ORG, "rn_1", original.id, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "lab",
      drafterDiscipline: "rn_case_manager",
      data: {
        testCodes: [{ system: "http://loinc.org", code: "718-7", display: "Hemoglobin" }],
        fastingRequired: false,
      },
      priority: "routine",
      orderingPhysicianMdmId: PHYS,
    });
    expect(replacement.status).toBe("draft");
    expect(replacement.replacesOrderId).toBe(original.id);
    expect((await svc.getOrder(ORG, original.id)).status).toBe("discontinued");
  });
});
