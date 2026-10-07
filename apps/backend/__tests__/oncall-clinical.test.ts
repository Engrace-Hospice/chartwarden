// apps/backend/__tests__/oncall-clinical.test.ts — M19-T05 (D8 M8 encounter, D9 M11 verbal order, D15 M12
// medication/refill context; §7.1, §7.5, §7.7, §2.6, §2.7 D-B).
//
// The three cross-module clinical bindings. The pure halves take injected facts; the seam-touching halves
// register a fake through the M1 registry, because the FINDING in each case is about the seam's real
// contract — a creator with no dedupe key, a signature primitive over an existing target, and two reads
// that must fail as "unreadable" rather than as "empty".
import type {
  EncounterCreator,
  MedicationOrderDto,
  MedicationOrderProvider,
  OrderSignatureProvider,
  RefillInboxProvider,
  RefillRequestDto,
  SessionStepUpFields,
} from "@wardenx/types";
import { M19_ENCOUNTER_TYPE, M19_SUBSCRIBED_EVENT_NAMES, STEP_UP_POLICY } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  type EncounterSignedPorts,
  type M8EncounterSignedPayload,
  M8_ENCOUNTER_SIGNED_EVENT,
  type TriageEncounterCallFacts,
  type TriageEncounterLinkPort,
  type TriageVerbalOrderRequest,
  VERBAL_ATTESTATION_MAX_CHARS,
  VERBAL_ATTESTATION_MIN_CHARS,
  appendLinkedVerbalOrderId,
  assertVerbalOrderBelongsToCall,
  assertVerbalOrderScope,
  assertVerbalOrderStepUp,
  buildVerbalOrderInput,
  decideEncounterSigned,
  encounterDisciplineFor,
  linkTriageEncounter,
  planTriageDocumentation,
  planTriageEncounter,
  readTriageMedicationContext,
  recordTriageVerbalOrder,
  redactSudMedications,
  validatePrnAuthorizationTarget,
  verbalOrderLinkEffect,
} from "../src/modules/19-oncall/clinical/index";
import type { TriageActorDiscipline } from "../src/modules/19-oncall/lifecycle/protocol";
import type { TriageCallFacts } from "../src/modules/19-oncall/lifecycle/triage-call";

const ORG = "0a000000-0000-4000-8000-000000000001";
const PATIENT = "0d000000-0000-4000-8000-000000000004";
const ADMISSION = "0e000000-0000-4000-8000-000000000005";
const CALL = "13000000-0000-4000-8000-00000000000c";
const NURSE = "11000000-0000-4000-8000-000000000009";
const ENCOUNTER = "14000000-0000-4000-8000-00000000000d";
const ENCOUNTER_2 = "14000000-0000-4000-8000-00000000000e";
const ORDER = "15000000-0000-4000-8000-00000000000f";
const ORDER_2 = "15000000-0000-4000-8000-000000000010";
const MED_ORDER = "16000000-0000-4000-8000-000000000011";
const PHYSICIAN = "17000000-0000-4000-8000-000000000012";

/** §7.1's clock: the 22:30 call, documented just after midnight UTC. */
const OPENED_AT = "2026-08-01T02:30:00.000Z";
const SIGNED_AT = "2026-08-01T03:10:00.000Z";

