import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import {
  M36_CHANNEL_MEMBERSHIP_SYNC_EVENT_TYPES,
  buildM36ChannelMembershipSyncConsumer,
} from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";

const ENVELOPE_ORG = "11111111-1111-4111-8111-111111111111";
const PAYLOAD_ORG = "99999999-9999-4999-8999-999999999999";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "44444444-4444-4444-8444-444444444444";

function event(eventType: string, payload: Record<string, unknown>): DispatchableOutboxEvent {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    organizationId: ENVELOPE_ORG,
    eventType,
    aggregateKind: "x",
    aggregateId: "agg",
    payload,
    attemptCount: 0,
    createdAt: new Date("2026-10-05T10:00:00.000Z"),
  };
}

function harness(resolvedPatient: string | null = PATIENT) {
  const deps = {
    syncCareTeam: vi.fn(async () => ({})),
    archiveCareTeam: vi.fn(async () => undefined),
    reopenCareTeam: vi.fn(async () => true),
    patientIdForAdmission: vi.fn(async () => resolvedPatient),
    routeForReview: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  };
  return { deps, consumer: buildM36ChannelMembershipSyncConsumer(deps) };
}

describe("M36 channel membership sync consumer (GAP-104)", () => {
  it("binds the four lifecycle events", () => {
    expect(buildM36ChannelMembershipSyncConsumer(harness().deps).eventTypes).toEqual(
      M36_CHANNEL_MEMBERSHIP_SYNC_EVENT_TYPES,
    );
  });

  it("re-syncs the roster when an assignment ends, in the ENVELOPE tenant", async () => {
    const { deps, consumer } = harness();
    await consumer.handle(
      event("m5.patient.assignment_ended", {
        patientId: PATIENT,
        organizationId: PAYLOAD_ORG,
        clinicianUserId: "u",
        role: "primary_rn",
      }),
    );
    expect(deps.syncCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
    expect(deps.archiveCareTeam).not.toHaveBeenCalled();
  });

  it("syncs BEFORE routing the removed clinician for review, with the envelope tenant and the event id", async () => {
    const { deps, consumer } = harness();
    const order: string[] = [];
    deps.syncCareTeam.mockImplementation(async () => order.push("sync"));
    deps.routeForReview.mockImplementation(async () => order.push("route"));
    await consumer.handle(
      event("m5.patient.assignment_ended", {
        patientId: PATIENT,
        organizationId: PAYLOAD_ORG,
        clinicianUserId: "u",
        role: "primary_rn",
      }),
    );
    expect(order).toEqual(["sync", "route"]);
    expect(deps.routeForReview).toHaveBeenCalledWith(
      ENVELOPE_ORG,
      PATIENT,
      "u",
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("propagates a routing failure so the relay retries", async () => {
    const { deps, consumer } = harness();
    deps.routeForReview.mockRejectedValueOnce(new Error("boom"));
    await expect(
      consumer.handle(
        event("m5.patient.assignment_ended", { patientId: PATIENT, clinicianUserId: "u" }),
      ),
    ).rejects.toThrow("boom");
  });

  it("never routes on created, deceased or discharged", async () => {
    const { deps, consumer } = harness();
    await consumer.handle(event("m5.patient.assignment_created", { patientId: PATIENT }));
    await consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    await consumer.handle(event("m6.admission.discharged", { admissionId: ADMISSION }));
    expect(deps.routeForReview).not.toHaveBeenCalled();
  });

  it("reopens an archived channel and then syncs on a new assignment", async () => {
    const { deps, consumer } = harness();
    await consumer.handle(event("m5.patient.assignment_created", { patientId: PATIENT }));
    expect(deps.reopenCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
    expect(deps.syncCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
  });

  it("syncs then archives on death", async () => {
    const { deps, consumer } = harness();
    await consumer.handle(event("m5.patient.deceased", { patientId: PATIENT }));
    expect(deps.syncCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
    expect(deps.archiveCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
  });

  it("archives the patient's channel on admission discharge via the admission lookup", async () => {
    const { deps, consumer } = harness();
    await consumer.handle(event("m6.admission.discharged", { admissionId: ADMISSION }));
    expect(deps.patientIdForAdmission).toHaveBeenCalledWith(ENVELOPE_ORG, ADMISSION);
    expect(deps.archiveCareTeam).toHaveBeenCalledWith(ENVELOPE_ORG, PATIENT);
  });

  it("throws (DLQ) on a malformed payload or an unresolvable admission, never silently drops", async () => {
    const { deps, consumer } = harness(null);
    await expect(consumer.handle(event("m5.patient.assignment_ended", {}))).rejects.toThrow(
      /no patientId/,
    );
    await expect(
      consumer.handle(event("m5.patient.assignment_ended", { patientId: PATIENT })),
    ).rejects.toThrow(/no clinicianUserId/);
    expect(deps.routeForReview).not.toHaveBeenCalled();
    await expect(
      consumer.handle(event("m6.admission.discharged", { admissionId: ADMISSION })),
    ).rejects.toThrow(/does not resolve/);
    expect(deps.archiveCareTeam).not.toHaveBeenCalled();
  });
});
