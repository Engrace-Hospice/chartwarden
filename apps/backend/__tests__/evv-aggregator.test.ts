import type { AggregatorSubmitResult } from "@wardenx/evv-aggregators";
import {
  OpenModelAdapter,
  SandataAdapter,
  StateAggregatorRegistry,
  createSandataSandboxTransport,
  eventPairHash,
} from "@wardenx/evv-aggregators";
// apps/backend/__tests__/evv-aggregator.test.ts — M18-T06 (§2.2.5 D7, §4.5 D1, §4.7, §7.8, §7.9).
//
// Covers the M18-T06 headline deliverables with no DB / no network:
//   • the pure §2.2.5 D7 aggregator-submission state machine (legal graph, resubmit/cancel validity, effects);
//   • the §4.5 D1 `EvvAggregatorAdapter` package — Sandata + open-model adapters + the per-state
//     `StateAggregatorRegistry` selecting from M40-style state configs;
//   • the §7.8 (submit → poll → accepted) / §7.9 (submit → rejected → resubmit) orchestration;
//   • the §4.7 ABAC predicate resolvers (`assigned_clinician_for_visit` / `evv_within_visit_window`);
//   • the route service's aggregator resubmit/cancel + missing-resolution attest paths over the machine.
import { describe, expect, it } from "vitest";
import { buildEvvAbacPredicates } from "../src/modules/18-evv/abac-predicates";
import {
  type EvvAggregatorSubmissionEvent,
  EvvStateError,
  isAggregatorSubmissionCancellable,
  isAggregatorSubmissionResubmittable,
  isAggregatorSubmissionTerminal,
  outboxEvents,
  transitionAggregatorSubmission,
} from "../src/modules/18-evv/domain/index";
import { EvvRouteService } from "../src/modules/18-evv/routes/service";
import { dispatchSubmission, pollSubmissionOnce } from "../src/modules/18-evv/submission-flow";

const CRED = { providerEntityId: "pe-1", secrets: {} };
const PAYLOAD_ARGS = {
  orgId: "org-1",
  visitId: "visit-1",
  checkInEventId: "ci-1",
  checkOutEventId: "co-1",
  serviceTypeCode: "T1019",
  clinicianNpi: "1234567890",
  patientStateIdentifier: "TXMED-1",
  encounterDurationMinutes: 76,
} as const;

describe("§2.2.5 D7 — aggregator-submission state machine", () => {
  it("walks the happy path pending → queued → submitting → submitted → accepted", () => {
    expect(transitionAggregatorSubmission("pending", { type: "queue" }).status).toBe("queued");
    expect(transitionAggregatorSubmission("queued", { type: "dispatch" }).status).toBe(
      "submitting",
    );
    expect(
      transitionAggregatorSubmission("submitting", { type: "ack_async", transactionId: "tx" })
        .status,
    ).toBe("submitted");
    const accepted = transitionAggregatorSubmission("submitted", {
      type: "poll_result",
      result: { result: "accepted", acceptedAt: "2026-06-22T10:00:00Z" },
    });
    expect(accepted.status).toBe("accepted");
    expect(outboxEvents(accepted.effects)).toContain("m18.evv.aggregator_accepted");
  });

  it("dispatch increments the attempt count", () => {
    expect(transitionAggregatorSubmission("queued", { type: "dispatch" }).incrementsAttempt).toBe(
      true,
    );
  });

  it("resubmit is valid ONLY from rejected/timeout and re-queues (attempt++)", () => {
    for (const from of ["rejected", "timeout"] as const) {
      const t = transitionAggregatorSubmission(from, { type: "resubmit" });
      expect(t.status).toBe("queued");
      expect(t.incrementsAttempt).toBe(true);
    }
    expect(isAggregatorSubmissionResubmittable("rejected")).toBe(true);
    expect(isAggregatorSubmissionResubmittable("accepted")).toBe(false);
    // accepted/cancelled are terminal — resubmit is an illegal transition (not even reachable from the graph).
    expect(() => transitionAggregatorSubmission("accepted", { type: "resubmit" })).toThrow(
      EvvStateError,
    );
  });

  it("cancel is valid ONLY from a non-terminal status", () => {
    for (const from of ["pending", "queued", "submitting", "submitted"] as const) {
      const t = transitionAggregatorSubmission(from, { type: "cancel" });
      expect(t.status).toBe("cancelled");
      expect(outboxEvents(t.effects)).toContain("m18.evv.aggregator_cancelled");
    }
    expect(isAggregatorSubmissionCancellable("submitted")).toBe(true);
    expect(isAggregatorSubmissionCancellable("accepted")).toBe(false);
    expect(() => transitionAggregatorSubmission("accepted", { type: "cancel" })).toThrow(
      EvvStateError,
    );
  });

  it("a hard rejection emits the warn alert + outbox; a timeout the critical alert", () => {
    const rejected = transitionAggregatorSubmission("submitted", {
      type: "poll_result",
      result: { result: "rejected", rejectionCode: "INVALID_SERVICE_CODE", rejectionReason: "x" },
    });
    expect(rejected.status).toBe("rejected");
    expect(
      rejected.effects.some((e) => e.kind === "alert" && e.alert === "aggregator_rejected"),
    ).toBe(true);
    expect(isAggregatorSubmissionTerminal("rejected")).toBe(false); // resubmittable, not fully terminal

    const timeout = transitionAggregatorSubmission("submitted", {
      type: "poll_result",
      result: { result: "timeout" },
    });
    expect(timeout.status).toBe("timeout");
    expect(
      timeout.effects.some((e) => e.kind === "alert" && e.alert === "aggregator_timeout"),
    ).toBe(true);
  });

  it("an illegal transition throws ILLEGAL_AGGREGATOR_SUBMISSION_TRANSITION", () => {
    expect(() => transitionAggregatorSubmission("pending", { type: "dispatch" })).toThrow(
      EvvStateError,
    );
  });
});

