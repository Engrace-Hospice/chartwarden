// apps/backend/__tests__/encounter-outbox.test.ts — M8-T11 (§4.4 outbox contract + the M17 visit-
// scheduling consumer (inert) + the M18 EVV-bracket forward seam deny-stub). Locks the full `m8.*`
// event catalog (naming/ownership/consumers + the locked `m8.encounter.signed` payload — the same
// invariants arch:gaps enforces) against M8_EVENT_NAMES, exercises the pure `decideVisitSeeding`
// decision core (idempotent skip, active-service guard, the seed happy path), and asserts the
// `EvvBracketResolver` forward seam is registered fail-closed (denies until M18 lands in Wave F).
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { M8_EVENT_NAMES } from "@wardenx/types";
import {
  __resetSeamsForTest,
  getSeam,
  validateSeams,
} from "../src/bootstrap/index";
import {
  type VisitScheduledPayload,
  type VisitSeedingFacts,
  M8_OUTBOX_EVENTS,
  M8_VISIT_SCHEDULED_CONSUMER,
  M8_VISIT_SCHEDULED_CONSUMER_DEFERRED,
  decideVisitScheduled,
  decideVisitSeeding,
} from "../src/modules/08-encounters/index";

const PAT = "00000000-0000-4000-8000-0000000000aa";
const ADM = "00000000-0000-4000-8000-0000000000bb";
const VISIT = "00000000-0000-4000-8000-0000000000cc";
const MEMBER = "00000000-0000-4000-8000-0000000000dd";
const ORG = "00000000-0000-4000-8000-0000000000ee";

// ── §4.4 outbox event contract ────────────────────────────────────────────────────────────────────────

