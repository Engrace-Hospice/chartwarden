// WP 3.8 - the shared "review queued" alert helpers (reused by WP 3.9): fixed PHI-free text, hashed correlation ids that
// dedupe across redeliveries, a logged warning (hash only) when no supervisor resolves, one alert per distinct assignee.
import type { AlertEmitter } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import {
  REVIEW_ALERT_TEXT,
  REVIEW_QUEUED_ALERT,
  REVIEW_TASK_NEEDS_DECISION_ALERT,
  emitReviewQueuedAlert,
  emitTaskNeedsDecisionAlerts,
} from "./review-alerts";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const PATIENT = "00000000-0000-4000-8000-0000000000e1";
const ALICE = "00000000-0000-4000-8000-00000000aaa1";
const trigger = { source: "patient_lifecycle", triggerRef: PATIENT } as const;

function emitter(resolved: number) {
  const calls: Array<Parameters<AlertEmitter["emit"]>[1]> = [];
  const alerts: AlertEmitter = {
    emit: async (_org, input) => {
      calls.push(input);
      return { alertId: "a", resolvedRecipientCount: resolved };
    },
  };
  return { alerts, calls };
}

describe("emitReviewQueuedAlert", () => {
  it("emits one fixed-text warn alert whose ids never include the raw trigger", async () => {
    const { alerts, calls } = emitter(2);

    const out = await emitReviewQueuedAlert({ alerts }, ORG, trigger);

    expect(out.resolvedRecipientCount).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ eventType: REVIEW_QUEUED_ALERT, severity: "warn" });
    expect(calls[0]?.payload.message).toBe(REVIEW_ALERT_TEXT.queued);
    expect(JSON.stringify(calls[0])).not.toContain(PATIENT);
  });

  it("uses the same correlation id for a redelivery", async () => {
    const { alerts, calls } = emitter(1);

    await emitReviewQueuedAlert({ alerts }, ORG, trigger);
    await emitReviewQueuedAlert({ alerts }, ORG, trigger);

    expect(calls[0]?.correlationId).toBe(calls[1]?.correlationId);
  });

  it("warns with the hash only when no supervisor resolved", async () => {
    const { alerts } = emitter(0);
    const warnings: Array<[string, Record<string, string>]> = [];

    await emitReviewQueuedAlert({ alerts, warn: (m, c) => warnings.push([m, c]) }, ORG, trigger);

    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(PATIENT);
  });
});

describe("emitTaskNeedsDecisionAlerts", () => {
  it("emits one alert per distinct assignee with a distinct correlation id and generic text", async () => {
    const { alerts, calls } = emitter(1);

    await emitTaskNeedsDecisionAlerts({ alerts }, ORG, trigger, [ALICE, ALICE, "u2"]);

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.correlationId)).size).toBe(2);
    expect(calls[0]).toMatchObject({ eventType: REVIEW_TASK_NEEDS_DECISION_ALERT });
    expect(calls[0]?.payload).toMatchObject({
      assigneeUserId: ALICE,
      message: REVIEW_ALERT_TEXT.taskNeedsDecision,
    });
    expect(JSON.stringify(calls)).not.toContain(PATIENT);
  });
});