/** Assert a guard raises the exact machine-readable code — never `toThrowError(/CODE/)`, which passes
 *  whenever the prose happens to contain the token (the M15-T03 finding). */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but nothing was thrown`);
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────────

function callFacts(over: Partial<TriageEncounterCallFacts> = {}): TriageEncounterCallFacts {
  return {
    triageCallId: CALL,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    linkedEncounterId: null,
    openedAt: OPENED_AT,
    ...over,
  };
}

function machineCall(
  over: Partial<TriageCallFacts> = {},
): TriageCallFacts & { triageCallId: string } {
  return {
    triageCallId: CALL,
    state: "documented_pending_encounter",
    version: 4,
    selectedProtocolId: null,
    linkedEncounterId: ENCOUNTER,
    firstResponseAt: OPENED_AT,
    documentedAt: null,
    paperOriginFlag: false,
    ...over,
  };
}

function linkPort(behaviour: "linked" | "already_linked"): TriageEncounterLinkPort & {
  calls: Array<{ triageCallId: string; encounterId: string }>;
} {
  const calls: Array<{ triageCallId: string; encounterId: string }> = [];
  return {
    calls,
    async linkEncounter(_org, triageCallId, encounterId) {
      calls.push({ triageCallId, encounterId });
      return behaviour;
    },
  };
}

function encounterCreator(result: string | Error): EncounterCreator & { seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    async createDraftEncounter(input) {
      seen.push(input);
      if (result instanceof Error) throw result;
      return { encounterId: result };
    },
  };
}

function signedPayload(over: Partial<M8EncounterSignedPayload> = {}): M8EncounterSignedPayload {
  return {
    encounterId: ENCOUNTER,
    patientId: PATIENT,
    admissionId: ADMISSION,
    signedByMembershipId: NURSE,
    signedAt: SIGNED_AT,
    ...over,
  };
}

function verbalRequest(over: Partial<TriageVerbalOrderRequest> = {}): TriageVerbalOrderRequest {
  return {
    organizationId: ORG,
    targetKind: "order",
    targetId: ORDER,
    recordingMembershipId: NURSE,
    orderingPhysicianMdmId: PHYSICIAN,
    verbalAttestation: "A".repeat(VERBAL_ATTESTATION_MIN_CHARS),
    receivedAt: OPENED_AT,
    ...over,
  };
}

/** A step-up that satisfies the platform floor as of `NOW_MS`. */
const NOW_MS = Date.parse(OPENED_AT);
const freshStepUp: SessionStepUpFields = {
  lastStepUpAt: new Date(NOW_MS - 60_000),
  lastStepUpFactor: "webauthn",
};

function medicationDto(over: Partial<MedicationOrderDto> = {}): MedicationOrderDto {
  return {
    id: MED_ORDER,
    organizationId: ORG,
    patientId: PATIENT,
    admissionId: ADMISSION,
    medClass: "opioid_analgesic" as MedicationOrderDto["medClass"],
    status: "active" as MedicationOrderDto["status"],
    rxnormRxcui: null,
    ndc: null,
    drugName: "Morphine Sulfate ER",
    strength: "30 mg",
    doseForm: "tablet",
    route: "PO",
    sigStructured: {
      doseQuantity: 1,
      doseUnit: "tablet",
      route: "PO",
      frequencyCode: "Q12H",
      asNeeded: false,
    },
    prescriberMembershipId: NURSE,
    prescribingPhysicianMdmId: PHYSICIAN,
    dispensingPharmacyMdmId: null,
    refillsRemaining: 0,
    signedAt: null,
    transmittedAt: null,
    activatedAt: null,
    discontinuedAt: null,
    isControlledSubstance: true,
    deaSchedule: "cii" as MedicationOrderDto["deaSchedule"],
    isSudTreatment: false,
    derivedFromRefillId: null,
    derivedFromHistoryId: null,
    replacesMedicationOrderId: null,
    documentId: null,
    ...over,
  };
}

function refillDto(over: Partial<RefillRequestDto> = {}): RefillRequestDto {
  return {
    id: "18000000-0000-4000-8000-000000000013",
    organizationId: ORG,
    patientId: PATIENT,
    sourceMedicationOrderId: MED_ORDER,
    status: "pending",
    requestedAt: OPENED_AT,
    requestedQuantity: 30,
    prescriberMembershipId: null,
    resultingMedicationOrderId: null,
    ...over,
  };
}

// ── D8 — the M8 encounter plan ────────────────────────────────────────────────────────────────────────

describe("M19 D8 — planning the M8 draft encounter", () => {
  it("maps every triage discipline onto an M8 authoring discipline except the vendor operator", () => {
    const expected: Record<TriageActorDiscipline, string | null> = {
      clinical_rn: "rn",
      // §6's supervisor band (Clin Supv / DON / TN) is RN-licensed; `encounter_discipline` records the
      // LICENSE that authored, not the org-chart position.
      supervisor: "rn",
      clinical_lpn: "lpn",
      msw: "msw",
      chaplain: "chaplain",
      medical_director: "md",
      // §7.5 / ADR-0026 — no WardenX membership, so no id M8 could attribute the signature to.
      external: null,
    };
    for (const [discipline, m8] of Object.entries(expected)) {
      expect(encounterDisciplineFor(discipline as TriageActorDiscipline)).toBe(m8);
    }
  });

  it("opens the encounter as `telephonic` with no visit bracket (D1/D8)", () => {
    const plan = planTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
    });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") return;
    // D1/D8 name `triage_telephonic_contact`; `EncounterType` has no such member. The published enum wins.
    expect(plan.input.encounterType).toBe(M19_ENCOUNTER_TYPE);
    expect(M19_ENCOUNTER_TYPE).toBe("telephonic");
    // §7.9 — the dispatched pronouncement visit gets its OWN encounter; bracketing this one to it would
    // make the phone call and the home visit the same documented event.
    expect(plan.input.visitId).toBeNull();
    expect(plan.input.patientId).toBe(PATIENT);
    expect(plan.input.admissionId).toBe(ADMISSION);
    expect(plan.input.authorMembershipId).toBe(NURSE);
  });

  it("prefers the caller's tenant-local service date over the UTC slice", () => {
    const utc = planTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
    });
    // 22:30 US/Eastern is already 02:30 the NEXT day in UTC — the fallback dates the encounter a day after
    // the night it documents, which is why T07 passes the local date.
    expect(utc.kind === "create" && utc.input.serviceDate).toBe("2026-08-01");
    const local = planTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
      serviceDate: "2026-07-31",
    });
    expect(local.kind === "create" && local.input.serviceDate).toBe("2026-07-31");
  });

  it("short-circuits to `already_linked` when the call already carries an encounter (§2.6)", () => {
    const plan = planTriageEncounter({
      call: callFacts({ linkedEncounterId: ENCOUNTER }),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
    });
    expect(plan).toEqual({ kind: "already_linked", encounterId: ENCOUNTER });
  });

  it("refuses a vendor operator as author and an unidentified caller, with distinct codes", () => {
    expectCode(
      () =>
        planTriageEncounter({
          call: callFacts(),
          actorDiscipline: "external",
          authorMembershipId: NURSE,
        }),
      "ENCOUNTER_ACTOR_CANNOT_AUTHOR",
    );
    for (const missing of [{ patientId: null }, { admissionId: null }] as const) {
      expectCode(
        () =>
          planTriageEncounter({
            call: callFacts(missing),
            actorDiscipline: "clinical_rn",
            authorMembershipId: NURSE,
          }),
        "ENCOUNTER_PATIENT_NOT_IDENTIFIED",
      );
    }
  });
});

// ── D8 — executing the link through the seam ──────────────────────────────────────────────────────────

describe("M19 D8 — the EncounterCreator seam call", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  it("mints the draft and persists the back-reference", async () => {
    const creator = encounterCreator(ENCOUNTER);
    registerSeam("EncounterCreator", creator);
    const port = linkPort("linked");

    const outcome = await linkTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
      port,
    });

    expect(outcome).toEqual({ kind: "linked", encounterId: ENCOUNTER });
    expect(port.calls).toEqual([{ triageCallId: CALL, encounterId: ENCOUNTER }]);
  });

  it("never calls the seam when the call is already linked — M8 has no dedupe key of its own", async () => {
    const creator = encounterCreator(ENCOUNTER_2);
    registerSeam("EncounterCreator", creator);
    const port = linkPort("linked");

    const outcome = await linkTriageEncounter({
      call: callFacts({ linkedEncounterId: ENCOUNTER }),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
      port,
    });

    // §2.6 claims the seam is idempotent on `triage_call_id`. `CreateEncounterInput` carries no such id, so
    // a second call would mint a SECOND draft — the guard has to be M19's, and this is it.
    expect(outcome).toEqual({
      kind: "already_linked",
      encounterId: ENCOUNTER,
      orphanedEncounterId: null,
    });
    expect(creator.seen).toHaveLength(0);
  });

  it("reports the orphaned draft when a concurrent attempt won the conditional write", async () => {
    registerSeam("EncounterCreator", encounterCreator(ENCOUNTER_2));
    const outcome = await linkTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
      port: linkPort("already_linked"),
    });
    // M8 minted a draft nobody will sign. It cannot be prevented from here (no dedupe key upstream), so it
    // is REPORTED — swallowing it would hide the row from the ops path entirely.
    expect(outcome).toEqual({
      kind: "already_linked",
      encounterId: null,
      orphanedEncounterId: ENCOUNTER_2,
    });
  });

  it("defers rather than throwing when M8 is unreachable (§2.7 degraded class D-B)", async () => {
    registerSeam("EncounterCreator", encounterCreator(new Error("m8 timeout")));
    const port = linkPort("linked");

    const outcome = await linkTriageEncounter({
      call: callFacts(),
      actorDiscipline: "clinical_rn",
      authorMembershipId: NURSE,
      port,
    });

    // The disposition transaction already committed; a throw here would be a rollback of work that
    // succeeded. The call parks in `documented_pending_encounter` and §4.8's queue retries.
    expect(outcome.kind).toBe("deferred");
    expect(outcome.kind === "deferred" && outcome.reason).toContain("m8 timeout");
    expect(port.calls).toHaveLength(0);
  });

  it("still refuses an unauthorable actor before reaching the seam", async () => {
    registerSeam("EncounterCreator", encounterCreator(ENCOUNTER));
    await expectCodeAsync(
      () =>
        linkTriageEncounter({
          call: callFacts(),
          actorDiscipline: "external",
          authorMembershipId: NURSE,
          port: linkPort("linked"),
        }),
      "ENCOUNTER_ACTOR_CANNOT_AUTHOR",
    );
  });
});

// ── D8 — the m8.encounter.signed consumer ─────────────────────────────────────────────────────────────

describe("M19 D8 — the m8.encounter.signed consumer", () => {
  it("subscribes under the frozen event name", () => {
    expect(M19_SUBSCRIBED_EVENT_NAMES).toContain(M8_ENCOUNTER_SIGNED_EVENT);
  });

  it("advances the call and stamps documented_at from the ENCOUNTER's signature instant", () => {
    const plan = planTriageDocumentation({ payload: signedPayload(), call: machineCall() });
    expect(plan.kind).toBe("advance");
    if (plan.kind !== "advance") return;
    expect(plan.transition.to).toBe("documented");
    // Not the consumer's wall clock: the 30-minute amendment grace before `documented → closed` is measured
    // from `documented_at`, so a queue lag would silently move the window a clinician has to amend.
    expect(plan.transition.effects).toContainEqual({
      kind: "set_timestamp",
      field: "documented_at",
      at: SIGNED_AT,
    });
    // §2.2.1 — a system transition: no membership took this action.
    expect(plan.transition.effects).toContainEqual({
      kind: "state_history",
      from: "documented_pending_encounter",
      to: "documented",
      systemActor: true,
    });
  });

  it("skips the encounters that belong to no triage call — the ordinary case", () => {
    expect(planTriageDocumentation({ payload: signedPayload(), call: null })).toEqual({
      kind: "skip",
      reason: "no_linked_call",
      triageCallId: null,
    });
  });

  it("skips a re-delivery rather than throwing it into the DLQ", () => {
    for (const state of ["documented", "closed"] as const) {
      const plan = planTriageDocumentation({
        payload: signedPayload(),
        call: machineCall({ state, documentedAt: SIGNED_AT }),
      });
      // At-least-once delivery makes this NORMAL. Letting `markDocumented` throw
      // `INVALID_STATE_TRANSITION` would dead-letter every duplicate.
      expect(plan).toEqual({ kind: "skip", reason: "not_pending_encounter", triageCallId: CALL });
    }
  });

  it("resolves the call by its link, since M8's payload carries no triage context", async () => {
    const seen: string[] = [];
    const ports: EncounterSignedPorts = {
      async findCallByLinkedEncounter(_org, encounterId) {
        seen.push(encounterId);
        return encounterId === ENCOUNTER ? machineCall() : null;
      },
    };
    const hit = await decideEncounterSigned({
      organizationId: ORG,
      payload: signedPayload(),
      ports,
    });
    expect(hit.kind).toBe("advance");
    const miss = await decideEncounterSigned({
      organizationId: ORG,
      payload: signedPayload({ encounterId: ENCOUNTER_2 }),
      ports,
    });
    expect(miss.kind).toBe("skip");
    expect(seen).toEqual([ENCOUNTER, ENCOUNTER_2]);
  });
});

// ── D9 / §7.7 — the verbal order taken during a call ──────────────────────────────────────────────────

describe("M19 D9 — the §7.7 verbal-order scope and step-up gates", () => {
  it("admits only the disciplines the §6 disposition matrix admits", () => {
    for (const discipline of ["clinical_rn", "supervisor", "medical_director"] as const) {
      expect(() => assertVerbalOrderScope(discipline)).not.toThrow();
    }
    // Derived from `permittedDispositions`, not restated — a second copy of the matrix would be the way
    // around §7.3's LPN gate. The vendor operator is excluded by D13 and has no membership besides.
    for (const discipline of ["clinical_lpn", "msw", "chaplain", "external"] as const) {
      expectCode(() => assertVerbalOrderScope(discipline), "VERBAL_ORDER_ACTOR_OUT_OF_SCOPE");
    }
  });

  it("fails closed on every missing, weak, stale or future-dated step-up", () => {
    expect(() => assertVerbalOrderStepUp(freshStepUp, NOW_MS)).not.toThrow();
    const denied: Array<SessionStepUpFields | null> = [
      null,
      { lastStepUpAt: null, lastStepUpFactor: null },
      // SMS is the accessibility fallback, not step-up: no proof of possession, SIM-swappable.
      { lastStepUpAt: new Date(NOW_MS - 1_000), lastStepUpFactor: "sms" },
      // Outside the platform-floor freshness window.
      {
        lastStepUpAt: new Date(NOW_MS - (STEP_UP_POLICY.defaultMaxAgeSec + 1) * 1000),
        lastStepUpFactor: "webauthn",
      },
      // Clock skew forward — a future stamp must not buy an unbounded window.
      { lastStepUpAt: new Date(NOW_MS + 60_000), lastStepUpFactor: "webauthn" },
    ];
    for (const state of denied) {
      expectCode(() => assertVerbalOrderStepUp(state, NOW_MS), "VERBAL_ORDER_STEP_UP_REQUIRED");
    }
  });

  it("honours a TIGHTENED tenant policy", () => {
    // Tenants may only tighten (M2 D9). A webauthn-only floor denies a TOTP step-up the platform accepts.
    expectCode(
      () =>
        assertVerbalOrderStepUp(
          { lastStepUpAt: new Date(NOW_MS - 1_000), lastStepUpFactor: "totp" },
          NOW_MS,
          {
            ...STEP_UP_POLICY,
            qualifyingFactors: ["webauthn"],
          },
        ),
      "VERBAL_ORDER_STEP_UP_REQUIRED",
    );
  });
});

describe("M19 D9 — building and recording the verbal order", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  it("refuses everything M11's contract requires, before the seam call", () => {
    expectCode(
      () => buildVerbalOrderInput(verbalRequest({ targetId: "   " })),
      "VERBAL_ORDER_TARGET_REQUIRED",
    );
    expectCode(
      () => buildVerbalOrderInput(verbalRequest({ orderingPhysicianMdmId: "" })),
      "VERBAL_ORDER_PHYSICIAN_REQUIRED",
    );
    for (const attestation of [
      "A".repeat(VERBAL_ATTESTATION_MIN_CHARS - 1),
      "A".repeat(VERBAL_ATTESTATION_MAX_CHARS + 1),
    ]) {
      expectCode(
        () => buildVerbalOrderInput(verbalRequest({ verbalAttestation: attestation })),
        "VERBAL_ORDER_ATTESTATION_INVALID",
      );
    }
    // Trimmed before measuring — leading whitespace must not buy the 100-char floor.
    expectCode(
      () =>
        buildVerbalOrderInput(
          verbalRequest({ verbalAttestation: `${" ".repeat(50)}${"A".repeat(60)}` }),
        ),
      "VERBAL_ORDER_ATTESTATION_INVALID",
    );
  });

  it("records the attestation against the EXISTING target and keeps the ORDER id as the link", async () => {
    const seen: unknown[] = [];
    const provider: OrderSignatureProvider = {
      async signOrderTarget() {
        throw new Error("not used");
      },
      async recordVerbalOrder(input) {
        seen.push(input);
        return {
          verbalOrderId: "19000000-0000-4000-8000-000000000014",
          deadlineAt: "2026-08-03T02:30:00.000Z",
        };
      },
      async cosignOrder() {
        throw new Error("not used");
      },
      async discontinueOrder() {
        throw new Error("not used");
      },
    };
    registerSeam("OrderSignatureProvider", provider);

    const receipt = await recordTriageVerbalOrder({
      request: verbalRequest(),
      actorDiscipline: "clinical_rn",
      stepUp: freshStepUp,
      nowMs: NOW_MS,
    });

    // §4.3's `triageContextForVerbalOrder(orgId, verbalOrderId: OrderRecordId)` types the reverse lookup on
    // the ORDER id — storing M11's attestation-row id would leave that seam permanently returning null.
    expect(receipt.orderRecordId).toBe(ORDER);
    expect(receipt.verbalOrderId).toBe("19000000-0000-4000-8000-000000000014");
    expect(receipt.deadlineAt).toBe("2026-08-03T02:30:00.000Z");
    expect(seen).toHaveLength(1);
    expect(verbalOrderLinkEffect(receipt)).toEqual({
      kind: "link_verbal_order",
      orderRecordId: ORDER,
    });
  });

  it("gates on scope and step-up BEFORE touching the seam", async () => {
    let called = false;
    registerSeam("OrderSignatureProvider", {
      async signOrderTarget() {
        throw new Error("not used");
      },
      async recordVerbalOrder() {
        called = true;
        return { verbalOrderId: "x", deadlineAt: "y" };
      },
      async cosignOrder() {
        throw new Error("not used");
      },
      async discontinueOrder() {
        throw new Error("not used");
      },
    } satisfies OrderSignatureProvider);

    await expectCodeAsync(
      () =>
        recordTriageVerbalOrder({
          request: verbalRequest(),
          actorDiscipline: "clinical_lpn",
          stepUp: freshStepUp,
          nowMs: NOW_MS,
        }),
      "VERBAL_ORDER_ACTOR_OUT_OF_SCOPE",
    );
    await expectCodeAsync(
      () =>
        recordTriageVerbalOrder({
          request: verbalRequest(),
          actorDiscipline: "clinical_rn",
          stepUp: null,
          nowMs: NOW_MS,
        }),
      "VERBAL_ORDER_STEP_UP_REQUIRED",
    );
    expect(called).toBe(false);
  });

  it("propagates an M11 failure instead of degrading — there is no partial verbal order", async () => {
    registerSeam("OrderSignatureProvider", {
      async signOrderTarget() {
        throw new Error("not used");
      },
      async recordVerbalOrder() {
        throw new Error("m11 unavailable");
      },
      async cosignOrder() {
        throw new Error("not used");
      },
      async discontinueOrder() {
        throw new Error("not used");
      },
    } satisfies OrderSignatureProvider);

    // Unlike the M8 path: reporting success would show the RN an order the pharmacy never sees and the
    // attending never countersigns. The call stays in `disposition_pending`, which is recoverable.
    await expect(
      recordTriageVerbalOrder({
        request: verbalRequest(),
        actorDiscipline: "clinical_rn",
        stepUp: freshStepUp,
        nowMs: NOW_MS,
      }),
    ).rejects.toThrow("m11 unavailable");
  });

  it("appends verbal-order links in order and never duplicates one", () => {
    // §7.7's "ondansetron + IV morphine" — one call, two orders.
    const one = appendLinkedVerbalOrderId([], ORDER);
    const two = appendLinkedVerbalOrderId(one, ORDER_2);
    expect(two).toEqual([ORDER, ORDER_2]);
    // The effect runner is retried by the same at-least-once machinery as everything else in §4.8; a
    // duplicated id would claim two verbal orders where one was taken.
    expect(appendLinkedVerbalOrderId(two, ORDER)).toEqual([ORDER, ORDER_2]);
  });
});

// ── D15 — the M12 medication / refill context ─────────────────────────────────────────────────────────

describe("M19 D15 — the M12 medication and refill surface", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  function medProvider(
    active: MedicationOrderDto[] | Error,
    byId: MedicationOrderDto | null = null,
  ): MedicationOrderProvider {
    return {
      async getActiveMedications() {
        if (active instanceof Error) throw active;
        return active;
      },
      async getMedicationsSince() {
        return [];
      },
      async getMedicationOrder() {
        return byId;
      },
      async listForAdmission() {
        return [];
      },
      async getAdministrationContext() {
        return null;
      },
      async getControlledSubstanceFlag() {
        return { isControlled: false, schedule: null };
      },
      async getComfortKitDeploymentTimeline() {
        return null;
      },
      async getCostBasisSummary() {
        return { totalCostCents: 0, lineCount: 0 };
      },
      async getPortalMedicationSummary() {
        return { summary: [] };
      },
      async asFhirMedicationRequest() {
        return null;
      },
    };
  }

  function refillProvider(pending: RefillRequestDto[] | Error): RefillInboxProvider {
    return {
      async getPendingRefillsForPrescriber() {
        return [];
      },
      async getPendingRefillsForPatient() {
        if (pending instanceof Error) throw pending;
        return pending;
      },
      async getRefillRequestById() {
        return null;
      },
    };
  }

  it("projects the minimum-necessary medication and refill rows the panel shows", async () => {
    registerSeam("MedicationOrderProvider", medProvider([medicationDto()]));
    registerSeam("RefillInboxProvider", refillProvider([refillDto()]));

    const context = await readTriageMedicationContext({
      organizationId: ORG,
      patientId: PATIENT,
      sudDisclosurePermitted: true,
    });

    expect(context.activeMedications).toEqual({
      kind: "ready",
      items: [
        {
          medicationOrderId: MED_ORDER,
          display: "Morphine Sulfate ER 30 mg tablet",
          route: "PO",
          asNeeded: false,
          isControlledSubstance: true,
          deaSchedule: "cii",
          isRedacted: false,
        },
      ],
    });
    expect(context.pendingRefills.kind === "ready" && context.pendingRefills.items[0]).toEqual({
      refillRequestId: "18000000-0000-4000-8000-000000000013",
      sourceMedicationOrderId: MED_ORDER,
      requestedAt: OPENED_AT,
      requestedQuantity: 30,
    });
    expect(context.sudRedactedCount).toBe(0);
  });

  it("degrades each slice independently — 'unreadable' is never rendered as 'empty'", async () => {
    registerSeam("MedicationOrderProvider", medProvider(new Error("m12 down")));
    registerSeam("RefillInboxProvider", refillProvider([]));

    const context = await readTriageMedicationContext({
      organizationId: ORG,
      patientId: PATIENT,
      sudDisclosurePermitted: true,
    });

    // An RN who reads "no active medications" at 2 a.m. authorizes against a chart she believes is empty.
    expect(context.activeMedications.kind).toBe("unavailable");
    expect(
      context.activeMedications.kind === "unavailable" && context.activeMedications.reason,
    ).toContain("m12 down");
    // M12 can be half-up: a genuinely empty refill list is still a FACT and stays one.
    expect(context.pendingRefills).toEqual({ kind: "ready", items: [] });
  });

  it("withholds 42 CFR Part 2 medications by count, never by a blanked row", async () => {
    const rows = [
      medicationDto(),
      medicationDto({ id: "1a000000-0000-4000-8000-000000000015", isSudTreatment: true }),
    ];
    registerSeam("MedicationOrderProvider", medProvider(rows));
    registerSeam("RefillInboxProvider", refillProvider([]));

    const gated = await readTriageMedicationContext({
      organizationId: ORG,
      patientId: PATIENT,
      sudDisclosurePermitted: false,
    });

    // Dropped, not blanked: a placeholder keeping route/DEA schedule re-identifies the medication class.
    expect(gated.activeMedications.kind === "ready" && gated.activeMedications.items).toHaveLength(
      1,
    );
    // The count is what tells the clinician the list is incomplete without disclosing what is missing.
    expect(gated.sudRedactedCount).toBe(1);

    const direct = redactSudMedications(rows, true);
    expect(direct.kept).toHaveLength(2);
    expect(direct.redactedCount).toBe(0);
  });

  it("validates a PRN authorization target through M12's reader, and refuses an unknown one", async () => {
    registerSeam("MedicationOrderProvider", medProvider([], medicationDto()));
    registerSeam("RefillInboxProvider", refillProvider([]));

    const target = await validatePrnAuthorizationTarget({
      organizationId: ORG,
      medicationOrderId: MED_ORDER,
    });
    expect(target).toEqual({
      medicationOrderId: MED_ORDER,
      display: "Morphine Sulfate ER 30 mg tablet",
      isControlledSubstance: true,
      deaSchedule: "cii",
    });

    __resetSeamsForTest();
    registerSeam("MedicationOrderProvider", medProvider([], null));
    // A write, unlike the panel read: a PRN authorized against an order M12 will not confirm is the shape
    // M13 cannot administer against.
    await expectCodeAsync(
      () => validatePrnAuthorizationTarget({ organizationId: ORG, medicationOrderId: MED_ORDER }),
      "PRN_TARGET_NOT_FOUND",
    );
  });
});

describe("assertVerbalOrderBelongsToCall (GAP-134)", () => {
  it("accepts an M11 order of the call's own patient", () => {
    expect(() => assertVerbalOrderBelongsToCall({ patientId: "p1" }, "p1")).not.toThrow();
  });

  it("refuses a fabricated id (no such order) with DISPOSITION_PAYLOAD_INVALID", () => {
    expectCode(() => assertVerbalOrderBelongsToCall(null, "p1"), "DISPOSITION_PAYLOAD_INVALID");
  });

  it("refuses any order while the caller is not yet matched to a patient", () => {
    expectCode(
      () => assertVerbalOrderBelongsToCall({ patientId: "p1" }, null),
      "DISPOSITION_PAYLOAD_INVALID",
    );
  });

  it("refuses another patient's order with DISPOSITION_PAYLOAD_INVALID", () => {
    expectCode(
      () => assertVerbalOrderBelongsToCall({ patientId: "p2" }, "p1"),
      "DISPOSITION_PAYLOAD_INVALID",
    );
  });
});
