// The held-work alert end to end through the REAL pieces: the M23 hold and M41 alert (their in-process quiet windows), the real
// `cronAlertCorrelationId` / `emitCronAlert` the composition root sends through, and an emitter double that does what M36's does with an
// (org, correlation id) it has seen: absorb the repeat and write no deliveries. The in-process window alone proved nothing: the emitter
// collapsed these alerts per UTC day and code, so a warning at 02:00 swallowed a critical for a NOE at 09:00.
import { CLEARINGHOUSE_HOLD_ALERT_CODES } from "@chartwarden/types";
import { DelayedError } from "bullmq";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetClearinghouseAlertMemoryForTest,
  holdJobWhileUnbound,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-unbound-hold";
import {
  type CronAlertEmitter,
  emitCronAlert,
} from "../src/modules/36-messaging/cron-alert-correlation";
import {
  __resetUnboundAlertMemoryForTest,
  reportUnboundWithWork,
} from "../src/modules/41-billing-commercial/jobs/unbound-alert";

const ORG = "11111111-1111-4111-8111-111111111111";
const HOUR = 60 * 60_000;
const T0 = Date.parse("2026-11-09T02:00:00Z");

/** M36's persist behaviour that matters here: a repeat of (org, correlationId) is absorbed, and only a new one notifies anyone. */
function emitterDouble(resolvedRecipientCount = 1) {
  const seen = new Set<string>();
  const notified: { severity: string; queue: unknown; correlationId: string }[] = [];
  const emitter: CronAlertEmitter = {
    async emit(orgId, input) {
      const key = `${orgId}:${input.correlationId}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (resolvedRecipientCount > 0) {
          notified.push({
            severity: input.severity,
            queue: input.payload.queue,
            correlationId: input.correlationId,
          });
        }
      }
      return { alertId: "a", resolvedRecipientCount };
    },
  };
  return { emitter, notified };
}

const job = { moveToDelayed: async () => undefined };

/** A held M23 job, sent through the real sender at `at`. */
async function hold(
  emitter: CronAlertEmitter,
  at: number,
  queue: string,
  severity: "warn" | "critical",
  reason = "not_active",
  logged: string[] = [],
) {
  await holdJobWhileUnbound({
    deps: {
      alerts: {
        dispatch: (a) => emitCronAlert(emitter, "m23-cron", a.organizationId, a, new Date(at)),
      },
      logger: { error: (_f, message) => void logged.push(message) },
    },
    job,
    token: undefined,
    queue,
    organizationId: ORG,
    reason,
    severity,
    now: () => at,
  }).catch((err: unknown) => {
    if (!(err instanceof DelayedError)) throw err;
  });
}

describe("the M23 held-work alert reaches the tenant (CH-4 / F1)", () => {
  beforeEach(() => __resetClearinghouseAlertMemoryForTest());

  it("a held NOE's critical alert is not absorbed by a held claim's warning raised earlier the same day", async () => {
    const { emitter, notified } = emitterDouble();

    await hold(emitter, T0, "claim.submit", "warn");
    await hold(emitter, T0 + 7 * HOUR, "noe.submit", "critical");

    expect(notified.map((n) => [n.severity, n.queue])).toEqual([
      ["warn", "claim.submit"],
      ["critical", "noe.submit"],
    ]);
  });

  it("re-alerts after the six-hour window instead of once per UTC day, and a repeat inside the window is quiet", async () => {
    const { emitter, notified } = emitterDouble();

    await hold(emitter, T0, "claim.submit", "warn");
    await hold(emitter, T0 + HOUR, "claim.submit", "warn"); // inside the window: quiet in process
    expect(notified).toHaveLength(1);

    await hold(emitter, T0 + 6 * HOUR + 1, "claim.submit", "warn"); // a new window: it reaches the tenant again
    expect(notified).toHaveLength(2);
    expect(notified[1]?.correlationId).not.toEqual(notified[0]?.correlationId);
  });

  it("a second process (its own memory) repeating the alert inside the window is absorbed by the emitter, not paged twice", async () => {
    const { emitter, notified } = emitterDouble();

    await hold(emitter, T0, "claim.submit", "warn");
    __resetClearinghouseAlertMemoryForTest(); // another worker process, or a restart
    await hold(emitter, T0 + HOUR, "claim.submit", "warn");

    expect(notified).toHaveLength(1);
  });

  it("an alert that resolved no recipient does not start the quiet window: the next held job tries again and the failure is logged", async () => {
    const nobody = emitterDouble(0);
    const logged: string[] = [];

    await hold(nobody.emitter, T0, "claim.submit", "warn", "not_active", logged);
    expect(logged).toEqual(["clearinghouse hold alert not dispatched"]);

    // recipients exist now: the next held job in the same in-process window alerts (the persisted zero-recipient alert of that
    // M36 window absorbs it there, until the window turns over; the point is that the sender did try and did not go quiet)
    const calls: string[] = [];
    const counting: CronAlertEmitter = {
      emit: async (_orgId, input) => {
        calls.push(input.correlationId);
        return { alertId: "a", resolvedRecipientCount: 2 };
      },
    };
    await hold(counting, T0 + 15 * 60_000, "claim.submit", "warn");
    expect(calls).toHaveLength(1);
  });
});

describe("the M41 held-work alert reaches the tenant (CH-4)", () => {
  beforeEach(() => __resetUnboundAlertMemoryForTest());

  const report = (emitter: CronAlertEmitter, at: number, queue: string) =>
    reportUnboundWithWork(
      {
        alerts: {
          dispatch: (a) => emitCronAlert(emitter, "m41-cron", a.organizationId, a, new Date(at)),
        },
      },
      { organizationId: ORG, queue, waiting: 3, now: () => at },
    );

  it("the submission drain and the ack pull of one org alert apart, and each re-alerts after the window", async () => {
    const { emitter, notified } = emitterDouble();

    await report(emitter, T0, "m41.submission.drain");
    await report(emitter, T0 + 1, "m41.ack.pull");
    await report(emitter, T0 + 7 * HOUR, "m41.submission.drain");

    expect(notified.map((n) => n.queue)).toEqual([
      "m41.submission.drain",
      "m41.ack.pull",
      "m41.submission.drain",
    ]);
    expect(
      notified.every((n) => n.correlationId.includes(CLEARINGHOUSE_HOLD_ALERT_CODES.m41)),
    ).toBe(true);
  });
});
