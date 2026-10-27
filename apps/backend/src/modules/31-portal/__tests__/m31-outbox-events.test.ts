import { M31_EVENT_NAMES } from "@chartwarden/types";
// GAP-159 - the 22 spec 4.10 events are catalogued, and the emitters publish through the (validating) publisher.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  type M31OutboxPublisher,
  createM31EventEmitter,
  emitGrantGranted,
  emitGrantsRevoked,
} from "../events";
import { M31_OUTBOX_EVENTS } from "../events-by-m31";
import { lateJoinEndReason } from "../jobs/late-join-watchdog";
import { lifecycleEventsFor } from "../routes/store";

const ORG = "11111111-1111-4111-8111-111111111111";
const row = (over: Partial<Parameters<typeof lifecycleEventsFor>[1]> = {}) => ({
  id: "v1",
  m17VisitId: "m17",
  visitStartedAt: new Date("2026-10-10T10:00:00Z"),
  endReason: "clean" as string | null,
  totalDurationSec: 120 as number | null,
  audioOnlyFallbackActive: false,
  lifecycleState: "ended_clean",
  ...over,
});

describe("M31_OUTBOX_EVENTS", () => {
  it("catalogues exactly the 22 spec 4.10 event names", () => {
    expect(M31_OUTBOX_EVENTS.map((e) => e.eventName).sort()).toEqual([...M31_EVENT_NAMES].sort());
  });

  it("validates a representative grant-revoked payload and refuses one missing a field", () => {
    const schema = M31_OUTBOX_EVENTS.find((e) => e.eventName === "m31.portal_access_grant.revoked")
      ?.payloadSchema as never;
    expect(
      Value.Check(schema, {
        grantId: "g",
        portalAccountId: "a",
        patientId: "p",
        revokeCascadeSource: "consent_revoked",
      }),
    ).toBe(true);
    expect(Value.Check(schema, { grantId: "g" })).toBe(false);
  });
});

describe("createM31EventEmitter", () => {
  it("emitInTx publishes on the caller's tx with the aggregate and payload", async () => {
    const publish = vi.fn(async () => undefined);
    const emitter = createM31EventEmitter({
      db: {} as never,
      publisher: { publish } as M31OutboxPublisher,
    });
    const tx = { tx: true };
    await emitter.emitInTx(
      tx,
      ORG,
      "m31.portal_account.suspended",
      { kind: "portal_account", id: "a1" },
      { portalAccountId: "a1", reason: "admin_suspend" },
    );
    expect(publish).toHaveBeenCalledWith(tx, {
      eventName: "m31.portal_account.suspended",
      payload: { portalAccountId: "a1", reason: "admin_suspend" },
      organizationId: ORG,
      aggregateKind: "portal_account",
      aggregateId: "a1",
    });
  });

  it("grant helpers emit one event per row and are a no-op without an emitter", async () => {
    const emitInTx = vi.fn(async () => undefined);
    const events = { emitInTx, emit: vi.fn() };
    await emitGrantsRevoked(
      events,
      {},
      ORG,
      [
        { id: "g1", portalAccountId: "a", patientId: "p" },
        { id: "g2", portalAccountId: "a", patientId: "p" },
      ],
      "destruction",
    );
    expect(emitInTx).toHaveBeenCalledTimes(2);
    await emitGrantGranted(events, {}, ORG, {
      id: "g3",
      portalAccountId: "a",
      patientId: "p",
      grantKind: "bereaved_family",
    });
    expect(emitInTx).toHaveBeenCalledTimes(3);
    await expect(emitGrantsRevoked(undefined, {}, ORG, [], "x")).resolves.toBeUndefined();
  });
});

describe("lifecycleEventsFor", () => {
  it("maps in_progress to visit_started, ended_* to visit_ended, recording on to recording_started", () => {
    expect(lifecycleEventsFor({ lifecycleState: "in_progress" }, row()).map((e) => e.name)).toEqual(
      ["m31.telehealth.visit_started"],
    );
    expect(lifecycleEventsFor({ lifecycleState: "ended_clean" }, row()).map((e) => e.name)).toEqual(
      ["m31.telehealth.visit_ended"],
    );
    expect(lifecycleEventsFor({ recordingEnabled: true }, row()).map((e) => e.name)).toEqual([
      "m31.telehealth.recording_started",
    ]);
    expect(lifecycleEventsFor({ lifecycleState: "clinician_joined" }, row())).toEqual([]);
  });
});

describe("lateJoinEndReason", () => {
  it("names who failed to show", () => {
    expect(lateJoinEndReason("room_minted")).toBe("both_dropped");
    expect(lateJoinEndReason("patient_joined")).toBe("clinician_dropped");
    expect(lateJoinEndReason("clinician_joined")).toBe("patient_dropped");
  });
});