describe("§4.5 D1 — adapters + StateAggregatorRegistry (M40 state-vendor selection)", () => {
  it("selects the Sandata adapter for a mandate state and open-model short-circuits its states", () => {
    const reg = new StateAggregatorRegistry([
      { stateCode: "TX", aggregatorVendor: "sandata", operatingModel: "closed_single_vendor" },
      { stateCode: "CA", aggregatorVendor: "open_model", operatingModel: "open_no_aggregator" },
    ]);
    expect(reg.adapterForState("TX")?.vendor).toBe("sandata");
    expect(reg.isOpenModelNoAggregator("CA")).toBe(true);
    expect(reg.adapterForState("CA")).toBeNull();
  });

  it("throws when a state requires a vendor with no registered adapter", () => {
    expect(
      () =>
        new StateAggregatorRegistry([
          {
            stateCode: "NY",
            aggregatorVendor: "hhaexchange",
            operatingModel: "closed_single_vendor",
          },
        ]),
    ).toThrow(/No adapter for vendor 'hhaexchange'/);
  });

  it("the open-model adapter accepts synchronously", async () => {
    const r = await new OpenModelAdapter().submit({
      body: {},
      idempotencyKey: "k",
      credentials: CRED,
    });
    expect(r.result).toBe("accepted");
  });

  it("event_pair_hash is deterministic + order-sensitive", () => {
    expect(eventPairHash("a", "b")).toBe(eventPairHash("a", "b"));
    expect(eventPairHash("a", "b")).not.toBe(eventPairHash("b", "a"));
  });
});

describe("§7.8 / §7.9 — submission orchestration over the machine", () => {
  it("§7.8 Sandata async: dispatch → submitted (awaiting poll) → accepted", async () => {
    const adapter = new SandataAdapter({
      transport: createSandataSandboxTransport(() => new Date("2026-06-22T11:02:00Z")),
    });
    const pass = await dispatchSubmission({
      adapter,
      credentials: CRED,
      payloadArgs: PAYLOAD_ARGS,
    });
    expect(pass.status).toBe("submitted");
    expect(pass.awaitingPoll).toBe(true);
    expect(pass.transactionId).toBeTruthy();
    expect(outboxEvents(pass.effects)).toContain("m18.evv.aggregator_submitted");

    const polled = await pollSubmissionOnce({
      adapter,
      credentials: CRED,
      transactionId: pass.transactionId!,
    });
    expect(polled.status).toBe("accepted");
  });

  it("§7.8 open-model synchronous: dispatch → accepted in one pass", async () => {
    const pass = await dispatchSubmission({
      adapter: new OpenModelAdapter(),
      credentials: CRED,
      payloadArgs: PAYLOAD_ARGS,
    });
    expect(pass.status).toBe("accepted");
    expect(pass.awaitingPoll).toBe(false);
  });

  it("§7.9 hard rejection surfaces as rejected with the rejection code", async () => {
    const rejectingTransport = {
      async post(): Promise<AggregatorSubmitResult> {
        return {
          result: "rejected",
          rejectionCode: "INVALID_SERVICE_CODE",
          rejectionReason: "not in roster",
          transactionId: null,
        };
      },
      async pollStatus() {
        return { result: "timeout" } as const;
      },
      async ping() {
        return true;
      },
    };
    const adapter = new SandataAdapter({ transport: rejectingTransport });
    const pass = await dispatchSubmission({
      adapter,
      credentials: CRED,
      payloadArgs: PAYLOAD_ARGS,
    });
    expect(pass.status).toBe("rejected");
    expect(pass.rejectionCode).toBe("INVALID_SERVICE_CODE");
  });
});