describe("M8 outbox event contract (§4.4)", () => {
  it("publishes exactly the §4.4 taxonomy (M8_EVENT_NAMES), no more, no less", () => {
    const published = M8_OUTBOX_EVENTS.map((e) => e.eventName).sort();
    expect(published).toEqual([...M8_EVENT_NAMES].sort());
  });

  it("every event is owned by m8 and namespaced under its own prefix", () => {
    for (const e of M8_OUTBOX_EVENTS) {
      expect(e.moduleOwner).toBe("m8");
      expect(e.eventName.startsWith("m8.")).toBe(true);
      expect(e.eventName).toMatch(/^m\d+\.[a-z0-9_]+\.[a-z0-9_.]+$/);
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it("is outbox-only across the board (§4.7: M8 is not a Socket.IO producer)", () => {
    for (const e of M8_OUTBOX_EVENTS) expect(e.isOutboxOnly).toBe(true);
  });

  it("declares only real module-id consumers in `mN` form", () => {
    for (const e of M8_OUTBOX_EVENTS) {
      for (const c of e.declaredConsumers) expect(c).toMatch(/^m\d+$/);
    }
  });

  it("has no duplicate event names (catalog is collision-free)", () => {
    const names = M8_OUTBOX_EVENTS.map((e) => e.eventName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("`m8.encounter.signed` fans out to the clinical-record subscriber set (§4.4 subscriber map)", () => {
    const signed = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.signed");
    expect(signed?.declaredConsumers).toEqual(
      expect.arrayContaining(["m9", "m10", "m14", "m22", "m28", "m30", "m31", "m33", "m36"]),
    );
  });

  it("`m8.encounter.cosigned` reaches the billing readers (§7.2 billable flip)", () => {
    const cosigned = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.cosigned");
    expect(cosigned?.declaredConsumers).toEqual(expect.arrayContaining(["m23", "m24"]));
  });

  it("`m8.encounter.orphan_recorded` routes to M17 reconciliation (D2)", () => {
    const orphan = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.orphan_recorded");
    expect(orphan?.declaredConsumers).toEqual(["m17"]);
  });

  it("validates the locked `m8.encounter.signed` payload and rejects one missing a required key", () => {
    const signed = M8_OUTBOX_EVENTS.find((e) => e.eventName === "m8.encounter.signed")!;
    expect(
      Value.Check(signed.payloadSchema, {
        encounterId: "enc-1",
        patientId: PAT,
        admissionId: ADM,
        visitId: VISIT,
        encounterType: "routine_visit",
        discipline: "rn",
        signedByMembershipId: MEMBER,
        signedAt: "2026-01-01T16:23:00.000Z",
        lateEntryTier: "normal",
        layer2Involved: false,
        evvBracketState: "evv_present",
        requiresCosign: false,
        careplanLinks: [{ problemId: "prob-1" }],
        documentRenderPayload: { final: "signed bytes", addenda: [] },
      }),
    ).toBe(true);
    // missing signedAt → rejected
    expect(
      Value.Check(signed.payloadSchema, {
        encounterId: "enc-1",
        patientId: PAT,
        admissionId: ADM,
        encounterType: "routine_visit",
        discipline: "rn",
        signedByMembershipId: MEMBER,
        lateEntryTier: "normal",
        layer2Involved: false,
        evvBracketState: "evv_present",
        requiresCosign: false,
        careplanLinks: [],
        documentRenderPayload: { final: "x", addenda: [] },
      }),
    ).toBe(false);
    // illegal lateEntryTier literal → rejected
    expect(
      Value.Check(signed.payloadSchema, {
        encounterId: "enc-1",
        patientId: PAT,
        admissionId: ADM,
        encounterType: "routine_visit",
        discipline: "rn",
        signedByMembershipId: MEMBER,
        signedAt: "2026-01-01T16:23:00.000Z",
        lateEntryTier: "whenever",
        layer2Involved: false,
        evvBracketState: "evv_present",
        requiresCosign: false,
        careplanLinks: [],
        documentRenderPayload: { final: "x", addenda: [] },
      }),
    ).toBe(false);
  });
});

// ── M17 visit-scheduling consumer (inert) ──────────────────────────────────────────────────────────────

function visitPayload(over: Partial<VisitScheduledPayload> = {}): VisitScheduledPayload {
  return {
    visitId: VISIT,
    patientId: PAT,
    admissionId: ADM,
    organizationId: ORG,
    encounterType: "routine_visit",
    discipline: "rn",
    serviceDate: "2026-01-02",
    assignedMembershipId: MEMBER,
    ...over,
  };
}

describe("decideVisitSeeding (M17 visit-scheduling consumer, §4.7 / line 65)", () => {
  it("seeds a draft encounter for an active-service patient with no existing draft", () => {
    const action = decideVisitSeeding(visitPayload(), {
      alreadySeeded: false,
      patientOnService: true,
    });
    expect(action.kind).toBe("seed");
    if (action.kind === "seed") {
      expect(action.input.visitId).toBe(VISIT);
      expect(action.input.patientId).toBe(PAT);
      expect(action.input.admissionId).toBe(ADM);
      expect(action.input.authorMembershipId).toBe(MEMBER);
      expect(action.input.encounterType).toBe("routine_visit");
      expect(action.input.discipline).toBe("rn");
      expect(action.input.serviceDate).toBe("2026-01-02");
    }
  });

  it("is idempotent — a redelivery whose visit already has a draft is a no-op skip", () => {
    const action = decideVisitSeeding(visitPayload(), {
      alreadySeeded: true,
      patientOnService: true,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_seeded" });
  });

  it("skips when the patient is not on active service (authoring impossible)", () => {
    const action = decideVisitSeeding(visitPayload(), {
      alreadySeeded: false,
      patientOnService: false,
    });
    expect(action).toEqual({ kind: "skip", reason: "patient_not_on_service" });
  });

  it("idempotency wins over the active-service guard (skip reason is `already_seeded`)", () => {
    const action = decideVisitSeeding(visitPayload(), {
      alreadySeeded: true,
      patientOnService: false,
    });
    expect(action).toEqual({ kind: "skip", reason: "already_seeded" });
  });

  it("the outbox binding is forward-declared + deferred (no M17 producer in Phase 1)", () => {
    expect(M8_VISIT_SCHEDULED_CONSUMER.eventName).toBe("m17.visit.scheduled");
    expect(M8_VISIT_SCHEDULED_CONSUMER.consumerName).toBe("m8.seed-visit-encounter");
    expect(M8_VISIT_SCHEDULED_CONSUMER_DEFERRED).toBe(true);
  });

  it("the deferred binding re-export delegates to the pure decider", () => {
    const facts: VisitSeedingFacts = { alreadySeeded: false, patientOnService: true };
    expect(decideVisitScheduled(visitPayload(), facts)).toEqual(decideVisitSeeding(visitPayload(), facts));
  });
});

// ── M18 EVV-bracket forward seam (deny-stub) ───────────────────────────────────────────────────────────

describe("EvvBracketResolver forward seam (§4.7 / D9)", () => {
  afterEach(() => __resetSeamsForTest());

  it("is registered fail-closed by validateSeams and denies on call until M18 lands (Wave F)", () => {
    validateSeams();
    const resolver = getSeam("EvvBracketResolver");
    expect(() => resolver.resolveBracket({ organizationId: ORG, visitId: VISIT })).toThrow(
      /EvvBracketResolver/,
    );
  });
});