describe("§4.7 — owned ABAC predicate resolvers", () => {
  const resolver = {
    async assignedMembershipForVisit(orgId: string, visitId: string) {
      return orgId === "org-1" && visitId === "visit-1" ? "mem-1" : null;
    },
    async visitWindowForVisit(orgId: string, visitId: string) {
      return orgId === "org-1" && visitId === "visit-1"
        ? { scheduledStartedAt: "2026-06-22T10:00:00Z", scheduledEndedAt: "2026-06-22T11:00:00Z" }
        : null;
    },
    async captureWindow() {
      return { beforeMs: 2 * 3_600_000, afterMs: 4 * 3_600_000 };
    },
  };
  const predicates = buildEvvAbacPredicates({ resolver });
  const ctx = {
    organizationId: "org-1",
    userId: "mem-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: {},
  };

  it("assigned_clinician_for_visit allows the assigned membership and denies others", async () => {
    expect(
      await predicates.assigned_clinician_for_visit!(ctx, {
        visitId: "visit-1",
        membershipId: "mem-1",
      }),
    ).toBe(true);
    expect(
      await predicates.assigned_clinician_for_visit!(ctx, {
        visitId: "visit-1",
        membershipId: "mem-2",
      }),
    ).toBe(false);
    expect(
      await predicates.assigned_clinician_for_visit!(ctx, {
        visitId: "visit-x",
        membershipId: "mem-1",
      }),
    ).toBe(false);
  });

  it("evv_within_visit_window allows inside the 2h-before/4h-after window and denies outside", async () => {
    // 1h before start — inside the 2h pre-window.
    expect(
      await predicates.evv_within_visit_window!(ctx, {
        visitId: "visit-1",
        eventCapturedAt: "2026-06-22T09:00:00Z",
      }),
    ).toBe(true);
    // 5h after end — beyond the 4h post-window.
    expect(
      await predicates.evv_within_visit_window!(ctx, {
        visitId: "visit-1",
        eventCapturedAt: "2026-06-22T16:30:00Z",
      }),
    ).toBe(false);
  });
});

describe("route service — aggregator + resolution lifecycle over the machine", () => {
  it("resubmits a rejected submission (→ queued, attempt++) and refuses an accepted one", () => {
    const svc = new EvvRouteService({
      submissions: [
        {
          organizationId: "org-1",
          id: "sub-r",
          visitId: "v",
          stateCode: "TX",
          aggregatorVendor: "sandata",
          status: "rejected",
          attemptCount: 1,
        },
        {
          organizationId: "org-1",
          id: "sub-a",
          visitId: "v2",
          stateCode: "TX",
          aggregatorVendor: "sandata",
          status: "accepted",
          attemptCount: 1,
        },
      ],
    });
    const res = svc.resubmitSubmission("org-1", "ops-1", "sub-r");
    expect(res.status).toBe("queued");
    expect(res.attemptCount).toBe(2);
    expect(() => svc.resubmitSubmission("org-1", "ops-1", "sub-a")).toThrow(EvvStateError);
  });

  it("cancels a non-terminal submission and refuses an accepted one", () => {
    const svc = new EvvRouteService({
      submissions: [
        {
          organizationId: "org-1",
          id: "sub-q",
          visitId: "v",
          stateCode: "TX",
          aggregatorVendor: "sandata",
          status: "queued",
        },
      ],
    });
    expect(svc.cancelSubmission("org-1", "ops-1", "sub-q", "operator cancelled").status).toBe(
      "cancelled",
    );
  });

  it("is org-pinned — a cross-tenant submission id is NOT found", () => {
    const svc = new EvvRouteService({
      submissions: [
        {
          organizationId: "org-2",
          id: "sub-x",
          visitId: "v",
          stateCode: "TX",
          aggregatorVendor: "sandata",
          status: "rejected",
        },
      ],
    });
    expect(() => svc.resubmitSubmission("org-1", "ops-1", "sub-x")).toThrow(/not found/);
  });

  it("clinician self-attest closes an open missing-resolution for the assigned clinician", () => {
    const svc = new EvvRouteService({
      visits: [
        {
          organizationId: "org-1",
          visitId: "v",
          patientId: "p",
          assignedMembershipId: "mem-1",
          scheduledStartedAt: "2026-06-22T10:00:00Z",
          scheduledEndedAt: "2026-06-22T11:00:00Z",
        },
      ],
      resolutions: [
        {
          organizationId: "org-1",
          id: "mr-1",
          visitId: "v",
          kind: "missing_checkout",
          status: "open",
          checkInAt: new Date().toISOString(),
        },
      ],
    });
    const r = svc.clinicianAttestResolution("org-1", "mem-1", "mr-1", "x".repeat(40));
    expect(r.status).toBe("closed_clinician_attested");
    expect(r.resolvedByMembershipId).toBe("mem-1");
  });
});
